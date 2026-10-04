#!/usr/bin/env python3
"""deploy-flows.py - put solution-aware cloud flows into a solution from JSON files in the repo,
with their connection references, idempotently; then (optionally) turn them on and prove it.

    connection references (this build's own) -> one workflow row per flow file, created or updated
    by name -> activate (the server-side compile) -> read the state back

Usage:
    python deploy-flows.py --manifest flows.json                 plan: what it would do (no writes)
    python deploy-flows.py --manifest flows.json --apply         write, leave flows as they were
    python deploy-flows.py --manifest flows.json --apply --activate
    python deploy-flows.py --manifest flows.json connections --env ENV_ID
                                                                 list the signed-in person's
                                                                 connections per API, and which are
                                                                 already bound by another solution

The manifest (assets/templates/flows.example.json):
    {
      "org": "https://yourorg.crm.dynamics.com",
      "solution": "AppSolution",
      "prefix": "app",
      "connectionReferences": [
        { "logicalName": "app_sharedoffice365", "api": "shared_office365", "connection": "<connection id>" },
        { "logicalName": "app_sharedapprovals", "api": "shared_approvals", "connection": "<connection id>" }
      ],
      "flows": [
        { "name": "APP Loan Approval", "file": "flows/app-loan-approval.json", "activate": true },
        { "name": "APP Overdue Digest", "file": "flows/app-overdue-digest.json", "activate": true }
      ]
    }

A flow file is the solution format: {"properties": {"definition": ..., "connectionReferences": {
"<key>": {"connection": {"connectionReferenceLogicalName": "app_..."}, "api": {"name": "shared_..."}}}}}.

Rules it enforces (each one a defect seen in a real build):
  - Connection references carry this build's prefix. A connection already bound by a connection
    reference OUTSIDE this prefix belongs to another build or solution: the run refuses it unless
    --allow-shared-connection. Make a connection of your own (the person signs in once per API).
  - Every connectionReferenceLogicalName a flow uses must be declared in the manifest.
  - Before any write, lint-flows.mjs runs over the flow files when node is available (self-trigger
    loops, sends to anyone but the owner, date-only traps). Errors stop the run; --skip-lint skips.
  - An active flow is turned off before its definition is updated, and back on only with --activate.
  - Activation refused by the server is reported with the server's reason, and the run exits 1.
  - Nothing is ever deleted.

Options:
    --org URL           environment URL (or "org" in the manifest)
    --token-cmd CMD     command printing a Dataverse token ("{org}" / "{resource}" replaced)
    --token-env NAME    variable holding a Dataverse token (default DATAVERSE_TOKEN)
    --pa-token-cmd CMD  connections: command printing a token for https://service.powerapps.com/
    --only NAME         deploy only this flow (repeatable)
    --selftest          offline tests against a simulated Web API

Exit: 0 applied/planned (and every requested flow is on); 1 a refusal, a lint error or an activation
refused; 2 cannot run (manifest error, no token, API error).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _ppapi import (ApiError, Client, FakeTransport, PlanRefused, RESOURCES, dataverse,  # noqa: E402
                    get_token, odata_literal)

HERE = os.path.dirname(os.path.abspath(__file__))


class ManifestError(Exception):
    pass


def load(path):
    try:
        with open(path, encoding="utf-8-sig") as f:
            m = json.load(f)
    except (OSError, ValueError) as e:
        raise ManifestError("cannot read %s: %s" % (path, e))
    root = os.path.dirname(os.path.abspath(path))
    errs = []
    prefix = m.get("prefix") or ""
    if not prefix or not m.get("solution"):
        errs.append("prefix and solution are required")
    declared = {}
    for r in m.get("connectionReferences") or []:
        ln = r.get("logicalName", "")
        if not ln.startswith(prefix + "_"):
            errs.append("connection reference %r must start with %s_" % (ln, prefix))
        if not r.get("api"):
            errs.append("connection reference %r: api is required" % ln)
        declared[ln] = r
    flows = []
    for f in m.get("flows") or []:
        p = os.path.join(root, f.get("file", ""))
        try:
            with open(p, encoding="utf-8-sig") as fh:
                body = json.load(fh)
        except (OSError, ValueError) as e:
            errs.append("flow %r: cannot read %s: %s" % (f.get("name"), f.get("file"), e))
            continue
        props = body.get("properties") or {}
        if "definition" not in props:
            errs.append("flow %r: not a solution flow file (properties.definition missing)" % f.get("name"))
        for key, ref in (props.get("connectionReferences") or {}).items():
            ln = ((ref or {}).get("connection") or {}).get("connectionReferenceLogicalName")
            if ln not in declared:
                errs.append("flow %r uses connection reference %r (key %s) that the manifest does not declare"
                            % (f.get("name"), ln, key))
        flows.append(dict(f, path=p, clientdata=json.dumps(body)))
    if errs:
        raise ManifestError("\n  ".join(errs))
    m["_flows"], m["_root"] = flows, root
    return m


def lint(paths):
    node = shutil.which("node")
    if not node:
        print("lint: node not on PATH - lint-flows.mjs skipped (run it before shipping)")
        return 0
    r = subprocess.run([node, os.path.join(HERE, "lint-flows.mjs")] + paths, capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip()
    if out:
        print("\n".join("lint: " + ln for ln in out.splitlines()[-25:]))
    return r.returncode


def shared_by_others(dv, prefix, connection_id):
    rows = dv.get("connectionreferences?$select=connectionreferencelogicalname&$filter=connectionid eq %s"
                  % odata_literal(connection_id)) or {}
    return sorted(r["connectionreferencelogicalname"] for r in rows.get("value") or []
                  if not r["connectionreferencelogicalname"].startswith(prefix + "_"))


def step_connrefs(dv, m, apply, allow_shared):
    hdr = {"MSCRM.SolutionUniqueName": m["solution"]}
    bad = 0
    for r in m.get("connectionReferences") or []:
        ln, conn = r["logicalName"], r.get("connection")
        found = (dv.get("connectionreferences?$select=connectionreferenceid,connectionid&$filter="
                        "connectionreferencelogicalname eq %s" % odata_literal(ln)) or {}).get("value") or []
        if conn:
            others = shared_by_others(dv, m["prefix"], conn)
            if others and not allow_shared:
                print("REFUSED %s: connection %s is already bound by %s (another build or solution). Create a "
                      "connection of your own for %s, or pass --allow-shared-connection" % (ln, conn, ", ".join(others), r["api"]))
                bad += 1
                continue
        elif apply:
            print("REFUSED %s: no connection id in the manifest (list them with the connections command)" % ln)
            bad += 1
            continue
        if found:
            if conn and found[0].get("connectionid") != conn:
                if apply:
                    dv.call("PATCH", "connectionreferences(%s)" % found[0]["connectionreferenceid"],
                            {"connectionid": conn}, headers=hdr)
                print("%s connection reference %s -> %s" % ("rebound" if apply else "would rebind", ln, conn))
            else:
                print("ok connection reference %s" % ln)
            continue
        body = {"connectionreferencelogicalname": ln, "connectionreferencedisplayname": r.get("displayName") or ln,
                "connectorid": "/providers/Microsoft.PowerApps/apis/%s" % r["api"]}
        if conn:
            body["connectionid"] = conn
        if apply:
            dv.call("POST", "connectionreferences", body, headers=hdr)
        print("%s connection reference %s (%s)" % ("created" if apply else "would create", ln, r["api"]))
    return bad


def step_flow(dv, m, f, apply):
    hdr = {"MSCRM.SolutionUniqueName": m["solution"]}
    found = (dv.get("workflows?$select=workflowid,statecode,clientdata&$filter=category eq 5 and name eq %s"
                    % odata_literal(f["name"])) or {}).get("value") or []
    if found:
        wid, on = found[0]["workflowid"], found[0].get("statecode") == 1
        same = _same_json(found[0].get("clientdata"), f["clientdata"])
        if same:
            print("ok flow %r (definition unchanged)" % f["name"])
            return wid
        if not apply:
            print("would update flow %r%s" % (f["name"], " (turned off first: it is on)" if on else ""))
            return wid
        if on:
            dv.call("PATCH", "workflows(%s)" % wid, {"statecode": 0, "statuscode": 1})
        dv.call("PATCH", "workflows(%s)" % wid, {"clientdata": f["clientdata"]}, headers=hdr)
        print("updated flow %r %s" % (f["name"], wid))
        return wid
    if not apply:
        print("would create flow %r from %s" % (f["name"], f["file"]))
        return None
    _, _, body = dv.call("POST", "workflows", {"name": f["name"], "category": 5, "type": 1, "primaryentity": "none",
                                               "clientdata": f["clientdata"], "statecode": 0, "statuscode": 1},
                         headers=dict(hdr, Prefer="return=representation"))
    print("created flow %r %s" % (f["name"], body["workflowid"]))
    return body["workflowid"]


def _same_json(a, b):
    try:
        return json.loads(a or "null") == json.loads(b or "null")
    except ValueError:
        return False


def activate(dv, wid, name):
    try:
        dv.call("PATCH", "workflows(%s)" % wid, {"statecode": 1, "statuscode": 2})
    except ApiError as e:
        print("ACTIVATION REFUSED %r: %s" % (name, e))
    st = (dv.get("workflows(%s)?$select=statecode" % wid) or {}).get("statecode")
    print("state %r %s" % (name, "ON" if st == 1 else "OFF"))
    return st == 1


def cmd_connections(dv, pa, m, env):
    apis = sorted({r["api"] for r in m.get("connectionReferences") or []})
    for api in apis:
        rows = pa.get_all("providers/Microsoft.PowerApps/apis/%s/connections?api-version=2016-11-01&$filter="
                          "environment eq %s" % (api, odata_literal(env)))
        print(api)
        for c in rows:
            props = c.get("properties") or {}
            st = ",".join(s.get("status", "") for s in props.get("statuses") or []) or "?"
            others = shared_by_others(dv, m["prefix"], c["name"])
            print("  %-48s %-30s %-10s%s" % (c["name"], props.get("displayName", ""), st,
                                             ("  bound by " + ", ".join(others)) if others else ""))
        if not rows:
            print("  (none: the person creates one in the maker portal, Connections > New connection)")
    return 0


def run(argv, transport=None):
    ap = argparse.ArgumentParser(prog="deploy-flows.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("command", nargs="?", choices=["deploy", "connections"], default="deploy")
    ap.add_argument("--manifest")
    ap.add_argument("--org")
    ap.add_argument("--env")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--activate", action="store_true")
    ap.add_argument("--only", action="append")
    ap.add_argument("--allow-shared-connection", action="store_true")
    ap.add_argument("--skip-lint", action="store_true")
    ap.add_argument("--token-cmd")
    ap.add_argument("--token-env", default="DATAVERSE_TOKEN")
    ap.add_argument("--pa-token-cmd")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.manifest:
        ap.print_help()
        return 2
    try:
        m = load(a.manifest)
    except ManifestError as e:
        print("manifest error:\n  %s" % e)
        return 2
    org = a.org or m.get("org")
    if not org:
        print("pass --org or set \"org\" in the manifest")
        return 2
    try:
        token = "fixture" if transport else get_token(org, a.token_cmd, a.token_env, org)[0]
        dv = dataverse(org, token, read_only=not a.apply, transport=transport, sleep=(lambda s: None) if transport else None)
        if a.command == "connections":
            if not a.env:
                print("connections needs --env <environment id>")
                return 2
            pat = "fixture" if transport else get_token(RESOURCES["powerapps"], a.pa_token_cmd, "POWERAPPS_TOKEN")[0]
            pa = Client("https://api.powerapps.com/", pat, read_only=True, transport=transport)
            return cmd_connections(dv, pa, m, a.env)
        flows = [f for f in m["_flows"] if not a.only or f["name"] in a.only]
        if a.apply and not a.skip_lint and lint([f["path"] for f in flows]) == 1:
            print("lint errors: nothing was written (fix them, or --skip-lint with a reason)")
            return 1
        bad = step_connrefs(dv, m, a.apply, a.allow_shared_connection)
        if bad and a.apply:
            print("refused: no flow was written")
            return 1
        ok = True
        for f in flows:
            wid = step_flow(dv, m, f, a.apply)
            if a.activate and f.get("activate", True):
                if a.apply and wid:
                    ok &= activate(dv, wid, f["name"])
                elif not a.apply:
                    print("would turn on %r" % f["name"])
        if not a.apply:
            print("plan only: nothing was written. Re-run with --apply%s." % (" --activate" if a.activate else ""))
        return 1 if (bad or not ok) else 0
    except PlanRefused as e:
        print("BUG: %s" % e)
        return 2
    except ApiError as e:
        print("cannot run: %s" % e)
        return 2


# --------------------------------------------------------------------------- selftest

def selftest():
    import io
    import tempfile
    failures = []

    def check(name, cond):
        print("  %s  %s" % ("ok  " if cond else "FAIL", name))
        if not cond:
            failures.append(name)

    def fake():
        st = {"refs": [{"connectionreferenceid": "r-other", "connectionreferencelogicalname": "zzz_sharedapprovals",
                        "connectionid": "conn-taken"}], "flows": [], "refuse": False}
        t = FakeTransport()

        def refs_get(u, b):
            rows = st["refs"]
            if "connectionreferencelogicalname eq '" in u:
                ln = u.split("connectionreferencelogicalname eq '")[1].split("'")[0]
                rows = [r for r in rows if r["connectionreferencelogicalname"] == ln]
            if "connectionid eq '" in u:
                cid = u.split("connectionid eq '")[1].split("'")[0]
                rows = [r for r in rows if r.get("connectionid") == cid]
            return {"value": rows}
        t.on("GET", "/connectionreferences", refs_get)

        def refs_post(u, b):
            st["refs"].append(dict(b, connectionreferenceid="r-%d" % len(st["refs"])))
            return 204, {}, None
        t.on("POST", "/connectionreferences", refs_post)
        t.on("PATCH", "/connectionreferences(", lambda u, b: (204, {}, None))

        def wf_get(u, b):
            if "workflows(" in u:
                wid = u.split("workflows(")[1].split(")")[0]
                return next(f for f in st["flows"] if f["workflowid"] == wid)
            name = u.split("name eq '")[1].split("'")[0]
            return {"value": [f for f in st["flows"] if f["name"] == name]}
        t.on("GET", "/workflows", wf_get)

        def wf_post(u, b):
            f = dict(b, workflowid="w-%d" % (len(st["flows"]) + 1))
            st["flows"].append(f)
            return 201, {}, f
        t.on("POST", "/workflows", wf_post)

        def wf_patch(u, b):
            wid = u.split("workflows(")[1].split(")")[0]
            f = next(x for x in st["flows"] if x["workflowid"] == wid)
            if b.get("statecode") == 1 and st["refuse"]:
                return 400, {}, {"error": {"message": "Flow client error: connection not authorized"}}
            f.update(b)
            return 204, {}, None
        t.on("PATCH", "/workflows(", wf_patch)
        t.on("GET", "api.powerapps.com", lambda u, b: {"value": [
            {"name": "conn-taken", "properties": {"displayName": "someone@example.com", "statuses": [{"status": "Connected"}]}},
            {"name": "conn-mine", "properties": {"displayName": "someone@example.com", "statuses": [{"status": "Connected"}]}}]})
        return t, st

    tmp = tempfile.mkdtemp(prefix="deploy-flows-selftest-")
    flow = {"properties": {"definition": {"triggers": {}, "actions": {}},
                           "connectionReferences": {"shared_approvals": {
                               "connection": {"connectionReferenceLogicalName": "app_sharedapprovals"},
                               "api": {"name": "shared_approvals"}}}}, "schemaVersion": "1.0.0.0"}
    with open(os.path.join(tmp, "f.json"), "w") as fh:
        json.dump(flow, fh)
    man = {"org": "https://example.crm.dynamics.com", "solution": "AppSolution", "prefix": "app",
           "connectionReferences": [{"logicalName": "app_sharedapprovals", "api": "shared_approvals",
                                     "connection": "conn-mine"}],
           "flows": [{"name": "APP Approval", "file": "f.json"}]}

    def write_man(mm):
        p = os.path.join(tmp, "flows.json")
        with open(p, "w") as fh:
            json.dump(mm, fh)
        return p

    def go(t, *args):
        buf, old = io.StringIO(), sys.stdout
        sys.stdout = buf
        try:
            rc = run(list(args) + ["--skip-lint"], transport=t)
        finally:
            sys.stdout = old
        return rc, buf.getvalue()

    try:
        t, st = fake()
        p = write_man(man)
        rc, out = go(t, "--manifest", p, "--activate")
        check("plan exits 0 and writes nothing", rc == 0 and t.writes() == [])
        check("plan names the connection reference and the flow", "would create connection reference app_sharedapprovals" in out
              and "would create flow 'APP Approval'" in out and "would turn on" in out)
        rc, out = go(t, "--manifest", p, "--apply", "--activate")
        check("apply creates, activates and reads back ON", rc == 0 and "state 'APP Approval' ON" in out)
        check("the flow is created with the solution header", any(
            c[0] == "POST" and "/workflows" in c[1] and h.get("MSCRM.SolutionUniqueName") == "AppSolution"
            for c, h in zip(t.calls, t.headers)))
        n = len(t.writes())
        rc, out = go(t, "--manifest", p, "--apply")
        check("re-run with the same definition writes nothing", rc == 0 and len(t.writes()) == n
              and "definition unchanged" in out)
        flow["properties"]["definition"]["actions"] = {"Compose": {"type": "Compose", "inputs": 1}}
        with open(os.path.join(tmp, "f.json"), "w") as fh:
            json.dump(flow, fh)
        rc, out = go(t, "--manifest", p, "--apply")
        on_off = [b for m_, u, b in t.calls if m_ == "PATCH" and "workflows(" in u]
        check("an active flow is turned off before its update", on_off[-2] == {"statecode": 0, "statuscode": 1}
              and "clientdata" in on_off[-1])
        st["refuse"] = True
        rc, out = go(t, "--manifest", p, "--apply", "--activate")
        check("a refused activation exits 1 with the server's reason", rc == 1 and "connection not authorized" in out)

        t, st = fake()
        p = write_man(dict(man, connectionReferences=[dict(man["connectionReferences"][0], connection="conn-taken")]))
        rc, out = go(t, "--manifest", p, "--apply")
        check("a connection bound by another build is refused", rc == 1 and "zzz_sharedapprovals" in out)
        check("the refusal writes nothing", t.writes() == [])
        rc, out = go(t, "--manifest", p, "--apply", "--allow-shared-connection")
        check("--allow-shared-connection lets it through", rc == 0)

        t, _ = fake()
        p = write_man(dict(man, connectionReferences=[dict(man["connectionReferences"][0], logicalName="zzz_x")]))
        rc, out = go(t, "--manifest", p)
        check("an unprefixed connection reference is a manifest error", rc == 2 and "must start with app_" in out)
        check("so is a flow using an undeclared reference", "does not declare" in out)

        t, _ = fake()
        p = write_man(man)
        rc, out = go(t, "--manifest", p, "connections", "--env", "env-1")
        check("connections lists them and marks the one bound elsewhere",
              rc == 0 and "conn-mine" in out and "bound by zzz_sharedapprovals" in out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print()
    print("selftest: %s" % ("PASSED" if not failures else "FAILED %d: %s" % (len(failures), ", ".join(failures))))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(run(sys.argv[1:]))
