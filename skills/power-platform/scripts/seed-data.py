#!/usr/bin/env python3
"""seed-data.py - load sample and fixture rows into Dataverse tables from a JSON or CSV seed file,
idempotently, and list (or, with --apply, remove) them again afterwards.

Seed data early: the canvas, flow and report lanes can all start against real rows while the schema
lane finishes, and acceptance runs against known values.

Usage:
    python seed-data.py seed    --seed seed.json                plan: create / skip / drift per row
    python seed-data.py seed    --seed seed.json --apply        create the missing rows
    python seed-data.py seed    --seed seed.json --apply --update   also put drifted seed values back
    python seed-data.py check   --seed seed.json                read-only: do the live rows still hold the seed values?
    python seed-data.py cleanup --seed seed.json                list what cleanup would delete/restore
    python seed-data.py cleanup --seed seed.json --apply        do it (an OWNER step: hand it over)

The seed file (assets/templates/seed.example.json):
    {
      "org": "https://yourorg.crm.dynamics.com",
      "timezone": "America/New_York",
      "tables": [
        { "table": "app_asset", "key": "app_assettag", "cleanup": "restore", "restore": ["app_status"],
          "rows": [ { "app_assettag": "A-01", "app_name": "Laptop 14in", "app_category": "Laptop",
                      "app_status": "Available" } ] },
        { "table": "app_loan", "key": "app_borrower", "cleanup": "delete",
          "cleanupFilter": "startswith(app_borrower,'[SAMPLE]')",
          "rows": [ { "app_borrower": "[SAMPLE] Borrower A",
                      "app_asset": { "lookup": "app_asset", "key": "app_assettag", "value": "A-01" },
                      "app_checkedouton": "=today-24", "app_dueon": "=today-10", "app_status": "Open" } ] },
        { "table": "app_category", "key": "app_name", "csv": "seed/categories.csv" }
      ]
    }

Values:
  - Choice columns take the option LABEL ("Open"); it is resolved from the table's metadata, so the
    file does not depend on the publisher's option value prefix. An unknown label stops the run.
  - Lookups are {"lookup": <target table>, "key": <target column>, "value": <target key value>};
    the navigation property is the column's logical name (deploy-tables.py keeps them equal), or
    "nav" overrides it. A target seeded earlier in the same file resolves in the same run.
  - "=today", "=today-10", "=today+7" become a date in "timezone" (or the machine's zone).
  - CSV: a header row of logical names; empty cells are left out.

Rows are matched by "key" (one column whose value is unique among seed rows). An existing row is
never overwritten unless --update, and then only the columns the seed file names.

`check` is read-only and meant for the end of a build: walks that lend, return or approve change
seed rows, and a build that hands back with its own test edits still in the data fails its data
check. It prints one line per drifted or missing row (compact: a table, then the differences) and
exits 1 on any drift; re-apply with `seed --update --apply`.

Cleanup is list-only without --apply. "cleanup": "delete" deletes the seed rows of that table (and,
with "cleanupFilter", every row matching that OData filter - test rows a walk created);
"cleanup": "restore" puts the "restore" columns back to their seed values. Tables run in reverse
order for deletes, so children go before parents. Deleting rows is the owner's step in this skill:
print the list, hand the person the --apply line, never run it on their behalf.

Options:
    --org URL           environment URL (or "org" in the seed file)
    --only TABLE        just this table (repeatable)
    --token-cmd CMD     command printing a Dataverse token ("{org}" replaced)
    --token-env NAME    variable holding the token (default DATAVERSE_TOKEN)
    --selftest          offline tests against a simulated Web API

Exit: 0 done (or planned, or check clean); 1 a finding or (check) drift (unknown choice label, unresolvable lookup, duplicate key);
2 cannot run (bad seed file, no token, API error).
"""
import argparse
import csv
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ppapi import ApiError, FakeTransport, PlanRefused, dataverse, get_token, odata_literal  # noqa: E402

TODAY_RE = re.compile(r"^=today(?:([+-])(\d+))?$")


class SeedError(Exception):
    pass


class Finding(Exception):
    pass


def today_in(tz):
    if tz:
        try:
            from zoneinfo import ZoneInfo
            return datetime.datetime.now(ZoneInfo(tz)).date()
        except Exception:
            print("note: time zone %r unavailable here (pip install tzdata); using the machine's date" % tz)
    return datetime.date.today()


def load_seed(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            s = json.load(f)
    except (OSError, ValueError) as e:
        raise SeedError("cannot read %s: %s" % (path, e))
    root = os.path.dirname(os.path.abspath(path))
    for t in s.get("tables") or []:
        if not t.get("table") or not t.get("key"):
            raise SeedError("every table needs \"table\" (logical name) and \"key\" (match column)")
        rows = list(t.get("rows") or [])
        if t.get("csv"):
            with open(os.path.join(root, t["csv"]), encoding="utf-8-sig", newline="") as f:
                rows += [{k: v for k, v in r.items() if v not in ("", None)} for r in csv.DictReader(f)]
        keys = [r.get(t["key"]) for r in rows]
        if None in keys:
            raise SeedError("%s: a row has no %s" % (t["table"], t["key"]))
        dup = sorted({k for k in keys if keys.count(k) > 1})
        if dup:
            raise SeedError("%s: duplicate %s value(s): %s" % (t["table"], t["key"], ", ".join(map(str, dup))))
        if t.get("cleanup") not in (None, "delete", "restore"):
            raise SeedError("%s: cleanup is \"delete\" or \"restore\"" % t["table"])
        t["_rows"] = rows
    return s


class Meta:
    """Entity set, primary id and choice labels per table, read once."""

    def __init__(self, dv):
        self.dv = dv
        self.cache = {}

    def table(self, logical):
        if logical not in self.cache:
            d = self.dv.get("EntityDefinitions(LogicalName=%s)?$select=EntitySetName,PrimaryIdAttribute"
                            % odata_literal(logical))
            opts = self.dv.get("EntityDefinitions(LogicalName=%s)/Attributes/Microsoft.Dynamics.CRM."
                               "PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)"
                               % odata_literal(logical)) or {}
            choices = {}
            for a in opts.get("value") or []:
                m = {}
                for o in ((a.get("OptionSet") or {}).get("Options") or []):
                    lab = ((o.get("Label") or {}).get("UserLocalizedLabel") or {}).get("Label")
                    if lab:
                        m[lab.lower()] = o["Value"]
                choices[a["LogicalName"]] = m
            self.cache[logical] = {"set": d["EntitySetName"], "pk": d["PrimaryIdAttribute"], "choices": choices}
        return self.cache[logical]


def existing(dv, meta, table, key):
    t = meta.table(table)
    rows = dv.get("%s?$select=%s,%s" % (t["set"], t["pk"], key)) or {}
    out = {}
    for r in rows.get("value") or []:
        out[str(r.get(key))] = r
    nxt = rows.get("@odata.nextLink")
    while nxt:
        page = dv.get(nxt) or {}
        for r in page.get("value") or []:
            out[str(r.get(key))] = r
        nxt = page.get("@odata.nextLink")
    return out


def to_payload(row, table, meta, dv, today, created):
    """(body for POST/PATCH, comparable values) - raises Finding on unknown labels or lookups."""
    t = meta.table(table)
    body, plain = {}, {}
    for col, v in row.items():
        if isinstance(v, dict) and "lookup" in v:
            target = meta.table(v["lookup"])
            ident = created.get((v["lookup"], str(v["value"])))
            if not ident:
                hit = (dv.get("%s?$select=%s&$filter=%s eq %s" % (target["set"], target["pk"], v["key"],
                                                                   odata_literal(v["value"]))) or {}).get("value") or []
                if len(hit) != 1:
                    if (v["lookup"], str(v["value"])) in created.get("_pending", set()):
                        body["%s@odata.bind" % v.get("nav", col)] = "<pending %s %s>" % (v["lookup"], v["value"])
                        continue
                    raise Finding("%s.%s: lookup %s %s=%r matched %d rows" % (table, col, v["lookup"], v["key"],
                                                                                v["value"], len(hit)))
                ident = hit[0][target["pk"]]
            body["%s@odata.bind" % v.get("nav", col)] = "/%s(%s)" % (target["set"], ident)
            plain["_" + col + "_value"] = ident
            continue
        if isinstance(v, str):
            m = TODAY_RE.match(v)
            if m:
                n = int(m.group(2) or 0) * (-1 if m.group(1) == "-" else 1)
                v = (today + datetime.timedelta(days=n)).isoformat()
            elif col in t["choices"]:
                val = t["choices"][col].get(v.lower())
                if val is None:
                    raise Finding("%s.%s: %r is not an option (options: %s)" % (
                        table, col, v, ", ".join(sorted(t["choices"][col])) or "none"))
                v = val
        body[col] = v
        plain[col] = v
    return body, plain


def drift(live, plain):
    out = []
    for col, want in plain.items():
        have = live.get(col)
        if isinstance(have, str) and isinstance(want, str) and have[:10] == want[:10] and len(want) == 10:
            continue
        if have != want:
            out.append("%s: %r -> %r" % (col, have, want))
    return out


def cmd_seed(dv, meta, seed, only, apply, update, today):
    created, bad = {"_pending": set()}, 0
    for t in seed.get("tables") or []:
        if only and t["table"] not in only:
            continue
        key = t["key"]
        meta.table(t["table"])
        live = existing(dv, meta, t["table"], key)
        n = {"create": 0, "skip": 0, "drift": 0}
        for row in t["_rows"]:
            k = str(row[key])
            try:
                body, plain = to_payload(row, t["table"], meta, dv, today, created)
            except Finding as e:
                print("FINDING %s" % e)
                bad += 1
                continue
            if k in live:
                created[(t["table"], k)] = live[k][meta.table(t["table"])["pk"]]
                cols = [c for c in plain if not c.startswith("_")]
                full = dv.get("%s(%s)?$select=%s" % (meta.table(t["table"])["set"], live[k][meta.table(t["table"])["pk"]],
                                                    ",".join(cols))) if cols else {}
                d = drift(full or {}, {c: plain[c] for c in cols})
                if d and update:
                    if apply:
                        dv.call("PATCH", "%s(%s)" % (meta.table(t["table"])["set"], live[k][meta.table(t["table"])["pk"]]),
                                {c: body[c] for c in cols})
                    print("%s %s %s (%s)" % ("updated" if apply else "would update", t["table"], k, "; ".join(d)))
                    n["drift"] += 1
                elif d:
                    print("drift %s %s (%s) - left alone; --update puts the seed values back" % (t["table"], k, "; ".join(d)))
                    n["drift"] += 1
                else:
                    n["skip"] += 1
                continue
            if apply:
                _, _, out = dv.call("POST", meta.table(t["table"])["set"], body, headers={"Prefer": "return=representation"})
                created[(t["table"], k)] = (out or {}).get(meta.table(t["table"])["pk"])
                print("created %s %s" % (t["table"], k))
            else:
                created["_pending"].add((t["table"], k))
                print("would create %s %s" % (t["table"], k))
            n["create"] += 1
        print("%s: %d to create, %d present, %d drifted" % (t["table"], n["create"], n["skip"], n["drift"]))
    if not apply:
        print("plan only: nothing was written. Re-run with --apply.")
    return 1 if bad else 0


def cmd_check(dv, meta, seed, only, today):
    """Read-only: every seed row present and holding its seed values (lookups and choices resolved)."""
    rows_out, total, bad = [], 0, 0
    for t in seed.get("tables") or []:
        if only and t["table"] not in only:
            continue
        m = meta.table(t["table"])
        live = existing(dv, meta, t["table"], t["key"])
        for row in t["_rows"]:
            k = str(row[t["key"]])
            total += 1
            if k not in live:
                rows_out.append((t["table"], k, "missing"))
                bad += 1
                continue
            try:
                _, plain = to_payload(row, t["table"], meta, dv, today, {"_pending": set()})
            except Finding as e:
                rows_out.append((t["table"], k, "cannot compare: %s" % e))
                bad += 1
                continue
            cols = [c for c in plain if not c.startswith("_")]
            look = {c: v for c, v in plain.items() if c.startswith("_")}
            full = dv.get("%s(%s)?$select=%s" % (m["set"], live[k][m["pk"]], ",".join(cols + list(look)))) if (cols or look) else {}
            d = drift(full or {}, plain)
            if d:
                rows_out.append((t["table"], k, "; ".join(d)))
                bad += 1
    print("seed check: %d row(s) compared, %d drifted or missing" % (total, bad))
    for table, k, what in rows_out:
        print("  DRIFT %-20s %-24s %s" % (table, k, what))
    if bad:
        print("Put the seed back with: seed --seed <file> --update --apply (and list test rows with cleanup).")
    return 1 if bad else 0


def cmd_cleanup(dv, meta, seed, only, apply, today, seed_path):
    tables = [t for t in seed.get("tables") or [] if t.get("cleanup") and (not only or t["table"] in only)]
    count = 0
    for t in reversed(tables):
        m = meta.table(t["table"])
        if t["cleanup"] != "delete":
            continue
        live = existing(dv, meta, t["table"], t["key"])
        targets = {live[str(r[t["key"]])][m["pk"]]: str(r[t["key"]]) for r in t["_rows"] if str(r[t["key"]]) in live}
        if t.get("cleanupFilter"):
            extra = dv.get("%s?$select=%s,%s&$filter=%s" % (m["set"], m["pk"], t["key"], t["cleanupFilter"])) or {}
            for r in extra.get("value") or []:
                targets.setdefault(r[m["pk"]], str(r.get(t["key"])))
        for ident, label in sorted(targets.items(), key=lambda x: x[1]):
            if apply:
                dv.call("DELETE", "%s(%s)" % (m["set"], ident))
            print("%s %s %s" % ("deleted" if apply else "would delete", t["table"], label))
            count += 1
    for t in tables:
        if t["cleanup"] != "restore":
            continue
        m = meta.table(t["table"])
        live = existing(dv, meta, t["table"], t["key"])
        cols = t.get("restore") or []
        for row in t["_rows"]:
            k = str(row[t["key"]])
            if k not in live or not cols:
                continue
            body, plain = to_payload({c: row[c] for c in cols if c in row}, t["table"], meta, dv, today, {})
            full = dv.get("%s(%s)?$select=%s" % (m["set"], live[k][m["pk"]], ",".join(plain))) or {}
            d = drift(full, plain)
            if d:
                if apply:
                    dv.call("PATCH", "%s(%s)" % (m["set"], live[k][m["pk"]]), body)
                print("%s %s %s (%s)" % ("restored" if apply else "would restore", t["table"], k, "; ".join(d)))
                count += 1
    if not apply:
        print("%d change(s) listed; nothing was written." % count)
        if count:
            print("Owner step - hand the person this line to run:\n  ! python \"%s\" cleanup --seed \"%s\" --apply"
                  % (os.path.abspath(__file__), os.path.abspath(seed_path)))
    return 0


def run(argv, transport=None, today=None):
    ap = argparse.ArgumentParser(prog="seed-data.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("command", nargs="?", choices=["seed", "check", "cleanup"])
    ap.add_argument("--seed")
    ap.add_argument("--org")
    ap.add_argument("--only", action="append")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--update", action="store_true")
    ap.add_argument("--token-cmd")
    ap.add_argument("--token-env", default="DATAVERSE_TOKEN")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.command or not a.seed:
        ap.print_help()
        return 2
    try:
        seed = load_seed(a.seed)
    except SeedError as e:
        print("seed file error: %s" % e)
        return 2
    org = a.org or seed.get("org")
    if not org:
        print("pass --org or set \"org\" in the seed file")
        return 2
    try:
        token = "fixture" if transport else get_token(org, a.token_cmd, a.token_env, org)[0]
        dv = dataverse(org, token, read_only=(a.command == "check") or not a.apply, transport=transport,
                       sleep=(lambda s: None) if transport else None)
        meta = Meta(dv)
        day = today or today_in(seed.get("timezone"))
        only = set(a.only or [])
        if a.command == "seed":
            return cmd_seed(dv, meta, seed, only, a.apply, a.update, day)
        if a.command == "check":
            return cmd_check(dv, meta, seed, only, day)
        return cmd_cleanup(dv, meta, seed, only, a.apply, day, a.seed)
    except Finding as e:
        print("FINDING %s" % e)
        return 1
    except PlanRefused as e:
        print("BUG: %s" % e)
        return 2
    except ApiError as e:
        print("cannot run: %s" % e)
        return 2


# --------------------------------------------------------------------------- selftest

def _fake():
    import uuid
    db = {"app_assets": [], "app_loans": []}
    meta = {"app_asset": ("app_assets", "app_assetid", {"app_status": {"Available": 100000000, "On Loan": 100000001}}),
            "app_loan": ("app_loans", "app_loanid", {"app_loanstatus": {"Open": 100000001, "Returned": 100000002}})}
    t = FakeTransport()

    def ent(u, b):
        name = u.split("LogicalName='")[1].split("'")[0]
        s, pk, ch = meta[name]
        if "PicklistAttributeMetadata" in u:
            return {"value": [{"LogicalName": c, "OptionSet": {"Options": [
                {"Value": v, "Label": {"UserLocalizedLabel": {"Label": lab}}} for lab, v in opts.items()]}}
                for c, opts in ch.items()]}
        return {"EntitySetName": s, "PrimaryIdAttribute": pk}
    t.on("GET", "EntityDefinitions(", ent)

    def coll(u, b):
        s = u.split("/api/data/v9.2/")[1].split("?")[0].split("(")[0]
        pk = s[:-1] + "id"
        if "(" in u.split("/api/data/v9.2/")[1].split("?")[0]:
            ident = u.split("(")[1].split(")")[0]
            return next(r for r in db[s] if r[pk] == ident)
        rows = db[s]
        if "$filter=" in u:
            f = u.split("$filter=")[1]
            if f.startswith("startswith("):
                col, pre = f[len("startswith("):].split(",", 1)
                rows = [r for r in rows if str(r.get(col, "")).startswith(pre.strip(")'").strip("'"))]
            else:
                col, val = f.split(" eq ", 1)
                rows = [r for r in rows if str(r.get(col)) == val.strip("'")]
        return {"value": rows}
    for s in db:
        t.on("GET", "/" + s, coll)

    def post(u, b):
        s = u.split("/api/data/v9.2/")[1]
        r = {k: v for k, v in b.items() if "@odata.bind" not in k}
        for k, v in b.items():
            if "@odata.bind" in k:
                r["_%s_value" % k.split("@")[0]] = v.split("(")[1].rstrip(")")
        r[s[:-1] + "id"] = uuid.uuid4().hex
        db[s].append(r)
        return 201, {}, r

    def patch(u, b):
        s = u.split("/api/data/v9.2/")[1].split("(")[0]
        ident = u.split("(")[1].split(")")[0]
        next(r for r in db[s] if r[s[:-1] + "id"] == ident).update(b)
        return 204, {}, None

    def delete(u, b):
        s = u.split("/api/data/v9.2/")[1].split("(")[0]
        ident = u.split("(")[1].split(")")[0]
        db[s][:] = [r for r in db[s] if r[s[:-1] + "id"] != ident]
        return 204, {}, None
    for s in db:
        t.on("POST", "/" + s, post)
        t.on("PATCH", "/" + s + "(", patch)
        t.on("DELETE", "/" + s + "(", delete)
    return t, db


def selftest():
    import io
    import shutil
    import tempfile
    failures = []

    def check(name, cond):
        print("  %s  %s" % ("ok  " if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    tmp = tempfile.mkdtemp(prefix="seed-data-selftest-")
    day = datetime.date(2026, 3, 15)
    seed = {"org": "https://example.crm.dynamics.com", "tables": [
        {"table": "app_asset", "key": "app_assettag", "cleanup": "restore", "restore": ["app_status"],
         "rows": [{"app_assettag": "A-01", "app_name": "Laptop", "app_status": "Available"},
                  {"app_assettag": "A-02", "app_name": "Monitor", "app_status": "On Loan"}]},
        {"table": "app_loan", "key": "app_borrower", "cleanup": "delete",
         "cleanupFilter": "startswith(app_borrower,'[SAMPLE]')",
         "rows": [{"app_borrower": "[SAMPLE] Borrower A", "app_loanstatus": "Open", "app_dueon": "=today-10",
                   "app_asset": {"lookup": "app_asset", "key": "app_assettag", "value": "A-02"}}]}]}

    def write(s):
        p = os.path.join(tmp, "seed.json")
        with open(p, "w") as f:
            json.dump(s, f)
        return p

    def go(t, *args):
        buf, old = io.StringIO(), sys.stdout
        sys.stdout = buf
        try:
            rc = run(list(args), transport=t, today=day)
        finally:
            sys.stdout = old
        return rc, buf.getvalue()

    try:
        t, db = _fake()
        p = write(seed)
        rc, out = go(t, "seed", "--seed", p)
        check("plan exits 0 and writes nothing", rc == 0 and t.writes() == [])
        check("plan resolves a lookup to a row it would create first", "would create app_loan [SAMPLE] Borrower A" in out)
        rc, out = go(t, "seed", "--seed", p, "--apply")
        check("apply creates three rows", rc == 0 and len(db["app_assets"]) == 2 and len(db["app_loans"]) == 1)
        loan = db["app_loans"][0]
        a2 = next(r for r in db["app_assets"] if r["app_assettag"] == "A-02")
        check("choice label stored as its value", loan["app_loanstatus"] == 100000001 and a2["app_status"] == 100000001)
        check("=today-10 became a date", loan["app_dueon"] == "2026-03-05")
        check("lookup bound to the row created in the same run", loan["_app_asset_value"] == a2["app_assetid"])
        n = len(t.writes())
        rc, out = go(t, "seed", "--seed", p, "--apply")
        check("re-run is idempotent", rc == 0 and len(t.writes()) == n and len(db["app_loans"]) == 1)

        rc, out = go(t, "check", "--seed", p)
        check("check: clean seed exits 0 and writes nothing", rc == 0 and len(t.writes()) == n and "0 drifted" in out)
        a2["app_status"] = 100000000                      # a walk returned the asset
        db["app_loans"].append({"app_loanid": "walk1", "app_borrower": "[SAMPLE] walk row"})
        db["app_loans"].append({"app_loanid": "real1", "app_borrower": "Real person"})
        rc, out = go(t, "seed", "--seed", p)
        check("drift is reported and left alone", "drift app_asset A-02" in out)
        n0 = len(t.writes())
        rc, out = go(t, "check", "--seed", p)
        check("check: drift exits 1, names the row and column, writes nothing",
              rc == 1 and "DRIFT app_asset" in out and "A-02" in out and "app_status" in out and len(t.writes()) == n0)
        gone = db["app_loans"].pop(0)
        rc, out = go(t, "check", "--seed", p)
        check("check: a missing seed row is drift", rc == 1 and "missing" in out)
        db["app_loans"].insert(0, gone)
        n = len(t.writes())
        rc, out = go(t, "cleanup", "--seed", p)
        check("cleanup without --apply only lists", rc == 0 and len(t.writes()) == n and "would delete app_loan" in out
              and "would restore app_asset A-02" in out)
        check("cleanup lists the filter's test rows but not real rows", "[SAMPLE] walk row" in out and "Real person" not in out)
        check("cleanup hands over the owner line", "! python" in out and "--apply" in out)
        rc, out = go(t, "cleanup", "--seed", p, "--apply")
        check("cleanup --apply deletes seed and test rows only",
              [r["app_borrower"] for r in db["app_loans"]] == ["Real person"])
        check("cleanup --apply restores the seed status", a2["app_status"] == 100000001)

        bad = json.loads(json.dumps(seed))
        bad["tables"][0]["rows"][0]["app_status"] = "Missing"
        t, db = _fake()
        rc, out = go(t, "seed", "--seed", write(bad), "--apply")
        check("an unknown choice label is a finding, not a write of that row", rc == 1 and "'Missing' is not an option" in out
              and not any(r["app_assettag"] == "A-01" for r in db["app_assets"]))
        dup = json.loads(json.dumps(seed))
        dup["tables"][0]["rows"].append(dict(dup["tables"][0]["rows"][0]))
        rc, out = go(t, "seed", "--seed", write(dup))
        check("a duplicate key is refused before any call", rc == 2 and "duplicate" in out)

        with open(os.path.join(tmp, "assets.csv"), "w", newline="") as f:
            f.write("app_assettag,app_name,app_status\nC-01,Dock,Available\nC-02,,On Loan\n")
        t, db = _fake()
        rc, out = go(t, "seed", "--seed", write({"org": "https://example.crm.dynamics.com", "tables": [
            {"table": "app_asset", "key": "app_assettag", "csv": "assets.csv"}]}), "--apply")
        check("CSV rows load and empty cells are left out", rc == 0 and len(db["app_assets"]) == 2
              and "app_name" not in next(r for r in db["app_assets"] if r["app_assettag"] == "C-02"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print()
    print("selftest: %s" % ("PASSED" if not failures else "FAILED %d: %s" % (len(failures), ", ".join(failures))))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
