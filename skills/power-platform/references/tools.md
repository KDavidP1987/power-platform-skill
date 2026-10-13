# Bundled tools

## Contents

1. Every bundled tool
2. Playwright, two ways
3. When Playwright is not there
4. When Studio or the player changes
5. Alongside Microsoft's official plugins

Options, exit codes and finding codes for each script are in `interfaces.md`; run any script with
`--help`.

## 1. Every bundled tool

All are dependency-light and project-agnostic; each reads its configuration from the project rather
than carrying an id. Run any of them with `--help`.

| Tool | Use |
|---|---|
| `scripts/canvas-browser.mjs` | Playwright driver for the maker portal and the published player: `login`, `check`, `create` (a new blank app in the solution, Coauthoring on, tables added by logical name, then the saved app reopened to prove every table stayed; exit 4 names one that did not), `connection` (this build's own signed-in connection: account and environment checked against the config, OAuth consent finished in the signed-in browser, plan unless `--apply`), `play`, `walk <scenario.json>`, `studio`, `save`, `publish`, `close-studio`, `second-tab`, `studio-has`, `dirty`, `tabs`, `tidy` (closes blank and leftover tabs), `shot`, `doctor`, `confirm`. Walk steps include `viewport` (phone and desktop in one walk), `radio` and `pick` (classic DropDown). `--fresh` clears the player's cached build, `--trace` records `$batch` traffic, `--channel` picks Chrome, Edge or bundled Chromium (falls back to Edge when Chrome will only open in the running session). A scenario that writes must declare a `restore` and `confirm` checks: after the steps the walk reads the rows back over the Web API (token from `dataverseTokenCommand` in the app config) and fails unless they hold the expected values and changed during this run. `expect` also finds `Notify()` banners, which the player draws outside the app frame. `lint` checks a scenario without a browser. Every UI anchor it depends on is in `assets/selectors.json`; `doctor` checks them against a live, signed-in session (exit 0 all resolve, 9 stale, 2 cannot verify - never a pass offline). Needs `npm i playwright`. |
| `scripts/site-walk.mjs` | Playwright driver for a live Power Pages site: `signin` once (headed, persistent profile; `--accept-site-consent` accepts only the site's own sign-in consent when nobody is present), then `walk <scenario.json>` at 1440 and 390 px: steps, expected text, sideways-scroll, spill, covered-control, current-page-marker and focus-indicator checks on every page, double writes (`pressTwice`, `repeat`), columns the site must fill, `ship` (audit, upload, cache clear and walk in one call), page-only screenshots, Web API probes sent from inside the signed-in page with the site's anti-forgery token (a hidden row by id or filter, another person's row, PATCH, DELETE, a forbidden create: each must be refused), and signed-out leak checks in a fresh context. Example in `assets/scenarios/site-walk.example.json`. Exit 2 when it examined nothing. |
| `references/interfaces.md` | Every script's options, exit codes and finding codes in one table, with upgrade notes (the 0.9 interface freeze candidate). |
| `scripts/inspect-artifact.py` | Opens a solution zip or `.msapp` and reports what is really inside: root components vs built metadata, security roles, canvas `LoadFromYaml`, build stamp, data-source count, `DatabaseReferences` vs `DataSources.json`, marker search in the half that runs. Python 3 standard library only. |
| `scripts/check-drift.py` | Compares a canvas app's cached Dataverse metadata with the live environment, read-only: tables, entity set names (every cached copy), columns the formulas use, column types, choice members in both caches, lookup navigation names, and `<DatabaseReferences>` vs `DataSources.json`. Each drift names what breaks in the published app and the fix. `--dump` / `--offline` run it in CI without a tenant. Exit 2 is never a pass. Python 3 standard library only. |
| `scripts/deploy-tables.py` | Dataverse schema from a JSON manifest (`assets/tables.example.json`): publisher, solution, tables, columns (text, memo, whole number, decimal, currency, yes/no, date, date and time, choice, autonumber, file), lookups, publish, then every table owned by another solution that a lookup pulled in WITH its schema turned back into a reference, then a read-back of every table, column, option and lookup. `--plan` prints every change and writes nothing. Idempotent; never renames, retypes or deletes; choice options append-only; a manifest error is refused before any call. Exit 0 deployed and read back, 1 conflict or missing on read-back, 2 could not run. Python 3 standard library only. |
| `scripts/ship-canvas.py` | The solution-import ship: build on the LIVE manifest, reconcile the caches, stamp the build, strip roles, repair the player list, pack with pac, then assert on the finished zip (inspect-artifact + check-drift). `--dry-run` writes nothing and runs no pac; it never imports without `--import`. Reads `scripts/canvas-app.json`. Python 3 standard library only. |
| `scripts/lint-flows.mjs` | Static checks on cloud-flow definition JSON: invoker runtime on non-app triggers, self-writes whose path conditions are not FALSE after the write (it parses the expressions and follows one level of Compose/variable indirection; warns when a guard holds only if a run-time value is non-blank), apostrophes in expression literals, references outside the `runAfter` path, trigger message codes, sends chained after `Failed`, single-`@` property names, multiple triggers, date-only columns used as instants (`--date-only`), cross-flow cycles. Node 18+. |
| `scripts/check-canvas-format.mjs` | Formatting rules no compile enforces, from canvas source: accessible names on inputs and click targets (a note at write time, not a block), WCAG text contrast against the real backdrop at desktop and phone width (unresolved counted, never passed), literal captions that clip, and every data-bound text control must fit the widest value its expression can produce (lengths from a Dataverse-metadata schema, choices by their labels, collections from the formulas that build them) or carry a remedy - clamp plus a tooltip that reads the same columns, a flexible-height row, a detail view, or a scrolling detail pane; and screens use theme tokens, not literal colours or fonts. `--hook` runs it as a PostToolUse hook. Prints what it examined; exit 2 when nothing was. Node 18+. |
| `scripts/check-canvas-overlap.mjs` | Controls drawn over other controls, from canvas source: every pair of text-bearing or interactive controls in the same coordinate space (screen, container, gallery row) whose boxes overlap and whose `Visible` conditions - their own and every ancestor's - are not provably exclusive; decoration declared after a button (dead click) or a label (hidden text); controls off the design surface or outside their gallery row. Geometry from literals, `App.OnStart` globals, `Parent`, other controls and every `If`/`Switch` branch, each branch compared only with the conditions it holds under. Modal backdrops, empty states over their own gallery and text-less click pads are exempt; `--explain` lists every exemption. `--hook` runs it at write time. Prints how many controls it resolved; exit 2 when none. Node 18+. |
| `scripts/seed-data.py` | Sample and fixture rows from JSON or CSV, idempotent by a key column: choices by label, dates relative to today (`=today-3`), lookups by the target row's key (including rows created in the same run). `cleanup` lists the rows it would delete and only deletes with `--apply`. `list` prints the same plan and can never write. Plan by default. Python 3 standard library only. |
| `scripts/deploy-flows.py` | Solution cloud flows and this build's own prefixed connection references from a manifest (`assets/templates/flows.example.json`): lints first, turns an active flow off before updating it, activates and reads the state back, reports a refused activation with the server's reason. Refuses a connection bound by another prefix's connection reference. Plan by default. |
| `scripts/fabric.py` | Fabric items from repo files into one workspace folder, idempotently (`deploy`), list (`items`), and run a pipeline or notebook job and wait (`run`). Resolves item ids and SQL endpoints at deploy time; refuses unfilled template tokens and names that exist outside the folder. Templates in `assets/templates/fabric-medallion/`. Plan by default. `teardown-plan` lists a folder's items in a safe deletion order (Dataflows before their lakehouse) for the person; it deletes nothing. |
| `scripts/reconcile-report.py` | Each report figure's DAX (executeQueries) against an independent Dataverse count, sum or group; exit 1 on any difference. Read-only. |
| `scripts/pbi-theme.py` | A Power BI report theme from the app's `theme.json` tokens, installed into a PBIR report folder; refuses purple, violet, indigo and magenta, contrast under 4.5:1 and unset values. |
| `scripts/check-all.mjs` | One call for the routine checks: canvas format, overlap, flow lint, drift, seed drift and the build stamp, printed as one compact table with an exit code. Use it instead of a shell call per check. |
| `assets/templates/pages-decisions.md` | The go-live decisions for a Power Pages portal, settled in the first batch: audience and visibility, identity for people who are not Dataverse users, licence, access without invitations, freshness; each with the recommendation to take when no person answers. |
| `assets/templates/design-prototype.html`, `reviewer-prompt.md`, `screenshot-walk.json` | The design lane's HTML prototype skeleton (tokens as CSS properties, both widths, no palette of its own), the independent reviewer's prompt, and the walk that captures every published screen at 1440 and 390 px for the design critique. |
| `scripts/setup-harness.mjs` | Installs this method's harness into a project: the hooks wired with `$CLAUDE_PROJECT_DIR`, the tools, the config and continuity documents, `.gitignore` entries and the version record the pre-flight's update notice reads. Plan by default, `--apply` to install; never overwrites a changed file or removes anything; merges into an existing `settings.json`. |
| `scripts/canvas-mcp.py` | Direct stdio client for the canvas authoring server: `tools` (the argument names it accepts now), `compile`, `hold` (push, refuse unless clean, hold the session until a release file appears and a save newer than the push is proven), `sync` (never into `Src`; `--diff` compares it with `Src` property by property), `diff` (offline, order-independent; `--restyle` refuses behaviour changes and collapsed colour branches), `sources`, `schema`, `describe`, `a11y`, `checker`, `accounts`. Sends `login_hint` so connect never prompts; always releases the session and kills the server tree. |
| `scripts/check-new-galleries.py` | Names every gallery in the repo's source that the live app does not have yet: in October 2026 a gallery created from source broke a published app while every package check passed. Workaround in `references/canvas-shipping.md` section 4. Exit 2 when nothing was compared. Python 3 standard library only. |
| `scripts/check-published-order.py` | Compares control (z-)order in a downloaded published app with the repo; catches a push that drew a card over its gallery while every property matched. |
| `scripts/contract-to-walk.mjs` | Checks an acceptance contract's coverage (requirement without action, action without scenario, write or refusal without a Dataverse confirm) and writes one walk scenario skeleton per row. |
| `scripts/flow-runs.py` | Read-only flow run diagnosis: `list`, `runs <flow>`, `why <flow> [run]` walks to the deepest specific error (inside nested loops, on the failing iteration), prints its inputs and outputs and the side effects a resubmit would repeat. |
| `scripts/audit-pages-permissions.py` | Audits a downloaded Power Pages site: table permissions, Web API allow-lists and header settings against the Liquid and `/_api` calls in its code; optional anonymous live-header read. |
| `scripts/dv-token.ps1` | A Dataverse token with one sign-in: device code once, then a rotating cached refresh token; prints the token for `dataverseTokenCommand`, `-WhoAmI` to prove it. |
| `scripts/hooks/check-pa-yaml.mjs` | Claude Code PostToolUse hook: flags the `.pa.yaml` faults that fail a whole-app compile, at write time. |
| `scripts/hooks/check-standards.mjs`, `shared-guard.mjs`, `audit-stop.mjs`, `preflight.mjs` | Optional output-standards hook, shared-table reminder, end-of-turn audit, and session pre-flight (with a once-a-day update notice). Wiring in `assets/settings.snippet.json`; `setup-harness.mjs` installs them. |

## 2. Playwright, two ways

For an interactive investigation, use the Playwright MCP server's
browser tools (navigate, snapshot, click, evaluate) directly - they are the fastest way to look.
For anything that should be repeatable - a regression scenario, a post-ship verification, a sweep
for unclickable controls - write a JSON scenario and run it with `canvas-browser.mjs walk`. A
verification you cannot re-run is an anecdote. The bundled driver also works when the MCP server
did not attach to the session, which happens.

## 3. When Playwright is not there

Check before relying on it: the MCP tools are present in the
session, or `node -e "import('playwright')"` succeeds in the repo. If neither, do not install
anything silently - ask, and offer the lighter option first: `npm i -D playwright` drives the
Chrome or Edge already on the machine (`--channel chrome|msedge`); only without either is
`npx playwright install chromium` needed (`--channel chromium`). The MCP server is a separate,
optional install (`claude mcp add playwright -- npx @playwright/mcp@latest`). Until a browser
check can run, the change is **unverified**: say so, keep going with the parts that need no
browser (`lint`, `--selftest`, `inspect-artifact.py`, the hooks), and give the user the exact
steps to perform in the published app and the Web API query that would confirm the effect.

## 4. When Studio or the player changes

Run `canvas-browser.mjs doctor` after a Playwright upgrade
or whenever the driver stops finding something, and fix stale entries in `assets/selectors.json`.
A monthly upkeep workflow re-runs every self-test and flags new Playwright versions against
`assets/tested-versions.json`.

## 5. Alongside Microsoft's official plugins

Microsoft publishes Power Platform plugins (`microsoft/power-platform-skills`) that generate:
canvas screens through the same authoring server this skill drives, model-driven apps, code apps,
Power Pages code sites, flows through their own server, and mobile apps. They stop where this skill
starts - their canvas skill ends at a clean compile, with no save, publish or test in the published
app. Use both: theirs to generate where it has a generator (and for code apps, code sites, mobile and
PCF, which this skill does not cover); this skill for the schema, the shared-environment rules, the
ship, the proof in the published app, and the guards. When their planner writes a requirements
matrix, turn it into this skill's acceptance contract and walk it.
