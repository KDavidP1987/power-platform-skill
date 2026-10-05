# Changelog

All notable changes to this plugin and its `power-platform` skill are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The plugin version lives in `.claude-plugin/plugin.json`. The marketplace entry,
`package.json`, the README badge and version line, and the newest release heading below
must agree with it; `node scripts/validate-skills.mjs --check-versions` enforces that in CI.
The skill's own version is `metadata.version` in `skills/power-platform/SKILL.md`.

## [Unreleased]

## [0.20.1] - 2026-10-04

Test F (0.20.0, impeccable, no DOD) was the first build to meet all 35 acceptance rows, with the best
design of six and nothing asked of the person. It still took 107 agent minutes and $41, against 63
minutes and $24 for Microsoft's plugins. Most of that went on Studio churn, not on the work: 29 Studio
opens, 27 saves, 21 publishes, 13 second tabs left open, 81 walk calls and 472 single shell calls. It
also stalled on Studio's "Accept Coauthoring preview terms?" dialog with three Studio tabs open. Each
fix here is enforced by the driver or a hook, not left to the guidance.

### Added

- **Budget hook** (`plugin-gate.mjs --post`, PostToolUse on Bash and PowerShell). In a Power Platform
  build it reports the shell-call count every 40 calls, with the batched tools to use, and the elapsed
  time at 45, 60, 90 and 120 minutes against the one-hour budget. It never blocks. 8 self-test cases.
- **One walk call for every scenario:** `canvas-browser.mjs walk <a.json> <b.json> ...` or
  `walk <folder>`, ending with a one-line-per-scenario summary.

### Changed

- **The driver keeps the browser tidy without being asked:**
  - Blank tabs are closed after every command.
  - `second-tab` leaves and closes the older Studio tab once the new one is in edit mode.
- **Studio's Coauthoring terms dialog is a known step.** The driver accepts it, because Coauthoring is
  what the authoring server needs. `"acceptCoauthoringTerms": false` in `scripts/canvas-app.json` makes
  it stop and report instead. The setting is in the example config, and the decision is listed with the
  up-front decisions.
- **Publish once per batch:**
  - `publish` refuses when the canvas source has not changed since the last publish. `--again`
    overrides.
  - Each publish is recorded in the work folder, and a note appears after the fourth.
- **Orchestration:**
  - Fix rounds cover high and medium findings in one batch; low findings are listed.
  - The format check and the clip sweep run before the first ship.
  - Never open Studio tabs from your own scripts.
- Driver self-test: 7 new cases (publish guard, terms selector, auto-tidy scope).

## [0.20.0] - 2026-10-04

Test E, the fifth measured build of one brief, was the first in which every design and review step
ran: the order gates worked. It had the best design of the five (blind 20/25, impeccable critique
30/40), and the person rated it the best. But it took 291 agent minutes and about $82, against 63
minutes and $24 for Microsoft's plugins, and it stopped three times to ask questions it had already
answered. Nearly all of the extra time went to an uncapped DOD plan: 12 review rounds and 20
amendments, with the plan still changing through the build. The other losses were a turn ended with
the walk batch running in the background (twice), an Approvals action swapped for an Outlook email,
and an audit that re-read 44 findings in the skill's own copied tools at every stop. This release
keeps what made E's design best and removes what made it slow.

### Added

- **Run checks in the plugin's Stop gate**, read from the session transcript. They apply to every
  project, harness or not:
  - *Background work still running.* A command started in the background whose completion has not
    arrived blocks the stop. `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` covers helper agents only, and a
    headless session ends, killing the work, when the turn ends.
  - *No person present.* In a headless run (entrypoint `sdk-*`, or `"unattended": true` in
    `scripts/canvas-app.json`), a last message that asks the person something blocks the stop. The
    agent takes its recommendation, records it and carries on.
  - Replayed against Test E's real transcript, the checks catch all three stops on questions and the
    stop with walks running, and none of the five builds' final hand-backs.
  - 47 self-test cases.
- **Vendored copies are skipped by the audit.** `setup-harness.mjs` records each copied tool and hook
  with its hash in `.claude/hooks/vendored.json`. The end-of-turn audit skips a copy while it still
  matches, and skips generated files listed in `auditIgnore` (default: the dod index).

### Changed

- **DOD is opt-in and capped.** The acceptance contract is the plan. The plugin no longer demands a
  DOD plan when dod is installed, though one still counts as the plan.
  - Use DOD when the person asks for it, or for a multi-week feature with a person present.
  - When used: two review rounds at most, the plan frozen at build start, advisories after READY to
    the Log, and items pointed at bundled checks.
  - Findings and suggestions were sent to dod-skill (issues 15 and 16).
- **Design and schema at the same time.** A design helper runs impeccable (init, the HTML prototype,
  one critique, one fix batch) while the lead deploys the schema, seeds the data and creates the
  connections. Flows and reporting start after the schema; canvas starts after the design.
- **A time budget.** About an hour of agent time for a five-screen app, two flows and a medallion,
  with each phase given its own allowance.
- **Walks run in the foreground**, or inside a helper. Never as a background shell command.
- **Hands-off, completed:**
  - Approvals allows one connection per user per environment. Bind this build's own reference to the
    owner's existing connection without asking, and never swap the action for an Outlook email.
  - Answer the approvals your own `[TEST]` rows raise, in the signed-in browser, one approve and one
    reject.
  - Create the Fabric Dataflow connection in the signed-in browser profile, not by asking the person.
- **Report screenshots show the report canvas only.** Never the Power BI header, which shows the
  person's photo and the organisation's logo, or the workspace rail. The same rule is in the
  reviewer prompt.
- **More reviewer checks:** two date formats on one screen, another product's nouns in copy, blank
  gaps, a phone list scrolling inside a short box, and a stale report. The report is refreshed last.

## [0.19.2] - 2026-10-04

The 0.19.1 Stop gate produced a report, not compliance: in a live test the agent listed the missing
design and planning steps in its summary and ended. A gate at the end arrives when the work is
already done in the wrong order. This release gates the order of work as it happens.

### Added

- **Order gates before tools** (`plugin-gate.mjs --pre`, PreToolUse on Write, Edit, MultiEdit, Bash
  and PowerShell, in `hooks/hooks.json`):
  - *Design before screens.* A new app's screen `.pa.yaml` (not `App.pa.yaml` or `_EditorState`) is
    refused, by a file tool or a shell write, until `DESIGN.md` and `design/prototype.html` exist;
    the denial tells the agent to invoke impeccable. An established app (three or more screens) is
    not held up, so maintenance work elsewhere is unaffected.
  - *Plan before schema.* `deploy-tables.py` (not `--plan`) is refused until the DOD plan exists
    when dod is installed, otherwise until `docs/acceptance-contract.md` is filled in (the bare
    template does not count).
- Live test, headless, with only the brief "write the Loans list screen": the screen write was
  denied, and the agent then invoked dod (plan), impeccable (PRODUCT.md, prototype, DESIGN.md),
  wrote the screen from the prototype and recorded a design critique, in that order.

### Changed

- The Stop gate blocks up to three times per session (counted per session id in the temp folder)
  instead of once, then lets the stop through with the gaps on stderr, so it cannot trap a session.
  Its reason now says to carry out the steps, not to list them.
- Shell writes are judged by their target: a read such as `cat Src/*.pa.yaml 2>/dev/null` (denied in
  the first live run) passes; a redirect into a screen file or a write command naming one does not.
- SKILL.md "Start here" and the README hooks section describe the plugin gates.
- 39 self-test cases for the gate (was 17), in CI.

## [0.19.1] - 2026-10-04

Test D (the fourth measured build) followed the brief and skipped every design and planning step
the skill asked for: no impeccable, no HTML prototype, no DOD plan, no independent reviewer, and the
project-level gates never ran because the harness is installed only when a person agrees. Writing
it down was not enough; this release enforces it from the plugin.

### Added

- **Plugin-level build gate** (`hooks/hooks.json`, `scripts/hooks/plugin-gate.mjs`): runs whenever
  the plugin is enabled, with no project harness. Silent in any folder without canvas source or a
  Power BI report; never loops; stands aside when the project harness's own gate is installed;
  `"pluginGate": false` turns it off. It blocks the hand-back once, listing every missing step:
  DESIGN.md (invoke impeccable `init`), `design/prototype.html`, the screenshot critique once an app
  is packed, the dod plan when dod is installed, the independent reviewer's `docs/review.md` once
  shipped, and any access token written to a file or shared storage. 17 self-test cases, in CI;
  run read-only against the Test D build it flagged every skipped step and the token hand-off.
- **"Start here" at the top of SKILL.md**: plan, design, harness, lanes, prove - in that order,
  as actions.

### Changed

- The harness is installed with its defaults when no person is present, instead of being skipped.
- `orchestration.md`: never end a turn while helpers run (a headless run is terminated 600 s after
  the lead's turn ends with work still running, which cut a build off mid-task); start the lanes and
  the screen helpers each in one message. The harness sets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`
  as a backstop. Compacting stays at 40%: the build that used it re-read no more context than
  Microsoft's plugins and was the cheapest of four.
- `reporting.md`: never hand a token to Fabric through a file or lakehouse (a build staged the
  owner's Dataverse token in a lakehouse file for a notebook).
- `canvas-controls-and-patterns.md` section 1: a Radio group needs the height of all its options
  (a clipped group passed a build's own 390 px sweep).

## [0.19.0] - 2026-10-04

Quality first: the design is settled in HTML with impeccable before any screen is built, the product
is critiqued again from screenshots after the ship, the build is planned with DOD when it is
installed, and an independent reviewer checks it before the hand-back. Cost savings that do not
touch quality: one call for every static check.

### Added

- **Design lane first, in HTML** (`project-setup.md` section 3, `orchestration.md` section 1):
  impeccable `init` (the agent creates the theme when none is given), then `design/prototype.html`
  with every screen at 1440 and 390 px, every state (empty, loading, error, saved) and a report mock,
  critiqued with impeccable's detector and browser check and fixed once; only then do the screen
  helpers start, each with its frame and the tokens. A table turns impeccable's web practice into
  canvas terms. Template `assets/templates/design-prototype.html` (token-driven, no fixed palette).
- **Critique of the real product from screenshots**: `assets/templates/screenshot-walk.json` captures
  every published screen at both widths (and fails on clipped text); impeccable critiques them
  (declared degraded where its detector cannot run on canvas) into `docs/design-critique.md`, which
  the 0.18.2 design gate checks. Email captures are the single open message, never the mailbox.
- **Planning with DOD** when installed: `dod plan --autonomous` first, its question batch as the one
  up-front decision list, `contract-to-walk.mjs --from-dod <plan.md>` to turn its items into walks,
  `dod close` with the prediction rate in the hand-back.
- **Independent reviewer** before the fix batch (`orchestration.md` section 7,
  `assets/templates/reviewer-prompt.md`): a fresh helper walks the contract on the published app and
  in Dataverse, runs `seed-data.py check` and reads the design record; findings only.
- `check-all.mjs`: every static check (pa-yaml, format with build-stamp-visible, overlap, flow lint,
  offline drift, seed) in one call, one compact table, at most `--max` findings per failing check.
  Installed by the harness; CI runs its self-test.
- `seed-data.py check` (read-only, exit 1 on drift); `fabric.py prove-refresh` (change one of this
  build's rows, refresh from Fabric alone, check the report followed, restore).
- `canvas-controls-and-patterns.md` section 15: a pending request reserves the item; a typed date the
  picker cannot read gets a format message, not "required"; gating rules are walk-tested.

### Fixed

- `check-canvas-format.mjs` exits 1 when it finds an error (a visible build stamp) even on a screen
  with no data-bound text, instead of 2 ("nothing examined").

## [0.18.2] - 2026-10-04

Hardening from Test C (the third measured build of one brief): the rules that guidance alone did not
enforce become gates, and the connection command gets the two fixes the build needed.

### Added

- **Design gate** in the end-of-turn hook (`audit-stop.mjs`): a project with canvas source or a
  Power BI report must have a `DESIGN.md` (impeccable `init`, or written by hand when the person
  declined impeccable, saying so) before the turn can end, and a `docs/design-critique.md` naming
  the screenshots and the score once an app package has been built. `"designGate": false` in
  `standards.config.json` turns it off. A build whose guidance called impeccable "required" skipped
  it entirely. `audit-stop.mjs --selftest`, run in CI.
- **`build-stamp-visible`** in `check-canvas-format.mjs` (error): a control showing the build-stamp
  variable must be hidden or gated by a role, admin, support or debug flag; a layout condition
  such as `Visible: =!lyPhone` is not a gate. A measured build shipped exactly that.
- **Compact at 40%**: `setup-harness.mjs` writes `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40` into the
  project's `.claude/settings.json` (never overwriting a value the project set), and
  `orchestration.md` section 4 adds the practice that makes it safe: state in `docs/STATE.md` at each
  lane boundary, restored by the pre-flight hook after compaction; compact between lanes; the
  strongest model for building and judging, a smaller one only for read-only errands; narrow reads.

### Fixed

- `canvas-browser.mjs connection` picks the configured account on "Pick an account" by its visible
  text when the attribute selector does not match, and confirms the consent code over the API when
  the consent page alone leaves the connection Unauthenticated (Dataverse and Outlook needed this).

### Changed

- `reporting.md` section 4: the refresh runs in Fabric, or it is not a refresh. A build landed
  Dataverse rows as files from a local script, and the pipeline then served stale data after the
  tests. Prove it by changing one row and refreshing from Fabric alone.
- `orchestration.md`: the design step is a lane run first by the lead; seed data is re-applied after
  the last walk (a build left two seed rows changed and failed its own data check).
- `tooling-and-auth.md`: "one Approvals connection per person" is untested in either direction; try
  before claiming.

## [0.18.1] - 2026-10-04

### Added

- `canvas-browser.mjs connection`: the agent creates this build's own signed-in connections instead
  of asking the person. It refuses unless the token's account is the config's `login` and the
  environment's Dataverse URL is the config's `environmentUrl`; creates the connection over the
  API; for an OAuth connector (Dataverse, Outlook, Teams) completes consent in the driver's
  signed-in profile (measured silent with a Windows-signed-in Edge: reaching the consent service's
  confirm step sets it Connected); reuses this build's connection by name; reads back Connected.
  Plan unless `--apply`; `--json` prints the id for the flows manifest.
- `login` and `connectionPrefix` in `assets/canvas-app.example.json`; two consent anchors in
  `assets/selectors.json`.

### Changed

- 0.18.0 told the agent to use its own connections but gave it no way to make one, so a measured
  build stopped and asked the person. `tooling-and-auth.md` section 6 now makes connections the
  agent's job, gives the one permission rule that allows the command, and corrects "one Approvals
  connection per person" (Approvals needs no consent; API-created ones are Connected at once).
  `power-automate.md`, `orchestration.md` and `deploy-flows.py`'s messages point at the command.

## [0.18.0] - 2026-10-04

### Added

- `references/orchestration.md`: how to build a whole solution fast and cheaply. Schema and sample
  data first, then the canvas app, flows and reporting in parallel helper agents (one helper per
  screen), a lane contract with one owner per shared lock (Studio session, import, model refresh),
  the lead running the acceptance walks, cost discipline (small lead context, batched checks, bundled
  tools before new ones, no driver patching mid-build), a hands-off person (decisions only, this
  build's own connections), browser hygiene, and a single verify-fix-confirm round. Drawn from a
  measured comparison where a single-thread build took 1.6 times as long and re-read twice the
  context of a build that delegated screens.
- `canvas-browser.mjs`: `tabs` (list the held browser's tabs), `tidy` (close blank, new-tab and
  crashed tabs; `--all`, `--studio`, `--dry-run`; never the last tab), `second-tab` (open the app's
  edit address in a second tab of the held browser, refuse a new-blank address), `studio-has`
  (are the named controls on the held Studio tab; exit 6 if not), `dirty` (make Save available
  after a push left it disabled).
- Walk steps `viewport: [w, h]` (phone and desktop in one walk), `radio: "<label>"`, and
  `pick: "<option>", from: "<dropdown>"` for the classic DropDown the current player draws as a
  button and a list; the scenario linter checks all three.
- Six UI anchors in `assets/selectors.json` for the new commands.
- Build tools a measured build had to write for itself mid-run, now bundled (plan by default,
  `--apply` to write, offline `--selftest`, Python standard library): `seed-data.py` (sample rows,
  idempotent, cleanup lists unless `--apply`), `deploy-flows.py` (solution flows and this build's
  own connection references; refuses another prefix's connection), `fabric.py` (deploy items into a
  workspace folder, run jobs and wait), `reconcile-report.py` (report figures against Dataverse),
  `pbi-theme.py` (Power BI theme from the app's tokens), and the shared `_ppapi.py`.
- `assets/templates/fabric-medallion/`: bronze dataflow, silver and gold notebooks, refresh
  pipeline, Direct Lake model, a one-card report, reconcile checks and a theme example; plus
  `seed.example.json` and `flows.example.json`.

### Changed

- The impeccable design skill is a **required step**, not a recommendation: `init` before the first
  screen, tokens and the Power BI report theme from its `DESIGN.md`, `critique` on the published
  screens at 1440 and 390 px and on the report (`project-setup.md` section 3). A measured build had
  it installed and never called it, and shipped Power BI's default theme.
- New rules from the defects both measured builds shipped: wrap names at phone width rather than
  truncating them; use the width at desktop; one date format; offer an action only in the state that
  allows it; show "Saving..."; rows open their detail on tap; no build stamp, diagnostics or
  placeholder dates in front of users; remove the leftover `Screen1`; styled email tables; a report
  theme from the design, never the default; this build's own connections.
- `SKILL.md`: ask the person for decisions, never labour; leave the browser tidy; never call a sweep
  clean that did not cover truncation, both widths and every role.
- `save`, `publish` and `keys` act on the newest Studio tab (after a push blanks the first one);
  `close-studio` leaves every Studio tab through Back.

### Fixed

- Leaving the editor picks the frame that holds Back or Leave, not an empty prefetched copy.
- `check-canvas-overlap.mjs` resolves formula-based named values (`App.Formulas`) at the screen size
  being checked instead of only literal numbers.

## [0.17.1] - 2026-10-04

### Fixed

- `canvas-browser.mjs` no longer leaves a row of `about:blank` tabs in the browser it drives. Every
  command opened a new tab beside the blank tab a persistent context starts with, and the browser
  restored earlier runs' tabs on the next launch. Commands now reuse the starting tab, close any
  restored tabs at launch (a restored Studio tab would also compete for the edit lock), and launch
  without session restore or the crash-restore bubble.

## [0.17.0] - 2026-10-04

### Added

- `canvas-browser.mjs create`: the agent creates the canvas app itself instead of asking the person.
  New blank app in the solution, first save (which creates it), app id written to
  `scripts/canvas-app.json`, layout (Responsive or Fixed), Coauthoring on (`--modern` for modern
  controls), tables added by logical name, save, optional publish, then Back or hold Studio for the
  authoring server. Measured end to end in a tenant in about two minutes.
- Seventeen UI anchors for it in `assets/selectors.json` (selftest keeps them in step).

### Fixed

- The driver falls back to Edge when Chrome hands every automated launch to the running Chrome
  ("Opening in existing browser session"); Edge then signed in through the Windows account with no
  prompt.
- The "Welcome to Power Apps Studio" dialog, which blocks every click and returns after each
  refresh, is dismissed (Skip, and "Don't show me this again").
- A failed command exits instead of leaving the browser and its profile held.

### Changed

- `canvas-shipping.md`, `project-setup.md` section 3, `browser-verification.md` sections 3
  and 11, `first-run.md` sections 12 and 13 and `SKILL.md`: creating the app is the browser's
  work, not a human step; Coauthoring is off on a new app and lives under Settings > Updates > New.

## [0.16.0] - 2026-10-04

### Added

- Canvas apps: recommend the third-party impeccable design skill for the look, and use it when it is
  installed - its `init` sets the design (`PRODUCT.md`, `DESIGN.md`), the decisions become
  `theme.json` and the tokens, and its `critique` reviews the published screens at both widths
  (`project-setup.md` section 3, `canvas-layout.md` section 10, `SKILL.md` step 2). Previously
  recommended for Power Pages only.

## [0.15.0] - 2026-10-04

Closes the gaps found comparing this skill with Microsoft's official Power Platform plugins, adds
the development harness as something the agent offers and installs, and removes repeated sign-ins.

### Added

- **The harness, offered at the start of a project.** `scripts/setup-harness.mjs` installs the
  hooks (wired with `$CLAUDE_PROJECT_DIR`), the tools, the config and the continuity documents into
  a project: plan by default, `--apply` to install, idempotent, never overwrites a changed file,
  merges into an existing `settings.json`. `project-setup.md` section 4 (generated screens and owner
  scripts as the two per-project patterns); `SKILL.md` working loop step 1.
- `scripts/canvas-mcp.py`: a direct client for the canvas authoring server - `tools`, `compile`,
  `hold` (refuses unless clean, holds the session until a release file appears), `sync`, `sources`,
  `schema`, `describe`, `a11y`, `checker`, `accounts`. Sends `login_hint`, always releases the
  session and kills the server tree. Tested against the live server (connect without a prompt in 5 s).
- `scripts/check-published-order.py`: control order in the published app against the repo.
- `scripts/dv-token.ps1`: a Dataverse token with one sign-in (rotating cached refresh token);
  measured silent in about a second.
- `scripts/hooks/shared-guard.mjs`: a non-blocking reminder when an edit names a shared table.
- `assets/templates/owner-cleanup.ps1`: the owner-run, list-first, prefix-guarded cleanup script.
- **Update notice:** the harness records the skill version; the pre-flight checks the latest
  release at most once a day and tells the agent to offer the update. README "Updating"; issue
  templates for defects and lessons.
- **No sign-in barriers:** `first-run.md` section 13, every identity (pac, Dataverse, Az, the
  authoring server, the browser, GitHub, MCP servers) signed in once, with its check and the cause
  when prompts come back; permission prompts and standing authorisations.
- **Requirements to verification:** `assets/templates/acceptance-contract.md`,
  `scripts/contract-to-walk.mjs` (coverage findings, walk skeletons with Dataverse confirms) and
  `browser-verification.md` section 18; pairing with Microsoft's canvas planner.
- **Accessibility and contrast:** `check-canvas-format.mjs` gains `no-accessible-name` (a note at
  write time), `low-contrast` (WCAG against the real backdrop at desktop and phone width; unresolved
  counted, never passed) and `literal-text-overflow`; `canvas-layout.md` section 6.
- **Responsive screens:** `canvas-layout.md` section 9, computed geometry (measured) against
  auto-layout containers (a skeleton and ten traps, marked to confirm); theme tokens are section 10.
- **Power Pages security review:** `power-pages.md` section 8 (a release checklist, each item
  measured or from documentation) and `scripts/audit-pages-permissions.py`; the design section is
  now section 9.
- **Flow run diagnosis:** `power-automate.md` section 18 and `scripts/flow-runs.py`, measured on a
  real failed run (the error of an action inside a loop is only on the failing iteration; list the
  side effects before any resubmit).
- **Model-driven apps:** `model-driven-and-docs.md` section 8.
- `SKILL.md` "Alongside Microsoft's official plugins".

### Changed

- `assets/settings.snippet.json` anchors every hook on `$CLAUDE_PROJECT_DIR` (the relative form
  stopped running from a subfolder) and allows the harness's read-only tools.
- `check-canvas-format.mjs` evaluates layout constants written as named formulas, resolved `If`
  conditions, `Mod` and real rounding, so far more geometry is measured; on one app, existing screens
  showed text-fit findings the earlier version could not see (2 of 9 screens now block on edit).
- `canvas-browser.mjs` finds `selectors.json` next to itself when installed into a project.
- The pre-flight hook ends with `process.exitCode`, not `process.exit` (Windows aborted while a
  network handle was closing).

## [0.14.0] - 2026-10-03

### Added

- `power-pages.md` section 8: use a design skill for the design and this reference for the
  platform. Recommends the third-party impeccable skill (install commands for Claude Code and other
  agents, a manual fallback), and how to pair them: `init` for the product and design context, the
  brand pack as input, impeccable owning the look while this reference owns the platform
  constraints, then its critique or polish pass and an independent review. A site that followed
  every platform rule looked like a stock portal until it was redesigned this way.
- ROADMAP: the gaps found comparing this skill with Microsoft's official Power Platform plugins,
  highest value first (working alongside them, requirements to verification, container layout,
  accessibility and contrast checks, Power Pages security review, flow run diagnosis, model-driven
  apps, install and update), and what is out of scope.

### Changed

- README: how this skill relates to Microsoft's plugins, under Limits.

## [0.13.0] - 2026-10-03

### Added

From building a multi-screen evaluation and change-board canvas app over Dataverse:

- `canvas-shipping.md` section 4: a clean push may not mark Studio dirty (no-op edit, then save);
  choose the no-op property with care and compare the downloaded `App.pa.yaml` with the source; a
  push that deletes controls can crash Studio (keep removed controls hidden for one push, watch
  `pageerror`).
- `power-fx-and-pa-yaml.md`: lookup tables built in `OnStart` race the start screen's load (end
  `OnStart` by re-running it); a Yes/No column can fail to read in the player, so derive decisions,
  and derive any flag an external client cannot be trusted to set.
- `canvas-controls-and-patterns.md`: `App.OnError` naming the failing control; a result toast that
  never covers navigation; use the control type Studio writes (`ModernDatePicker`); a
  create-and-select fallback when the new row's id is not returned usefully.
- `browser-verification.md` section 11: Studio's tree search changes what a coordinate click
  selects.

## [0.12.0] - 2026-10-03

### Added

- `power-pages.md` section 8, from redesigning a real site in its organisation's identity: take
  the brand from the brand pack; own the Header and Footer templates and one CSS web file; the
  platform theme's rules on bare paragraphs and headings and how to beat them; CSS web files under
  Home are linked automatically with a version stamp (a second link loads it twice; clear the
  browser cache to judge a change); artwork kept out of git with a prepare script and a designed
  fallback (review screenshots too); phone-first forms (pills, optional sections with a count,
  money inputs, first field on the first screen); echoing answers in the form's own words via a
  Liquid lookup and keeping typed cents; the stage as a track; an independent review of the
  rendered pages, which found six defects two self-review rounds missed.

## [0.11.1] - 2026-10-03

### Changed

- `power-pages.md` section 4: claims mapping on the built-in Entra provider did not fill the
  contact even after a site restart; identify the person by `adx_identity_username` (the Entra
  object id) and resolve name and email in the back-office app. Turn off the profile redirect on a
  site without a profile form (every sign-in otherwise lands on an empty `/profile/`).

## [0.11.0] - 2026-10-03

### Added

- `references/power-pages.md`, from the first Power Pages build: choosing canvas, Pages or
  model-driven by audience and licence (split by audience; no SharePoint mirror to avoid licences);
  the site in git with `pac pages download/upload` and hand-written enhanced-model records (pages,
  table permissions, site settings, web links); two guards on every write (table permissions for
  rows, `Webapi/<table>/fields` for columns); Append AND Append To on both tables of a lookup set
  through the Web API (the documented rule returned 403); process columns kept out of the client;
  identity derived in Liquid; the Private-site gate is not a site sign-in; first-sign-in consent;
  the blank contact and claims mapping (recorded as unverified); Liquid `fetchxml` reads and Web API
  writes with the anti-forgery token; no `for ... else` in Power Pages Liquid (a parse error blanks
  the page); clearing config after an upload; verifying signed out, as the submitter, in Dataverse,
  the refusals, and at phone width.
- `SKILL.md` routes Power Pages tasks to the new reference and names them in the description.

### Changed

- `deploy-tables.py` waits out the org-wide customization lock (429 `0x80071151`) with its own
  budget (20 s x 13): a Power Pages site still provisioning held it for minutes, longer than the
  ordinary 429 backoff. `dataverse-web-api.md` section 6 lists the signature.

## [0.10.1] - 2026-10-03

### Added

- `audits.md` section 7: compare the published control order with the repo, per container. Every
  property matched while a card published on top of its gallery; the page looked empty and the DOM
  still held the gallery's text.
- `canvas-shipping.md` Path B: the push does not reorder controls Studio already has - append new
  controls, rename controls that must move, then run the order check.
- `reporting.md` 1b: carry unfinished work into the next period by two separate moves (back to the
  backlog, then planned into the next period), driven by the change log's Carry-over rows; one direct
  move is classified as unplanned scope removal and can race the history writer.

## [0.10.0] - 2026-10-03

### Added

- `power-fx-and-pa-yaml.md` section 5: a "no parent" (blank-lookup) filter. `IsBlank(Lookup)` inside a
  delegated `Filter` compiled and failed at run time; `IsBlank(Lookup.Id)` compiled with one
  delegation warning that made the whole `Filter` local, so every picker choice read only the first
  500 rows. The pattern that keeps it delegable (narrow only the branch that needs it), reading
  delegation warnings per control, and `_lookup_value eq null` to confirm server-side.
- `canvas-controls-and-patterns.md` section 5: one picker for "All", "None" and real records with
  sentinel ids, and writing blank for both sentinels on save.
- `dataverse.md` section 10: who sprints - a team of one rather than a second owner type, a
  membership table with allocation and dates, project optional on work items, keys that fall back
  to the team and resolve by a global number.
- `reporting.md` section 4, three medallion rules: an untyped row appended to a typed table makes the
  shared columns type `any`, which the lakehouse destination drops (build the row with
  `Value.Type(Base)`); give records with no parent a named "None" member in gold and recompute checks
  with the same mapping; Direct Lake lists "(Blank)" on dimensions with no orphans, so prove the data
  clean in DAX and SQL and hide the member on slicers.
- `audits.md` section 7: compare the published app with the repo as YAML (control/property pairs,
  properties present on both sides, control sets), because Studio drops default-valued properties.
- `browser-verification.md`: reload the player with a cache-busting query string and answer any new
  consent prompt; choosing the option a ComboBox already holds can leave its list open and swallow
  the next click - press Escape.
- `tooling-and-auth.md`: a tool that reads stdin hangs the agent's shell (`< /dev/null`); a single
  query result unrolls, and `+=` on it throws `op_Addition` (wrap in `@()`).
- `reporting.md`: a contents list, like every other reference over 100 lines.

### Changed

- The skill description is in the third person and says what the skill does before when to use it.
- Duplicated guidance consolidated, each topic in one home with pointers from the others (9
  passages): player cache and Studio Preview (`browser-verification.md` section 10), publish
  propagation measurements and declared-versus-present checks (`canvas-shipping.md`,
  `dataverse.md` section 2), Preview error banners, the review workbook and cut-over
  (`data-migration.md`), relationship husks (`dataverse.md` section 9), the security-role summary
  (`security-and-access.md`), gallery row clicks (`canvas-layout.md` section 3), and the PowerShell
  5.1 traps (`tooling-and-auth.md` section 5, one table instead of a table and a list).
- A preview-tool note no longer says "as of the time of writing"; it says to check `--help`.

## [0.9.0] - 2026-10-03

### Added

- `references/reporting.md` section 1b: the change log beside the event table - one row per changed
  field, diffed against the last event by the history flow (trigger concurrency 1), with stage, kind,
  Unplanned, reason and a classification table; "original" columns set once so plan against actual
  is a subtraction; the variance waterfall. Section 5: Power BI inside a canvas app (tile control with
  `AllowNewAPI` and a URL filter, the first-use consent and sign-in, no mobile rendering) and the
  "Open in Power BI" link that always works. Section 4: `MissingField.UseNull` with non-nullable types,
  no relationship between sibling dimensions, where an SLA clock starts, workspace folders, PBIR and a
  notebook model refresh; licensing on F64 / P1 by sharing.
- `canvas-controls-and-patterns.md` section 3: after Save a modern input can show the pre-edit value,
  and `Reset()` last does not fix it; reset the inputs in the save formula before the reload.
- `dataverse.md`: a custom table must not share a display name with a system table (Team / Teams).
- `power-automate.md`: branch-safe expression forms (clamped index, `take()`, `ticks(if(empty()))`).
- `browser-verification.md`: assert formula-bar focus before typing in Studio; parallel agents
  sharing one browser must hold their own tab.
- `audits.md`: a pipe reports the last command's exit code, not the audit's.

### Changed

- `tooling-and-auth.md`: the case-insensitive variable row now carries two measured collisions and
  says to avoid single-letter names.
- `reporting.md` and the `SKILL.md` router name the change log, variance and embedding.

## [0.8.1] - 2026-10-03

### Added

- `references/reporting.md` section 4: the rules a real medallion build over an event history needed -
  lower-case text ids (the SQL endpoint returns upper-case GUIDs), one day convention, the record-day
  snapshot in silver with dimension copies in gold for Direct Lake, one relationship path per table,
  zero periods from the date dimension, the model refresh after every data run, retrying a new
  dataflow's first refresh and reading real M errors through query execution, verification by SQL and
  DAX recomputation, and naming the refresh identity.

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
