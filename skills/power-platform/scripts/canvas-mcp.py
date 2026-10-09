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
    (not stdin), so it works when run in the background. It releases only once a save NEWER than
    the push is proven (canvas-browser.mjs `save` writes save-proof.json on SAVE LANDED): measured,
    a release about 40 s after the Save click lost the save. It records the hash it pushed
    (last-push.json), which `canvas-browser.mjs publish` records instead of the source on disk.
  - `diff` compares two canvas source folders property by property, order-independently. A line
    diff of a synced session against Src is useless (the server re-orders properties); this prints
    only real differences. `sync <scratch> --diff` syncs a FRESH session and diffs it with Src: 0
    differences is the proof that the save holds what Src holds.

Usage (reads the app identity from scripts/canvas-app.json, or --config <path>):
  python scripts/canvas-mcp.py tools                  # tool names and the argument names they take now
  python scripts/canvas-mcp.py compile                # compile and push canvasSrc to the live session
  python scripts/canvas-mcp.py hold [minutes]         # compile; if clean, hold the session until released
  python scripts/canvas-mcp.py sync <scratch-dir> [--diff]  # session -> disk (refuses any folder named Src);
                                                      # --diff then compares it with canvasSrc
  python scripts/canvas-mcp.py diff <dir> [<dir-b>]    # canvasSrc (or <dir>) vs <dir-b>, property by property;
                                                      # --behaviour skips presentation properties; --restyle
                                                      # also flags If/Switch colours whose branches collapsed;
                                                      # --strict also lists default-valued one-sided properties
  python scripts/canvas-mcp.py sources | controls
  python scripts/canvas-mcp.py schema "<Data Source>"
  python scripts/canvas-mcp.py describe <ControlName>
  python scripts/canvas-mcp.py a11y | checker         # the server's accessibility and App Checker results
  python scripts/canvas-mcp.py accounts               # accounts the server has cached sign-ins for
  python scripts/canvas-mcp.py --selftest             # parser checks, no server needed

Config keys (canvas-app.json): environmentId, appId, canvasSrc, login (your sign-in, sent as
login_hint so the server does not show an account picker), optional releaseFile (default
.ship-work/release-session), workDir (.ship-work: last-push.json and save-proof.json live there),
buildStampVariable (gblBuild; ignored by diff), optional serverCommand (a list; default the dnx launch).

Order that works: reload Studio in edit mode and wait for "(Editing)" (`canvas-browser.mjs studio
--reload`), THEN run hold in the background and wait for its PUSHED CLEAN line; read a changed control
back in Studio; `canvas-browser.mjs save` (SAVE LANDED); then create the release file. The hold
releases when save-proof.json is newer than the push. Write "saved" into the release file when you read
"Saved: <time>" after the push by eye, or "discard" to drop the push without saving.
Exit codes: 0 ok (diff: no difference), 1 refused, failed or a difference found, 2 usage or configuration.
"""
import hashlib
import json
import os
import shutil
import tempfile
import re
import subprocess
import sys
import threading
import time

if hasattr(sys.stdout, "reconfigure"):
    # The compile result contains check and cross glyphs; on a cp1252 console printing them raises
    # UnicodeEncodeError and the result is lost after the compile already ran.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# CANVAS_MCP_VERSION pins the server (e.g. 1.1.5). A new version can be listed on NuGet before its
# platform package is, and "latest" then fails to start (the process exits; writing to it raises
# OSError 22). dnx refuses --prerelease together with a version, so a pin drops it.
_PIN = os.environ.get("CANVAS_MCP_VERSION", "").strip()
DEFAULT_CMD = (["dnx", "Microsoft.PowerApps.CanvasAuthoring.McpServer" + ("@" + _PIN if _PIN else ""), "--yes"]
               + ([] if _PIN else ["--prerelease"])
               + ["--source", "https://api.nuget.org/v3/index.json"])
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


# --------------------------------------------------------------------------- push record, save proof

def src_hash(src_dir):
    """The canvas source's hash: sha256 over each *.pa.yaml name and bytes, sorted by name. The same
    algorithm as canvas-browser.mjs srcHash, so publish can compare it with its own log."""
    if not src_dir or not os.path.isdir(src_dir):
        return None
    h = hashlib.sha256()
    for f in sorted(x for x in os.listdir(src_dir) if x.lower().endswith(".pa.yaml")):
        h.update(f.encode("utf-8"))
        with open(os.path.join(src_dir, f), "rb") as fh:
            h.update(fh.read())
    return h.hexdigest()


def release_verdict(content, proof, push_ms):
    """What a release request means for a held push: 'discard' (drop it, no save wanted), 'release'
    (a save newer than the push is proven, by the driver's proof file or by a person writing 'saved'),
    or 'wait'. Measured: releasing about 40 s after a Save click, before the save landed, lost it."""
    c = (content or "").strip().lower()
    if c.startswith("discard"):
        return "discard"
    if c.startswith("saved"):
        return "release"
    try:
        if proof and float(proof.get("atMs", 0)) >= push_ms:
            return "release"
    except (TypeError, ValueError):
        pass
    return "wait"


# --------------------------------------------------------------------------- order-independent diff
# A refused push can leave its formulas in the session, and a later clean push may not replace them
# (measured: 6 sites of a refused formula saved while every other change landed; the screen's
# OnVisible silently never ran). The server re-orders properties and re-serialises values, so only a
# control-by-control, property-by-property compare finds that.

KEY = re.compile(r'^(?P<ind>\s*)(?P<dash>-\s+)?(?P<key>[A-Za-z_][\w.]*|"[^"]*"|\'[^\']*\'):(?:\s+(?P<rest>.*))?$')
BLOCK = re.compile(r'^[|>][-+]?\d*\s*$')
# Values the server writes when the source omits them, and drops when the source states a control's
# default (measured: Height =40, IsSearchable =true, AccessibleLabel ="" gone after a round trip). A
# property present on one side only, with one of these values, is counted, not reported (--strict lists them).
SERVER_DEFAULT = re.compile(r'^=(-?\d+(\.\d+)?|true|false|""|RGBA\([^)]*\)|\w+|\w+\.\w+(\.\w+)?)$')
PRESENTATION_EXACT = {"X", "Y", "Width", "Height", "Size", "FontSize", "Font", "FontWeight", "Image",
                      "ImagePosition", "BorderThickness", "BorderStyle", "FocusedBorderThickness",
                      "RadiusTopLeft", "RadiusTopRight", "RadiusBottomLeft", "RadiusBottomRight",
                      "PaddingTop", "PaddingBottom", "PaddingLeft", "PaddingRight", "DropShadow"}


def is_presentation(prop):
    return prop in PRESENTATION_EXACT or prop.endswith("Fill") or prop.endswith("Color")


def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == '"' and v[-1] == '"':
        try:
            return json.loads(v)
        except ValueError:
            return v[1:-1]
    if len(v) >= 2 and v[0] == "'" and v[-1] == "'":
        return v[1:-1].replace("''", "'")
    return v


def pa_props(text):
    """{path: value} for every scalar in a .pa.yaml file. List items ('- lblName:') are keyed by name,
    so sibling order does not matter; whitespace is collapsed, so serialisation does not either."""
    out, stack = {}, []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i]
        i += 1
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = KEY.match(line)
        if not m:
            continue
        ind = len(m.group("ind")) + (len(m.group("dash")) if m.group("dash") else 0)
        key = _unquote(m.group("key"))
        rest = (m.group("rest") or "").strip()
        while stack and stack[-1][0] >= ind:
            stack.pop()
        path = "/".join([k for _, k in stack] + [key])
        if not rest:
            stack.append((ind, key))
            continue
        if BLOCK.match(rest):
            body = []
            while i < len(lines) and (not lines[i].strip() or len(lines[i]) - len(lines[i].lstrip()) > ind):
                body.append(lines[i].strip())
                i += 1
            rest = "\n".join(body)
        else:
            rest = _unquote(rest)
        out[path] = re.sub(r"\s+", " ", rest).strip()
    return out


def _args(call):
    """Top-level arguments of 'Name(a, b, ...)' (strings and nested brackets respected), or None."""
    m = re.match(r"^\s*=?\s*(If|Switch)\s*\(", call)
    if not m:
        return None, None
    depth, cur, out, q = 0, "", [], None
    body = call[m.end():]
    for j, ch in enumerate(body):
        if q:
            cur += ch
            if ch == q:
                q = None
            continue
        if ch in "\"'":
            q = ch
        elif ch in "([{":
            depth += 1
        elif ch in ")]}":
            if depth == 0:
                out.append(cur.strip())
                return m.group(1), (out if not body[j + 1:].strip() else None)
            depth -= 1
        elif ch == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
            continue
        cur += ch
    return m.group(1), None


def collapsed(value):
    """True when a whole-formula If/Switch has two or more result branches and all are the same
    (If(c, clrX, clrX)): a restyle mapped two colours to one token and the state no longer shows."""
    fn, a = _args(value or "")
    if not a:
        return False
    rest = a if fn == "If" else a[1:]
    results = rest[1::2] + ([rest[-1]] if len(rest) % 2 else [])
    norm = [re.sub(r"\s+", "", r) for r in results]
    return len(norm) >= 2 and len(set(norm)) == 1


def strip_stamp(v, var):
    return re.sub(r'Set\(\s*%s\s*,\s*"[^"]*"\s*\)' % re.escape(var), "", v or "")


def around(x, y, width=150):
    """Both values cut to show where they first differ (a long formula can differ past its 150th character)."""
    if x is None or y is None:
        return (x if x is not None else "<none>")[:width], (y if y is not None else "<none>")[:width]
    i = next((k for k, (p, q) in enumerate(zip(x, y)) if p != q), min(len(x), len(y)))
    start = max(0, i - 40)
    cut = lambda v: ("..." if start else "") + v[start:start + width] + ("..." if len(v) > start + width else "")
    return cut(x), cut(y)


def diff_dirs(a_dir, b_dir, behaviour=False, restyle=False, stamp_var="gblBuild", out=print, strict=False):
    """Compare every .pa.yaml in two folders. Returns (differences, compared files, ignored defaults)."""
    names = lambda d: {f for f in os.listdir(d) if f.lower().endswith(".pa.yaml") and not f.startswith("_")}
    na, nb = names(a_dir), names(b_dir)
    found = ignored = 0
    for n in sorted(na - nb):
        out("%s: only in %s" % (n, a_dir))
        found += 1
    for n in sorted(nb - na):
        out("%s: only in %s" % (n, b_dir))
        found += 1
    for n in sorted(na & nb):
        with open(os.path.join(a_dir, n), encoding="utf-8-sig") as f:
            a = pa_props(f.read())
        with open(os.path.join(b_dir, n), encoding="utf-8-sig") as f:
            b = pa_props(f.read())
        for k in sorted(set(a) | set(b)):
            x, y = a.get(k), b.get(k)
            prop = k.rsplit("/", 1)[-1]
            where = "%s %s" % (n, "/".join(p for p in k.split("/") if p not in ("Children", "Properties"))[-90:])
            if restyle and is_presentation(prop) and y is not None and collapsed(y) and not collapsed(x):
                out("%s\n    COLLAPSED: every branch is the same value - the state it showed is gone\n    a: %s\n    b: %s"
                    % (where, (x or "<none>")[:150], y[:150]))
                found += 1
                continue
            if strip_stamp(x, stamp_var) == strip_stamp(y, stamp_var):
                continue
            if not strict and (x is None or y is None) and SERVER_DEFAULT.match(x if y is None else y):
                ignored += 1
                continue
            if (behaviour or restyle) and is_presentation(prop):
                continue
            found += 1
            out("%s\n    a: %s\n    b: %s" % ((where,) + around(x, y)))
    return found, len(na & nb), ignored


def cmd_diff(a_dir, b_dir, flags, stamp_var):
    for d in (a_dir, b_dir):
        if not os.path.isdir(d):
            print("not a folder: %s" % d)
            return 2
    found, compared, ignored = diff_dirs(a_dir, b_dir, behaviour="--behaviour" in flags,
                                         restyle="--restyle" in flags, stamp_var=stamp_var, strict="--strict" in flags)
    if not compared:
        print("NOTHING COMPARED - no .pa.yaml file is in both folders. This proves nothing.")
        return 2
    print("%d difference(s) in %d file(s) compared%s%s." % (
        found, compared, " (presentation properties skipped)" if ("--behaviour" in flags or "--restyle" in flags) else "",
        "; %d server-written default(s) ignored" % ignored if ignored else ""))
    return 1 if found else 0


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
    checks = []

    def check(name, cond):
        checks.append((name, bool(cond)))

    # The hold releases only after a save newer than the push (or an explicit word).
    check("release: no proof waits", release_verdict("", None, 1000) == "wait")
    check("release: proof older than the push waits", release_verdict("", {"atMs": 900}, 1000) == "wait")
    check("release: proof newer than the push releases", release_verdict("", {"atMs": 1500}, 1000) == "release")
    check("release: 'saved' (read by eye) releases", release_verdict("saved 10:41", None, 1000) == "release")
    check("release: 'discard' drops the push", release_verdict("discard\n", {"atMs": 1}, 1000) == "discard")

    # The order-independent diff. Source as written; the session re-ordered, re-serialised, and kept a
    # refused formula at one site (the measured failure).
    src = ("Screens:\n  scrMain:\n    Properties:\n      OnVisible: =Set(locRows, GroupBy(colA, Code, Rows))\n"
           "    Children:\n      - lblTitle:\n          Control: Label@2.1.0\n          Properties:\n"
           "            Text: =\"Totals: by code\"\n            X: =0\n            Color: =If(locSel, clrPrimary, clrText)\n"
           "      - btnGo:\n          Control: Button@0.0.45\n          Properties:\n            OnSelect: |-\n"
           "              =Navigate(scrNext);\n              Notify(\"Go\")\n")
    sess = ("Screens:\n  scrMain:\n    Children:\n      - btnGo:\n          Control: Button@0.0.45\n          Properties:\n"
            "            OnSelect: =Navigate(scrNext);  Notify(\"Go\")\n            Visible: =true\n"
            "      - lblTitle:\n          Control: Label@2.1.0\n          Properties:\n            Color: =If(locSel, clrPrimary, clrText)\n"
            "            Text: '=\"Totals: by code\"'\n    Properties:\n      OnVisible: =Set(locRows, GroupBy(colA, 'Cost Code', Rows))\n")
    app_a = "App:\n  Properties:\n    OnStart: |-\n      =Set(gblBuild, \"unshipped\");\n      Set(gblX, 1)\n"
    app_b = "App:\n  Properties:\n    OnStart: =Set(gblBuild, \"2026-01-15 14:02Z a1b2c3d (push)\"); Set(gblX, 1)\n    Theme: =PowerAppsTheme\n"
    tmp = tempfile.mkdtemp(prefix="canvas-mcp-selftest-")
    try:
        def tree(name, files):
            d = os.path.join(tmp, name)
            os.makedirs(d)
            for n, t in files.items():
                with open(os.path.join(d, n), "w", encoding="utf-8", newline="\n") as f:
                    f.write(t)
            return d
        quiet = lambda *_: None
        a = tree("a", {"App.pa.yaml": app_a, "Main.pa.yaml": src})
        b = tree("b", {"App.pa.yaml": app_b, "Main.pa.yaml": sess, "_EditorState.pa.yaml": "x: 1\n"})
        found, compared, ignored = diff_dirs(a, b, out=quiet)
        check("diff: a refused formula left in the session is the one difference (re-order, re-quote, block form, stamp, defaults ignored)",
              (found, compared) == (1, 2))
        c = tree("c", {"App.pa.yaml": app_a, "Main.pa.yaml": sess.replace("'Cost Code'", "Code")})
        check("diff: the fixed session has 0 differences", diff_dirs(a, c, out=quiet)[0] == 0)
        check("diff: server-written defaults are counted, not reported", ignored >= 2)
        d = tree("d", {"App.pa.yaml": app_a, "Main.pa.yaml": src.replace("            X: =0\n", "")})
        check("diff: X =0 dropped by the server is not a difference", diff_dirs(a, d, out=quiet)[0] == 0)
        e = tree("e", {"App.pa.yaml": app_a, "Main.pa.yaml": src.replace("Control: Button@0.0.45\n          Properties:\n",
                                                                          "Control: Button@0.0.45\n          Properties:\n            Visible: =false\n")})
        check("diff: a default-valued property only one side has is counted, not reported", diff_dirs(e, a, out=quiet)[0] == 0)
        check("diff: --strict reports it", diff_dirs(e, a, out=quiet, strict=True)[0] >= 1)
        e2 = tree("e2", {"App.pa.yaml": app_a, "Main.pa.yaml": src.replace("Control: Button@0.0.45\n          Properties:\n",
                                                                            "Control: Button@0.0.45\n          Properties:\n            Visible: =locShowGo && !locBusy\n")})
        check("diff: a formula only the source has (dropped by a refused push) is a difference", diff_dirs(e2, a, out=quiet)[0] == 1)
        f = tree("f", {"Main.pa.yaml": src})
        check("diff: a screen missing on one side is a difference", diff_dirs(a, f, out=quiet)[0] == 1)
        # Restyle guard: presentation may change; any other property is refused; collapsed branches flagged.
        g = tree("g", {"App.pa.yaml": app_a, "Main.pa.yaml": src.replace("If(locSel, clrPrimary, clrText)", "If(locSel, clrNavy, clrInk)")})
        check("restyle: a colour change alone passes the guard", diff_dirs(a, g, restyle=True, out=quiet)[0] == 0)
        h = tree("h", {"App.pa.yaml": app_a, "Main.pa.yaml": src.replace("If(locSel, clrPrimary, clrText)", "If(locSel, clrInk, clrInk)")})
        check("restyle: If(c, clrX, clrX) is flagged as collapsed", diff_dirs(a, h, restyle=True, out=quiet)[0] == 1)
        i = tree("i", {"App.pa.yaml": app_a, "Main.pa.yaml": src.replace("Navigate(scrNext)", "Navigate(scrOther)")})
        check("restyle: a behaviour line that changed is refused", diff_dirs(a, i, restyle=True, out=quiet)[0] == 1)
        check("restyle: without --restyle the behaviour filter still sees the colour change skipped",
              diff_dirs(a, g, behaviour=True, out=quiet)[0] == 0 and diff_dirs(a, g, out=quiet)[0] == 1)
        check("collapsed: Switch with equal results", collapsed("=Switch(x, 1, clrA, 2, clrA, clrA)"))
        check("collapsed: Switch with one different result", not collapsed("=Switch(x, 1, clrA, 2, clrB, clrA)"))
        check("collapsed: strings with commas and brackets", not collapsed('=If(a, "x, (y)", "x, (z)")') and collapsed('=If(a, "x, (y)", "x, (y)")'))
        check("collapsed: If with no else is not collapsed", not collapsed("=If(a, clrA)"))
        check("collapsed: an If inside an expression is not judged", not collapsed("=ColorFade(If(a, clrA, clrA), 0.2)"))
        # The push record hash: same names and bytes, same hash; a change moves it.
        h1 = src_hash(a)
        check("push hash: stable", h1 == src_hash(a) and h1 and len(h1) == 64)
        check("push hash: a changed file moves it", h1 != src_hash(c))
        check("push hash: no folder", src_hash(os.path.join(tmp, "none")) is None)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    for name, ok in checks:
        bad += not ok
        print("%s  %s" % ("ok  " if ok else "FAIL", name))
    print("selftest: %d case(s), %d failed" % (len(cases) + len(checks), bad))
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


class ServerGone(Exception):
    """The server process did not start, or exited: nothing was pushed."""


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
        try:
            self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}) + "\n")
            self.p.stdin.flush()
        except OSError as e:
            # Measured: a server version listed without its platform package exits at once, and the
            # first write raised OSError 22 with no word about the cause.
            raise ServerGone(str(e))
        while True:
            line = self.p.stdout.readline()
            if not line:
                raise ServerGone("the server closed its output")
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
        work = os.path.join(root, cfg.get("workDir", ".ship-work"))
        proof_file = os.path.join(work, "save-proof.json")
        os.makedirs(os.path.dirname(release), exist_ok=True)
        os.makedirs(work, exist_ok=True)
        if os.path.exists(release):
            os.remove(release)
        nums = [a for a in args if a.isdigit()]
        cap = int(nums[0]) * 60 if nums else 3600
        push_ms = time.time() * 1000
        # The hash THIS push sent. Publish records it, so a push that failed or never started can never
        # mark the source as published (measured: the next real publish was then refused as unchanged).
        pushed = src_hash(os.path.join(root, cfg["canvasSrc"]))
        with open(os.path.join(work, "last-push.json"), "w", encoding="utf-8") as f:
            json.dump({"hash": pushed, "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "atMs": push_ms, "files": files}, f)
        print("\nPUSHED CLEAN (%d files, 0 errors). SESSION HELD." % files)
        print("  Studio may go white: do not reload it (a reload joins a new session and drops the push).")
        print("  Read a changed property back in Studio, then `canvas-browser.mjs save` (SAVE LANDED), then create:")
        print("    %s" % release)
        print("  The hold releases once a save newer than this push is proven (%s)." % proof_file)
        print("  Saved by hand? Write 'saved' into the release file after reading 'Saved: <time>'. 'discard' drops the push.")
        print("  Auto-release after %d minutes." % (cap // 60), flush=True)
        waited, told = 0, False
        while waited < cap:
            if os.path.exists(release):
                try:
                    with open(release, encoding="utf-8") as f:
                        content = f.read()
                except OSError:
                    content = ""
                try:
                    with open(proof_file, encoding="utf-8") as f:
                        proof = json.load(f)
                except (OSError, ValueError):
                    proof = None
                verdict = release_verdict(content, proof, push_ms)
                if verdict == "release":
                    print("save after the push is proven - releasing.")
                    break
                if verdict == "discard":
                    print("release file says discard - releasing WITHOUT a proven save. Nothing from this push is saved.")
                    break
                if not told:
                    print("RELEASE REQUESTED, but no save newer than the push is proven. STILL HOLDING:")
                    print("  releasing before the save lands loses it (measured: a release about 40 s after the Save click).")
                    print("  Run `canvas-browser.mjs save` until SAVE LANDED, or write 'saved' or 'discard' into the release file.", flush=True)
                    told = True
            time.sleep(5)
            waited += 5
            if waited % 300 == 0:
                print("still holding (%d min)" % (waited // 60), flush=True)
        if waited >= cap:
            print("AUTO-RELEASE after %d minutes: the hold timed out. A save is proven only by save-proof.json or a fresh session." % (cap // 60))
        print("session released after %d s" % waited)
        return 0
    if action == "sync":
        if not args:
            print("usage: sync <scratch-dir>")
            return 2
        pos = [a for a in args if not a.startswith("--")]
        if not pos:
            print("usage: sync <scratch-dir> [--diff]")
            return 2
        target = os.path.abspath(pos[0])
        if os.path.basename(target.rstrip("/\\")) == "Src" or os.path.abspath(app_dir) in target:
            print("refusing to sync into the app source: sync_canvas overwrites. Use a scratch folder.")
            return 2
        txt, err = c.tool("sync_canvas", {"directoryPath": target})
        print(txt)
        if "No files returned" in txt:
            print("\nEMPTY SYNC - no Studio is attached, so the session is empty. This proves nothing about the saved app.")
            return 1
        if err:
            return 1
        if "--diff" in args:
            # Proof of a SAVE only when Studio was reloaded first: the session then holds the saved app.
            print("\nComparing the synced session with %s (order-independent):" % cfg["canvasSrc"])
            return cmd_diff(os.path.join(root, cfg["canvasSrc"]), target, args, cfg.get("buildStampVariable", "gblBuild"))
        return 0
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
    if argv[0] == "diff":
        # Offline: no server, no session. Two folders, or canvasSrc and one folder.
        rest, dirs, stamp = argv[1:], [], None
        k = 0
        while k < len(rest):
            if rest[k] in ("--config", "--stamp"):
                if rest[k] == "--stamp" and k + 1 < len(rest):
                    stamp = rest[k + 1]
                k += 2
                continue
            if not rest[k].startswith("--"):
                dirs.append(rest[k])
            k += 1
        if len(dirs) == 2:
            return cmd_diff(dirs[0], dirs[1], argv, stamp or "gblBuild")
        if len(dirs) != 1:
            print("usage: diff <dir> | diff <dir-a> <dir-b>  [--behaviour] [--restyle] [--stamp <variable>]")
            return 2
        cfg, root = load_config(argv)
        if not cfg:
            return 2
        return cmd_diff(os.path.join(root, cfg["canvasSrc"]), dirs[0], argv, stamp or cfg.get("buildStampVariable", "gblBuild"))
    cfg, root = load_config(argv)
    if not cfg:
        return 2
    c = Client(cfg.get("serverCommand") or DEFAULT_CMD)
    try:
        return run(c, argv[0], argv[1:], cfg, root)
    except ServerGone as e:
        print("\nAUTHORING SERVER DID NOT START OR EXITED (%s). NOTHING WAS PUSHED - stop the chain here." % e)
        print("  Run the server command by hand to read its error:")
        print("    " + " ".join(cfg.get("serverCommand") or DEFAULT_CMD))
        print("  A version listed without its platform package fails this way: set CANVAS_MCP_VERSION to a version")
        print("  already in ~/.nuget/packages (authoring-sessions.md section 2).")
        return 1
    finally:
        c.close()   # always release the authoring session, including on error or Ctrl+C


if __name__ == "__main__":
    sys.exit(main())
