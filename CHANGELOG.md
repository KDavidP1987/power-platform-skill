# Changelog

All notable changes to this plugin and its `power-platform` skill are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin version lives in `.claude-plugin/plugin.json`. The marketplace entry,
`package.json`, the README badge and version line, and the newest release heading below
must agree with it; `node scripts/validate-skills.mjs --check-versions` enforces that in CI.
The skill's own version is `metadata.version` in `skills/power-platform/SKILL.md`.

## [Unreleased]

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
