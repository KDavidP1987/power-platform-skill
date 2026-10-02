# Studio sessions, the edit lock, and the authoring MCP server

Read this with `canvas-shipping.md` whenever a change goes through the co-authoring push, or when
Studio opens read-only, `connect` fails, a compile returns thousands of errors, or a version
restore is refused.

## Contents

1. Studio sessions and the edit lock
2. The authoring MCP server

---

## 1. Studio sessions and the edit lock

The whole diagnosis often starts with one word in the window title: `(Editing)` or `(Read-only)`.
Studio's own text for the second is "This app is read-only because you already have editing
control elsewhere". The authoring `connect` then answers a **bare HTTP 422 with an empty body**.

What strands the lock:

- **Killing the tab** instead of closing through the editor's Back button.
- **A Studio crash mid-push** (white screen, `TypeError: Cannot read properties of undefined`) -
  same 422 / read-only signature.
- **An ordinary push/save/publish cycle**, observed in one project with nothing killed.
- **A push whose Save button stays disabled.** Measured on a new app (2026-10): after a clean
  compile Studio spent one to two minutes walking the pushed controls (the status line names a
  different selected control every few seconds) with Save disabled and a spinner in its place. A
  Save click in that state does nothing; a reload then discards the push - the reopened app was the
  blank Screen1. What worked: wait for the walk to stop, real-click an empty part of the canvas, press
  Ctrl+S; "Saving to Power Apps" covered the canvas for about two minutes, then Publish (real click,
  "Publish this version") moved `lastpublishtime`.
- **Or do not save the push at all.** The compile is the formula check; the session only has to
  exist for schemas to resolve. Compile in a throwaway session, leave Studio without saving, and ship
  the same commit with `ship-canvas.py --import`. The player showed the new build stamp after the
  "old version - Refresh" banner was clicked. This sidesteps every save failure above.
- **Your own authoring-server processes.** `connect` opens a co-authoring session **under the
  signed-in user's identity**, so the agent is indistinguishable from the user and "I don't have it
  open anywhere" can be true while the app is locked. When the client launches the server through
  a shell (`shell=True` on Windows), terminating the client kills only `cmd.exe`; the
  `CanvasAuthoringMcpServer` process keeps running with its session open. Every probe, sync and
  compile that does this leaks another session.

What did and did not release it (all observed, timings environment-specific):

- **Did not:** Override (it restored `(Editing)` in the browser while `connect` still returned
  422); waiting four minutes; a full close and reopen; 40 `connect` retries over 30 minutes.
- **Did:** time - the lock is server-side and aged out on its own after roughly 30-60 minutes
  (one case about 50 minutes, a crash case about an hour). In one case, the owner signing out of
  the maker portal and closing every Power Apps tab on every machine; killing the orphaned server
  process alone did not release that one.
- The read-only teaching bubble sits over the Override button - click "Got it" first.
- A stale tab can show `(Editing)` while the server reports no co-authoring session. Reload before
  concluding anything from the title.

**Is it the session or the source?** `git stash` the canvas source and compile the last shipped
tree. If that fails the same way, the session is at fault, not your YAML.

**When locked: stop.** Do not retry into it. Commit with the shipped/unshipped boundary stated in
the state file, and ship the delta next session.

**Prevent the self-inflicted kind.** Kill the server's **process tree** (`taskkill /F /T /PID
<pid>`), release the session in a `finally` (including on Ctrl+C), and sweep stray
`CanvasAuthoringMcpServer` processes at client start and exit. Before any version restore or other
version operation, stop connecting and kill lingering servers: a restore fails with "Restore
failed. '<app>' is locked by user with object id ... please wait at least 15 minutes before
retrying", and each new `connect` restarts that clock.

## 2. The authoring MCP server

### Connect order, and the no-session cascade

- **The compile fails open if the MCP connected before Studio opened.** It validates with no
  data-source context and returns thousands of `'X' isn't recognized` errors, including files you
  never touched (one run: 2,487 errors on a tree that compiled clean minutes later; another 4,068).
  The tell is **line 1** of the output: `Warning: No active coauthoring canvas designer session
  detected.` Order that works: open Studio in edit mode, wait for `(Editing)`, then `connect`, then
  `compile`. Re-connect after a reload, a data-source add/remove, a save or a publish.
- **When line 1 is the no-session warning, print that cause loudly and suppress the rest.** Twice
  the thousands of consequent `isn't recognized` lines were read as real findings in the code under
  test. Refuse to report them.
- **`isError` on the compile result does not track validation errors.** A compile reporting 4,068
  errors returned `isError=false`, so a "hold the session if the push was good" gate held a broken
  push. Gate on a parsed count: anchor on `Files validated: N`, use `Errors: N` when present, else
  count `: error` lines (the summary omits the `Errors:` line when zero; a FAILED banner appears for
  warnings alone). **Print the result before any hold loop** - the count was invisible exactly while
  someone was deciding whether to Save. Refuse to hold on no session, unreadable output, or any
  error.
- **Zero errors is not a clean compile.** Read warnings on the lines you changed: a type mismatch
  in a filter compiles as a warning and filters nothing (`power-fx-and-pa-yaml.md`).
- **A broken compile can empty the session's data-source list.** A compile that cascaded about 980
  errors left the session reporting no data sources. A Studio session restart plus a reconnect
  brought all 37 back and the compile passed. Do not read the empty list as "the app lost its
  sources".
- **A data source added in Studio is not in an already-open authoring session.** It reads "isn't
  recognized" until the app is Saved and Published in Studio AND the authoring session is
  re-connected. A probe compile naming the new table is the cheap test; revert the probe so the
  tree stays green until the source resolves.

### Contract drift

- **The server may be launched as a floating prerelease** (`dnx <package> --prerelease`), so its
  tool contract can change between sessions with no version pin. It has happened: argument names
  were renamed (snake_case to camelCase) and every tool taking an argument failed with a bare
  "An error occurred invoking 'compile_canvas'" while zero-argument tools kept working.
- **It can drift to mixed casing at once.** In one observed state `connect` wanted snake_case
  (`environment_id`, `app_id`, `login_hint`) while `compile_canvas` and `sync_canvas` wanted
  camelCase (`directoryPath`); the plugin sent the wrong case to `connect` and got a bare error.
- When reads work and writes fail, call the server's `tools/list` directly and compare argument
  names with what the client sends.

### A direct stdio client keeps you shipping while the plugin catches up

What one worked well enough to describe:

- Spawn the server, send `initialize` and `notifications/initialized`; **skip JSON-RPC
  notifications** (such as `tools/list_changed`) while waiting for a response id - they arrive
  between calls and can be mistaken for the response. Drain stderr and surface server exceptions.
- Send the argument names the server **advertises** (a `tools` command prints them - a
  one-command diagnosis of a renamed argument).
- **Hold a session from a background process by waiting on a sentinel FILE, not stdin.** When
  backgrounded, stdin is closed, `readline()` returns at once, and the session is released the
  moment it is created. Run the hold as the background command itself, not `cmd &` inside a
  wrapper (the wrapper exits and its process group is killed). Treat only the wait loop's own line
  ("session will auto-release after N minutes") as proof of a hold: one wrapper printed "PUSHED
  CLEAN ... SESSION HELD OPEN" before a loop that a mis-indentation had made unreachable.
- Parse arguments robustly: a positional `int(argv[2])` minutes argument raised after the push had
  landed, losing the session.
- On a cp1252 Windows console, printing the result's check/cross glyphs raised
  `UnicodeEncodeError` after the compile ran, losing the result. Call
  `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`; capture child output as bytes.
- Always kill the server process tree on exit (section 1).

### The other tools, and what they read

- **`sync_canvas` writes server state to disk. Never sync into `Src`** - sync into a scratch folder
  and diff. It proves nothing about what is SAVED (it returns the session you just pushed into);
  verify saves from a fresh session or download.
- **An empty `sync_canvas` means no Studio is attached, not that work is missing.** With no
  designer attached the session is empty, nothing is written ("No files returned"), and a marker
  grep reports every marker absent - which reads exactly like lost work and invites re-pushing
  saved work. Make the sync tool warn on an empty result.
- **`get_data_source_schema` per source** (Studio open) is the server's view of each binding; a
  broken source returns no columns. Use it before removing anything Studio's Data pane calls broken
  (`manifest-caches.md`).
- **`get_appchecker_errors` exists only after a successful `connect`** (the server logs that it
  "supports app checker, registering tool") and reads session state. It answers "does this formula
  evaluate", naming control and property; group by severity and by message to see the shape of a
  failure. It and `get_accessibility_errors` analyse the build the session holds, which can lag
  the repo by a session, and both return clean with no session - inconclusive, not a pass.
