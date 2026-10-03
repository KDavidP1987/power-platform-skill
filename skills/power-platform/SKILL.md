---
name: power-platform
description: >-
  Use this skill for any hands-on Microsoft Power Platform work, even a quick question and even if
  the skill isn't named: writing or fixing Power Fx formulas (Filter, Patch, collections, delegation
  warnings, large tables cut off at 500/2,000 rows), building or editing canvas app screens,
  galleries and controls in .pa.yaml files kept in git, Dataverse tables, columns, choices and
  solutions, Power Automate cloud flows, and pac pack/import. Also use it to debug "the button does
  nothing", "works in Studio but not in the published app", columns the app can't see, flows that
  loop or fail on activation, risky bulk writes, and to prove a change works by driving the
  published app with Playwright. It brings repo-first habits and checks of what each ship step
  actually proves. Not for Power BI/DAX, Dynamics C# plugins, desktop (RPA) flows, or custom web
  apps calling the Dataverse API.
license: MIT
metadata:
  author: SkillEra
  version: "0.8.1"
---

# Power Platform development

A working method for building Power Apps canvas apps, Dataverse solutions and Power Automate flows
the way software is built: the definition lives in git, a portable artifact is built from it, the
artifact is deployed deliberately, and the change is proved by **performing the task in the running
product** - not by the fact that it compiled.

Everything here was paid for. Power Platform has an unusual property that shapes the whole method:
**almost every failure is silent**. A pack exits 0 while omitting a component. A compile passes
against no data sources. An import reports success for the wrong artifact. A flow registers and
listens to the wrong event. A formula that throws abandons the rest of the button without a message.
The published app runs a cached manifest that no longer matches the database. So the method is
mostly about one question, asked at every step: **what does this step actually prove, and what
does it not?**

## The non-negotiables

These hold on every task. The reasons are short here; the references carry the full story.

1. **The repo is the source of truth.** Canvas screens are `.pa.yaml` under `canvas/<app>/Src/`;
   the solution is an unpacked tree under `solution/src`. Studio is a validator and a data-source
   editor, never the last place a change was made. Any time Studio had to be touched, re-ship from
   git afterwards.
2. **Assert on the finished artifact, never on the exit code.** `pac solution pack` returns 0 while
   dropping components; an import says "success" for whatever zip it was handed. Open the zip and
   check it contains the change.
3. **Verify in the running product, by performing the task, as the role that will use it.** A
   canvas app has no test framework; the published app is the test harness, and a browser driven
   by Playwright is how you reach it. An admin session proves nothing about a restriction - say a
   gate is unverified rather than imply it was checked.
4. **Verify the effect where it lands.** The screen that wrote a row is the least independent
   witness. Query the table.
5. **Know which half of the app runs, and which build the browser is on.** Read
   `LoadFromYaml`, read the build stamp, refresh the player before judging anything.
6. **Schema before screens, and never in one step.** A new column does not exist for a published
   app until its data source is re-added in Studio and published. Get column types right before
   a canvas app binds them - Dataverse cannot change an attribute's type.
7. **Security roles stay out of the solution.** An import carrying roles resets live access
   control. Every table the app binds must be granted by some role, proved by impersonation.
8. **No flow ships that could loop. This is a hard gate, not a guideline.** Before any import,
   `scripts/lint-flows.mjs` over ALL the solution's flows must exit 0, and no finding may be
   waived. It fails on: an Update trigger without `filteringattributes`; a self-write not stopped
   by a value it changes; any cycle of "this write starts that flow" across flows, including a
   Create-triggered flow creating its own rows; and a write that can land two different values
   which each start a flow. A recovery or sweep job must end in a terminal state a person
   re-arms. The update trigger delivers the whole row, so any other guard loops forever, billed
   per run - one project measured 1,203 runs in 45 minutes. See `references/power-automate.md`
   sections 3 and 4.
9. **Before any bulk write, ask what watches the table** - and count the messages that would go
   to real people, then park the sender. While a build must not reach real people, prove it from
   source (`lint-flows.mjs --require-safe-recipients`) and from run history, and pin the one
   permitted address in the flow source, where no settings edit can widen it.
10. **Query the source; do not filter a copy of it.** A collection holds at most the data row
    limit (500 by default, 2,000 at most) and answers silently from that prefix. When you touch a
    gallery or picker that reads a whole-table collection, move the query into its `Items` as a
    delegable `Filter`/`Search` on the source, filter a lookup by the record or its id (never by
    the related table's column), and say in your notes which clauses delegate and which Studio
    warns on. `references/power-fx-and-pa-yaml.md` section 6.
11. **An audit that can pass vacuously will.** Give every check a floor ("found at least N write
    paths"), prove it goes red on a known-bad input, and make it say when its own inputs are stale.

## The working loop

Every non-trivial change moves through the same cycle. Skipping a step is how a change reaches a
user unproven.

1. **Pre-flight.** Correct branch, clean tree, `pac org who` names the right environment. Read
   the project's state file (`docs/STATE.md` or equivalent) before touching anything. **On a new
   project, offer version control on GitHub** (optional; personal or organisation account) before
   the first change: `references/project-setup.md` section 12.
2. **Specify.** A written spec for anything non-trivial - an issue, or a backlog entry. Include
   who uses it, what proves it works, and what it touches (consult the dependency register).
   **For a new app, take the theme first**: the organisation's palette and restrictions, fonts,
   logo and imagery, icons and symbolism, the landing page, tone, contrast and light/dark. Record
   it as `canvas/theme.json`, define it once as tokens in `App.pa.yaml`, and build every screen on
   the tokens (`references/project-setup.md` section 3). Asked for after ten screens, the theme is
   a rebuild.
3. **Build in source.** Edit `.pa.yaml`, solution XML, or flow JSON in the repo. Hooks check each
   write for the compile-killers in `references/power-fx-and-pa-yaml.md`. **When the hooks are not
   wired in the project, run the checks yourself before you finish** - a YAML comment or an
   unquoted `": "` in a formula fails the whole app's compile, and nothing else will say so:
   `node scripts/hooks/check-pa-yaml.mjs <Src>`, `node scripts/check-canvas-format.mjs <Src>` and
   `node scripts/check-canvas-overlap.mjs <Src>` over every folder you wrote to, and
   `node scripts/lint-flows.mjs <flows>` over every flow. **Every label bound to
   data must fit the longest value it can show, or clamp with an ellipsis and a tooltip** -
   `scripts/check-canvas-format.mjs` checks it, with lengths from Dataverse metadata, and also
   fails literal colours once the theme exists (`references/canvas-layout.md` sections 8 and 9).
   **No control may sit over another that can be on screen at the same time** - a new button over
   a label that only shows under some condition is the commonest layout defect an agent makes.
   `scripts/check-canvas-overlap.mjs` compares every pair across all their `Visible` conditions
   and fails unless the conditions are provably exclusive (`references/canvas-layout.md` section 7).
   **New tables and columns go in a manifest, not in the maker portal**: write `tables.json` (shape
   in `assets/tables.example.json`), run `scripts/deploy-tables.py --plan` and show the person what
   it would create, then run it without `--plan`. It creates only what is missing, never renames,
   retypes or deletes, turns shared tables into references, and reads everything back
   (`references/dataverse.md` section 16).
4. **Audit.** Run the project's audit suite. Treat a stale-input result as unverified, not as a
   pass.
5. **Compile against a live Studio session** (canvas only). This is the only step that proves the
   formulas bind to real data sources. Open Studio first, confirm the title reads `(Editing)`,
   then connect, then compile, and **read the first line of the result** - a "no active
   coauthoring session" warning means it validated against nothing.
6. **Build the artifact on the LIVE manifest and assert on it.** Not the repo's stale `.msapr`.
   Strip security roles. Check the zip contains every component and every marker you changed.
   `scripts/ship-canvas.py` does all of this; `scripts/check-drift.py` alone answers "is the
   app's cached metadata stale" before you build.
7. **Import / publish.** Then confirm what landed: download the app, read `LoadFromYaml`, search the
   half that runs for your markers, compare data-source counts with the previous live app.
8. **Perform the task in the published app** with Playwright, after refreshing past any cached
   build and confirming the build stamp. Check the result in the database on every run: a scenario
   that writes carries `confirm` checks, and `canvas-browser.mjs walk` reads the row back over the
   Web API and fails unless it holds the expected values and changed during this run. Restore
   anything you wrote, and record what you touched.
9. **Document in the same change.** Changelog, dependency register, decisions log, state file.
10. **Refresh the audit inputs** so the next audit describes the app that now exists.
11. **Offer the documentation set** once the app works end to end, and again at each major
    release: a guide per user role, a manager guide, an administrator guide and a developer and
    platform guide, generated from the app and the live environment with screenshots per role
    (`references/documentation-set.md`, kit in `assets/doc-kit/`). Let the developer choose which.

The table of what each step proves, and the two ship paths (solution import vs co-authoring push),
are in `references/canvas-shipping.md`. Read it before the first ship in a session.

## Where to look

Read only the reference the task needs. Each one is self-contained.

| If the task involves | Read |
|---|---|
| **Canvas apps** | |
| Shipping a canvas change and proving it landed: the two ship paths, building on the live manifest, build stamps, `LoadFromYaml`, Save vs Publish proof, player caching, imports that remove nothing, rollback, the screen-file ceiling | `references/canvas-shipping.md` |
| Studio opens read-only, `connect` returns 422, a compile shows thousands of "isn't recognized", a restore says "locked by user", the authoring MCP misleads (`isError`, contract drift) | `references/authoring-sessions.md` |
| "Works in Studio, fails in the published app"; a new column/choice/table the app cannot see; option-set members, column types, entity set names, data sources the player never initialises, the Data pane | `references/manifest-caches.md` |
| Writing or debugging Power Fx or `.pa.yaml`: silent no-op buttons, `App.OnStart`, collections, types, lookups in queries, delegation and the row limit, chunked large-table reads, identity, compile output | `references/power-fx-and-pa-yaml.md` |
| Building or debugging a screen: TextInput/NumberInput/CheckBox/ComboBox/DropDown/Gallery/Timer quirks, OnChange firing on render, Default/Reset, edit screens and concurrency, permission gates, overlays, read-model tables, honest UX, list filters/search/grouping, communication history and resend, template guides with live preview | `references/canvas-controls-and-patterns.md` |
| Layout: text width and clipping, long data-bound text (the fit rule and its four remedies), gallery row slicing, scrollbars, z-order, unclickable controls, geometry audits, theme tokens | `references/canvas-layout.md` |
| Driving Studio or the published app with Playwright: scenarios, iframes, committing input, dropdowns, stale player cache (IndexedDB), save/publish proof, MCP startup timeouts, scenario design and negative tests, dead-click and clip sweeps, OData trace instead of Monitor | `references/browser-verification.md` |
| **Dataverse** | |
| Solutions and schema: pack/unpack, asserting on the artifact, imports that never remove, what cannot change after creation, solution membership and shared tables, retiring components, column types, schema hygiene, delete behaviour, effective dating | `references/dataverse.md` |
| Scripting the Web API: idempotent provisioning, payload ordering, which errors to retry, metadata PUTs, choice members, alternate keys, solution components, dependencies, paging and counts, `systemuser`, PowerShell 5.1 traps | `references/dataverse-web-api.md` |
| Who can read or write: roles kept out of solutions, `ReplacePrivilegesRole`, depth and record sharing, Append/AppendTo, impersonation, column security, SharePoint virtual tables, onboarding users | `references/security-and-access.md` |
| Writing live data: migrations, backfills, spreadsheet loads, crosswalks, agreement audits, purges, rollup rebuilds, cutover | `references/data-migration.md` |
| **Power Automate** | |
| Cloud flows: definition shape, triggers and message codes, `runtimeSource`, loops and sentinels, activation-only defects, dates and nulls, imports changing flow on/off state, run-as identity, notifications and safety caps, bulk writes, FetchXML, run history, the communication log and resend, documents and templates (link, stored file, generated), attachment encoding | `references/power-automate.md` |
| **Reporting** | |
| Reports for an app: the append-only history table every trend chart needs (start it first), baseline and labelled demo history, commitment fields, in-app charts from galleries (burn-down, burn-up, velocity, throughput, cycle time, aging, mix) and their compile traps, metric definitions, Power BI over a Fabric medallion (bronze, silver daily snapshot, gold facts, Direct Lake model), viewer licensing | `references/reporting.md` |
| **Process and environment** | |
| Writing or trusting an audit; stale inputs; vacuous passes; reusable tool designs | `references/audits.md` |
| Starting from nothing: what the person needs, the machine, pac, a self-renewing token, a browser that signs in by itself, Studio and the authoring server, the app config, what the agent hands back, and the smoke test to run before the first change | `references/first-run.md` |
| Starting a repo or a new app: theme intake (palette, fonts, logo, imagery, symbolism, landing page) before the first screen, layout, bootstrap, hooks, continuity docs, trackers, templates, CI, shipping without pipeline rights, offering GitHub version control (what it is, personal against organisation accounts, commit identity, releases) | `references/project-setup.md` |
| CI/CD: service-principal pac auth, export/unpack on a branch, pack + Solution Checker, managed vs unmanaged and upgrade, deployment settings for connection references and environment variables, importing flows off then activating, powerplatform-actions / Build Tools, the skill's tools as pipeline gates | `references/alm-pipelines.md` |
| Several apps sharing one environment or a shared reference solution | `references/shared-environments.md` |
| pac, tokens, the TDS endpoint, MCP servers, Windows/OneDrive/PowerShell failures, and production actions Claude Code must hand to a person | `references/tooling-and-auth.md` |
| Model-driven forms by script, user guides/SOPs from the running app, licensing, weekly reporting from git, replacing a spreadsheet tool | `references/model-driven-and-docs.md` |
| The documentation set for a finished app: user, manager, administrator and developer guides, chapter skeletons, screenshots per role, the doc kit, the inventory check | `references/documentation-set.md` |

## Bundled tools

All are dependency-light and project-agnostic; each reads its configuration from the project rather
than carrying an id. Run any of them with `--help`.

| Tool | Use |
|---|---|
| `scripts/canvas-browser.mjs` | Playwright driver for the maker portal and the published player: `login`, `check`, `play`, `walk <scenario.json>`, `studio`, `save`, `publish`, `close-studio`, `shot`, `doctor`, `confirm`. `--fresh` clears the player's cached build, `--trace` records `$batch` traffic, `--channel` picks Chrome, Edge or bundled Chromium. A scenario that writes must declare a `restore` and `confirm` checks: after the steps the walk reads the rows back over the Web API (token from `dataverseTokenCommand` in the app config) and fails unless they hold the expected values and changed during this run. `expect` also finds `Notify()` banners, which the player draws outside the app frame. `lint` checks a scenario without a browser. Every UI anchor it depends on is in `assets/selectors.json`; `doctor` checks them against a live, signed-in session (exit 0 all resolve, 9 stale, 2 cannot verify - never a pass offline). Needs `npm i playwright`. |
| `scripts/inspect-artifact.py` | Opens a solution zip or `.msapp` and reports what is really inside: root components vs built metadata, security roles, canvas `LoadFromYaml`, build stamp, data-source count, `DatabaseReferences` vs `DataSources.json`, marker search in the half that runs. Python 3 standard library only. |
| `scripts/check-drift.py` | Compares a canvas app's cached Dataverse metadata with the live environment, read-only: tables, entity set names (every cached copy), columns the formulas use, column types, choice members in both caches, lookup navigation names, and `<DatabaseReferences>` vs `DataSources.json`. Each drift names what breaks in the published app and the fix. `--dump` / `--offline` run it in CI without a tenant. Exit 2 is never a pass. Python 3 standard library only. |
| `scripts/deploy-tables.py` | Dataverse schema from a JSON manifest (`assets/tables.example.json`): publisher, solution, tables, columns (text, memo, whole number, decimal, currency, yes/no, date, date and time, choice, autonumber, file), lookups, publish, then every table owned by another solution that a lookup pulled in WITH its schema turned back into a reference, then a read-back of every table, column, option and lookup. `--plan` prints every change and writes nothing. Idempotent; never renames, retypes or deletes; choice options append-only; a manifest error is refused before any call. Exit 0 deployed and read back, 1 conflict or missing on read-back, 2 could not run. Python 3 standard library only. |
| `scripts/ship-canvas.py` | The solution-import ship: build on the LIVE manifest, reconcile the caches, stamp the build, strip roles, repair the player list, pack with pac, then assert on the finished zip (inspect-artifact + check-drift). `--dry-run` writes nothing and runs no pac; it never imports without `--import`. Reads `scripts/canvas-app.json`. Python 3 standard library only. |
| `scripts/lint-flows.mjs` | Static checks on cloud-flow definition JSON: invoker runtime on non-app triggers, self-writes whose path conditions are not FALSE after the write (it parses the expressions and follows one level of Compose/variable indirection; warns when a guard holds only if a run-time value is non-blank), apostrophes in expression literals, references outside the `runAfter` path, trigger message codes, sends chained after `Failed`, single-`@` property names, multiple triggers, date-only columns used as instants (`--date-only`), cross-flow cycles. Node 18+. |
| `scripts/check-canvas-format.mjs` | Formatting rules no compile enforces, from canvas source: every data-bound text control must fit the widest value its expression can produce (lengths from a Dataverse-metadata schema, choices by their labels, collections from the formulas that build them) or carry a remedy - clamp plus a tooltip that reads the same columns, a flexible-height row, a detail view, or a scrolling detail pane; and screens use theme tokens, not literal colours or fonts. `--hook` runs it as a PostToolUse hook. Prints what it examined; exit 2 when nothing was. Node 18+. |
| `scripts/check-canvas-overlap.mjs` | Controls drawn over other controls, from canvas source: every pair of text-bearing or interactive controls in the same coordinate space (screen, container, gallery row) whose boxes overlap and whose `Visible` conditions - their own and every ancestor's - are not provably exclusive; decoration declared after a button (dead click) or a label (hidden text); controls off the design surface or outside their gallery row. Geometry from literals, `App.OnStart` globals, `Parent`, other controls and every `If`/`Switch` branch, each branch compared only with the conditions it holds under. Modal backdrops, empty states over their own gallery and text-less click pads are exempt; `--explain` lists every exemption. `--hook` runs it at write time. Prints how many controls it resolved; exit 2 when none. Node 18+. |
| `scripts/hooks/check-pa-yaml.mjs` | Claude Code PostToolUse hook: flags the `.pa.yaml` faults that fail a whole-app compile, at write time. |
| `scripts/hooks/check-standards.mjs`, `audit-stop.mjs`, `preflight.mjs` | Optional output-standards hook, end-of-turn audit, and session pre-flight. Wiring in `assets/settings.snippet.json`. |

**Playwright, two ways.** For an interactive investigation, use the Playwright MCP server's
browser tools (navigate, snapshot, click, evaluate) directly - they are the fastest way to look.
For anything that should be repeatable - a regression scenario, a post-ship verification, a sweep
for unclickable controls - write a JSON scenario and run it with `canvas-browser.mjs walk`. A
verification you cannot re-run is an anecdote. The bundled driver also works when the MCP server
did not attach to the session, which happens.

**When Playwright is not there.** Check before relying on it: the MCP tools are present in the
session, or `node -e "import('playwright')"` succeeds in the repo. If neither, do not install
anything silently - ask, and offer the lighter option first: `npm i -D playwright` drives the
Chrome or Edge already on the machine (`--channel chrome|msedge`); only without either is
`npx playwright install chromium` needed (`--channel chromium`). The MCP server is a separate,
optional install (`claude mcp add playwright -- npx @playwright/mcp@latest`). Until a browser
check can run, the change is **unverified**: say so, keep going with the parts that need no
browser (`lint`, `--selftest`, `inspect-artifact.py`, the hooks), and give the user the exact
steps to perform in the published app and the Web API query that would confirm the effect.

**When Studio or the player changes.** Run `canvas-browser.mjs doctor` after a Playwright upgrade
or whenever the driver stops finding something, and fix stale entries in `assets/selectors.json`.
A monthly upkeep workflow re-runs every self-test and flags new Playwright versions against
`assets/tested-versions.json`.

## How to behave

- **Lead with the mechanism, then the fix.** When diagnosing, name which cache or which half or
  which step is lying, explain why every green signal so far was answering a different question,
  and give the shortest test that would move the failure (change one thing, ship it alone).
- **State what is unproven.** If a restriction could only be tested as an admin, if a check ran on
  stale inputs, if a count is an upper bound - say so in the output. Confidence you do not have is
  the most expensive thing you can give a Power Platform developer.
- **Every write is production data** unless proven otherwise. Dry-run first, print the rows, fill
  blanks rather than overwrite disagreements, read back after writing, make it idempotent.
- **When a step is the person's, hand them one line to run in this session**, not a list of
  commands for a separate PowerShell window. Run every offline step yourself first, then give a
  single `!`-prefixed command with absolute quoted paths that runs as-is from bash or PowerShell, say
  what it does and what result to expect, and verify the effect yourself once its output comes back.
  A separate terminal only when an interactive prompt cannot appear in the session.
  `references/tooling-and-auth.md`, "The safety layer refuses some production actions".
- **Read the first diagnostic, not the loudest.** One broken `ClearCollect` in `App.OnStart`
  produces hundreds of errors on screens nobody touched.
- **Never reload Studio while a co-authoring push is held, never import while one is held, and
  close Studio through its Back button.** Each of these silently discards work or strands a lock.
- **Treat measured behaviour as measured.** The references record what real projects observed;
  Microsoft changes Studio, the player and connectors. Where a reference says "observed once" or
  gives a measured range, confirm it in your environment before building on it.
- **Write it down where the next person will look.** When a session learns something that is not
  specific to one app, put it in the shared standards, not only the project's notes - the same
  trap otherwise gets paid for twice.
