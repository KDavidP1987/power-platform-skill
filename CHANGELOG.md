# Changelog

All notable changes to this plugin and its `power-platform` skill are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin version lives in `.claude-plugin/plugin.json`. The marketplace entry,
`package.json`, the README badge and version line, and the newest release heading below
must agree with it; `node scripts/validate-skills.mjs --check-versions` enforces that in CI.
The skill's own version is `metadata.version` in `skills/power-platform/SKILL.md`.

## [Unreleased]

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
