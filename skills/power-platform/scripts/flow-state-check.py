#!/usr/bin/env python3
"""flow-state-check.py - before an import, refuse a package that would switch a cloud flow on or off.

An import applies the on/off state each flow carries in the package (its StateCode). A flow that is
running in the environment and Draft in the package is switched off by the import, without a word;
a reminder that is deliberately off and on in the package starts sending. A package rebuilt from a
live export carries whatever state the export saw, so drift travels into the next import. The
post-import check (`import-watch.py`) finds the damage afterwards; this one refuses it beforehand.

Usage:
    python flow-state-check.py --package out/app.zip                       package against the live environment
    python flow-state-check.py --package out/app.zip --repo solution/src   ... and against the repo's sidecars
    python flow-state-check.py --package out/app.zip --repo solution/src --offline   repo only, no sign-in

--package takes a built solution zip (states read from customizations.xml) or an unpacked source
folder (states read from Workflows/*.json.data.xml).

Options:
    --org URL           environment URL (default: "environmentUrl" in scripts/canvas-app.json)
    --config PATH       identity config (default: ./scripts/canvas-app.json if present)
    --repo PATH         the unpacked source in git; any flow whose state differs from it is DRIFT
    --offline           do not read the environment (needs --repo)
    --allow a,b         flows (display names) whose switch is intended; reported, not refused
    --token-cmd, --token-env   as import-watch.py. The token is never printed or saved.
    --json              print the result as JSON
    --selftest          run the built-in tests against fixtures and exit

Read-only: every call is a GET, and the package is only read.

Exit codes: 0 no flow changes state and the package matches the repo; 2 cannot run (no flows found,
no token, bad arguments); 4 a flow would be switched, or the package's state differs from the repo.
"""
import argparse
import json
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ppapi import ApiError, FakeTransport, NotFound, dataverse, get_token  # noqa: E402

CLOUD_FLOW = 5             # workflow.category for a modern cloud flow
ON = 1                     # statecode Activated; 0 Draft and 2 Suspended both mean "not running"
STATE = {0: "off (Draft)", 1: "on", 2: "off (Suspended)"}


class CannotRun(Exception):
    pass


def load_config(path):
    paths = [path] if path else [os.path.join("scripts", "canvas-app.json"), "canvas-app.json"]
    for p in paths:
        if p and os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)
    if path:
        raise CannotRun("config not found: %s" % path)
    return {}


def _int(block, tag):
    m = re.search(r"<%s>\s*(-?\d+)\s*</%s>" % (tag, tag), block)
    return int(m.group(1)) if m else None


def parse_workflows(xml):
    """Cloud flows in a customizations.xml or a .json.data.xml: {id: {name, state}}."""
    out = {}
    for m in re.finditer(r"<Workflow\b([^>]*)>(.*?)</Workflow>", xml or "", re.S):
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        body = m.group(2)
        wid = (attrs.get("WorkflowId") or "").strip("{}").lower()
        if not wid or _int(body, "Category") != CLOUD_FLOW:
            continue
        state = _int(body, "StateCode")
        out[wid] = {"name": attrs.get("Name") or wid, "state": state}
    return out


def read_package(path):
    """States from a zip (customizations.xml) or an unpacked folder (Workflows/*.data.xml)."""
    if os.path.isdir(path):
        wf = os.path.join(path, "Workflows")
        if not os.path.isdir(wf):
            raise CannotRun("no Workflows folder in %s (is it the unpacked solution source?)" % path)
        out = {}
        for n in sorted(os.listdir(wf)):
            if n.lower().endswith(".data.xml"):
                with open(os.path.join(wf, n), encoding="utf-8-sig") as f:
                    out.update(parse_workflows(f.read()))
        return out
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            name = next((n for n in z.namelist() if n.lower() == "customizations.xml"), None)
            if not name:
                raise CannotRun("%s has no customizations.xml (not a solution zip?)" % path)
            return parse_workflows(z.read(name).decode("utf-8-sig", "replace"))
    raise CannotRun("not a zip or a folder: %s" % path)


def live_states(dv, ids):
    out = {}
    for wid in ids:
        try:
            w = dv.get("workflows(%s)?$select=name,statecode,category" % wid)
        except NotFound:
            out[wid] = None            # not in the environment yet: the import creates it
            continue
        out[wid] = {"name": w.get("name"), "state": w.get("statecode")}
    return out


def running(state):
    return state == ON


def judge(pkg, live=None, repo=None, allow=()):
    """Findings: switch-off / switch-on (package vs live), drift (package vs repo), new."""
    allow = {a.strip().lower() for a in allow if a.strip()}
    rows = []
    for wid, p in sorted(pkg.items(), key=lambda kv: kv[1]["name"].lower()):
        row = {"id": wid, "name": p["name"], "package": p["state"], "kind": "same"}
        if repo is not None:
            r = repo.get(wid)
            row["repo"] = r["state"] if r else None
            if r is None:
                row["kind"] = "not-in-repo"
            elif r["state"] != p["state"]:
                row["kind"] = "drift"
        if live is not None and row["kind"] == "same":
            lv = live.get(wid)
            row["live"] = lv["state"] if lv else None
            if lv is None:
                row["kind"] = "new"
            elif running(lv["state"]) and not running(p["state"]):
                row["kind"] = "switch-off"
            elif not running(lv["state"]) and running(p["state"]):
                row["kind"] = "switch-on"
        row["allowed"] = row["kind"] in ("switch-off", "switch-on") and p["name"].lower() in allow
        rows.append(row)
    return rows


def report(rows):
    bad = [r for r in rows if r["kind"] in ("switch-off", "switch-on", "drift", "not-in-repo") and not r["allowed"]]
    for r in rows:
        s = STATE.get(r["package"], r["package"])
        if r["kind"] == "same":
            print("  ok    %s: %s" % (r["name"], s))
        elif r["kind"] == "new":
            print("  new   %s: not in the environment; the import creates it %s" % (r["name"], s))
        elif r["kind"] == "drift":
            print("  !! DRIFT  %s: package %s, repo %s. The package was not built from the repo (a live export?). "
                  "Rebuild it from git." % (r["name"], s, STATE.get(r["repo"], r["repo"])))
        elif r["kind"] == "not-in-repo":
            print("  !! NOT IN REPO  %s: in the package, not in the repo's Workflows. Commit it or rebuild." % r["name"])
        else:
            verb = "switch it OFF" if r["kind"] == "switch-off" else "switch it ON"
            tag = "allowed" if r["allowed"] else "!! REFUSED"
            print("  %s  %s: %s live, %s in the package; the import would %s." % (
                tag, r["name"], STATE.get(r["live"], r["live"]), s, verb))
            if not r["allowed"]:
                want = "1</StateCode> and <StatusCode>2" if r["kind"] == "switch-off" else "0</StateCode> and <StatusCode>1"
                print("         Fix: set <StateCode>%s</StatusCode> in its .json.data.xml and repack, or pass "
                      "--allow \"%s\" if the switch is intended." % (want, r["name"]))
    return bad


def run(a, dv=None):
    if a.offline and not a.repo:
        raise CannotRun("--offline compares with nothing: give --repo <solution/src>")
    pkg = read_package(a.package)
    if not pkg:
        raise CannotRun("no cloud flows (category 5) in %s" % a.package)
    repo = read_package(a.repo) if a.repo else None
    live = None if a.offline else live_states(dv, list(pkg))
    rows = judge(pkg, live, repo, (a.allow or "").split(","))
    print("flow-state-check: %d cloud flow(s) in the package; compared with %s" % (
        len(pkg), " and ".join(x for x in ("the environment" if live is not None else "", "the repo" if repo is not None else "") if x)))
    bad = report(rows)
    if bad:
        print("REFUSED: %d flow(s) would change state or do not match the repo. Do not import this package." % len(bad))
        return 4, rows
    print("OK: no flow changes state on import%s." % (" and the package matches the repo" if repo is not None else ""))
    return 0, rows


def selftest():
    import tempfile
    failures = []

    def check(name, cond):
        print("  %s  %s" % ("ok  " if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    A = "aaaaaaaa-0000-0000-0000-000000000001"
    B = "bbbbbbbb-0000-0000-0000-000000000002"
    C = "cccccccc-0000-0000-0000-000000000003"

    def wf(wid, name, state, cat=5):
        status = 2 if state == 1 else 1
        return ('<Workflow WorkflowId="{%s}" Name="%s"><Type>1</Type><Category>%d</Category>'
                '<StateCode>%d</StateCode><StatusCode>%d</StatusCode></Workflow>' % (wid.upper(), name, cat, state, status))

    cust = ('<ImportExportXml><Workflows>%s%s%s%s</Workflows></ImportExportXml>'
            % (wf(A, "Order reminder", 1), wf(B, "Vendor sync", 0), wf(C, "Weekly digest", 1),
               wf("dddddddd-0000-0000-0000-000000000004", "Classic workflow", 1, cat=0)))
    tmp = tempfile.mkdtemp()
    zpath = os.path.join(tmp, "app.zip")
    with zipfile.ZipFile(zpath, "w") as z:
        z.writestr("customizations.xml", cust)
        z.writestr("solution.xml", "<ImportExportXml/>")
    src = os.path.join(tmp, "src", "Workflows")
    os.makedirs(src)
    for wid, name, st in ((A, "Order reminder", 1), (B, "Vendor sync", 0), (C, "Weekly digest", 1)):
        with open(os.path.join(src, name.replace(" ", "") + "-" + wid.upper() + ".json.data.xml"), "w", encoding="utf-8") as f:
            f.write('<?xml version="1.0" encoding="utf-8"?>\n' + wf(wid, name, st))

    pkg = read_package(zpath)
    check("a zip's customizations.xml yields its cloud flows only", sorted(pkg) == sorted([A, B, C]))
    check("ids are read lower-case without braces, with the state", pkg[A]["state"] == 1 and pkg[B]["state"] == 0)
    check("an unpacked folder yields the same flows", read_package(os.path.join(tmp, "src")) == pkg)

    def fake(live):
        t = FakeTransport()
        for wid, st in live.items():
            t.on("GET", "workflows(%s)" % wid, (lambda s: lambda u, b: {"name": "x", "statecode": s, "category": 5})(st))
        return t

    def go(live, *args):
        t = fake(live)
        dv = dataverse("https://example.invalid", "fixture", read_only=True, transport=t, sleep=lambda s: None)
        a = parse(["--package", zpath] + list(args))
        try:
            rc, rows = run(a, dv)
        except CannotRun as e:
            rc, rows = 2, str(e)
        return rc, rows, t

    rc, rows, t = go({A: 1, B: 0, C: 1})
    check("live state equal to the package exits 0", rc == 0)
    check("every call is a GET", t.calls and not t.writes())
    rc, rows, _ = go({A: 1, B: 0, C: 0})
    check("a flow off live and on in the package is refused (exit 4)", rc == 4 and
          [r["kind"] for r in rows if r["name"] == "Weekly digest"] == ["switch-on"])
    rc, rows, _ = go({A: 1, B: 1, C: 1})
    check("a running flow that is Draft in the package is refused", rc == 4 and
          [r["kind"] for r in rows if r["name"] == "Vendor sync"] == ["switch-off"])
    rc, rows, _ = go({A: 1, B: 2, C: 1})
    check("Suspended live and Draft in the package is not a switch", rc == 0)
    rc, rows, _ = go({A: 1, B: 1, C: 1}, "--allow", "vendor sync")
    check("--allow accepts a named, intended switch", rc == 0 and any(r["allowed"] for r in rows))
    rc, rows, _ = go({A: 1, B: 0})
    check("a flow not in the environment is new, not refused", rc == 0 and
          [r["kind"] for r in rows if r["name"] == "Weekly digest"] == ["new"])

    with open(os.path.join(src, "VendorSync-" + B.upper() + ".json.data.xml"), "w", encoding="utf-8") as f:
        f.write(wf(B, "Vendor sync", 1))
    rc, rows, t = go({}, "--repo", os.path.join(tmp, "src"), "--offline")
    check("--offline with --repo makes no call", rc == 4 and not t.calls)
    check("a package state that differs from the repo is DRIFT", [r["kind"] for r in rows if r["name"] == "Vendor sync"] == ["drift"])
    rc, rows, _ = go({}, "--offline")
    check("--offline without --repo cannot run", rc == 2)

    print("selftest: %s" % ("PASSED" if not failures else "FAILED (%d)" % len(failures)))
    return 0 if not failures else 1


def parse(argv):
    ap = argparse.ArgumentParser(prog="flow-state-check.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("--package")
    ap.add_argument("--repo")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--allow")
    ap.add_argument("--org")
    ap.add_argument("--config")
    ap.add_argument("--token-cmd")
    ap.add_argument("--token-env", default="DATAVERSE_TOKEN")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    return ap.parse_args(argv)


def main(argv=None):
    a = parse(argv if argv is not None else sys.argv[1:])
    if a.selftest:
        return selftest()
    if not a.package:
        print("usage: flow-state-check.py --package <zip|folder> [--repo <solution/src>] [--offline] [--allow a,b]")
        return 2
    try:
        dv = None
        if not a.offline:
            cfg = load_config(a.config)
            org = a.org or cfg.get("environmentUrl")
            if not org:
                raise CannotRun("no environment URL: pass --org, set environmentUrl in scripts/canvas-app.json, "
                                "or use --offline with --repo")
            token = get_token(org, a.token_cmd or cfg.get("dataverseTokenCommand"), a.token_env, org)[0]
            dv = dataverse(org, token, read_only=True)
        rc, rows = run(a, dv)
    except (CannotRun, ApiError, ValueError) as e:
        print("cannot run: %s" % e)
        return 2
    if a.json:
        print(json.dumps(rows, default=str))
    return rc


if __name__ == "__main__":
    sys.exit(main())
