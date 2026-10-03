# Changelog

All notable changes to this plugin and its `power-platform` skill are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin version lives in `.claude-plugin/plugin.json`. The marketplace entry,
`package.json`, the README badge and version line, and the newest release heading below
must agree with it; `node scripts/validate-skills.mjs --check-versions` enforces that in CI.
The skill's own version is `metadata.version` in `skills/power-platform/SKILL.md`.

## [Unreleased]

## [0.8.0] - 2026-10-03

### Added

- `references/reporting.md`: reporting for an app. History first (an append-only event table written
  by a flow from the trigger body, text ids, baseline, labelled demo history, commitment fields on time
  boxes); in-app charts built from galleries of rectangles and the traps that broke a real build;
  metric definitions; Power BI over a Fabric medallion (bronze, silver daily snapshot, gold facts,
  Direct Lake model) and viewer licensing. Routed from SKILL.md.

### Changed

- A step the person must run is handed over as ONE `!`-prefixed line to run in the agent session,
  not commands for a separate PowerShell window: offline steps run by the agent first, absolute
  quoted paths, a form that runs from bash or PowerShell. Now in SKILL.md "How to behave" and
  `references/tooling-and-auth.md`.

### Added

- `references/project-setup.md` section 12: offer version control on GitHub when a project starts
  (optional): what git and GitHub are and why they matter for Power Platform, choosing a personal or
  an organisation account (Enterprise Cloud, Enterprise Server, managed users, single sign-on),
  set-up commands, private by default, what never goes in, a per-repository commit identity, what
  the agent may do, and tagged releases. Offered from the SKILL.md pre-flight and `first-run.md`.
  Includes a GitHub CLI install without administrator rights and a sign-in that works from inside
  an agent session.

- `scripts/deploy-tables.py`: Dataverse schema from a JSON manifest in one command - publisher,
  solution, tables, columns (text, memo, whole number, decimal, currency, yes/no, date, date and
  time, choice, autonumber, file), lookups and publish, then every shared table a lookup pulled into
  the solution with its schema turned back into a reference, then a read-back of every table,
  column, option and lookup that exits 1 if anything is missing. `--plan` prints every change and
  writes nothing. Idempotent; never renames, retypes or deletes; choice options append-only; lookup
  schema names must be lower case; manifest errors are refused before any call. Python 3 standard
  library only, with a self-test against a simulated Web API, run in CI.
  On a real tenant, `--plan` ran read-only against two schemas deployed by the scripts it replaces
  (71 and 195 items, one and three shared tables): 0 changes, every item found, every shared table a
  reference. The apply path has run only against the simulated API so far.
- `assets/tables.example.json`: an example manifest (a small request tracker) using every column
  type.
- `references/dataverse.md` section 16: creating schema with the tool, plan first, what a green run
  proves, and why security roles are not part of it. Pointers from the SKILL.md working loop,
  `first-run.md` (the agent creates tables itself once the token command works, with System
  Customizer or System Administrator) and `dataverse-web-api.md` section 4.

### Fixed

- `canvas-browser.mjs` `overlapcheck`: each control's box is cut to every ancestor that clips its
  overflow before pairs are compared. A gallery row scrolled past the gallery's edge keeps its full
  layout box, so a label just below a gallery was reported as overlapped by a row nobody can see
  (found on a real app: 2 px, after the source checker had passed it).

### Changed

- `check-canvas-overlap.mjs` names every control it skipped, with file and line, in the report and
  in `--json` (`skippedControls`); the count alone did not say what went unchecked.

## [0.7.1] - 2026-10-02

From the full 0.7.0 evaluation and the first build of a new app with the skill.

### Added

- `hooks/check-pa-yaml.mjs` runs directly on files or a `Src` folder
  (`node check-pa-yaml.mjs <Src>`): exit 0 clean, 1 with findings, 2 when nothing was found (never
  a silent pass). The hook mode is unchanged.

### Changed

- SKILL.md working loop, step 3: when the project's hooks are not wired, run `check-pa-yaml`,
  `check-canvas-format` and `check-canvas-overlap` over every folder written, and `lint-flows` over
  every flow, before finishing. On 0.7.0 the compile check failed in every evaluation run, with and
  without the skill, because the evaluation installs the skill but not its hooks; on 0.7.1 it passes
  in every run with the skill.

### Fixed

- `lint-flows.mjs` self-write check: a write to the trigger table no longer counts as a re-trigger
  when the trigger cannot fire on it - a Create-only trigger and an update (`self-write-not-fired`),
  or a filtered Update trigger and a write whose columns are all outside `filteringattributes`
  (`self-write-outside-filter`). `@odata.bind` columns are compared by their column name. Both
  cases are reported as info so the reasoning stays visible. Five new guard fixtures (18 in all).
  Found as false positives on a three-flow mirror between Dataverse and SharePoint.
- Evaluation harness: the grader finds a task's corrected flow in any folder of the run's output,
  and the grader and `analyze.py` skip stray files in an iteration folder.

### Evaluation

- 0.7.0, three runs per configuration, ten tasks (two rewritten harder): 216/222 with the skill,
  136/222 without. Canvas tasks re-run on 0.7.1: 217/222 overall. Table in the README.

## [0.7.0] - 2026-10-02

Verification that reaches the database on every run, a check for the commonest layout defect in
agent-built apps, harder flow tests, and a first-run guide. Everything here ran against a real app
before release.

### Added

- `scripts/check-canvas-overlap.mjs`: controls drawn over other controls, from canvas source, across
  every `Visible` condition (own and ancestors'). Finds text-bearing or interactive controls that
  overlap and are not provably exclusive (`overlap`), decoration declared after a button
  (`covers-control`) or a label (`hidden-under`), and controls off the design surface or outside
  their gallery row. Geometry resolves literals, `App.OnStart` globals, `Parent`, other controls,
  `Min`/`Max` and every `If`/`Switch` branch, each branch compared only under the condition that
  selects it. Exclusivity covers literals, `!A`, `A || B` against `!A && !B`, numeric ranges,
  `x = y` against `x <> y`, and `in` lists. `--explain` lists every exempted pair; `--hook` blocks
  a write that creates an overlap. 36 self-test layouts in CI. First run on a real 704-control app:
  697 resolved, five real defects found and fixed, every exemption audited.
- `canvas-browser.mjs`: Dataverse confirmation. A scenario's `confirm` checks (`entitySet`, `filter`,
  `expect`, `count`, `absent`, `changedThisRun`) run after the steps on every walk, over the Web API
  with a token from the app config's `dataverseTokenCommand` (or `DATAVERSE_TOKEN`), and fail the
  verdict unless the rows hold the expected values (choice labels accepted) and changed during the
  run. `lint` refuses a writing scenario without a check that finds the written row. `confirm
  <scenario.json> [--since]` runs only the checks.
- `references/first-run.md`: from nothing to a working agent - what the person must hold, the
  machine, pac, a self-renewing token, a browser that signs in by itself (and why it can need no
  prompt on a managed device), Studio and the authoring server, the app config, the hand-back
  pattern for refused actions, a smoke test, and what removed each manual step over time.
- Evaluation tasks 5 and 6 replaced with harder versions (`evals/inputs/flows-portfolio`,
  `evals/inputs/flows-notify`): a loop through three of five filtered, guarded flows with a date that
  drifts every pass; and a recipient leak in an existing flow's failure path that the prompt never
  mentions. The grader lints task 6's shipped set with `--require-safe-recipients`.

### Fixed

- `canvas-browser.mjs`: `expect` and `absent` also search the player's frames, because `Notify()`
  banners are drawn outside the app frame (a visible "Saved" was reported "not in the DOM").
- `canvas-browser.mjs`: the service-worker update error the player logs after `--fresh` clears its
  caches is platform noise, not an app error (it failed a clean walk).

### Changed

- `SKILL.md`: the working loop requires the overlap check after layout changes and Dataverse
  confirmation on every writing walk; the example scenario declares `writes`, `restore` and
  `confirm`; `assets/canvas-app.example.json` carries `dataverseTokenCommand`.

## [0.6.0] - 2026-10-02

The first measured release: a fresh evaluation on 0.5.1, the fixes for what it found in canvas
edits, and the documentation kit after its first run on a real app.

### Added

- `evals/`: the evaluation tasks, inputs, the run, grade and analysis harness, and the 0.5.1 results.
- Core rule 10, **query the source; do not filter a copy of it**: a gallery or picker that reads a
  whole-table collection moves to a delegable `Filter`/`Search` on the source, a lookup is filtered
  by the record or its id, and the notes say which clauses delegate (`SKILL.md`; the old rule 10 is
  now 11).
- Documentation kit (`assets/doc-kit/doc_kit.py`): `inventory` checks every figure a build used
  against `shots.json` and the build stamp (`--figures`, `--build`) and fails on draft placeholders;
  `finish` updates fields and contents and exports the PDF through Word, or LibreOffice without it;
  `render` writes every page as an image and flags blank pages; `column_table` and
  `lint_edges_table` build reference tables from the build manifest, live metadata and
  `lint-flows.mjs --json`; width presets for figures, including `email` for message captures;
  `cut_band`; unknown theme keys warn, so a misspelt token cannot silently do nothing.

### Changed

- The evaluation was re-run on 0.5.1 and replaces the 0.1.0 results on `docs/evaluation.html` and in
  the README: ten tasks (six new: a looping pair of flows, an allowlist-only notification flow, long
  text in a gallery, a list with no filters asked for, theme intake before the first screen, and the
  documentation set), two runs per configuration, 133/148 checks with the skill against 98/148
  without. Three lenient 0.1.0 checks were tightened. The 1.0 evaluation criterion is now 90% and 20
  points over the baseline across ten tasks, with no task lower with the skill (`ROADMAP.md`).
- `references/power-fx-and-pa-yaml.md` section 6: each aggregate in a screen is its own point in the
  notes (whether it delegates for the source per Microsoft's list, that Studio may still warn, and
  the fallback named: a rollup column, a flow-written total or a server aggregate; a `Sum` over a
  row-limited collection or `Gallery.AllItems` is not a table total), and delegation notes
  are written as a list the maker can check, including lookups filtered by record or id and
  server-side picker search.
- `references/canvas-controls-and-patterns.md` section 16: after applying the default list filters,
  the reply ends with the choices made and an explicit invitation to change them.
- `check-canvas-format.mjs` resolves `<gallery>.Selected.<Column>` against that gallery's table in
  `--schema`, as it already did `ThisItem.<Column>`, so a detail pane beside a list is measured
  rather than skipped. New self-test case.
- Documentation kit: the build script resolves every path against itself, not the current
  directory; pagination is the kit's job (no blank pages, captions and lead-ins kept with their
  figure or table, header rows repeat); the cover names the build the screenshots were taken on;
  the user guide gains "About this guide", "Before you begin" and a quick reference
  (`references/documentation-set.md`).
- Evaluation check 4.8 (the `Sum` total) was reworded. It asked the notes to say that `Sum` over a
  Dataverse source does not delegate, but Microsoft documents `Sum` as delegable for Dataverse; it
  now asks for the total as its own delegation point with the documented behaviour, the Studio
  warning and the fallback (`evals/README.md`).
- Task 4 re-run on 0.6.0: 17/18 checks with the skill against 4/18 without; the gallery and `Sum`
  checks that failed on 0.5.1 pass in both runs.

## [0.5.1] - 2026-10-02

Beta hardening: what a second real build taught, the snippets it confirmed, and the roadmap to 1.0.

### Added

- `ROADMAP.md`: the releases to 1.0 and the measurable criteria for 1.0.
- README: a "Status: public beta (0.x)" section - what is proven, what is guidance only, what may
  change before 1.0, and how to report issues.
- `ship-canvas.py`: when it refuses on a column that exists live but not in the app's cached column
  list, it prints the remedy (refresh the data source in Studio, save and PUBLISH, rebuild - the build
  starts from the published app's cache). New self-test case.
- `canvas-shipping.md`: the live baseline is the published app; the exported solution carries the
  flows, so deploy flows first and build the canvas package after; a push that reported clean while
  Studio never showed it, after a data-source refresh.
- `tooling-and-auth.md`: the automation boundary by category (connections, security roles,
  production imports) with what to prepare for each, and reusing existing connections through the
  connections API and a deployment-settings file instead of creating them.
- `dataverse-web-api.md`: enabling `HasNotes` before binding annotations; URL-encoding `$filter`
  string values.
- `power-automate.md`: inspecting runs, loop repetitions, inputs and outputs, trigger histories and
  running a recurrence from the command line (flow management API); the attachment fix confirmed
  byte for byte; uploading a file column from canvas.

### Changed

- `manifest-caches.md`: the Add-data picker has listed tables by the singular name in one build and
  by the plural only in another - search a stem.
- Confirmed in a real compile and publish (2026-10-02) and marked so: a file column's
  `.FileName`; dropdowns over a record collection with a `Value` column; `ParseJSON` with `Table()`
  and `ForAll` inside `IfError`; grouped rows built with `Collect` inside `ForAll`; sorting by
  `Value()` of dates; a DatePicker with no default meaning "no filter".
- README "Limits of this version": `ship-canvas.py` has now run real ships.

## [0.5.0] - 2026-10-02

From a second round of feedback on a real app: lists people could not filter, messages that could
not be resent or traced, a generated attachment that arrived corrupt, and no standard for the
documentation a finished app should ship with.

### Added

- `references/documentation-set.md` and `assets/doc-kit/`: the documentation set the skill offers
  once an app works - a guide per user role, a manager guide, an administrator guide and a developer
  and platform guide (environment, Dataverse, roles, licensing, connections, every flow with its
  loop analysis, ALM, operations, architecture, start-up, a record's lifecycle, theme, traps, the
  repository, known gaps). `doc_kit.py` builds the Word documents in the app's own theme colours
  (cover with version, issue date and build; contents; restarting numbered steps; callouts; tables
  that repeat headers; captioned figures), trims player chrome from screenshots, and checks the shot
  inventory (every required screen and role has a figure; an empty list fails). `--selftest` builds
  and inspects a sample. `build_guides_example.py` holds the four chapter skeletons, with shared
  chapters written once; `--draft` marks missing captures instead of stopping.
- `check-canvas-format.mjs`: advisory `list-without-filter` warning for a table gallery whose Items
  reads no input control, variable, `Search` or `GroupBy` (system choices such as statecode
  ignored). A warning only: the exit code is unchanged. Four selftest cases.
- `canvas-controls-and-patterns.md` sections 16-18: lists (the default filter, search, sort and
  section headers, with pa.yaml for an empty-means-All dropdown and a delegation-friendly grouped
  gallery), communications (last sent, history, a Resend button), and the template guide with a live
  preview that uses the flow's exact substitution rules.
- `power-automate.md` sections 16-17: the communication log (columns, writing before a send that
  waits, Create-only so it can never start a loop), loop-safe resend ending in a terminal status, and
  documents (link, stored file, generated from an HTML template; the Word-template premium upgrade
  and the connection it needs; one placeholder list shared by flow and app). The attachment trap: a
  Note's base64 `documentbody` passed as `ContentBytes` arrives corrupt - pass `base64ToBinary(...)`
  and verify by opening the received file.
- `project-setup.md` section 3: intake questions for lists, messages and documents, with defaults.
- `SKILL.md`: working-loop step 11 offers the documentation set.

### Changed

- CI installs python-docx and Pillow and runs the doc kit self-test.

## [0.4.0] - 2026-10-02

Long text and theme, decided before they become rework. Data-bound labels that wrap past their
fixed-height gallery rows, showing half a sentence, turned up in every app built so far; the theme
was asked for after the screens existed.

### Added

- `scripts/check-canvas-format.mjs`: the long-text fit rule and the theme-token rule, from canvas
  source, as a CLI and as a PostToolUse hook (`--hook`).
  - For every text control whose `Text` reads data, the widest value the expression can produce
    (literals and choice labels measured per character; text at its column's maximum length;
    `&`, `If`, `Switch`, `Coalesce`, `Left`, `With`, `If(Len(x) > n, ...)`, `Text(x, "fmt")`,
    `Concat`) against the room the box has (size in points, padding, wrap, line height, bold).
    Geometry resolves App globals, `Parent`/template sizes and other controls.
  - Lengths from a `--schema` file: per table (picked from the gallery's `Items`), flat, and
    `overrides` for limits the app enforces, each with its reason. Collections are measured from
    the `ClearCollect`/`Collect` formulas that build them. Without a schema, lengths are guessed from
    the column name and each finding says so; the hook never blocks on a guess.
  - Findings: `text-overflow`, `autoheight-in-fixed-row`, `clamped-without-full-text` (a tooltip
    must read the same columns as the clamped text), `scroll-in-gallery-row`, `literal-colour`,
    `literal-font`.
  - A floor: it prints how many controls it examined, read data and measured; exit 2 when no
    data-bound control was examined. `--char-em` calibrates the character width from `measurefont`.
  - Self-test: 14 row cases, plus flexible-height, detail-pane, no-theme, floor, per-table,
    `With()` and collection cases.
- `references/canvas-layout.md` section 8, "Long text: the fit rule": the formula, its error
  direction, the schema and how to generate it from Dataverse metadata, and the four remedies with
  `.pa.yaml` snippets (clamp plus tooltip, flexible height, a detail view, a scrolling detail pane).
- `references/canvas-layout.md` section 9, theme tokens: one definition in `App.pa.yaml`, role
  names, contrast per pair, imagery referenced from one place, and the literal-colour rule.
- Theme intake before the first screen: `SKILL.md` working loop step 2 and
  `references/project-setup.md` section 3 ask for the palette and restricted colours, fonts, logo
  and imagery, iconography and symbolism, the landing page, tone, contrast and light/dark, and
  record them in `canvas/theme.json` (`assets/templates/theme.json`). An interim palette is fine;
  the app is built on tokens either way.
- `assets/settings.snippet.json` wires the new hook; `assets/standards.config.example.json` gains
  `textFitSchema`.

### Fixed

- `hooks/lib.mjs`: a byte-order mark on the hook payload (PowerShell adds one when piping) made
  `JSON.parse` throw, so every hook exited 0 without checking anything. It is now stripped.

## [0.3.0] - 2026-10-02

Flow loops become a hard gate. A second app built with the skill showed that the per-flow
self-write check could not see three loop shapes, and an older app in the same environment
turned out to carry one of them.

### Added

- `lint-flows.mjs`: a trigger graph across all the flows given. Every Create, Update, Upsert or
  Delete is an edge to each flow whose trigger it can fire (message code, table,
  `filteringattributes`). An edge is dropped only when the target's trigger condition is false for
  every value the write can land, trying each arm of an `if()`. New errors:
  - `trigger-cycle`: any strongly connected set of flows, or a Create-triggered flow creating its
    own rows;
  - `alternating-rearm`: a write that can land two values which each start a flow (a retry sweep
    flipping between two re-arming states loops forever once the target stops moving the row on);
  - `update-trigger-unfiltered`: an Update trigger with no `filteringattributes`.
- `lint-flows.mjs --require-safe-recipients`: every recipient parameter of a messaging connector
  must be a `Safe_to_` Compose shaped `if(outputs('Is_live'), <real>, <test>)`, whose test branch
  can only produce the allowlist or nothing; HTTP actions fail.
- `lint-flows.mjs --verbose` prints the surviving trigger-graph edges.
- Self-test: 6 loop-graph shapes (each looping shape and its fixed twin), 4 recipient shapes and
  the unfiltered-trigger rule.
- `references/power-automate.md`: the loop rules as a table; lost Dataverse trigger events
  (a Create never delivered, a second change about 5 s after a first dropped, no event for an
  unchanged value) and the two-step terminal sweep that recovers them; pinning the one permitted
  address in flow source rather than in a settings row; proving recipients from run history too.

### Changed

- The cross-flow cycle check replaced: it compared table pairs only, ignored flows on the same
  table, and could not see trigger conditions.
- `SKILL.md` rule 8 is now a gate: no import unless the linter, run over every flow, exits 0, with
  no waivers. Rule 9 adds the source-pinned recipient for builds that must not reach real people.
- Flows that passed 0.2.x can now fail: every Dataverse Update trigger needs
  `filteringattributes`.

## [0.2.2] - 2026-10-01

First real build of a new app with the skill: a Dataverse + canvas onboarding app, from tables to a
published, imported, stamped build in one session.

### Fixed

- `ship-canvas.py`: every second run refused, because `pac canvas download` has no `--overwrite`
  and the previous run's `live.msapp` was still in the work folder. The old baseline is now removed
  first. The self-test's fake `pac` refuses an existing file as the real one does, and a new case
  downloads twice into one folder (it fails without the fix).

### Added

- `ship-canvas.py`: refuses a zip in which a table matched by `externalTables` ships WITH its
  subcomponents (`behavior="0"`), since an import would write that copy over the owning solution's
  table. `--allow-shared-schema` overrides it and says so. Three self-test cases.
- References:
  - A lookup into another solution's table adds that table to yours with every subcomponent, and how
    to check and fix it (`dataverse-web-api.md`, `dataverse.md`).
  - A push whose Save button stays disabled, what saved it, and the alternative of compiling only
    as a check and shipping by import (`authoring-sessions.md`).
  - An unset variable compared with `= 0` divides by Blank; `x in Column` delegates on Dataverse and
    finds surnames (`power-fx-and-pa-yaml.md`).
  - The Add-data picker with two tables of the same display name (`manifest-caches.md`).

## [0.2.1] - 2026-10-01

### Changed

- `lint-flows.mjs`: writing a column listed in the trigger's `filteringattributes` is no longer
  always an error. When a trigger condition is provably false once the written values are in
  the row, the finding is downgraded to info (`writes-filtered-column-guarded`): the trigger
  still fires, but no run starts. A guard only in an If inside the flow keeps the error, since
  the run has already started. Two self-test cases cover both shapes.

## [0.2.0] - 2026-10-01

### Added

- `scripts/ship-canvas.py`: the canvas ship pipeline. It builds on the live baseline, reconciles
  the caches (and proves a second pass changes nothing), stamps the build, strips roles, repairs
  the player list, packs with pac, and asserts on the finished artifact. Includes `--dry-run`,
  opt-in `--import`/`--publish`, and a `--selftest` that simulates pac.
- `scripts/check-drift.py`: read-only comparison of a canvas app's cached Dataverse metadata
  (entity sets, columns the formulas use, column types, choice members in both caches, lookup
  navigation names, `<DatabaseReferences>`) with the live environment or a saved `--dump`. Exits
  0 clean, 1 drift, 2 could not verify. Includes `--selftest`.
- `references/alm-pipelines.md`: CI/CD with pac in GitHub Actions and Azure DevOps. Covers
  service-principal auth, Solution Checker, managed vs unmanaged and upgrades, deployment
  settings, activating flows after import, and the skill's tools as pipeline gates. Statements
  are tagged Documented, Observed or Untested here.
- `canvas-browser.mjs doctor`: checks every UI anchor against a live Studio and player. Exits 0
  when all resolve, 9 when any is stale, 2 when it cannot verify; it never passes offline.
- `assets/selectors.json`: every selector, text anchor and URL template the driver uses, with
  `lastVerified` per entry; compiled-in defaults are the fallback.
- `assets/tested-versions.json` and `.github/workflows/upkeep.yml`: a monthly run of all
  self-tests plus Playwright and Playwright MCP version checks, opening an `upkeep` issue with a
  re-verification checklist.
- `lint-flows.mjs`: new warning `self-write-guard-assumes-value`, raised when a self-write's
  guard holds only if a value read at run time is never blank.

### Changed

- `lint-flows.mjs` `self-trigger-loop` now parses flow expressions instead of matching column
  names. It passes a self-write only if a path condition reads a written column and is false
  once the written values are in the row. The self-test adds 13 guard shapes.
- `assets/canvas-app.example.json`: optional ship keys (`appLogicalName`, `externalTables`,
  `buildStampVariable`, `buildStampPlaceholder`, `outDir`, `workDir`, `maxScreenFiles`,
  `bumpVersion`).
- `references/power-automate.md`: why a column-name match is not a guard, and the caveat on
  is-blank guards.
- CI runs the self-tests of the two new Python tools.

## [0.1.0] - 2026-10-01

First public release.

### Added

- `power-platform` skill: the method for source-controlled Power Platform development
  (canvas apps as `.pa.yaml` in git, Dataverse solutions, Power Automate cloud flows,
  shipping by solution import) and the non-negotiables that keep it honest.
- 17 reference files, loaded only when a task needs them:
  - Canvas: `canvas-shipping`, `authoring-sessions`, `manifest-caches`,
    `power-fx-and-pa-yaml`, `canvas-controls-and-patterns`, `canvas-layout`,
    `browser-verification`.
  - Dataverse: `dataverse`, `dataverse-web-api`, `security-and-access`,
    `data-migration`, `model-driven-and-docs`.
  - Power Automate: `power-automate`.
  - Process and environment: `audits`, `project-setup`, `shared-environments`,
    `tooling-and-auth`.
- `scripts/canvas-browser.mjs`: Playwright driver for the maker portal and the published
  player. It drives JSON scenarios, cache-busts with `--fresh`, records `$batch` traffic
  with `--trace`, proves a Studio save from the flyout's time, and runs
  `publish --reload-first`. A scenario that writes must declare a `restore`.
- `scripts/inspect-artifact.py`: reports what a solution zip or `.msapp` really contains,
  covering root components against built metadata, `LoadFromYaml`, the build stamp,
  data-source counts, and `DatabaseReferences` against `DataSources.json`.
- `scripts/lint-flows.mjs`: static checks on cloud-flow definitions. It covers the
  `runtimeSource` invoker, message-code mismatch, unguarded self-writes, apostrophes in
  literals, references off the `runAfter` path, sends after `Failed`, single-`@` property
  names, multiple triggers, date-only columns used as instants, unknown entity sets and
  cross-flow cycles.
- Claude Code hooks: `preflight`, `check-pa-yaml`, `check-standards` and `audit-stop`.
- Assets: hook settings snippet, config examples, an example scenario, and templates for
  the state file, decisions log and dependency register.
- `canvas-browser.mjs --channel chrome|msedge|chromium` chooses the browser. When Playwright or
  the browser is missing, the driver prints the install options and exits 8, meaning nothing was
  verified. `SKILL.md` tells the agent to ask before installing anything and to report the change
  as unverified until a browser check can run.
- `docs/evaluation.html`: the evaluation report, published with GitHub Pages. Four tasks were run
  with and without the skill (32/32 checks against 14/32), alongside a 20-query triggering
  evaluation and the method's limits.
- Every checker ships a `--selftest`. CI runs them along with the skill validator and the
  version-agreement check.
