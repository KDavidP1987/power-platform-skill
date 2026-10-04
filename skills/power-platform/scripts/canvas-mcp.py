#!/usr/bin/env python3
"""
canvas-mcp.py - a direct stdio client for the canvas authoring MCP server.

Why a direct client, when the plugin already exposes the tools:
  - The server is launched as a floating prerelease, so its argument names can change between
    sessions (snake_case to camelCase). The plugin's cached schema then sends the old names and
    every tool that takes an argument fails with a bare error while zero-argument tools work.
    `tools` prints what the server accepts now, and this client sends those names.
  - `isError` does not track validation errors, the summary omits "Errors:" when the count is zero,
    and a compile with no Studio session reports thousands of "isn't recognized" errors that all
    have one cause. This client parses the count, says "no session" once, and refuses to hold a
    push that is not clean.
  - A server left running holds the app's authoring session as YOU, which blocks version restore
    for about 15 minutes. This client always releases it and kills the process tree on exit.
  - `hold` keeps a clean push alive until Studio has saved it, and releases on a sentinel FILE
    (not stdin), so it works when run in the background.

Usage (reads the app identity from scripts/canvas-app.json, or --config <path>):
  python scripts/canvas-mcp.py tools                  # tool names and the argument names they take now
  python scripts/canvas-mcp.py compile                # compile and push canvasSrc to the live session
  python scripts/canvas-mcp.py hold [minutes]         # compile; if clean, hold the session until released
  python scripts/canvas-mcp.py sync <scratch-dir>     # session -> disk (refuses any folder named Src)
  python scripts/canvas-mcp.py sources | controls
  python scripts/canvas-mcp.py schema "<Data Source>"
  python scripts/canvas-mcp.py describe <ControlName>
  python scripts/canvas-mcp.py a11y | checker         # the server's accessibility and App Checker results
  python scripts/canvas-mcp.py accounts               # accounts the server has cached sign-ins for
  python scripts/canvas-mcp.py --selftest             # parser checks, no server needed

Config keys (canvas-app.json): environmentId, appId, canvasSrc, login (your sign-in, sent as
login_hint so the server does not show an account picker), optional releaseFile (default
.ship-work/release-session), optional serverCommand (a list; default the dnx prerelease launch).

Order that works: open the app in Studio in edit mode and wait for "(Editing)", THEN run hold in the
background; select a changed control in Studio and read it back; Save; create the release file.
Exit codes: 0 ok, 1 refused or failed, 2 usage or configuration error.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time

if hasattr(sys.stdout, "reconfigure"):
    # The compile result contains check and cross glyphs; on a cp1252 console printing them raises
    # UnicodeEncodeError and the result is lost after the compile already ran.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_CMD = ["dnx", "Microsoft.PowerApps.CanvasAuthoring.McpServer", "--yes", "--prerelease",
               "--source", "https://api.nuget.org/v3/index.json"]
NO_SESSION = "No active coauthoring canvas designer session detected"
SERVER_EXE = "CanvasAuthoringMcpServer"


def parse_compile(txt):
    """Return (errors or None when unreadable, no_session flag, validated file count or None)."""
    no_session = NO_SESSION in txt
    validated = re.search(r"Files validated:\s*(\d+)", txt)
    summary = re.search(r"Errors:\s*(\d+)", txt)
    error_lines = len(re.findall(r"^\s*:\s*error\b", txt, re.MULTILINE))
    if not validated:
        return None, no_session, None
    errors = max(int(summary.group(1)), error_lines) if summary else error_lines
    return errors, no_session, int(validated.group(1))


def selftest():
    cases = [
        ("clean, summary omits Errors", "Files validated: 49\nDiagnostics: 55 total\nWarnings: 55\n", (0, False, 49)),
        ("broken", "Files validated: 12\nErrors: 3\n : error PA1: x\n : error PA1: y\n : error PA1: z\n", (3, False, 12)),
        ("no session", NO_SESSION + "\nFiles validated: 40\nErrors: 4068\n", (4068, True, 40)),
        ("unreadable", "An error occurred invoking 'compile_canvas'.", (None, False, None)),
        ("error lines exceed summary", "Files validated: 5\nErrors: 1\n : error A\n : error B\n", (2, False, 5)),
    ]
    bad = 0
    for name, txt, want in cases:
        got = parse_compile(txt)
        ok = got == want
        bad += not ok
        print("%s  %s  %s" % ("ok  " if ok else "FAIL", name, "" if ok else "got %r want %r" % (got, want)))
    print("selftest: %d case(s), %d failed" % (len(cases), bad))
    return 1 if bad else 0


def load_config(argv):
    path = None
    if "--config" in argv:
        i = argv.index("--config")
        path = argv[i + 1]
        del argv[i:i + 2]
    root = os.getcwd()
    path = path or os.path.join(root, "scripts", "canvas-app.json")
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception as e:
        print("cannot read %s (%s). Copy assets/canvas-app.example.json to scripts/canvas-app.json." % (path, e))
        return None, None
    missing = [k for k in ("environmentId", "appId", "canvasSrc") if not cfg.get(k) or set(str(cfg.get(k))) <= set("0-")]
    if missing:
        print("canvas-app.json is missing %s." % ", ".join(missing))
        return None, None
    return cfg, os.path.dirname(os.path.dirname(os.path.abspath(path)))


class Client(object):
    def __init__(self, cmd):
        # shell=True so dnx resolves through PATH on Windows; the cost is that terminating the shell
        # leaves the server running, which close() handles.
        self.p = subprocess.Popen(cmd if os.name != "nt" else subprocess.list2cmdline(cmd),
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                  text=True, encoding="utf-8", errors="replace", bufsize=1, shell=(os.name == "nt"))
        self.n = 0

        def drain():
            for line in self.p.stderr:
                line = line.rstrip()
                if "fail:" in line or "Exception" in line or "   at " in line:
                    print("[server] " + line, flush=True)
        threading.Thread(target=drain, daemon=True).start()

    def call(self, method, params=None):
        self.n += 1
        i = self.n
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}) + "\n")
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            if not line:
                return None
            try:
                msg = json.loads(line.strip() or "null")
            except ValueError:
                continue
            # Skip notifications (tools/list_changed arrives between calls).
            if isinstance(msg, dict) and msg.get("id") == i:
                return msg

    def tool(self, name, args):
        r = self.call("tools/call", {"name": name, "arguments": args}) or {}
        res = r.get("result") or {}
        return "\n".join(c.get("text", "") for c in res.get("content", [])), bool(res.get("isError") or r.get("error"))

    def start(self):
        self.call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                 "clientInfo": {"name": "canvas-mcp", "version": "1"}})
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.p.stdin.flush()

    def close(self):
        for step in (lambda: self.p.stdin.close(), lambda: self.p.terminate(), lambda: self.p.wait(timeout=10)):
            try:
                step()
            except Exception:
                pass
        # Kill the tree and sweep strays: an orphaned server holds the authoring session as you.
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(self.p.pid)], capture_output=True)
            subprocess.run(["taskkill", "/F", "/IM", SERVER_EXE + ".exe"], capture_output=True)
        else:
            subprocess.run(["pkill", "-f", SERVER_EXE], capture_output=True)


def run(c, action, args, cfg, root):
    c.start()
    if action == "tools":
        r = c.call("tools/list", {}) or {}
        for t in (r.get("result") or {}).get("tools", []):
            print("%-26s %s" % (t["name"], list((t.get("inputSchema") or {}).get("properties", {}).keys())))
        return 0

    connect = {"environment_id": cfg["environmentId"], "app_id": cfg["appId"]}
    if cfg.get("login"):
        connect["login_hint"] = cfg["login"]   # picks the cached account: no account picker, no prompt
    if cfg.get("tenantId"):
        connect["tenant_id"] = cfg["tenantId"]
    txt, err = c.tool("connect", connect)
    print(txt.split(".")[0] + ".")
    if err:
        print("connect FAILED - run `tools` and compare the argument names with what this client sends.")
        return 1
    if action == "accounts":
        txt, err = c.tool("list_accounts", {})
        print(txt)
        return 1 if err else 0

    app_dir = os.path.dirname(os.path.join(root, cfg["canvasSrc"]).rstrip("/\\"))
    if action in ("compile", "hold"):
        # The server is given the folder that CONTAINS Src (measured on six apps), not Src itself.
        txt, err = c.tool("compile_canvas", {"directoryPath": app_dir})
        errors, no_session, files = parse_compile(txt)
        if no_session:
            n = len(re.findall(r"^\s*:\s*error", txt, re.MULTILINE))
            print("\nNO COAUTHORING SESSION - Studio is not open in edit mode.")
            print("  %s errors reported are all that one cause (no data sources resolve). Not printed." % (n or "The"))
            print("  Open the app for edit in Studio, wait for (Editing), then re-run.")
            return 1
        print(txt, flush=True)
        if errors is None:
            print("\nCould not read an error count from the compile output. Do not assume anything was pushed.")
            return 1
        if action == "compile":
            return 1 if errors else 0
        if errors:
            print("\nREFUSING TO HOLD - compile reported %d error(s). Nothing valid was pushed; do not save." % errors)
            return 1
        release = os.path.join(root, cfg.get("releaseFile", os.path.join(".ship-work", "release-session")))
        os.makedirs(os.path.dirname(release), exist_ok=True)
        if os.path.exists(release):
            os.remove(release)
        cap = int(args[0]) * 60 if args else 3600
        print("\nPUSHED CLEAN (%d files, 0 errors). SESSION HELD." % files)
        print("  Studio may go white: do not reload it (a reload joins a new session and drops the push).")
        print("  Read a changed property back in Studio, Save, then create: %s" % release)
        print("  Auto-release after %d minutes." % (cap // 60), flush=True)
        waited = 0
        while not os.path.exists(release) and waited < cap:
            time.sleep(5)
            waited += 5
            if waited % 300 == 0:
                print("still holding (%d min)" % (waited // 60), flush=True)
        print("session released after %d s" % waited)
        return 0
    if action == "sync":
        if not args:
            print("usage: sync <scratch-dir>")
            return 2
        target = os.path.abspath(args[0])
        if os.path.basename(target.rstrip("/\\")) == "Src" or os.path.abspath(app_dir) in target:
            print("refusing to sync into the app source: sync_canvas overwrites. Use a scratch folder.")
            return 2
        txt, err = c.tool("sync_canvas", {"directoryPath": target})
        print(txt)
        if "No files returned" in txt:
            print("\nEMPTY SYNC - no Studio is attached, so the session is empty. This proves nothing about the saved app.")
        return 1 if err else 0
    tools = {"sources": ("list_data_sources", {}), "controls": ("list_controls", {}),
             "schema": ("get_data_source_schema", {"dataSourceName": args[0] if args else ""}),
             "describe": ("describe_control", {"controlName": args[0] if args else ""}),
             "a11y": ("get_accessibility_errors", {}), "checker": ("get_appchecker_errors", {})}
    if action not in tools:
        print("unknown action: %s" % action)
        return 2
    txt, err = c.tool(*tools[action])
    print(txt)
    return 1 if err else 0


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    if argv[0] == "--selftest":
        return selftest()
    cfg, root = load_config(argv)
    if not cfg:
        return 2
    c = Client(cfg.get("serverCommand") or DEFAULT_CMD)
    try:
        return run(c, argv[0], argv[1:], cfg, root)
    finally:
        c.close()   # always release the authoring session, including on error or Ctrl+C


if __name__ == "__main__":
    sys.exit(main())
