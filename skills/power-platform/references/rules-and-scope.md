# Rules and their scope

Every rule this skill carries, the surfaces it applies to, and how it is enforced: by a **hook** (runs
whether or not anyone remembers it), by a **script check** (runs when its tool runs, and refuses), or as
an **instruction** (in SKILL.md or a reference, which an agent can forget as its context fills). Read
this before adding or changing a rule.

## 1. Surfaces

The hooks decide scope from the folder, never from what the agent says it is building
(`plugin-gate.mjs` `surfaces()`):

| Surface | Detected by |
|---|---|
| Canvas | `canvas/<app>/Src`, or `canvasSrc` in `scripts/canvas-app.json` |
| Power Pages | a folder holding `website.yml` (dot folders and `node_modules` skipped) |
| Power BI | `definition.pbir` or a `*.Report` folder under `fabric/` |
| Fabric | a `fabric/` folder at all (notebooks, pipelines, lakehouse items) |
| Dataverse (and model-driven) | `solution/src`, `dataverse/`, `scripts/dataverse/`, `tables.json` |
| Power Automate | `*.json` under `flows/` or any `Workflows/` folder |

A **Power Platform project** is any of these, or a folder with `.ship-work/` or `canvas-app.json`.
Outside one, every hook is silent: the plugin changes nothing in unrelated projects.

Every blocking message starts with the surfaces it applies to, for example `[Canvas]`, `[Power Pages]`,
or `[Power Automate]`. The person can then see at once why the rule fired.

## 2. When a rule becomes a hook

An instruction is promoted to a hook or a script check only when **all four** hold:

1. **Evidence.** A measured build forgot it or skipped it. A rule that every build followed stays an
   instruction.
2. **Mechanical.** It can be decided from files or the transcript with no false positives in the
   measured builds. A judgement (is this layout good) stays an instruction or goes to the reviewer.
3. **Costly to miss.** Skipping it cost a real defect, money, a lost run or a person's time.
4. **Safe.** The hook is silent outside its scope, names its scope, can never trap a session (the
   plugin Stop gate blocks at most three times a session, the harness once in a row), and offers an
   escape with a stated reason or an opt-out the person agrees to.

A hook stays narrow on purpose. One that fires on style gets ignored, and is then not there when it
matters.

## 3. The matrix

### Platform-wide (every Power Platform project)

| Rule | Enforcement | Where | Evidence |
|---|---|---|---|
| No emoji, no purple, violet, indigo or magenta in source and docs | hook | `check-standards.mjs` (each write), `audit-stop.mjs` (whole repo) | standard, always enforced |
| No leftover debug markers at the end of a turn | hook | `audit-stop.mjs` | standard |
| No access token written to a file or to shared storage | hook (Stop) | `plugin-gate.mjs` evaluate | a build staged the owner's token in a lakehouse file for a notebook |
| No background shell work still running at the stop (R1) | hook (Stop) | `plugin-gate.mjs` runChecks | a headless build lost two legs |
| No question to an absent person (R2) | hook (Stop) | `plugin-gate.mjs` runChecks | a build stopped three times to ask what it had already answered |
| Test writes proven back: seed check, or test rows listed (R3) | hook (Stop) | `plugin-gate.mjs` seedState | two builds handed back with their test edits in the seed |
| Shell-call count and elapsed time reported | hook (after shell calls), never blocks | `plugin-gate.mjs --post` | one lead made 472 single calls |
| Session baseline: git state, pac environment, `docs/STATE.md` | hook (SessionStart) | `preflight.mjs` | standard |
| A shared table changed: record it in the shared registry | hook (reminder) | `shared-guard.mjs` | only when shared prefixes are configured |
| The repo is the source of truth (1); assert on the artifact (2); perform the task as the role (3); verify where it lands (4) | instruction, plus script checks where a tool exists (`inspect-artifact.py`, walks with Dataverse confirms) | SKILL.md 1 to 4 | judgement per task; no file test decides them |
| An audit must not pass vacuously (11) | instruction; every bundled check has a floor and a self-test | SKILL.md 11 | a design rule for checks, not a project state |

### Canvas

| Rule | Enforcement | Where | Evidence |
|---|---|---|---|
| Design (DESIGN.md, `design/prototype.html`) before the first screens of a new app | hook (before tools) | `plugin-gate.mjs` rule A | a build never ran the design step though it was "required" |
| Design record, critique and review before hand-back | hook (Stop) | `plugin-gate.mjs` evaluate, and the harness's `audit-stop.mjs` (same function) | as above |
| Compile-killers in `.pa.yaml` (a full-line comment between controls is not one; a `#` line inside a formula and ` #` in a single-line value are) | hook (each write): the harness copy, or the plugin's own where the session's folder has no harness copy | `check-pa-yaml.mjs` (`--plugin` from the plugin) | each pattern broke a real compile; a session opened at a parent folder ran no harness and missed one; section banners compiled clean on 30 screens |
| Text fit, theme tokens, contrast, visible build stamp, accessible names | hook (each write) | `check-canvas-format.mjs` | measured clipping and a stamp shown to users |
| Text fits vertically: one line of the font fits the box (`text-cut-vertically`); a one-line box holding data that can exceed its width has Wrap false and a Tooltip (`one-line-box-wraps`); a literal paragraph has room for its lines at the design width (`literal-text-overflow`) | hook (each write) and script check | `check-canvas-format.mjs` | labels cut at the top and the bottom shipped past every check; 14 found in one published app |
| A text check that measured none of the bound text is not a pass (exit 2); under half measured warns loudly | script check | `check-canvas-format.mjs` | layout constants lost to a comment: 0 of 225 measured, 0 findings |
| Controls drawn over controls; text over a clickable shape (`covers-control`); a click-to-dismiss scrim is still a modal backdrop | hook (each write) | `check-canvas-overlap.mjs` | measured; a clickable scrim produced 259 false overlaps in one app |
| Text cut at the top and the bottom in the running app | script check (walk step `clipcheck`) | `canvas-browser.mjs` | measured: 14 cut labels the whole-line count missed |
| The held Studio tab stays open until after publish; a save stamp older than the click is UNPROVEN | script check | `canvas-browser.mjs second-tab`, `save` | a push lost after the held tab closed; SAVE LANDED printed for a 12-minute-old stamp |
| Screen-file ceiling | hook (Stop) | `audit-stop.mjs` | a compile refused at 50 files |
| No critique floor | none, deliberately | | no canvas build has been measured against a floor yet; record the score, add a floor when the evidence exists |
| Know which build runs (5); delegation (10) | instruction, plus `check-drift.py`, build-stamp read-back in `ship-canvas.py` | SKILL.md 5, 10 | per screen judgement |

### Power Pages

| Rule | Enforcement | Where | Evidence |
|---|---|---|---|
| Design record, critique at 30/40 or more (or "Below 30 accepted: reason"), review covering identity, profile, permission scope, Web API, refusals | hook (Stop) | `plugin-gate.mjs` evaluate | three measured site builds (critique 25 to 30) |
| Global read with the table's Web API not explicitly off | script check (exit 1) | `audit-pages-permissions.py` `GLOBAL-READ-UNGUARDED` | all three measured sites |
| Refusals, double writes, nav marker, focus indicator, layout at 390 px | script check | `site-walk.mjs walk` | measured defects in the three builds |
| Settle identity first; record the decisions | instruction (template) | `assets/templates/pages-decisions.md` | every build recorded its decisions unprompted; identity needs an administrator, which no hook can supply |
| No HTML prototype required | none, deliberately | | not required by the brief; the site is its own prototype |

### Dataverse and model-driven

| Rule | Enforcement | Where | Evidence |
|---|---|---|---|
| Plan before a table deploy | hook (before tools) | `plugin-gate.mjs` rule B | a build never ran the planning step the skill called required |
| Plan first, idempotent writes | script check | `deploy-tables.py`, `seed-data.py` (plan unless `--apply`) | standard |
| Schema before screens (6); security roles out of the solution (7) | instruction | SKILL.md 6, 7; `dataverse.md`, `security-and-access.md` | a role-carrying import reset live access once; deciding "this import carries roles" from source is possible but has not been missed in a measured build |
| Before a bulk write, ask what watches the table (9) | instruction, plus `lint-flows.mjs --require-safe-recipients` | SKILL.md 9 | |
| Model-driven apps | no hook | `model-driven-and-docs.md` | no measured model-driven build; the build gate stays silent for a solution-only folder |

### Power Automate

| Rule | Enforcement | Where | Evidence |
|---|---|---|---|
| No flow ships that could loop (8): lint over every flow, no waiver | hook (before `pac solution import`) and script check | `plugin-gate.mjs` rule C reads `.ship-work/flow-lint.json`; `deploy-flows.py` lints and refuses when the lint cannot run; `--skip-lint` is refused on a live run | 1,203 runs in 45 minutes in one project; before 0.25 a plain import skipped the lint |
| No message to anyone but the permitted address during a build | script check | `lint-flows.mjs --require-safe-recipients` | standard |

### Power BI and Fabric

| Rule | Enforcement | Where | Evidence |
|---|---|---|---|
| Design record, critique and review for a report | hook (Stop) | `plugin-gate.mjs` evaluate | as canvas |
| No token in a lakehouse or file | hook (Stop) | `plugin-gate.mjs` evaluate (also a Fabric-only folder) | measured |
| Report figures match Dataverse | script check | `reconcile-report.py` | standard |
| Medallion shape, refresh without a person | instruction | `reporting.md` | per design |

## 4. Known gaps

- A project with the harness but **without the plugin** gets the Stop rules (the harness's
  `audit-stop.mjs` calls the same `evaluate`) but not rules A to C, which run only from the plugin's
  PreToolUse hook. `deploy-flows.py` still refuses an unlinted flow. Install the plugin for the order
  gates.
- `check-all.mjs` lints one flow folder. A project with both `flows/` and `solution/src/Workflows`
  must lint both, or rule C refuses the import and says how many flows the run covered.
