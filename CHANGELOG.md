# Changelog

All notable changes to this plugin and its `power-platform` skill are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin version lives in `.claude-plugin/plugin.json`. The marketplace entry,
`package.json`, the README badge and version line, and the newest release heading below
must agree with it; `node scripts/validate-skills.mjs --check-versions` enforces that in CI.
The skill's own version is `metadata.version` in `skills/power-platform/SKILL.md`.

## [Unreleased]

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
