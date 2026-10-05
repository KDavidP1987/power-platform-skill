#!/usr/bin/env python3
"""reconcile-report.py - prove a report's figures: every check runs a DAX query against the
published semantic model and an independent count or sum against Dataverse, and compares them.
Read only, on both sides.

A report that renders is not a report that is right. A medallion has three places a figure can go
wrong (the bronze copy, the silver rules, the gold measure) and a Direct Lake model can serve a
stale frame. This reads the answer the report shows and the answer the source gives, side by side.

Usage:
    python reconcile-report.py --checks report-checks.json
    python reconcile-report.py --checks report-checks.json --json

The checks file (assets/templates/fabric-medallion/report-checks.example.json):
    {
      "org": "https://yourorg.crm.dynamics.com",
      "workspace": "<workspace id>",
      "dataset": "<semantic model id or name>",
      "timezone": "America/New_York",
      "checks": [
        { "name": "all loans",
          "dax": "EVALUATE ROW(\\"v\\", [Loans])",
          "dataverse": { "table": "app_loan" } },
        { "name": "open loans",
          "dax": "EVALUATE ROW(\\"v\\", [Open Loans])",
          "dataverse": { "table": "app_loan", "filter": "app_status eq {choice:app_loan.app_status:Open}" } },
        { "name": "overdue loans",
          "dax": "EVALUATE ROW(\\"v\\", [Overdue Loans])",
          "dataverse": { "table": "app_loan",
                         "filter": "app_status eq {choice:app_loan.app_status:Open} and app_dueon lt {today}" } },
        { "name": "loans by status",
          "dax": "EVALUATE SUMMARIZECOLUMNS(fact_loan[status], \\"n\\", [Loans])",
          "dataverse": { "table": "app_loan", "groupBy": "app_status" } },
        { "name": "as-of date", "dax": "EVALUATE ROW(\\"d\\", MAX(fact_loan[as_of_date]))", "expect": "{today}" }
      ]
    }

Dataverse side: "table" (logical name), optional "filter" (OData), and one of: a row count (the
default), "aggregate": "sum" | "average" | "min" | "max" with "column", or "groupBy": <column> (a
choice column is reported by its labels). "expect" compares against a literal instead.
Placeholders: {today} (a date in "timezone"), {choice:<table>.<column>:<label>} (the option value).

DAX side: a one-row query compares its first value; with groupBy, the first two columns become
label -> value. Zero and blank groups are ignored on both sides. Numbers compare within
"tolerance" (default 0.0001); dates compare on the first ten characters.

Needs: the Power BI tenant setting "Dataset Execute Queries REST API" on, and Build or Write on the
model; read access to the tables in Dataverse.

Options:
    --org / --workspace / --dataset   override the file
    --token-cmd CMD       command printing a Dataverse token ("{org}" replaced)
    --pbi-token-cmd CMD   command printing a token for https://analysis.windows.net/powerbi/api
    --token-env / --pbi-token-env     variables holding them (DATAVERSE_TOKEN / POWERBI_TOKEN)
    --json                one JSON object per check
    --selftest            offline tests against simulated APIs

Exit: 0 every check matches; 1 at least one DIFF; 2 cannot run (bad file, no token, API error) or the
file lists no checks (nothing compared is NOT a pass).
"""
import argparse
import datetime
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ppapi import (ApiError, Client, FakeTransport, RESOURCES, dataverse, get_token,  # noqa: E402
                    odata_literal)

PBI = "https://api.powerbi.com/v1.0/myorg/"
CHOICE_RE = re.compile(r"\{choice:([a-z0-9_]+)\.([a-z0-9_]+):([^}]+)\}", re.I)


class Meta:
    def __init__(self, dv):
        self.dv, self.cache = dv, {}

    def table(self, logical):
        if logical not in self.cache:
            d = self.dv.get("EntityDefinitions(LogicalName=%s)?$select=EntitySetName" % odata_literal(logical))
            opts = self.dv.get("EntityDefinitions(LogicalName=%s)/Attributes/Microsoft.Dynamics.CRM."
                               "PicklistAttributeMetadata?$select=LogicalName&$expand=OptionSet($select=Options)"
                               % odata_literal(logical)) or {}
            choices = {}
            for a in opts.get("value") or []:
                choices[a["LogicalName"]] = {
                    o["Value"]: ((o.get("Label") or {}).get("UserLocalizedLabel") or {}).get("Label")
                    for o in (a.get("OptionSet") or {}).get("Options") or []}
            self.cache[logical] = {"set": d["EntitySetName"], "choices": choices}
        return self.cache[logical]

    def choice_value(self, table, col, label):
        for v, lab in self.table(table)["choices"].get(col, {}).items():
            if (lab or "").lower() == label.lower():
                return v
        raise ApiError("{choice:%s.%s:%s}: no such option" % (table, col, label))


def fill(text, meta, today):
    text = text.replace("{today}", today.isoformat())
    return CHOICE_RE.sub(lambda m: str(meta.choice_value(m.group(1), m.group(2), m.group(3))), text)


def dataverse_value(dv, meta, spec, today):
    t = meta.table(spec["table"])
    f = fill(spec["filter"], meta, today) if spec.get("filter") else None
    pre = "filter(%s)/" % f if f else ""
    if spec.get("groupBy"):
        col = spec["groupBy"]
        rows = (dv.get("%s?$apply=%sgroupby((%s),aggregate($count as n))" % (t["set"], pre, col)) or {}).get("value") or []
        labels = t["choices"].get(col, {})
        out = {}
        for r in rows:
            k = r.get(col)
            k = labels.get(k, r.get(col + "@OData.Community.Display.V1.FormattedValue", k))
            out[str(k)] = r.get("n")
        return out
    agg = spec.get("aggregate")
    if agg:
        fn = {"sum": "sum", "average": "average", "min": "min", "max": "max"}[agg]
        rows = (dv.get("%s?$apply=%saggregate(%s with %s as v)" % (t["set"], pre, spec["column"], fn)) or {}).get("value") or []
        return rows[0].get("v") if rows else None
    rows = (dv.get("%s?$apply=%saggregate($count as n)" % (t["set"], pre)) or {}).get("value") or []
    return rows[0].get("n") if rows else 0


def dax_value(pbi, ws, ds, query, grouped):
    _, _, body = pbi.call("POST", "groups/%s/datasets/%s/executeQueries" % (ws, ds),
                          {"queries": [{"query": query}], "serializerSettings": {"includeNulls": True}}, read=True)
    res = (body or {}).get("results") or [{}]
    if res[0].get("error"):
        raise ApiError("DAX error: %s" % json.dumps(res[0]["error"])[:600])
    rows = ((res[0].get("tables") or [{}])[0]).get("rows") or []
    if grouped:
        out = {}
        for r in rows:
            vals = list(r.values())
            out[str(vals[0])] = vals[1] if len(vals) > 1 else None
        return out
    return list(rows[0].values())[0] if rows else None


def same(want, got, tol):
    if isinstance(want, dict) and isinstance(got, dict):
        w = {k: v for k, v in want.items() if v not in (0, None)}
        g = {k: v for k, v in got.items() if v not in (0, None)}
        return set(w) == set(g) and all(same(w[k], g[k], tol) for k in w)
    if isinstance(want, (int, float)) and isinstance(got, (int, float)) and not isinstance(want, bool):
        return abs(want - got) <= tol
    if isinstance(want, str) and isinstance(got, str) and re.match(r"^\d{4}-\d{2}-\d{2}", want):
        return want[:10] == got[:10]
    return want == got


def resolve_dataset(pbi, ws, ds):
    if re.match(r"^[0-9a-fA-F-]{36}$", ds or ""):
        return ds
    for d in (pbi.get("groups/%s/datasets" % ws) or {}).get("value") or []:
        if d.get("name") == ds:
            return d["id"]
    raise ApiError("semantic model %r not found in the workspace" % ds)


def today_in(tz):
    if tz:
        try:
            from zoneinfo import ZoneInfo
            return datetime.datetime.now(ZoneInfo(tz)).date()
        except Exception:
            print("note: time zone %r unavailable (pip install tzdata); using the machine's date" % tz)
    return datetime.date.today()


def run(argv, transport=None, today=None):
    ap = argparse.ArgumentParser(prog="reconcile-report.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("--checks")
    ap.add_argument("--org")
    ap.add_argument("--workspace")
    ap.add_argument("--dataset")
    ap.add_argument("--token-cmd")
    ap.add_argument("--token-env", default="DATAVERSE_TOKEN")
    ap.add_argument("--pbi-token-cmd")
    ap.add_argument("--pbi-token-env", default="POWERBI_TOKEN")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.checks:
        ap.print_help()
        return 2
    try:
        with open(a.checks, encoding="utf-8-sig") as f:
            spec = json.load(f)
    except (OSError, ValueError) as e:
        print("cannot read checks file: %s" % e)
        return 2
    org, ws, ds = a.org or spec.get("org"), a.workspace or spec.get("workspace"), a.dataset or spec.get("dataset")
    if not (org and ws and ds):
        print("org, workspace and dataset are required (file or flags)")
        return 2
    if not spec.get("checks"):
        print("the checks file lists no checks - nothing was compared; this is NOT a pass")
        return 2
    tol = float(spec.get("tolerance", 0.0001))
    try:
        dtok = "fixture" if transport else get_token(org, a.token_cmd, a.token_env, org)[0]
        ptok = "fixture" if transport else get_token(RESOURCES["powerbi"], a.pbi_token_cmd, a.pbi_token_env)[0]
        dv = dataverse(org, dtok, read_only=True, transport=transport)
        pbi = Client(PBI, ptok, read_only=True, transport=transport)
        meta = Meta(dv)
        day = today or today_in(spec.get("timezone"))
        ds = resolve_dataset(pbi, ws, ds)
        bad = 0
        for c in spec.get("checks") or []:
            grouped = bool((c.get("dataverse") or {}).get("groupBy"))
            try:
                if "expect" in c:
                    want = fill(c["expect"], meta, day) if isinstance(c["expect"], str) else c["expect"]
                else:
                    want = dataverse_value(dv, meta, c["dataverse"], day)
                got = dax_value(pbi, ws, ds, fill(c["dax"], meta, day), grouped)
                ok = same(want, got, tol)
            except ApiError as e:
                want, got, ok = "error", str(e), False
            bad += not ok
            if a.json:
                print(json.dumps({"name": c["name"], "ok": ok, "source": want, "model": got}, default=str))
            else:
                print("%s %s: source %s | model %s" % ("OK  " if ok else "DIFF", c["name"],
                                                       json.dumps(want, default=str, sort_keys=True),
                                                       json.dumps(got, default=str, sort_keys=True)))
        if not a.json:
            print("%d check(s), %d DIFF" % (len(spec.get("checks") or []), bad))
        return 1 if bad else 0
    except ApiError as e:
        print("cannot run: %s" % e)
        return 2


# --------------------------------------------------------------------------- selftest

def selftest():
    import io
    import shutil
    import tempfile
    failures = []

    def check(name, cond):
        print("  %s  %s" % ("ok  " if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    model = {"open": 2, "status": [{"t[status]": "Open", "[n]": 2}, {"t[status]": "Returned", "[n]": 3},
                                    {"t[status]": "Lost", "[n]": None}], "asof": "2026-03-15T00:00:00"}
    t = FakeTransport()
    t.on("GET", "EntityDefinitions(", lambda u, b: {"value": [{"LogicalName": "app_status", "OptionSet": {"Options": [
        {"Value": 1, "Label": {"UserLocalizedLabel": {"Label": "Open"}}},
        {"Value": 2, "Label": {"UserLocalizedLabel": {"Label": "Returned"}}}]}}]}
        if "Picklist" in u else {"EntitySetName": "app_loans"})

    def loans(u, b):
        if "groupby" in u:
            return {"value": [{"app_status": 1, "n": 2}, {"app_status": 2, "n": 3}]}
        if "app_dueon lt 2026-03-15" in u:
            return {"value": [{"n": 1}]}
        if "app_status eq 1" in u:
            return {"value": [{"n": 2}]}
        if "with sum" in u:
            return {"value": [{"v": 12.5}]}
        return {"value": [{"n": 5}]}
    t.on("GET", "/app_loans", loans)
    t.on("GET", "/datasets", lambda u, b: {"value": [{"id": "ds-1", "name": "APP Model"}]})

    def dax(u, b):
        q = b["queries"][0]["query"]
        if "SUMMARIZECOLUMNS" in q:
            rows = model["status"]
        elif "Open Loans" in q:
            rows = [{"[v]": model["open"]}]
        elif "Overdue" in q:
            rows = [{"[v]": 1}]
        elif "MAX(" in q:
            rows = [{"[d]": model["asof"]}]
        elif "Cost" in q:
            rows = [{"[v]": 12.50001}]
        else:
            rows = [{"[v]": 5}]
        return {"results": [{"tables": [{"rows": rows}]}]}
    t.on("POST", "executeQueries", dax)

    spec = {"org": "https://example.crm.dynamics.com", "workspace": "ws-1", "dataset": "APP Model", "checks": [
        {"name": "all", "dax": "EVALUATE ROW(\"v\",[Loans])", "dataverse": {"table": "app_loan"}},
        {"name": "open", "dax": "EVALUATE ROW(\"v\",[Open Loans])",
         "dataverse": {"table": "app_loan", "filter": "app_status eq {choice:app_loan.app_status:Open}"}},
        {"name": "overdue", "dax": "EVALUATE ROW(\"v\",[Overdue])",
         "dataverse": {"table": "app_loan", "filter": "app_status eq {choice:app_loan.app_status:Open} and app_dueon lt {today}"}},
        {"name": "by status", "dax": "EVALUATE SUMMARIZECOLUMNS(t[status],\"n\",[Loans])",
         "dataverse": {"table": "app_loan", "groupBy": "app_status"}},
        {"name": "cost", "dax": "EVALUATE ROW(\"v\",[Cost])",
         "dataverse": {"table": "app_loan", "aggregate": "sum", "column": "app_cost"}},
        {"name": "as of", "dax": "EVALUATE ROW(\"d\", MAX(t[d]))", "expect": "{today}"}]}
    tmp = tempfile.mkdtemp(prefix="reconcile-selftest-")
    p = os.path.join(tmp, "checks.json")
    with open(p, "w") as f:
        json.dump(spec, f)

    def go(*args):
        buf, old = io.StringIO(), sys.stdout
        sys.stdout = buf
        try:
            rc = run(["--checks", p] + list(args), transport=t, today=datetime.date(2026, 3, 15))
        finally:
            sys.stdout = old
        return rc, buf.getvalue()

    try:
        rc, out = go()
        check("all six checks match and exit 0", rc == 0 and out.count("OK  ") == 6)
        check("only reads: the one POST is executeQueries", all("executeQueries" in u for _, u in t.writes()))
        check("choice placeholder resolved to the option value", any("app_status eq 1" in u for _, u, _b in t.calls))
        check("dataset resolved by name", any("/datasets/ds-1/" in u for _, u, _b in t.calls))
        model["open"] = 3
        model["asof"] = "2026-03-14T00:00:00"
        rc, out = go()
        check("a different figure is a DIFF with exit 1", rc == 1 and "DIFF open" in out)
        check("a stale as-of date is caught", "DIFF as of" in out)
        rc, out = go("--json")
        rows = [json.loads(x) for x in out.splitlines()]
        check("--json prints one object per check", len(rows) == 6 and rows[1]["ok"] is False)
        with open(p, "w") as f:
            json.dump(dict(spec, checks=[]), f)
        rc, out = go()
        check("a file with no checks compared nothing: exit 2, not a pass", rc == 2 and "NOT a pass" in out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print()
    print("selftest: %s" % ("PASSED" if not failures else "FAILED %d: %s" % (len(failures), ", ".join(failures))))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
