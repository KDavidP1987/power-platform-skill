---
name: power-platform
description: >-
  Builds, ships and verifies Microsoft Power Platform work the way software is built: canvas apps
  as .pa.yaml in git, Dataverse tables, choices, roles and solutions, Power Automate cloud flows,
  pac pack and import, reporting from app history, and Power Pages sites (pages in git, table
  permissions, Liquid and the Pages Web API). Use it for any hands-on Power Platform task,
  even a quick question and even if the skill isn't named: writing or fixing Power Fx (Filter,
  Patch, collections, delegation warnings, tables cut off at 500/2,000 rows), canvas screens,
  galleries and pickers, Dataverse columns and security, flows that loop or fail on activation,
  risky bulk writes, "the button does nothing", "works in Studio but not in the published app",
  columns the app can't see, and proving a change by driving the published app with Playwright.
  Not for DAX or Power BI report authoring, Dynamics C# plugins, desktop (RPA) flows, or custom web
  apps calling the Dataverse API.
license: MIT
metadata:
  author: SkillEra
  version: "0.29.0"
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

## Start here: a new app or solution, in this order

A measured build read this skill, followed the brief's concrete steps and skipped every design and
planning step below, which then cost it the design score. These are actions, not advice. For a new
app or a multi-part build, before any table, screen or flow:

1. **Plan and decide, in minutes.** Write the acceptance contract from the brief
   (`assets/templates/acceptance-contract.md`): every numbered requirement as a row someone can
   perform, the business rules the brief leaves implicit (a pending request reserves the item, a
   typed date gets a format message, which state wins when two answers race), and one list of
   decisions, each with a recommendation. **No person present (a headless run)? Take every
   recommendation, record it in `docs/decisions.md`, and never end a turn on a question**: the
   plugin blocks that stop. DOD is opt-in (section "Planning with DOD" in `references/orchestration.md`).
2. **Harness.** Install it (`scripts/setup-harness.mjs --apply`); with no person present, install
   with the defaults rather than skipping it. It wires the checks and compacting at 40%.
3. **Design and schema at the same time.** In one message: a design helper invokes the impeccable
   skill (`init` for PRODUCT.md and DESIGN.md, creating the theme when none is given, then
   `design/prototype.html` for every screen at 1440 and 390 px and the report page, one critique, one
   fix batch), while the lead deploys the schema, seeds the sample data and creates this build's
   connections (`references/project-setup.md` section 3).
4. **Build in lanes.** Flows and reporting start as soon as the schema is in; canvas (one helper per
   screen) as soon as the prototype is. Wait for every helper and every background command before
   ending a turn; run walks in the foreground (`references/orchestration.md`).
5. **Prove and hand back.** Straight after the first publish, in one message: the critique helper,
   the read-only reviewer (fifteen minutes) and the lead's own walks. Then one fix batch for
   everything they found, one publish, one walk call, the seed restored and checked, the report
   refreshed in the background while the hand-back is written. Budget: about an hour of agent time
   for a five-screen app with two flows and a medallion (`references/orchestration.md`, the
   timeline).

The plugin enforces this order with its own hooks, no project setup needed. Before a tool runs, it
refuses a new app's screen `.pa.yaml` until DESIGN.md and `design/prototype.html` exist, and a table
deploy until the plan exists (a filled `docs/acceptance-contract.md`, or a DOD plan when the person
chose DOD). At the end it blocks the hand-back, up to three times, while the critique or the
reviewer's record is missing, while background work this session started is still running, while a
walk wrote data after the last clean seed check, or, with no person present, while the last message
asks the person a question. After shell calls it reports the
budget (the call count every 40, the elapsed time at 45, 60, 90 and 120 minutes). The browser driver
enforces its own hygiene: it closes blank tabs after every command, keeps one Studio tab, answers
Studio's Coauthoring terms dialog per `acceptCoauthoringTerms`, refuses a publish when the canvas
source has not changed since the last one, refuses a third publish until the critique and the
review are both written (one fix batch), runs every walk scenario in one call (`walk <folder>`), and
fails a step where the page scrolls sideways after a resize.
A denial is an instruction: do the named step with its tool, then retry; do not work around it.

## The non-negotiables

These hold on every task. The reasons are short here; the references carry the full story.
Which of them a hook enforces, which a script refuses, and which stay instructions, and the surface
each applies to, is in `references/rules-and-scope.md`.

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
   sections 3 and 4. Enforced: the plugin refuses `pac solution import` until a clean lint over
   every flow is recorded (`.ship-work/flow-lint.json`, written by each lint run), and
   `deploy-flows.py` refuses a live run it could not lint.
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
   the first change: `references/project-setup.md` section 12. **Offer the harness** too - the
   hooks and tools this method runs every cycle - and install it with `scripts/setup-harness.mjs`
   when the person agrees, or with its defaults when no person is present (plan first; `references/project-setup.md` section 4). When a sign-in
   prompt appears, fix its cause rather than repeating it (`references/first-run.md` section 13).
2. **Specify.** A written spec for anything non-trivial - an issue, or a backlog entry. Include
   who uses it, what proves it works, and what it touches (consult the dependency register).
   For an app or feature with several actions, write the acceptance contract
   (`assets/templates/acceptance-contract.md`) and generate its walks with `contract-to-walk.mjs`,
   so every requirement is performed in the published app (`references/browser-verification.md`
   section 18).
   **For a new app, take the theme first**: the organisation's palette and restrictions, fonts,
   logo and imagery, icons and symbolism, the landing page, tone, contrast and light/dark. Record
   it as `canvas/theme.json`, define it once as tokens in `App.pa.yaml`, and build every screen on
   the tokens (`references/project-setup.md` section 3). Asked for after ten screens, the theme is
   a rebuild. **Run the impeccable design skill; it is a required step**: `init` for `PRODUCT.md`
   and `DESIGN.md` before the first screen (creating the theme when none is given), then **design
   every screen and the report page in HTML first** (`design/prototype.html`, critiqued and fixed
   with impeccable before any `.pa.yaml` is written), tokens and the Power BI theme from it, and
   after the ship a `critique` of the published screens and report from screenshots, recorded in
   `docs/design-critique.md` (`references/project-setup.md` section 3). Never ship Power BI's default
   theme. **The acceptance contract is the plan** (DOD only when the person chose it, capped as in
   `references/orchestration.md`). **Before the hand-back, an
   independent reviewer** (a fresh helper, `assets/templates/reviewer-prompt.md`) walks the contract
   and the design record; fix its findings in one batch.
   **For a build with several parts, orchestrate**: schema and sample data first, then the canvas
   app, flows and reporting in parallel helper agents with one screen per helper, the lead running
   the acceptance walks (`references/orchestration.md`).
   **Create the app yourself**: `scripts/canvas-browser.mjs create` makes a new blank app in the
   solution, turns Coauthoring on and adds the tables, in about two minutes. Studio-only steps are
   the browser's work, not the person's (`references/canvas-shipping.md`, "Creating a new canvas
   app").
3. **Build in source.** Edit `.pa.yaml`, solution XML, or flow JSON in the repo. Hooks check each
   write for the compile-killers in `references/power-fx-and-pa-yaml.md`. **When the hooks are not
   wired in the project, run the checks yourself before you finish** - a `#` line inside a formula
   or an unquoted `": "` in one fails the whole app's compile, and nothing else will say so:
   `node scripts/hooks/check-pa-yaml.mjs <Src>`, `node scripts/check-canvas-format.mjs <Src>` and
   `node scripts/check-canvas-overlap.mjs <Src>` over every folder you wrote to, and
   `node scripts/lint-flows.mjs <flows>` over every flow. **Every label bound to
   data must fit the longest value it can show, or clamp with an ellipsis and a tooltip** -
   `scripts/check-canvas-format.mjs` checks it, with lengths from Dataverse metadata, and also
   fails literal colours once the theme exists (`references/canvas-layout.md` sections 8 and 10).
   Every text control must fit vertically as well as horizontally (`text-cut-vertically`: Size is
   points, a line is about 1.15 x Size x 4/3 px; a one-line data cell takes Wrap false and a tooltip).
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

Read only the reference the task needs. Each topic has one home; another reference that touches it
points there.

| If the task involves | Read |
|---|---|
| **Building a whole solution** | |
| Planning and deciding up front (DOD opt-in, capped), running with no person present, the time budget, the design lane (impeccable, an HTML prototype of every screen and the report before any `.pa.yaml`), parallel lanes after the schema (canvas, flows, reporting), helper agents per screen, the lane contract and lock owners, keeping the lead's context and cost small (batched checks, compaction), a hands-off person (decisions only), browser hygiene, the independent reviewer and the single verification-and-fix round | `references/orchestration.md` |
| **Canvas apps** | |
| Shipping a canvas change and proving it landed: the two ship paths, building on the live manifest, build stamps, `LoadFromYaml`, Save vs Publish proof, player caching, imports that remove nothing, rollback, the screen-file ceiling | `references/canvas-shipping.md` |
| Studio opens read-only, `connect` returns 422, a compile shows thousands of "isn't recognized", a restore says "locked by user", the authoring MCP misleads (`isError`, contract drift) | `references/authoring-sessions.md` |
| "Works in Studio, fails in the published app"; a new column/choice/table the app cannot see; option-set members, column types, entity set names, data sources the player never initialises, the Data pane | `references/manifest-caches.md` |
| Writing or debugging Power Fx or `.pa.yaml`: silent no-op buttons, `App.OnStart`, collections, types, lookups in queries, "no parent" (blank-lookup) filters, delegation and the row limit, chunked large-table reads, identity, compile output | `references/power-fx-and-pa-yaml.md` |
| Building or debugging a screen: TextInput/NumberInput/CheckBox/ComboBox/DropDown/Gallery/Timer quirks, OnChange firing on render, Default/Reset, "All"/"None" picker rows, edit screens and concurrency, permission gates, overlays, read-model tables, honest UX, list filters/search/grouping, communication history and resend, template guides with live preview | `references/canvas-controls-and-patterns.md` |
| Layout: responsive screens (computed geometry against auto-layout containers, verified at three widths), text width and clipping, long data-bound text (the fit rule and its four remedies), gallery row slicing, scrollbars, z-order, unclickable controls, geometry audits, theme tokens | `references/canvas-layout.md` |
| Driving Studio or the published app with Playwright: scenarios, iframes, committing input, dropdowns, stale player cache (IndexedDB), save/publish proof, MCP startup timeouts, scenario design and negative tests, dead-click and clip sweeps, OData trace instead of Monitor, the acceptance contract that turns a request into walks | `references/browser-verification.md` |
| **Power Pages** | |
| Choosing canvas, Power Pages or model-driven by audience and licence; a site in git (`pac pages download/upload`, hand-written records); table permissions and the Web API column allow-list; Append and Append To on both sides of a lookup; Private-site sign-in vs site session; Entra consent and claims; Liquid `fetchxml` and Web API writes; Liquid traps; clearing the site cache; classic site or code site and how each deploys; rows only some people may see (table permissions cannot filter by a column: Custom access, server logic, or the Web API kept off); "my records" through a lookup to contact, filled on the server; Web API site settings, the anti-forgery token and refusal codes; Private-site access lists and the trial; creating, activating and deleting a site through the Power Platform API without the Azure CLI; teardown order; proving refusals with `site-walk.mjs`; the security review before release (permissions audit script, allow-lists, built-in roles, headers, firewall, scan); the organisation's brand on the site (recommend and install the impeccable design skill first; own header and footer, the platform theme's overrides, auto-linked CSS, artwork kept out of git), phone-first forms, echoing the person's own words | `references/power-pages.md` |
| **Dataverse** | |
| Solutions and schema: pack/unpack, asserting on the artifact, imports that never remove, what cannot change after creation, solution membership and shared tables, retiring components, column types and table shapes (a team of one, many-to-many membership), schema hygiene, delete behaviour, effective dating | `references/dataverse.md` |
| Scripting the Web API: idempotent provisioning, payload ordering, which errors to retry, metadata PUTs, choice members, alternate keys, solution components, dependencies, paging and counts, `systemuser`, PowerShell 5.1 traps | `references/dataverse-web-api.md` |
| Who can read or write: roles kept out of solutions, `ReplacePrivilegesRole`, depth and record sharing, Append/AppendTo, impersonation, column security, SharePoint virtual tables, onboarding users | `references/security-and-access.md` |
| Writing live data: migrations, backfills, spreadsheet loads, crosswalks, agreement audits, purges, rollup rebuilds, cutover | `references/data-migration.md` |
| **Power Automate** | |
| Cloud flows: definition shape, triggers and message codes, `runtimeSource`, loops and sentinels, activation-only defects, dates and nulls, imports changing flow on/off state, run-as identity, notifications and safety caps, bulk writes, FetchXML, run history and diagnosing a failed run (the deepest failing action and loop iteration, side effects before a resubmit), the communication log and resend, documents and templates (link, stored file, generated), attachment encoding | `references/power-automate.md` |
| **Reporting** | |
| Reports for an app: the append-only history table every trend chart needs (start it first), baseline and labelled demo history, commitment fields, the change log and plan-vs-actual variance (planned vs unplanned), in-app charts from galleries (burn-down, burn-up, velocity, throughput, cycle time, aging, mix) and their compile traps, metric definitions, Power BI over a Fabric medallion (bronze, silver daily snapshot, gold facts, Direct Lake model), Power BI embedded in a canvas app or linked with a URL filter, viewer licensing | `references/reporting.md` |
| **Process and environment** | |
| Which rules a hook enforces and which stay instructions; the surface each rule applies to (canvas, Power Pages, Dataverse, Power Automate, Power BI and Fabric, model-driven); when an instruction becomes a hook | `references/rules-and-scope.md` |
| Writing or trusting an audit; stale inputs; vacuous passes; comparing the published app with the repo; reusable tool designs | `references/audits.md` |
| Starting from nothing: what the person needs, the machine, pac, a self-renewing token, a browser that signs in by itself, every identity signed in once (no repeated prompts), Studio and the authoring server, the app config, what the agent hands back, and the smoke test to run before the first change | `references/first-run.md` |
| Starting a repo or a new app: offering and installing the harness (hooks, tools, config, continuity docs, update notice), theme intake (palette, fonts, logo, imagery, symbolism, landing page) before the first screen, layout, bootstrap, hooks, continuity docs, trackers, templates, CI, shipping without pipeline rights, offering GitHub version control (what it is, personal against organisation accounts, commit identity, releases) | `references/project-setup.md` |
| CI/CD: service-principal pac auth, export/unpack on a branch, pack + Solution Checker, managed vs unmanaged and upgrade, deployment settings for connection references and environment variables, importing flows off then activating, powerplatform-actions / Build Tools, the skill's tools as pipeline gates | `references/alm-pipelines.md` |
| Several apps sharing one environment or a shared reference solution | `references/shared-environments.md` |
| pac, tokens, the TDS endpoint, MCP servers, Windows/OneDrive/PowerShell failures, and production actions Claude Code must hand to a person | `references/tooling-and-auth.md` |
| Model-driven apps (when they fit, how the schema and shared-table rules apply, Microsoft's app builder, browser verification), model-driven forms by script, user guides/SOPs from the running app, licensing, weekly reporting from git, replacing a spreadsheet tool | `references/model-driven-and-docs.md` |
| The documentation set for a finished app: user, manager, administrator and developer guides, chapter skeletons, screenshots per role, the doc kit, the inventory check | `references/documentation-set.md` |

## Bundled tools

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
| `scripts/seed-data.py` | Sample and fixture rows from JSON or CSV, idempotent by a key column: choices by label, dates relative to today (`=today-3`), lookups by the target row's key (including rows created in the same run). `cleanup` lists the rows it would delete and only deletes with `--apply`. Plan by default. Python 3 standard library only. |
| `scripts/deploy-flows.py` | Solution cloud flows and this build's own prefixed connection references from a manifest (`assets/templates/flows.example.json`): lints first, turns an active flow off before updating it, activates and reads the state back, reports a refused activation with the server's reason. Refuses a connection bound by another prefix's connection reference. Plan by default. |
| `scripts/fabric.py` | Fabric items from repo files into one workspace folder, idempotently (`deploy`), list (`items`), and run a pipeline or notebook job and wait (`run`). Resolves item ids and SQL endpoints at deploy time; refuses unfilled template tokens and names that exist outside the folder. Templates in `assets/templates/fabric-medallion/`. Plan by default. `teardown-plan` lists a folder's items in a safe deletion order (Dataflows before their lakehouse) for the person; it deletes nothing. |
| `scripts/reconcile-report.py` | Each report figure's DAX (executeQueries) against an independent Dataverse count, sum or group; exit 1 on any difference. Read-only. |
| `scripts/pbi-theme.py` | A Power BI report theme from the app's `theme.json` tokens, installed into a PBIR report folder; refuses purple, violet, indigo and magenta, contrast under 4.5:1 and unset values. |
| `scripts/check-all.mjs` | One call for the routine checks: canvas format, overlap, flow lint, drift, seed drift and the build stamp, printed as one compact table with an exit code. Use it instead of a shell call per check. |
| `assets/templates/pages-decisions.md` | The go-live decisions for a Power Pages portal, settled in the first batch: audience and visibility, identity for people who are not Dataverse users, licence, access without invitations, freshness; each with the recommendation to take when no person answers. |
| `assets/templates/design-prototype.html`, `reviewer-prompt.md`, `screenshot-walk.json` | The design lane's HTML prototype skeleton (tokens as CSS properties, both widths, no palette of its own), the independent reviewer's prompt, and the walk that captures every published screen at 1440 and 390 px for the design critique. |
| `scripts/setup-harness.mjs` | Installs this method's harness into a project: the hooks wired with `$CLAUDE_PROJECT_DIR`, the tools, the config and continuity documents, `.gitignore` entries and the version record the pre-flight's update notice reads. Plan by default, `--apply` to install; never overwrites a changed file or removes anything; merges into an existing `settings.json`. |
| `scripts/canvas-mcp.py` | Direct stdio client for the canvas authoring server: `tools` (the argument names it accepts now), `compile`, `hold` (push, refuse unless clean, hold the session until a release file appears and a save newer than the push is proven), `sync` (never into `Src`; `--diff` compares it with `Src` property by property), `diff` (offline, order-independent; `--restyle` refuses behaviour changes and collapsed colour branches), `sources`, `schema`, `describe`, `a11y`, `checker`, `accounts`. Sends `login_hint` so connect never prompts; always releases the session and kills the server tree. |
| `scripts/check-published-order.py` | Compares control (z-)order in a downloaded published app with the repo; catches a push that drew a card over its gallery while every property matched. |
| `scripts/contract-to-walk.mjs` | Checks an acceptance contract's coverage (requirement without action, action without scenario, write or refusal without a Dataverse confirm) and writes one walk scenario skeleton per row. |
| `scripts/flow-runs.py` | Read-only flow run diagnosis: `list`, `runs <flow>`, `why <flow> [run]` walks to the deepest specific error (inside nested loops, on the failing iteration), prints its inputs and outputs and the side effects a resubmit would repeat. |
| `scripts/audit-pages-permissions.py` | Audits a downloaded Power Pages site: table permissions, Web API allow-lists and header settings against the Liquid and `/_api` calls in its code; optional anonymous live-header read. |
| `scripts/dv-token.ps1` | A Dataverse token with one sign-in: device code once, then a rotating cached refresh token; prints the token for `dataverseTokenCommand`, `-WhoAmI` to prove it. |
| `scripts/hooks/check-pa-yaml.mjs` | Claude Code PostToolUse hook: flags the `.pa.yaml` faults that fail a whole-app compile, at write time. |
| `scripts/hooks/check-standards.mjs`, `shared-guard.mjs`, `audit-stop.mjs`, `preflight.mjs` | Optional output-standards hook, shared-table reminder, end-of-turn audit, and session pre-flight (with a once-a-day update notice). Wiring in `assets/settings.snippet.json`; `setup-harness.mjs` installs them. |

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

## Alongside Microsoft's official plugins

Microsoft publishes Power Platform plugins (`microsoft/power-platform-skills`) that generate:
canvas screens through the same authoring server this skill drives, model-driven apps, code apps,
Power Pages code sites, flows through their own server, and mobile apps. They stop where this skill
starts - their canvas skill ends at a clean compile, with no save, publish or test in the published
app. Use both: theirs to generate where it has a generator (and for code apps, code sites, mobile and
PCF, which this skill does not cover); this skill for the schema, the shared-environment rules, the
ship, the proof in the published app, and the guards. When their planner writes a requirements
matrix, turn it into this skill's acceptance contract and walk it.

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
- **Ask the person for decisions, never for labour.** Collect every decision at the start (theme,
  names, recipients, sample-data volume) and do the rest yourself: Studio steps through the driver,
  this build's own connections, sign-in once. `references/orchestration.md` section 5.
- **Leave the machine as you found it.** Close every tab you opened, release every Studio session,
  and run `canvas-browser.mjs tidy` before the hand-back.
- **Never call a sweep clean that did not cover it.** "390 clean" was reported while names were cut
  with an ellipsis at 390 px. Say which widths, roles and checks (clipping, truncation, overlap,
  dead clicks) the sweep covered.
- **Write it down where the next person will look.** When a session learns something that is not
  specific to one app, put it in the shared standards, not only the project's notes - the same
  trap otherwise gets paid for twice.
