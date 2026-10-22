#!/usr/bin/env python3
"""run-flow.py - run a scheduled (Recurrence) cloud flow once, now, and prove what the run did.

After a flow definition is deployed, the proof is a run: activation only compiles it. A scheduled
flow will not run until its next tick, and Dataverse cannot start one (`flowrun` is read-only
history). This tool starts the run over the flow management API, waits for that run (not an
earlier one), and reports its status, its duration and, per action that changes something outside
the run, how many times it succeeded or was skipped - which is what tells a no-op run from one that
sent. A failed run is explained on the spot with flow-runs.py's `why`.

Usage:
    python run-flow.py "<flow>"                  plan: trigger, state, sends and writes found; runs nothing
    python run-flow.py "<flow>" --run            run it, wait, report (refused if the flow sends)
    python run-flow.py "<flow>" --run --send-ok  run a flow that sends: the person approved this run

<flow> is a flow id (the workflow's resourceid for a solution flow) or its display name (exact,
then a unique case-insensitive substring), resolved as flow-runs.py does.

Options:
    --trigger NAME      the trigger to fire when the definition has several
    --wait SECONDS      how long to wait for the run to finish (default 900)
    --max-chars N       passed to the failure explanation (default 800)
    --env, --config, --token-cmd, --token-env    as flow-runs.py
    --selftest          run the built-in tests against recorded, anonymised responses and exit

Refusals (exit 2, nothing started):
  - the flow is not Started (a stopped flow does not run; turn it on through the deploy, not here);
  - the trigger is not Recurrence: a Dataverse trigger is proved by making the same write the app
    makes on a test row, a manual or Power Apps trigger from its caller (power-automate.md 11);
  - the definition sends to people (email, Teams, approvals) and --send-ok was not given. Pass it
    only when the person has approved this run, and narrow recipients or switch the channels off
    first where the flow has settings for it.

Token: as flow-runs.py, held in memory only - never written to a file or printed.

Exit codes: 0 plan printed, or the run Succeeded; 1 the run Failed or was Cancelled (explained);
2 refused or cannot run; 3 the run was still going when --wait ran out (how to read it later is printed).
"""
import argparse
import contextlib
import importlib.util
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

_spec = importlib.util.spec_from_file_location(
    "flow_runs", os.path.join(os.path.dirname(os.path.abspath(__file__)), "flow-runs.py"))
fr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fr)

CannotRun = fr.CannotRun
# Operations that reach a person outside the run: running the flow sends these for real. Matched
# anywhere in the operation id - a shared-mailbox send is SharedMailboxSendEmailV2, which an anchored
# match read as a write (measured on a real definition).
SENDS = re.compile(r"(Send|Post|Reply|Forward|Invite|Approval|Notif|Mention)", re.I)
TERMINAL = {"Succeeded", "Failed", "Cancelled", "TimedOut", "Skipped"}


def _http_post(url, token):
    """POST with an empty body; returns the status code. Raises CannotRun on HTTP errors."""
    req = urllib.request.Request(url, data=b"", method="POST",
                                 headers={"Authorization": "Bearer " + token, "Content-Length": "0"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        if e.code in (401, 403):
            raise CannotRun("HTTP %d - this account cannot run the flow (a solution flow needs its owner or a "
                            "co-owner): %s" % (e.code, detail))
        raise CannotRun("HTTP %d starting the run: %s" % (e.code, detail))
    except urllib.error.URLError as e:
        raise CannotRun("network error starting the run: %s" % e.reason)


POST = _http_post            # the selftest replaces these three
SLEEP = time.sleep
NOW = lambda: datetime.now(timezone.utc)


def pick_trigger(definition, name):
    trig = (definition or {}).get("triggers") or {}
    if name:
        if name not in trig:
            raise CannotRun("no trigger %r; the definition has: %s" % (name, ", ".join(trig) or "none"))
        return name, trig[name]
    if len(trig) != 1:
        raise CannotRun("the definition has %d triggers (%s); pass --trigger" % (len(trig), ", ".join(trig)))
    return next(iter(trig.items()))


def effects(definition):
    """(sends, writes): [(action, operation, loop)] for actions that change something outside the run."""
    sends, writes = [], []
    for name, a in fr.action_map(definition).items():
        op = a.get("op")
        if not op:
            continue
        if SENDS.search(op):
            sends.append((name, op, a.get("loop")))
        elif fr.SIDE_EFFECT.match(op):
            writes.append((name, op, a.get("loop")))
    return sends, writes


def tally(fx, fid, run, items):
    """name -> {status: count}; actions inside a loop are counted per iteration."""
    acts = {x["name"]: x["properties"] for x in fx.paged("/flows/%s/runs/%s/actions" % (fid, run))}
    out = {}
    for name, op, loop in items:
        if loop:
            reps = fx.paged("/flows/%s/runs/%s/actions/%s/repetitions" % (fid, run, name))
            counts = {}
            for r in reps:
                s = r["properties"].get("status", "?")
                counts[s] = counts.get(s, 0) + 1
            out[name] = counts or {"not reached": 1}
        else:
            out[name] = {(acts.get(name) or {}).get("status", "not reached"): 1}
    return out


def fmt_counts(c):
    return ", ".join("%s %d" % (k, v) for k, v in sorted(c.items()))


def run(a):
    env = fr.load_env(a)
    token, how = fr.get_token(a.token_cmd, a.token_env)
    fx = fr.Flows(env, token)
    flow = fx.resolve(a.flow)
    fid, p = flow["name"], flow["properties"]
    definition = p.get("definition") or {}
    tname, trig = pick_trigger(definition, a.trigger)
    sends, writes = effects(definition)
    print("%s (%s)" % (p.get("displayName"), fid))
    print("  state    %s" % p.get("state"))
    print("  trigger  %s [%s]" % (tname, trig.get("type")))
    for label, items in (("sends", sends), ("writes", writes)):
        print("  %-8s %s" % (label, "; ".join("%s [%s]%s" % (n, op, " in " + lp if lp else "")
                                               for n, op, lp in items) or "none"))
    refusals = []
    if p.get("state") != "Started":
        refusals.append("the flow is %s; a stopped flow does not run. Turn it on through the deploy "
                        "(deploy-flows.py, or the import's state), then run this again" % p.get("state"))
    if trig.get("type") != "Recurrence":
        refusals.append("the trigger is %s, not Recurrence. Prove a Dataverse trigger by making the same write "
                        "the app makes on a test row, and a manual or Power Apps trigger from its caller "
                        "(power-automate.md section 11)" % trig.get("type"))
    if refusals:
        for r in refusals:
            print("REFUSED: " + r)
        return 2
    if sends and not a.send_ok:
        print("%s: the definition sends (%d action(s) above). Run it only with the person's approval of this "
              "run, recipients narrowed or channels off where the flow allows it, then add --send-ok"
              % ("REFUSED" if a.run else "NOTE", len(sends)))
        if a.run:
            return 2
    if not a.run:
        print("PLAN: nothing started. Add --run to run it now%s." % (" (sends approved)" if sends else ""))
        return 0

    before = {r["name"] for r in fx.paged("/flows/%s/runs" % fid, "$top=10", limit=10)}
    started = NOW()
    POST(fx.base + "/flows/%s/triggers/%s/run?%s" % (fid, tname, fr.API), token)
    print("STARTED at %s; waiting up to %d s for the new run" % (started.strftime("%H:%M:%S"), a.wait))
    deadline, step, mine = time.monotonic() + a.wait, 3, None
    while True:
        runs = fx.paged("/flows/%s/runs" % fid, "$top=10", limit=10)
        new = [r for r in runs if r["name"] not in before]
        if new:
            mine = new[-1] if len(new) > 1 else new[0]
            if mine["properties"].get("status") in TERMINAL:
                break
        if time.monotonic() >= deadline:
            print("STILL RUNNING: %s after %d s. Read it later: python flow-runs.py runs \"%s\""
                  % (mine["name"] if mine else "(no run seen yet)", a.wait, p.get("displayName")))
            return 3
        SLEEP(step)
        step = min(step * 2, 15)
    rp = mine["properties"]
    print("RUN %s  %s  %s" % (mine["name"], rp.get("status"), fr.seconds(rp)))
    if sends or writes:
        counts = tally(fx, fid, mine["name"], sends + writes)
        for n, op, lp in sends + writes:
            print("  %-6s %s [%s]: %s" % ("send" if (n, op, lp) in sends else "write", n, op, fmt_counts(counts[n])))
    if rp.get("status") == "Succeeded":
        return 0
    print()
    ns = argparse.Namespace(flow=fid, run=mine["name"], max_chars=a.max_chars)
    fr.cmd_why(fx, ns)
    return 1


def main(argv=None):
    ap = argparse.ArgumentParser(prog="run-flow.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("flow", nargs="?")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--send-ok", action="store_true")
    ap.add_argument("--trigger")
    ap.add_argument("--wait", type=int, default=900)
    ap.add_argument("--max-chars", type=int, default=800)
    ap.add_argument("--env")
    ap.add_argument("--config")
    ap.add_argument("--token-cmd")
    ap.add_argument("--token-env", default="FLOW_TOKEN")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.flow:
        ap.print_help()
        return 2
    try:
        return run(a)
    except CannotRun as e:
        print("cannot run: %s" % e)
        return 2


def selftest():
    """Recorded response shapes (names and values anonymised)."""
    global POST, SLEEP, NOW
    env, fid = "00000000-0000-0000-0000-00000000e000", "11111111-1111-1111-1111-111111111111"
    base = fr.BASE % env
    definition = {
        "triggers": {"Recurrence": {"type": "Recurrence", "recurrence": {"frequency": "Week", "interval": 1}}},
        "actions": {
            "List_orders": {"type": "OpenApiConnection", "inputs": {"host": {"operationId": "ListRecords"}}},
            "For_each_customer": {"type": "Foreach", "actions": {
                "Send_digest": {"type": "OpenApiConnection", "inputs": {"host": {"operationId": "SendEmailV2"}}},
                "Record_sent": {"type": "OpenApiConnection", "inputs": {"host": {"operationId": "CreateRecord"}}}}}}}
    mailbox = {"triggers": {"Weekly": {"type": "Recurrence"}},
               "actions": {"Send_to_admins": {"type": "OpenApiConnection",
                                              "inputs": {"host": {"operationId": "SharedMailboxSendEmailV2"}}}}}
    quiet = {"triggers": {"Recurrence": {"type": "Recurrence"}},
             "actions": {"Close_old": {"type": "OpenApiConnection",
                                       "inputs": {"host": {"operationId": "UpdateRecord"}}}}}
    flows = {
        fid: {"name": fid, "properties": {"displayName": "Order Weekly Digest", "state": "Started",
                                          "definition": definition}},
        "2" * 8 + "-2222-2222-2222-" + "2" * 12: {
            "name": "2" * 8 + "-2222-2222-2222-" + "2" * 12,
            "properties": {"displayName": "Order Cleanup", "state": "Started", "definition": quiet}},
        "3" * 8 + "-3333-3333-3333-" + "3" * 12: {
            "name": "3" * 8 + "-3333-3333-3333-" + "3" * 12,
            "properties": {"displayName": "Order Created Notice", "state": "Started", "definition": {
                "triggers": {"When_a_row_is_added": {"type": "OpenApiConnectionWebhook"}}, "actions": {}}}},
        "5" * 8 + "-5555-5555-5555-" + "5" * 12: {
            "name": "5" * 8 + "-5555-5555-5555-" + "5" * 12,
            "properties": {"displayName": "Admin Mailbox Digest", "state": "Started", "definition": mailbox}},
        "4" * 8 + "-4444-4444-4444-" + "4" * 12: {
            "name": "4" * 8 + "-4444-4444-4444-" + "4" * 12,
            "properties": {"displayName": "Order Archive", "state": "Stopped", "definition": quiet}},
    }
    st = {"calls": [], "posts": [], "polls": 0, "final": "Succeeded", "send_status": "Skipped", "appear": 2}
    old_run = {"name": "0858OLD", "properties": {"status": "Failed", "startTime": "2026-01-01T06:00:00Z",
                                                 "endTime": "2026-01-01T06:00:09Z"}}

    def new_run():
        status = st["final"] if st["polls"] > st["appear"] else "Running"
        return {"name": "0858NEW", "properties": {"status": status, "startTime": "2026-01-02T10:00:01Z",
                                                  "endTime": "2026-01-02T10:00:31Z",
                                                  "error": {"code": "ActionFailed", "message": fr.GENERIC}}}

    def fake(url, token):
        st["calls"].append(url)
        assert token == "fixture-token", "API call without the token"
        path = url[len(base):].split("?")[0]
        if path == "/flows":
            return {"value": [{"name": k, "properties": {"displayName": v["properties"]["displayName"]}}
                              for k, v in flows.items()]}
        m = re.match(r"^/flows/([^/]+)$", path)
        if m:
            return flows[m.group(1)]
        m = re.match(r"^/flows/([^/]+)/runs$", path)
        if m:
            if not st["posts"]:
                return {"value": [old_run]}
            st["polls"] += 1
            return {"value": ([new_run()] if st["polls"] > 1 else []) + [old_run]}
        if path.endswith("/runs/0858NEW"):
            return new_run()
        if path.endswith("/runs/0858NEW/actions"):
            return {"value": [
                {"name": "List_orders", "properties": {"status": "Succeeded"}},
                {"name": "For_each_customer", "properties": {"status": "Succeeded" if st["final"] == "Succeeded"
                                                             else "Failed", "error": None}},
                {"name": "Send_digest", "properties": {"status": "Succeeded"}},
                {"name": "Record_sent", "properties": {"status": "Succeeded" if st["final"] == "Succeeded"
                                                       else "Failed"}},
                {"name": "Close_old", "properties": {"status": "Succeeded"}}]}
        m = re.match(r".*/runs/0858NEW/actions/([^/]+)/repetitions$", path)
        if m:
            if m.group(1) == "Send_digest":
                return {"value": [{"name": "000000", "properties": {"status": st["send_status"]}}] * 3}
            err = {"code": "BadRequest", "message": "Record_sent: the column 'sentdate' does not exist"}
            return {"value": [{"name": "000000", "properties": {
                "status": "Failed" if st["final"] != "Succeeded" else "Succeeded",
                "error": err if st["final"] != "Succeeded" else None,
                "repetitionIndexes": [{"scopeName": "For_each_customer", "itemIndex": 0}]}}] * 3}
        raise CannotRun("unexpected call %s" % path)

    def fake_post(url, token):
        assert token == "fixture-token"
        st["posts"].append(url)
        return 202

    results = []

    def check(name, ok):
        results.append(ok)
        print("%s  %s" % ("ok  " if ok else "FAIL", name))

    saved = (fr.FETCH, POST, SLEEP, NOW)
    fr.FETCH, POST, SLEEP = fake, fake_post, (lambda s: None)
    NOW = lambda: datetime(2026, 1, 2, 10, 0, 0, tzinfo=timezone.utc)
    os.environ["RUN_FLOW_SELFTEST_TOKEN"] = "fixture-token"

    def go(args):
        st.update(calls=[], posts=[], polls=0)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = main(args + ["--env", env, "--token-env", "RUN_FLOW_SELFTEST_TOKEN"])
        return rc, buf.getvalue()

    try:
        rc, out = go(["Weekly Digest"])
        check("plan on a sending flow exits 0, starts nothing, and names the send in its loop",
              rc == 0 and not st["posts"] and "Send_digest [SendEmailV2] in For_each_customer" in out
              and "--send-ok" in out)
        check("a read (ListRecords) is neither a send nor a write", "List_orders" not in out)
        rc, out = go(["Admin Mailbox", "--run"])
        check("a shared-mailbox send (SharedMailboxSendEmailV2) is a send: refused without --send-ok",
              rc == 2 and not st["posts"] and "Send_to_admins [SharedMailboxSendEmailV2]" in out.split("writes")[0])
        rc, out = go(["Weekly Digest", "--run"])
        check("--run on a sending flow without --send-ok is refused with exit 2, nothing started",
              rc == 2 and not st["posts"] and "REFUSED" in out)
        rc, out = go(["Order Created", "--run", "--send-ok"])
        check("a Dataverse-triggered flow is refused (prove it with a test-row write)",
              rc == 2 and not st["posts"] and "not Recurrence" in out)
        rc, out = go(["Order Archive", "--run"])
        check("a stopped flow is refused", rc == 2 and not st["posts"] and "Stopped" in out)
        st.update(final="Succeeded", send_status="Skipped")
        rc, out = go(["Weekly Digest", "--run", "--send-ok"])
        check("an approved run posts the trigger's run endpoint once",
              len(st["posts"]) == 1 and st["posts"][0].startswith(base + "/flows/%s/triggers/Recurrence/run?" % fid))
        check("it waits for the NEW run, not the earlier failed one, and reports it",
              rc == 0 and "RUN 0858NEW  Succeeded  30.0 s" in out and "0858OLD" not in out)
        check("sends inside the loop are counted per iteration (a no-op run reads Skipped 3)",
              "send   Send_digest [SendEmailV2]: Skipped 3" in out)
        check("the token is never printed", "fixture-token" not in out)
        rc, out = go(["Order Cleanup", "--run"])
        check("a flow that only writes runs without --send-ok and reports the write",
              rc == 0 and len(st["posts"]) == 1 and "write  Close_old [UpdateRecord]: Succeeded 1" in out)
        st.update(final="Failed", send_status="Succeeded")
        rc, out = go(["Weekly Digest", "--run", "--send-ok"])
        check("a failed run exits 1 and is explained to its root cause",
              rc == 1 and "ROOT CAUSE  Record_sent" in out and "sentdate" in out)
        check("a failed run still shows what was sent before it failed", "Send_digest [SendEmailV2]: Succeeded 3" in out)
        st.update(final="Succeeded", appear=10 ** 6)
        rc, out = go(["Weekly Digest", "--run", "--send-ok", "--wait", "0"])
        check("a run not finished when --wait runs out exits 3 and says how to read it later",
              rc == 3 and "STILL RUNNING" in out and "flow-runs.py runs" in out)
        st.update(appear=2)
        rc, out = go(["Weekly Digest", "--trigger", "Daily"])
        check("an unknown --trigger is refused with exit 2", rc == 2 and "no trigger 'Daily'" in out)
        del os.environ["RUN_FLOW_SELFTEST_TOKEN"]
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = main(["Weekly Digest", "--env", env, "--token-env", "RUN_FLOW_SELFTEST_TOKEN",
                       "--token-cmd", "exit 3"])
        check("a failing token command exits 2 with no API call", rc == 2)
    finally:
        fr.FETCH, POST, SLEEP, NOW = saved
        os.environ.pop("RUN_FLOW_SELFTEST_TOKEN", None)
    print("%d/%d passed" % (sum(results), len(results)))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
