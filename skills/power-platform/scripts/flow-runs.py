#!/usr/bin/env python3
"""flow-runs.py - read Power Automate cloud flow runs and explain a failed one. Read only.

A failed run's headline error is almost never the cause. The run, the Dataverse `flowrun` row and
every container on the failure path all say "ActionFailed: An action failed. No dependent actions
succeeded." The real error sits on one action, and when that action is inside a loop it is not in
the run's action list at all: it is only on the failing ITERATION, read from the action's
repetitions. This tool walks there, prints the error with the inputs and outputs that produced
it, and lists the side effects (sends, creates, updates) that already happened in the run - the
things a resubmit would do a second time.

Usage:
    python flow-runs.py list                       flows in the environment, with state
    python flow-runs.py runs <flow> [--status S]   recent runs (S: Failed, Succeeded, Running, ...)
    python flow-runs.py why <flow> [<run>]         explain <run>, or the latest failed run

<flow> is a flow id (the workflow's resourceid for a solution flow) or its display name (exact,
then a unique case-insensitive substring).

Options:
    --env ID            environment id (default: "environmentId" in scripts/canvas-app.json)
    --config PATH       identity config (default: ./scripts/canvas-app.json if present)
    --top N             runs to list (default 20)
    --max-chars N       trim each inputs/outputs body to N characters (default 800; 0 = omit them)
    --token-cmd CMD     command that prints a token for https://service.flow.microsoft.com/
    --token-env NAME    environment variable holding that token (default: FLOW_TOKEN)
    --selftest          run the built-in tests against recorded, anonymised responses and exit

Token, in order: --token-env variable, --token-cmd, `az account get-access-token --resource
https://service.flow.microsoft.com/`, then Az PowerShell `Get-AzAccessToken`. The token is never
printed. Inputs and outputs links are pre-signed URLs and are fetched WITHOUT the token.

It never resubmits, cancels, turns on or off, or edits a flow. Resubmitting is a deliberate step
for a person, after reading the side-effects list this prints.

Exit codes: 0 nothing failed (list, runs, or why with no failed run in range); 1 a failed run was
explained (a finding); 2 cannot run (no token, no environment, flow not found, API error).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

AUDIENCE = "https://service.flow.microsoft.com/"
BASE = "https://api.flow.microsoft.com/providers/Microsoft.ProcessSimple/environments/%s"
API = "api-version=2016-11-01"
GENERIC = "An action failed. No dependent actions succeeded."
# Operations whose success changes something outside the run: a resubmit repeats them.
SIDE_EFFECT = re.compile(r"^(Send|Post|Create|Update|Upsert|Delete|Perform|Add|Remove|Start|Reply|"
                         r"Forward|Move|Copy|Patch|Assign|Approve|Set|Invite|Publish|Share|Upload|Run)",
                         re.I)


class CannotRun(Exception):
    pass


# --------------------------------------------------------------------------- transport
def _http_get(url, token=None):
    """GET url; returns parsed JSON (or text). Raises CannotRun on HTTP errors."""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            body = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        if e.code in (401, 403):
            raise CannotRun("HTTP %d - the token is not valid for %s, or this account cannot read "
                            "the flow (shared flows need co-owner): %s" % (e.code, AUDIENCE, detail))
        raise CannotRun("HTTP %d on %s: %s" % (e.code, url.split("?")[0], detail))
    except urllib.error.URLError as e:
        raise CannotRun("network error on %s: %s" % (url.split("?")[0], e.reason))
    try:
        return json.loads(body)
    except ValueError:
        return body


FETCH = _http_get   # the selftest replaces this


def get_token(token_cmd=None, token_env="FLOW_TOKEN"):
    if token_env and os.environ.get(token_env):
        return os.environ[token_env].strip(), "environment variable %s" % token_env
    tried = []

    def run(cmd, shell=False):
        p = subprocess.run(cmd, shell=shell, capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=180)
        return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()

    if token_cmd:
        rc, out, err = run(token_cmd, shell=True)
        if rc == 0 and out:
            return out.splitlines()[-1].strip(), "--token-cmd"
        raise CannotRun("--token-cmd failed (exit %d): %s" % (rc, err[-300:]))
    az = shutil.which("az")
    if az:
        rc, out, err = run([az, "account", "get-access-token", "--resource", AUDIENCE,
                            "--query", "accessToken", "-o", "tsv"])
        if rc == 0 and out:
            return out.splitlines()[-1].strip(), "az account get-access-token"
        tried.append("az (exit %d)" % rc)
    else:
        tried.append("az (not on PATH)")
    ps = shutil.which("pwsh") or shutil.which("powershell")
    if ps:
        script = ("$ErrorActionPreference='Stop'; $t=(Get-AzAccessToken -ResourceUrl '%s').Token; "
                  "if ($t -is [securestring]) { [System.Net.NetworkCredential]::new('', $t).Password } "
                  "else { $t }" % AUDIENCE)
        rc, out, err = run([ps, "-NoProfile", "-NonInteractive", "-Command", script])
        if rc == 0 and out:
            return out.splitlines()[-1].strip(), "Az PowerShell Get-AzAccessToken"
        tried.append("Az PowerShell (exit %d)" % rc)
    raise CannotRun("no token for %s: tried %s. Sign in (az login, or Connect-AzAccount after "
                    "Update-AzConfig -EnableLoginByWam $false) or pass --token-cmd / set %s"
                    % (AUDIENCE, "; ".join(tried), token_env))


class Flows:
    def __init__(self, env, token):
        self.base = BASE % env
        self.token = token

    def get(self, path, query=""):
        sep = "&" if "?" in path else "?"
        return FETCH(self.base + path + sep + API + (("&" + query) if query else ""), self.token)

    def paged(self, path, query="", limit=None):
        d = self.get(path, query)
        out = list(d.get("value", []))
        while d.get("nextLink") and (limit is None or len(out) < limit):
            d = FETCH(d["nextLink"], self.token)
            out.extend(d.get("value", []))
        return out[:limit] if limit else out

    def flows(self):
        return self.paged("/flows")

    def resolve(self, ident):
        if re.fullmatch(r"[0-9a-fA-F-]{36}", ident or ""):
            return self.get("/flows/%s" % ident)
        fl = self.flows()
        exact = [f for f in fl if f["properties"].get("displayName", "").lower() == ident.lower()]
        if len(exact) == 1:
            return self.get("/flows/%s" % exact[0]["name"])
        part = [f for f in fl if ident.lower() in f["properties"].get("displayName", "").lower()]
        if len(part) == 1:
            return self.get("/flows/%s" % part[0]["name"])
        names = ", ".join(sorted(f["properties"].get("displayName", "") for f in (exact or part)))
        raise CannotRun("flow %r %s" % (ident, ("matches several: " + names) if (exact or part)
                                        else "not found (run `list`)"))


# --------------------------------------------------------------------------- definition map
def action_map(definition):
    """name -> {type, op, parent, loop} for every action, nested ones included."""
    out = {}

    def walk(acts, parent, loop):
        for name, a in (acts or {}).items():
            inp = a.get("inputs") if isinstance(a.get("inputs"), dict) else {}
            host = inp.get("host") if isinstance(inp.get("host"), dict) else {}
            op = host.get("operationId") or (inp.get("method") if a.get("type") == "Http" else None)
            out[name] = {"type": a.get("type"), "op": op, "parent": parent, "loop": loop}
            inner_loop = name if a.get("type") in ("Foreach", "Until") else loop
            walk(a.get("actions"), name, inner_loop)
            if isinstance(a.get("else"), dict):
                walk(a["else"].get("actions"), name, inner_loop)
            for c in (a.get("cases") or {}).values():
                walk(c.get("actions"), name, inner_loop)
            if isinstance(a.get("default"), dict):
                walk(a["default"].get("actions"), name, inner_loop)
    walk((definition or {}).get("actions"), None, None)
    return out


def is_generic(err):
    return not err or (err.get("code") == "ActionFailed" and GENERIC in (err.get("message") or ""))


def fmt_err(err):
    if not err:
        return "(no error recorded)"
    return "%s: %s" % (err.get("code"), re.sub(r"\s+", " ", err.get("message") or "")[:600])


def link_body(props, key, max_chars):
    link = (props.get(key) or {}).get("uri")
    if not link or max_chars <= 0:
        return None
    try:
        body = FETCH(link, None)   # pre-signed: never send the bearer token
    except CannotRun as e:
        return "(could not read %s: %s)" % (key, e)
    text = json.dumps(body, ensure_ascii=False) if not isinstance(body, str) else body
    return text if len(text) <= max_chars else text[:max_chars] + " ... (%d chars)" % len(text)


def seconds(p):
    from datetime import datetime
    try:
        a = datetime.fromisoformat(p["startTime"][:26].rstrip("Z"))
        b = datetime.fromisoformat(p["endTime"][:26].rstrip("Z"))
        return "%.1f s" % (b - a).total_seconds()
    except (KeyError, ValueError, TypeError):
        return "-"


# --------------------------------------------------------------------------- commands
def cmd_list(fx, a):
    fl = fx.flows()
    for f in sorted(fl, key=lambda f: f["properties"].get("displayName", "").lower()):
        p = f["properties"]
        print("%-8s %s  %s" % (p.get("state", "?"), f["name"], p.get("displayName", "")))
    print("%d flow(s)" % len(fl))
    return 0


def cmd_runs(fx, a):
    flow = fx.resolve(a.flow)
    q = "$top=%d" % a.top
    if a.status:
        q += "&$filter=" + urllib.parse.quote("status eq '%s'" % a.status)
    runs = fx.paged("/flows/%s/runs" % flow["name"], q, limit=a.top)
    print("%s (%s), state %s" % (flow["properties"].get("displayName"), flow["name"],
                                 flow["properties"].get("state")))
    for r in runs:
        p = r["properties"]
        print("  %s  %-10s %s  %8s  %s" % (r["name"], p.get("status"), (p.get("startTime") or "")[:19],
                                         seconds(p), "" if p.get("status") == "Succeeded"
                                         else fmt_err(p.get("error"))[:90]))
    print("%d run(s)%s" % (len(runs), (" with status " + a.status) if a.status else ""))
    return 0


def cmd_why(fx, a):
    flow = fx.resolve(a.flow)
    fid = flow["name"]
    fp = flow["properties"]
    amap = action_map(fp.get("definition"))
    if a.run:
        run = fx.get("/flows/%s/runs/%s" % (fid, a.run))
    else:
        failed = fx.paged("/flows/%s/runs" % fid,
                          "$top=1&$filter=" + urllib.parse.quote("status eq 'Failed'"), limit=1)
        if not failed:
            print("%s: no failed run in the run history this account can read." % fp.get("displayName"))
            print("If something did not happen at all, there may be no run: check the trigger's "
                  "histories (fired or not) and its trigger conditions.")
            return 0
        run = failed[0]
    rp = run["properties"]
    print("flow  %s (%s), state %s" % (fp.get("displayName"), fid, fp.get("state")))
    if fp.get("flowSuspensionReason") not in (None, "", "None"):
        print("      SUSPENDED: %s" % fp.get("flowSuspensionReason"))
    print("run   %s  %s  %s  %s  trigger %s" % (run["name"], rp.get("status"), (rp.get("startTime") or "")[:19],
                                               seconds(rp), (rp.get("trigger") or {}).get("name")))
    print("      headline %s" % fmt_err(rp.get("error")))
    if rp.get("status") not in ("Failed", "TimedOut", "Cancelled"):
        print("This run did not fail. A logic fault in a green run shows as a Skipped branch "
              "where one should have run: read the conditions, not the status.")
        return 0

    acts = fx.paged("/flows/%s/runs/%s/actions" % (fid, run["name"]))
    roots, generic_fail, skipped = [], [], 0
    for act in acts:
        p = act["properties"]
        st = p.get("status")
        if st == "Skipped":
            skipped += 1
            continue
        if st not in ("Failed", "TimedOut", "Cancelled"):
            continue
        if not is_generic(p.get("error")) and p.get("error"):
            roots.append({"name": act["name"], "props": p, "where": []})
            continue
        # No specific error at this level: a container that failed because of a child, or an
        # action inside a loop whose error is only on its iterations.
        reps = []
        if (amap.get(act["name"]) or {}).get("loop"):
            reps = fx.paged("/flows/%s/runs/%s/actions/%s/repetitions" % (fid, run["name"], act["name"]))
        found = False
        for rep in reps:
            q = rep["properties"]
            if q.get("status") in ("Failed", "TimedOut", "Cancelled") and not is_generic(q.get("error")):
                where = ["%s[%s]" % (i.get("scopeName"), i.get("itemIndex"))
                         for i in q.get("repetitionIndexes") or []]
                roots.append({"name": act["name"], "props": q, "where": where})
                found = True
                break   # the first failing iteration; more are counted below
        if not found:
            generic_fail.append(act["name"])

    def depth(r):
        return (len(r["where"]), amap.get(r["name"], {}).get("parent") is not None)
    roots.sort(key=depth, reverse=True)

    if not roots:
        print("\nNo action carries a specific error. Failed containers: %s." % ", ".join(generic_fail))
        print("Open the run in the portal (append ?v3=false for the classic view) - a TimedOut or a "
              "Cancelled run, or a Terminate action with status Failed, also looks like this.")
    for i, r in enumerate(roots):
        p, m = r["props"], amap.get(r["name"], {})
        label = "ROOT CAUSE" if i == 0 else "also failed"
        print("\n%s  %s  [%s%s]%s" % (label, r["name"], m.get("type") or "?",
                                      (" " + m["op"]) if m.get("op") else "",
                                      ("  in " + " > ".join(r["where"])) if r["where"] else ""))
        print("  %s" % fmt_err(p.get("error")))
        if p.get("error", {}).get("code") == "InvalidTemplate":
            print("  An expression in this action's inputs failed before any call was made "
                  "(no inputs are recorded). Read the expression in the definition.")
        elif (p.get("code") or "") in ("TooManyRequests", "429") or "429" in fmt_err(p.get("error")):
            print("  Throttled: the platform retries 429s by policy; a failure here means the retries "
                  "ran out. Lower the concurrency or spread the work.")
        for key in ("inputsLink", "outputsLink"):
            body = link_body(p, key, a.max_chars)
            if body is not None:
                print("  %s: %s" % (key[:-4], body))
    if generic_fail:
        print("\ncascade: %d container or condition failure(s) caused by the above (%s); %d action(s) "
              "skipped." % (len(generic_fail), ", ".join(generic_fail[:6]) + (" ..." if len(generic_fail) > 6
                                                                            else ""), skipped))

    effects = []
    for act in acts:
        m = amap.get(act["name"], {})
        if act["properties"].get("status") == "Succeeded" and (
                m.get("type") == "Http" or (m.get("op") and SIDE_EFFECT.match(m["op"]))):
            effects.append("%s [%s]%s" % (act["name"], m.get("op") or m.get("type"),
                                          "  (in a loop: status is the loop's aggregate - read "
                                          "its repetitions to count)" if m.get("loop") else ""))
    print("\nside effects that already happened in this run (a resubmit repeats them):")
    for e in effects:
        print("  " + e)
    if not effects:
        print("  none found among the actions that succeeded")
    print("\nResubmit only after the fix is deployed and only when repeating every line above is "
          "harmless; otherwise fix the data and let the next trigger run, or run a guarded catch-up.")
    return 1


# --------------------------------------------------------------------------- selftest
def selftest():
    """Recorded response shapes from a real failed run (names and values anonymised)."""
    global FETCH
    env, fid, run = "00000000-0000-0000-0000-00000000e000", "11111111-1111-1111-1111-111111111111", "0858RUN01"
    base = BASE % env
    definition = {"actions": {
        "Read_the_mode": {"type": "OpenApiConnection", "inputs": {"host": {"operationId": "ListRecords"}}},
        "For_each_order": {"type": "Foreach", "actions": {
            "Has_a_date": {"type": "If", "actions": {
                "Send_each_line": {"type": "Foreach", "actions": {
                    "Email_customer": {"type": "OpenApiConnection",
                                       "inputs": {"host": {"operationId": "SendEmailV2"}}},
                    "Record_sent": {"type": "OpenApiConnection",
                                    "inputs": {"host": {"operationId": "CreateRecord"}}}}}},
                "else": {"actions": {"No_date": {"type": "Compose"}}}}}}}}
    gen = {"code": "ActionFailed", "message": GENERIC}
    root_err = {"code": "InvalidTemplate", "message": "Unable to process template language expressions in "
                "action 'Record_sent' inputs at line '0' and column '0': 'The template language function "
                "'substring' parameter is out of range.'"}
    out_link = "https://signed.example/out?sig=x"

    def run_rec(status, err=None, name=run):
        return {"name": name, "properties": {"status": status, "startTime": "2026-01-02T11:00:27.72Z",
                                             "endTime": "2026-01-02T11:00:42.14Z", "error": err,
                                             "trigger": {"name": "Recurrence"}}}

    acts = [
        {"name": "Read_the_mode", "properties": {"status": "Succeeded", "code": "OK",
                                                 "outputsLink": {"uri": out_link}}},
        {"name": "For_each_order", "properties": {"status": "Failed", "code": "ActionFailed", "error": gen}},
        {"name": "Has_a_date", "properties": {"status": "Failed", "code": "NotSpecified"}},
        {"name": "Send_each_line", "properties": {"status": "Failed", "code": "NotSpecified"}},
        {"name": "Email_customer", "properties": {"status": "Succeeded", "code": "NotSpecified"}},
        {"name": "Record_sent", "properties": {"status": "Failed", "code": "NotSpecified"}},
        {"name": "No_date", "properties": {"status": "Skipped", "code": "ActionSkipped"}}]
    reps = {
        "Record_sent": [{"name": "000000-000000", "properties": {
            "status": "Failed", "code": "BadRequest", "error": root_err,
            "repetitionIndexes": [{"scopeName": "For_each_order", "itemIndex": 0},
                                  {"scopeName": "Send_each_line", "itemIndex": 0}]}}],
        "Has_a_date": [{"name": "000000", "properties": {"status": "Failed", "error": gen,
                                                         "repetitionIndexes": [{"scopeName": "For_each_order",
                                                                                "itemIndex": 0}]}}],
        "Send_each_line": [{"name": "000000", "properties": {"status": "Failed", "error": gen}}],
        "Email_customer": [], "For_each_order": []}
    state = {"calls": [], "fail_runs": [run_rec("Failed", gen)], "flows_status": None}
    flow = {"name": fid, "properties": {"displayName": "Order Daily Guide", "state": "Started",
                                        "definition": definition}}

    def fake(url, token):
        state["calls"].append((url, token))
        if url.startswith("https://signed.example/"):
            assert token is None, "pre-signed link fetched with a bearer token"
            return {"statusCode": 200, "body": {"value": [{"mode": "test"}]}}
        assert token == "fixture-token", "API call without the token"
        path = url[len(base):].split("?")[0]
        if path == "/flows":
            return {"value": [flow, {"name": "2" * 8 + "-2222-2222-2222-" + "2" * 12,
                                     "properties": {"displayName": "Order Weekly Digest", "state": "Stopped"}}]}
        if path == "/flows/%s" % fid:
            return flow
        if path == "/flows/%s/runs" % fid:
            if "Failed" in urllib.parse.unquote(url):
                return {"value": state["fail_runs"]}
            return {"value": [run_rec("Succeeded", None, "0858RUN02")] + state["fail_runs"]}
        if path == "/flows/%s/runs/%s" % (fid, run):
            return run_rec("Failed", gen)
        if path == "/flows/%s/runs/%s/actions" % (fid, run):
            return {"value": acts}
        m = re.match(r"/flows/%s/runs/%s/actions/([^/]+)/repetitions" % (fid, run), path)
        if m:
            return {"value": reps[m.group(1)]}
        raise CannotRun("unexpected call %s" % path)

    results = []

    def check(name, ok):
        results.append(ok)
        print("%s  %s" % ("ok  " if ok else "FAIL", name))

    import io
    import contextlib
    FETCH = fake
    os.environ["FLOW_RUNS_SELFTEST_TOKEN"] = "fixture-token"

    def run_main(args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = main(args + ["--env", env, "--token-env", "FLOW_RUNS_SELFTEST_TOKEN"])
        return rc, buf.getvalue()

    try:
        rc, out = run_main(["why", "Daily Guide"])
        check("why on a failed run exits 1 (a finding)", rc == 1)
        check("root cause is the deepest specific error, found on the loop iteration",
              "ROOT CAUSE  Record_sent  [OpenApiConnection CreateRecord]  in For_each_order[0] > "
              "Send_each_line[0]" in out and "InvalidTemplate" in out)
        check("generic container failures are reported as the cascade, not the cause",
              "cascade: 3 container" in out and "ROOT CAUSE  For_each_order" not in out)
        check("a send that succeeded before the failure is listed as a side effect",
              "Email_customer [SendEmailV2]" in out and "aggregate" in out)
        check("a read (ListRecords) is not listed as a side effect", "Read_the_mode [" not in out)
        check("repetitions are read only for actions inside a loop",
              not any("Read_the_mode/repetitions" in u for u, _ in state["calls"]))
        check("the token is never printed", "fixture-token" not in out)
        rc, out = run_main(["why", fid, run, "--max-chars", "40"])
        check("an explicit run id is explained the same way", rc == 1 and "ROOT CAUSE  Record_sent" in out)
        state["fail_runs"] = []
        rc, out = run_main(["why", "Daily Guide"])
        check("no failed run exits 0 and points at trigger histories", rc == 0 and "histories" in out)
        rc, out = run_main(["runs", "Daily Guide", "--status", "Failed"])
        check("runs --status filters on the server", rc == 0 and any("status eq 'Failed'" in
                                                                      urllib.parse.unquote(u)
                                                                      for u, _ in state["calls"]))
        rc, out = run_main(["why", "Order"])
        check("an ambiguous name is refused with exit 2", rc == 2 and "matches several" in out)
        rc, out = run_main(["list"])
        check("list prints every flow with its state", rc == 0 and "Stopped" in out and "2 flow(s)" in out)
        del os.environ["FLOW_RUNS_SELFTEST_TOKEN"]
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = main(["list", "--env", env, "--token-env", "FLOW_RUNS_SELFTEST_TOKEN",
                       "--token-cmd", "exit 3"])
        check("a failing token command exits 2 with no API call", rc == 2)
        d = action_map(definition)
        check("the definition map reaches actions inside else branches and nested loops",
              d["No_date"]["parent"] == "Has_a_date" and d["Record_sent"]["loop"] == "Send_each_line")
    finally:
        FETCH = _http_get
        os.environ.pop("FLOW_RUNS_SELFTEST_TOKEN", None)
    print("%d/%d passed" % (sum(results), len(results)))
    return 0 if all(results) else 1


# --------------------------------------------------------------------------- main
def load_env(a):
    if a.env:
        return a.env
    paths = [a.config] if a.config else [os.path.join("scripts", "canvas-app.json"), "canvas-app.json"]
    for p in paths:
        if p and os.path.exists(p):
            with open(p, encoding="utf-8") as fh:
                env = (json.load(fh) or {}).get("environmentId")
            if env and "<" not in env:
                return env
    raise CannotRun("no environment id: pass --env or set environmentId in scripts/canvas-app.json")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="flow-runs.py", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter, usage=argparse.SUPPRESS)
    ap.add_argument("command", nargs="?", choices=["list", "runs", "why"])
    ap.add_argument("flow", nargs="?")
    ap.add_argument("run", nargs="?")
    ap.add_argument("--env")
    ap.add_argument("--config")
    ap.add_argument("--status")
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--max-chars", type=int, default=800)
    ap.add_argument("--token-cmd")
    ap.add_argument("--token-env", default="FLOW_TOKEN")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.command:
        ap.print_help()
        return 2
    if a.command in ("runs", "why") and not a.flow:
        print("%s needs a flow id or name" % a.command)
        return 2
    try:
        env = load_env(a)
        token, how = get_token(a.token_cmd, a.token_env)
        fx = Flows(env, token)
        return {"list": cmd_list, "runs": cmd_runs, "why": cmd_why}[a.command](fx, a)
    except CannotRun as e:
        print("cannot run: %s" % e)
        return 2


if __name__ == "__main__":
    sys.exit(main())
