#!/usr/bin/env python3
"""import-watch.py - read a solution import's outcome from the server, not from the client.

`pac solution import` can sit at "Solution Importing..." long after Dataverse has finished: one
measured import showed the client waiting for over 20 minutes while the server's importjob had
reached progress 100, completed 6.5 minutes after it started, with every component a success. The
server's `importjobs` row is the answer; the client's console is not. And a finished import is
not a working one until the flows it carries are on again (an import can leave active flows in
Draft), so this tool reads both.

Usage:
    python import-watch.py --solution <uniquename>                 the newest import job, once
    python import-watch.py --solution <uniquename> --wait 1800     poll until it completes (or time runs out)
    python import-watch.py --solution <uniquename> --since <ISO>   only a job that started at/after this time

Run it beside the client: start `pac solution import` (in the background), then run this with
--wait and --since set to the time the import began. When it prints COMPLETED the import is over
whatever the client shows; stop a client that is still waiting.

Options:
    --org URL           environment URL (default: "environmentUrl" in scripts/canvas-app.json)
    --config PATH       identity config (default: ./scripts/canvas-app.json if present)
    --poll SECONDS      between reads while waiting (default 20)
    --no-flows          skip the flow-state check
    --flows-off-ok a,b  flows (display names) that are meant to be off; not counted as a problem
    --token-cmd, --token-env   as seed-data.py (default env DATAVERSE_TOKEN; then the config's
                        "dataverseTokenCommand", az, Az PowerShell). The token is never printed or saved.
    --json              print the result as JSON
    --selftest          run the built-in tests against recorded, anonymised responses and exit

Read-only: every call is a GET.

Exit codes: 0 the import succeeded and every flow in the solution is on; 1 the import failed (the
failing components are listed); 2 cannot run (no job found, no token, bad arguments); 3 still
running when --wait ran out; 4 the import succeeded but flows in the solution are off.
"""
import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ppapi import ApiError, FakeTransport, dataverse, get_token, odata_literal  # noqa: E402

FLOW_COMPONENT = 29        # solutioncomponent.componenttype for a workflow (classic and cloud flows)
CLOUD_FLOW = 5             # workflow.category for a modern cloud flow
STATE = {0: "Draft (off)", 1: "Activated (on)", 2: "Suspended"}


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


def parse_time(s):
    if not s:
        return None
    s = s.strip().replace("Z", "+00:00")
    d = datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def summarise_data(xml):
    """Component results from importjob.data: counts per result and the failures' text."""
    xml = xml or ""
    counts = {}
    failures = []
    for m in re.finditer(r"<result\b([^>]*)>", xml):
        attrs = dict(re.findall(r'(\w+)="([^"]*)"', m.group(1)))
        r = (attrs.get("result") or "").lower()
        if not r:
            continue
        counts[r] = counts.get(r, 0) + 1
        if r == "failure":
            failures.append((attrs.get("errorcode", ""), attrs.get("errortext", "")[:300]))
    return counts, failures


def newest_job(dv, solution, since):
    q = ("importjobs?$select=importjobid,solutionname,progress,startedon,completedon,createdon"
         "&$filter=solutionname eq %s&$orderby=createdon desc&$top=5" % odata_literal(solution))
    rows = dv.get(q).get("value", [])
    for r in rows:
        started = parse_time(r.get("startedon") or r.get("createdon"))
        if since is None or (started and started >= since):
            return r
    return None


def read_outcome(dv, job):
    full = dv.get("importjobs(%s)?$select=progress,startedon,completedon,data" % job["importjobid"])
    counts, failures = summarise_data(full.get("data"))
    return full, counts, failures


def flow_states(dv, solution):
    sol = dv.get("solutions?$select=solutionid&$filter=uniquename eq %s" % odata_literal(solution)).get("value", [])
    if not sol:
        return None
    comps = dv.get("solutioncomponents?$select=objectid&$filter=_solutionid_value eq %s and componenttype eq %d"
                   % (sol[0]["solutionid"], FLOW_COMPONENT)).get("value", [])
    out = []
    for c in comps:
        try:
            w = dv.get("workflows(%s)?$select=name,statecode,category" % c["objectid"])
        except ApiError:
            continue
        if w.get("category") == CLOUD_FLOW:
            out.append({"name": w.get("name"), "state": w.get("statecode")})
    return out


def run(dv, a, now=time.time, sleep=time.sleep):
    since = parse_time(a.since) if a.since else None
    deadline = now() + max(0, a.wait)
    job = None
    while True:
        job = job or newest_job(dv, a.solution, since)
        if job:
            full, counts, failures = read_outcome(dv, job)
            done = bool(full.get("completedon"))
            if done:
                break
            print("  running: progress %s%%, started %s" % (round(float(full.get("progress") or 0), 1),
                                                          full.get("startedon")))
        elif now() >= deadline:
            raise CannotRun("no import job for solution %s%s" % (a.solution, " since %s" % a.since if since else ""))
        if now() >= deadline:
            print("STILL RUNNING when --wait ran out. Read it again later with the same command; do not "
                  "start a second import while this one runs.")
            return 3, {"state": "running", "job": job and job["importjobid"]}
        sleep(a.poll)

    started, completed = parse_time(full.get("startedon")), parse_time(full.get("completedon"))
    mins = (completed - started).total_seconds() / 60 if started and completed else None
    ok = not failures
    print("COMPLETED on the server at %s%s: %s (%s)" % (
        full.get("completedon"), " after %.1f min" % mins if mins is not None else "",
        "success" if ok else "FAILED",
        ", ".join("%s %d" % kv for kv in sorted(counts.items())) or "no component results"))
    print("  A client still showing 'Importing...' is stale: stop it; this is the answer.")
    result = {"state": "success" if ok else "failed", "job": job["importjobid"], "minutes": mins,
              "results": counts, "failures": failures}
    if not ok:
        for code, text in failures[:20]:
            print("  failure %s: %s" % (code, text))
        return 1, result
    if a.no_flows:
        return 0, result
    flows = flow_states(dv, a.solution)
    if flows is None:
        print("  !! solution %s not found by uniquename - flow states NOT checked" % a.solution)
        return 2, result
    allowed = {s.strip().lower() for s in (a.flows_off_ok or "").split(",") if s.strip()}
    off = [f for f in flows if f["state"] != 1 and (f["name"] or "").lower() not in allowed]
    result["flows"] = flows
    print("  flows in the solution: %d, on: %d" % (len(flows), sum(1 for f in flows if f["state"] == 1)))
    for f in off:
        print("  !! %s is %s" % (f["name"], STATE.get(f["state"], f["state"])))
    if off:
        print("  Turn them on through the flow deploy (and read the state back), or name the ones meant to be "
              "off with --flows-off-ok.")
        return 4, result
    return 0, result


def selftest():
    failures = []

    def check(name, cond):
        print("  %s  %s" % ("ok  " if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    JOB = "11111111-0000-0000-0000-000000000001"
    SOL = "22222222-0000-0000-0000-000000000002"
    ok_xml = ('<importexportxml><entities><entity><result result="success" errorcode="0" errortext=""/></entity>'
              '<entity><result result="success" errorcode="0" errortext=""/></entity></entities>'
              '<solutionManifests><solutionManifest><result result="success"/></solutionManifest></solutionManifests>'
              '</importexportxml>')
    bad_xml = ok_xml.replace('<result result="success" errorcode="0" errortext=""/></entity></entities>',
                             '<result result="failure" errorcode="0x80048d19" errortext="Missing dependency"/>'
                             '</entity></entities>')

    def fake(state):
        t = FakeTransport()
        t.on("GET", "importjobs?", lambda u, b: {"value": [
            {"importjobid": JOB, "solutionname": "app_orders", "startedon": "2026-01-05T10:00:00Z",
             "createdon": "2026-01-05T10:00:00Z", "progress": 100}]})

        def one(u, b):
            state["reads"] = state.get("reads", 0) + 1
            if state.get("running_reads", 0) >= state["reads"]:
                return {"progress": 40, "startedon": "2026-01-05T10:00:00Z", "completedon": None, "data": ""}
            return {"progress": 100, "startedon": "2026-01-05T10:00:00Z",
                    "completedon": "2026-01-05T10:06:30Z", "data": state.get("xml", ok_xml)}
        t.on("GET", "importjobs(" + JOB, one)
        t.on("GET", "solutions?", lambda u, b: {"value": [{"solutionid": SOL}]})
        t.on("GET", "solutioncomponents?", lambda u, b: {"value": [
            {"objectid": "33333333-0000-0000-0000-000000000001"},
            {"objectid": "33333333-0000-0000-0000-000000000002"}]})
        t.on("GET", "workflows(33333333-0000-0000-0000-000000000001", lambda u, b: {
            "name": "Order reminder", "statecode": 1, "category": 5})
        t.on("GET", "workflows(33333333-0000-0000-0000-000000000002", lambda u, b: {
            "name": "Vendor sync", "statecode": state.get("flow2", 1), "category": 5})
        return t

    def go(state, *args):
        t = fake(state)
        dv = dataverse("https://example.invalid", "fixture", read_only=True, transport=t, sleep=lambda s: None)
        a = parse(["--solution", "app_orders"] + list(args))
        clock = {"t": 0.0}

        def now():
            return clock["t"]

        def sleep(s):
            clock["t"] += s
        try:
            rc, res = run(dv, a, now=now, sleep=sleep)
        except CannotRun as e:
            rc, res = 2, {"error": str(e)}
        return rc, res, t

    c, f = summarise_data(bad_xml)
    check("the data XML is read for per-component results", c.get("failure") == 1 and c.get("success") == 2
          and f[0][1] == "Missing dependency")
    rc, res, t = go({})
    check("a completed, clean import with flows on exits 0", rc == 0 and res["state"] == "success")
    check("the time on the server is reported", abs((res["minutes"] or 0) - 6.5) < 0.01)
    check("every call is a GET", t.calls and not t.writes())
    rc, res, _ = go({"xml": bad_xml})
    check("a failed component exits 1 and names it", rc == 1 and res["failures"][0][0] == "0x80048d19")
    rc, res, _ = go({"flow2": 0})
    check("a flow left in Draft after a clean import exits 4", rc == 4)
    rc, _, _ = go({"flow2": 0}, "--flows-off-ok", "vendor sync")
    check("--flows-off-ok accepts a flow meant to be off", rc == 0)
    rc, _, _ = go({"flow2": 0}, "--no-flows")
    check("--no-flows skips the flow check", rc == 0)
    rc, res, _ = go({"running_reads": 2}, "--wait", "600", "--poll", "20")
    check("--wait polls a running job until it completes", rc == 0 and res["state"] == "success")
    rc, res, _ = go({"running_reads": 999}, "--wait", "60", "--poll", "20")
    check("a job still running when --wait ends exits 3", rc == 3)
    rc, res, _ = go({}, "--since", "2026-01-05T11:00:00Z")
    check("a job older than --since is not taken as this import's", rc == 2 and "no import job" in res["error"])

    print("selftest: %s" % ("PASSED" if not failures else "FAILED (%d)" % len(failures)))
    return 0 if not failures else 1


def parse(argv):
    ap = argparse.ArgumentParser(prog="import-watch.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("--solution")
    ap.add_argument("--since")
    ap.add_argument("--wait", type=int, default=0)
    ap.add_argument("--poll", type=int, default=20)
    ap.add_argument("--org")
    ap.add_argument("--config")
    ap.add_argument("--no-flows", action="store_true")
    ap.add_argument("--flows-off-ok")
    ap.add_argument("--token-cmd")
    ap.add_argument("--token-env", default="DATAVERSE_TOKEN")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    return ap.parse_args(argv)


def main(argv=None):
    a = parse(argv if argv is not None else sys.argv[1:])
    if a.selftest:
        return selftest()
    if not a.solution:
        print("usage: import-watch.py --solution <uniquename> [--since ISO] [--wait SECONDS]")
        return 2
    try:
        cfg = load_config(a.config)
        org = a.org or cfg.get("environmentUrl")
        if not org:
            raise CannotRun("no environment URL: pass --org or set environmentUrl in scripts/canvas-app.json")
        token = get_token(org, a.token_cmd or cfg.get("dataverseTokenCommand"), a.token_env, org)[0]
        dv = dataverse(org, token, read_only=True)
        rc, res = run(dv, a)
    except (CannotRun, ApiError, ValueError) as e:
        print("cannot run: %s" % e)
        return 2
    if a.json:
        print(json.dumps(res, default=str))
    return rc


if __name__ == "__main__":
    sys.exit(main())
