# Script interfaces (0.9 freeze candidate)

Every bundled script, its commands and options, its exit codes and its finding codes, in one place.
This is the candidate for the 0.9 interface freeze: rows marked **frozen** keep their options, exit
codes and finding codes until 1.0 (additions are allowed, renames and removals are not without an
entry in "Upgrading" below and one release of the old name still working). Rows marked **may
change** are still settling, usually because a recent build changed how they are driven.

`--help` on any script prints its full usage. Every script with a check in it has `--selftest`
(known-bad and fixed fixtures, run in CI on every commit); a self-test that ran no case exits 2.

## The exit-code convention

| Exit | Meaning |
|---|---|
| 0 | Clean: everything examined passed, or the action was done (or planned) and read back |
| 1 | Findings, drift, or a refusal by a guard: something is wrong and is named |
| 2 | Could not run, or **examined nothing**. Never a pass: a check that read nothing must not read as clean |
| 3 and up | `canvas-browser.mjs` only: a specific failure of the browser it drives (table below) |

Hooks follow Claude Code's contract instead: exit 0 with nothing printed lets the action through; a
PreToolUse hook blocks with exit 2 (reason on stderr); a Stop or PostToolUse hook blocks with
`{"decision": "block", "reason": ...}` on stdout. A hook with nothing relevant to check stays silent
by design: blocking an unrelated edit or an empty project would be wrong, so the "examined nothing"
rule applies to the checkers the hooks call, not to the hook's own silence.

## Checkers (read only)

| Script | Purpose | Commands and options | Exit | Finding codes | Stability |
|---|---|---|---|---|---|
| `check-canvas-format.mjs` | Long text that clips, theme-token use, contrast, accessible names, the build stamp, `MinScreenWidth` | `<Src or files>... [--schema cols.json] [--char-em N] [--json]`, `--hook`, `--selftest` | 0, 1, 2 (no file or no data-bound control) | `text-overflow`, `autoheight-in-fixed-row`, `literal-text-overflow`, `clamped-without-full-text`, `scroll-in-gallery-row`, `literal-colour`, `literal-font`, `low-contrast`, `contrast-unexamined`, `no-accessible-name`, `list-without-filter`, `build-stamp-visible`, `min-screen-width`, `unmeasured`, `unreadable` | frozen |
| `check-canvas-overlap.mjs` | Controls drawn over other controls, off the canvas or outside a gallery row | `<Src or files>... [--screen-width 1366] [--warnings-fail] [--explain]`, `--hook`, `--selftest` | 0, 1, 2 | `overlap`, `covers-control`, `hidden-under`, `off-canvas`, `outside-row`, `unreadable` | frozen |
| `hooks/check-pa-yaml.mjs` | `.pa.yaml` syntax traps the compiler reports badly; the Src file ceiling | `<Src or files>...`, hook mode on stdin, `--selftest` | 0, 1, 2 (no `.pa.yaml`) | messages, no codes | frozen |
| `lint-flows.mjs` | Cloud-flow definitions: loops, re-triggers, unsafe recipients, raw HTTP | `<path>... [--entity-sets sets.json] [--date-only cols.json] [--work-dir DIR] [--json]`, `--selftest`; records each run in `.ship-work/flow-lint.json` | 0 (warnings allowed), 1, 2 | `self-trigger-loop`, `trigger-cycle`, `alternating-rearm`, `update-trigger-unfiltered`, `writes-filtered-column`, `writes-filtered-column-guarded`, `self-write-not-fired`, `self-write-outside-filter`, `self-write-guard-assumes-value`, `until-loop`, `unsafe-recipient`, `unsafe-http`, `send-as-owner`, `send-after-failed`, `not-on-runafter-path`, `multiple-root-actions`, `runtime-invoker`, `trigger-message`, `trigger-message-mismatch`, `unknown-entity-set`, `date-only-as-instant`, `at-property-name`, `apostrophe-in-literal` | frozen |
| `check-drift.py` | Is a packed app's cached Dataverse metadata stale against the live tables | `<app.msapp or .msapr or solution.zip> [--org URL] [--dump live.json] [--offline] [--src DIR] [--config FILE] [--json] [--token-cmd CMD] [--token-env VAR]`, `--selftest` | 0, 1 (drift), 2 (unreadable, unreachable, or a table not verified) | `DRIFT` lines | frozen |
| `inspect-artifact.py` | What a solution zip or `.msapp` really contains: the half that runs, stamp, data sources, roles, workflows | `<artifact> [--expect A,B] [--absent A,B] [--min-datasources N] [--stamp REGEX] [--allow-roles] [--json]`, `--selftest` | 0, 1, 2 (unreadable, or a solution with nothing in it) | messages, no codes | frozen |
| `check-published-order.py` | The published app's control order against the repository's source | `<published Src> [<repo Src>]`, `--selftest` | 0, 1, 2 (nothing compared) | messages | frozen |
| `audit-pages-permissions.py` | A Power Pages site folder: table permissions, web roles, Web API settings, server logic, Liquid names, headers | `<site folder> [--url URL] [--entity-sets JSON] [--sensitive REGEX] [--json]`, `--selftest` | 0, 1 (critical or warning), 2 (nothing examined) | `NO-PERMISSION`, `NO-ROLE`, `GLOBAL-ANON`, `GLOBAL-AUTH`, `PARENT-MISSING`, `PRIV-MISSING`, `PRIV-UNUSED`, `PERM-NO-CODE`, `APPEND-UNUSED`, `FIELD-NOT-ALLOWED`, `FIELD-SENSITIVE`, `FIELD-UNUSED`, `WEBAPI-OFF`, `WEBAPI-UNUSED`, `WEBAPI-NO-FIELDS`, `WEBAPI-NO-PERMISSION`, `WEBAPI-WILDCARD`, `WEBAPI-WILDCARD-WRITE`, `WEBAPI-GLOBAL-READ`, `GLOBAL-READ-UNGUARDED`, `GLOBAL-READ-GUARDED`, `WEBAPI-INNERERROR`, `OPEN-REGISTRATION`, `CORS-ANY`, `CSP-NOT-SET`, `CSP-DISABLED`, `CSP-UNSAFE-INLINE`, `FRAME-NOT-SET`, `SAMESITE-NONE`, `LIVE-PRIVATE`, `LIVE-STATUS`, `LIVE-UNREACHABLE`, `LIVE-NO-CSP`, `LIVE-CSP-UNSAFE-INLINE`, `LIVE-CSP-UNSAFE-EVAL`, `LIVE-NO-FRAME`, `LIVE-NO-HSTS`, `LIQUID-CASE-CLASH` | may change (Power Pages coverage is growing) |
| `contract-to-walk.mjs` | Acceptance contract to walk scenarios, with coverage findings | `<contract.md> [--out DIR]`, `<contract.md> --check`, `--from-dod <plan.md> [--out-contract FILE]`, `--selftest` | 0, 1, 2 (nothing parsed) | `NO-ACTION`, `NO-SCENARIO`, `NO-THEN`, `NO-CONFIRM`, `UNKNOWN-ID` | frozen |
| `check-all.mjs` | One table for format, overlap, lint, drift, seed and stamp | `[--repo .] [--max 5] [--only a,b] [--json]`, `--selftest` | 0, 1, 2 (nothing failed but a check examined nothing, or nothing ran) | the codes of the checks it runs | frozen |
| `reconcile-report.py` | A Power BI model's figures against a direct Dataverse count | `--checks FILE [--org] [--workspace] [--dataset] [--json] [--token-cmd] [--token-env] [--pbi-token-cmd] [--pbi-token-env]`, `--selftest` | 0, 1 (a DIFF), 2 (cannot run, or the file lists no checks) | `DIFF` lines | frozen |
| `flow-runs.py` | Read a flow's run history and explain a failed run | `list`, `runs <flow> [--status S] [--top N]`, `why <flow> [<run>] [--max-chars N]`; `--env`, `--config`, `--token-cmd`, `--token-env`, `--selftest` | 0 (nothing failed), 1 (a failed run explained), 2 | messages | frozen |

## Builders and deployers (write, plan first)

| Script | Purpose | Commands and options | Exit | Stability |
|---|---|---|---|---|
| `deploy-tables.py` | Dataverse schema from a manifest, idempotent, read back after | `--manifest FILE [--plan] [--org URL] [--token-cmd] [--token-env]`, `--selftest` | 0 (applied or planned, read back complete), 1 (conflict, blocked lookup, missing on read-back), 2 (manifest error, no token, API failure part-way) | frozen |
| `deploy-flows.py` | Cloud flows from a manifest, linted, optionally activated | `--manifest FILE [--apply] [--activate] [--only NAME] [--skip-lint] (offline fixtures only) [--allow-shared-connection]`, `connections --env ENV`; token options, `--selftest` | 0, 1 (refusal, lint error or a lint that could not run, activation refused), 2 | frozen |
| `seed-data.py` | Seed rows: plan, create, check, clean up | `seed --seed FILE [--apply] [--update]`, `check --seed FILE`, `cleanup --seed FILE [--apply]`; `--only TABLE`, `--org`, token options, `--selftest` | 0, 1 (finding or drift), 2 (cannot run, or `check` compared no row) | frozen |
| `ship-canvas.py` | Export, pack, guard and import a canvas app, asserting on the finished zip | `[--dry-run] [--markers A,B] [--absent A,B] [--import] [--publish] [--no-bump] [--live] [--offline] [--accept-drift] [--allow-missing-tables] [--allow-shared-schema] [--config] [--repo] [--org]`, token options, `--selftest` | 0, 1 (a guard refused; nothing importable left), 2 | frozen |
| `fabric.py` | Fabric items in a folder: list, deploy, run, prove a refresh | `items`, `deploy --manifest FILE [--only NAME] [--apply]`, `run TYPE NAME [--job-type J] [--apply]`, `prove-refresh --manifest FILE --checks FILE --check NAME --touch SPEC [--apply]`, `teardown-plan` (read-only deletion order for a folder); `--workspace`, `--folder`, `--prefix`, `--poll`, `--timeout`, token options, `--selftest` | 0, 1 (job failed, a name owned outside the folder, an unresolved reference, a refresh that did not move), 2 | may change |
| `pbi-theme.py` | A Power BI report theme from the design tokens | `--tokens FILE [--name] [--out FILE] [--report DIR [--apply]]`, `--selftest` | 0, 1 (a check failed; nothing written), 2 | frozen |
| `setup-harness.mjs` | Install the hooks and tools into a project (plan first) | `[project dir] [--apply] [--force] [--hooks]`, `--selftest` | 0 (done or nothing to do), 1 (a file differs and was kept), 2 (bad usage) | frozen |
| `assets/doc-kit/doc_kit.py` | The documentation set (Word, PDF) from screenshots and text | see the header of `doc_kit.py` and `build_guides_example.py`; `--selftest` | 0, 1, 2 (no Office or LibreOffice to finish the PDF) | may change |

## Browser drivers

| Script | Purpose | Commands | Exit | Finding codes | Stability |
|---|---|---|---|---|---|
| `canvas-browser.mjs` | Studio and the published canvas player: create, save, publish, walk, confirm in Dataverse | `login`, `check`, `create`, `connection`, `play`, `walk`, `confirm`, `studio [--reload]`, `keys`, `save`, `publish`, `close-studio`, `tabs`, `tidy`, `second-tab`, `studio-has`, `dirty [--toggle]`, `shot`, `lint`, `doctor`, `--selftest`; options include `--timeout`, `--port`, `--settle`, `--fresh`, `--allow-writes`, `--skip-writes`, `--again`, `--unreviewed`, `--batch`, `--no-verify-sources`, `--channel`, `--profile` | 0; 1 a step or check failed; 2 cannot run or nothing examined; 3 wrong state (read-only, not in the editor, app frame missing); 4 a Studio control or action not found or not completed, including `create` finding a table missing from the saved app; 5 browser profile in use; 6 expected content missing, or a writing scenario without `--allow-writes`; 7 a save that did not land (or `dirty` left Save disabled), or a publish refused by a gate; 8 no usable browser; 9 (`doctor`) a selector is stale; 10 a publish after the fix batch without `--batch` or `--unreviewed` | scenario lint findings (messages) | may change: the publish gates and walk options moved in 0.20.x and 0.21 |
| `site-walk.mjs` | A live Power Pages (or any) site: pages at every width, steps, Web API refusal proofs, signed-out leaks | `signin --url URL [--marker SEL] [--accept-site-consent NAME]`, `walk --scenario FILE [--out DIR] [--json FILE] [--allow-writes] [--token-cmd CMD] [--work-dir DIR]`, `ship --site DIR --scenario FILE [--model-version N] [--no-clear]`, `--selftest [--logic-only]`; `--channel`, `--profile`, `--headed`. Scenario keys include `confirm`, `restore`, `capture`, `expectWithin`, `apiFrom`, `layoutChecks`, `layoutIgnore`, `uiChecks`, `navSelector`, `signInSelector`, `signInPath`, `signInTimeout`, steps `pressTwice`, api `repeat`, confirm `filled` and the `{{runId}}`, `{{today+N}}` variables | 0, 1, 2 (no browser, empty scenario, scenario refused, a writing scenario without `confirm` and `restore`, signed out of the site) | `SW-NAV`, `SW-SIGNED-OUT`, `SW-TEXT`, `SW-URL`, `SW-STEP`, `SW-SCROLL`, `SW-API-ALLOWED`, `SW-API-REFUSED`, `SW-API-STATUS`, `SW-API-ROWS`, `SW-SIGNEDOUT-LEAK`, `SW-CONFIRM`, `SW-STALE`, `SW-OVERFLOW`, `SW-COVERED`, `SW-NAV-CURRENT`, `SW-FOCUS`, `SW-FILLED` | may change (new in 0.21) |
| `canvas-mcp.py` | A client for the canvas authoring server: compile, hold, sync, describe; an offline order-independent property diff | `tools`, `compile`, `hold [minutes]` (releases only after a proven save; writes `last-push.json`), `sync DIR [--diff]`, `diff DIR [DIR-B] [--behaviour] [--restyle] [--strict] [--stamp VAR]`, `sources`, `controls`, `schema NAME`, `describe NAME`, `a11y`, `checker`, `accounts`, `--selftest` | 0, 1 (refused or failed, the server did not start, or `diff` found a difference), 2 (usage or configuration, or nothing compared) | messages | may change (the server is a prerelease) |

## Hooks

| Script | Event | Blocks when | Stability |
|---|---|---|---|
| `hooks/preflight.mjs` | SessionStart | never (prints git state, the pac environment, the state file and an update notice) | frozen |
| `hooks/check-standards.mjs` | PostToolUse (Write, Edit) | the written file holds emoji or purple, violet or magenta colours | frozen |
| `hooks/check-pa-yaml.mjs` | PostToolUse | a `.pa.yaml` syntax trap | frozen |
| `hooks/shared-guard.mjs` | PostToolUse | never (a reminder when a shared-prefix table is touched) | frozen |
| `hooks/audit-stop.mjs` | Stop | emoji or purple in the repository, debug markers, missing bookkeeping, the build gate (the same `evaluate` as `plugin-gate.mjs`, scoped per surface) | frozen |
| `hooks/plugin-gate.mjs` | Stop, PreToolUse, PostToolUse (shipped with the plugin) | work out of order (screens before design, tables before the plan, an import before the flow lint), the build gate, the run checks (only in Power Platform projects), tokens written to files; every message names its surface (`rules-and-scope.md`) | may change |
| `hooks/lib.mjs` | (shared helpers) | - | frozen |

## Upgrading from 0.x

No option or finding code has been renamed or removed since 0.1.0; every change so far added a
command, an option or a code. These changes can alter what a caller sees, so check scripts and CI
that call them:

| Version | Change | What to do |
|---|---|---|
| 0.29.0 | `check-pa-yaml.mjs` reports the file ceiling once per folder and fails only above it; it now fails duplicate keys and values without `=`; `canvas-browser.mjs publish` exits 11 when the publish dialog stays open; `site-walk.mjs ship` clears the browser cache, and its default sign-in selector excludes sign-out links | A script that counted per-file FAIL lines at the ceiling reads the one folder line; treat exit 11 as "not published"; a scenario that signed in with its own steps can drop them |
| 0.28.0 | `check-canvas-overlap.mjs` and `check-canvas-format.mjs` exit 2 when a screen file has under half its controls resolved and there are no errors (they warned); `site-walk.mjs` exits 2 with `SW-SIGNED-OUT` when it cannot sign in to the site (it reported page misses, exit 1); `canvas-mcp.py hold` waits for a proven save before releasing; new `check-pa-yaml.mjs` blocks (AccessibleLabel on a Label, an unguarded aggregate compared with 0) | Resolve the layout constants the screen uses, or read 2 as "not verified"; `signInSelector: false` skips the sign-in; after Save, let `hold` see the save (or write `saved` / `discard` to its release file) |
| 0.21.0 | `seed-data.py check` with no seed row to compare, `reconcile-report.py` with no checks, and `inspect-artifact.py` on a solution with nothing in it now exit 2 (they exited 0) | Treat 2 as "not verified", never as a pass |
| 0.22.0 | `site-walk.mjs walk` refuses a writing scenario without `confirm` and `restore` (exit 2), and logs writes to `.ship-work/writes.json` | Add confirm checks that read the rows back; the seed gate now sees site walks |
| 0.23.0 | `site-walk.mjs walk` runs spill and cover checks on every page (`SW-OVERFLOW`, `SW-COVERED`), so a walk that passed before can now exit 1 | Fix the layout, or skip a subtree meant to bleed with `layoutIgnore`; `layoutChecks: false` turns both off |
| 0.25.0 | `lint-flows.mjs` writes `.ship-work/flow-lint.json` on every run (`--work-dir` moves it); the plugin refuses `pac solution import` while flows exist without a clean lint over all of them; `deploy-flows.py` refuses a live run when node is missing, the lint read nothing, or `--skip-lint` is given; the critique floor (30/40) applies to Power Pages only; the run checks (R1 to R3) are silent outside Power Platform projects; the token rule also covers a `fabric/` folder with no report; the harness's `audit-stop.mjs` applies the plugin's build gate (`lib.mjs designGate` removed) | Lint every flow folder before an import; install Node.js where flows deploy; re-run `setup-harness.mjs` so `.claude/hooks/plugin-gate.mjs` is copied |
| 0.24.0 | `site-walk.mjs walk` also checks the menu's current-page marker and focus indicators on every page (`SW-NAV-CURRENT`, `SW-FOCUS`); `audit-pages-permissions.py` warns `GLOBAL-READ-UNGUARDED` (exit 1); the plugin's stop gate covers Power Pages builds (critique at 30/40, review topics) | Fix them, or `uiChecks: false`; set `Webapi/<table>/enabled` = false explicitly; record the critique score and the five review topics |
| 0.21.0 | `canvas-browser.mjs create` reopens the saved app and fails (exit 4) when a table is missing from it; `--no-verify-sources` skips the check. `publish` after the fix batch exits 10 unless `--batch "<what>"` or `--unreviewed "<reason>"` | Let `create` prove its tables; declare a new batch rather than publishing one fix at a time |
| 0.21.0 | `hooks/preflight.mjs` names the branch in a new repository with no commits (it said "Not a git repository yet") | Nothing |
| 0.20.2 | `canvas-browser.mjs publish` refuses a third publish until `docs/design-critique.md` and `docs/review/findings.json` exist; `--unreviewed "<reason>"` overrides. `walk --skip-writes` added | Batch the fixes; pass the reason when there is a real one |
| 0.20.1 | `publish` refuses when the canvas source has not changed since the last publish (exit 7); `--again` overrides | Push, save, then publish once |
| 0.19.0 | `check-all.mjs` added; exit 2 when a check examined nothing | Use it as the one gate in CI |
| 0.7.0 | `check-canvas-overlap.mjs` added, with `--hook` and `--explain` (`check-canvas-format.mjs` had `--hook` from 0.4.0) | Wire the hooks with `setup-harness.mjs` |
| 0.5.0 | `check-canvas-format.mjs` exits 2 when no data-bound control was examined | Point it at the app's `Src` folder, not the repository root |
