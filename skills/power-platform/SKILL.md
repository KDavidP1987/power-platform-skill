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
  Also auditing and rebuilding Fabric workspaces that feed Power BI.
  Not for DAX measures, C# plugins, desktop flows, or custom web apps on the Dataverse API.
license: MIT
metadata:
  author: SkillEra
  version: "0.36.0"
---

# Power Platform development

Build canvas apps, Dataverse solutions, Power Automate flows and Power Pages sites the way software
is built: the definition lives in git, a portable artifact is built from it and deployed
deliberately, and the change is proved by **performing the task in the running product**, not by
the fact that it compiled. Almost every Power Platform failure is silent - a pack exits 0 while
dropping a component, a compile passes against no data sources, an import reports success for the
wrong zip, a published app runs a cached manifest - so at every step ask: **what does this step
actually prove, and what does it not?**

## The non-negotiables

These hold on every task. `references/rules-and-scope.md` says which a hook enforces, which a script
refuses, which stay instructions, and the surface each applies to.

1. **The repo is the source of truth.** Canvas screens are `.pa.yaml` under `canvas/<app>/Src/`; the
   solution is an unpacked tree under `solution/src`. Studio is a validator and a data-source
   editor, never the last place a change was made; whenever Studio was touched, re-ship from git.
2. **Assert on the finished artifact, never on the exit code.** `pac solution pack` returns 0 while
   dropping components; an import says "success" for whatever zip it was handed. Open the zip.
3. **Verify in the running product, by performing the task, as the role that will use it.** The
   published app is the test harness and Playwright reaches it. An admin session proves nothing
   about a restriction: say a gate is unverified rather than imply it was checked.
4. **Verify the effect where it lands.** Query the table; the screen that wrote the row is the least
   independent witness.
5. **Know which half of the app runs, and which build the browser is on.** Read `LoadFromYaml` and
   the build stamp, and refresh the player before judging anything.
6. **Schema before screens, and never in one step.** A new column does not exist for a published app
   until its data source is re-added in Studio and published. Get column types right before a
   canvas app binds them - Dataverse cannot change an attribute's type.
7. **Security roles stay out of the solution.** An import carrying roles resets live access control.
   Every table the app binds must be granted by some role, proved by impersonation.
8. **No flow ships that could loop - a hard gate.** Before any import, `scripts/lint-flows.mjs` over
   ALL the solution's flows exits 0 and no finding is waived: Update triggers without
   `filteringattributes`, self-writes not stopped by a value they change, cross-flow cycles
   (including a Create-triggered flow creating its own rows), a write that can land two values that
   each start a flow. A recovery or sweep job ends in a terminal state a person re-arms. The update
   trigger delivers the whole row, so any other guard loops, billed per run (one project: 1,203 runs
   in 45 minutes). The plugin refuses `pac solution import` until a clean lint over every flow is
   recorded. `references/power-automate.md` sections 3 and 4.
9. **Before any bulk write, ask what watches the table**, count the messages that would reach real
   people, and park the sender. While a build must not reach real people, prove it from source
   (`lint-flows.mjs --require-safe-recipients` over every flow in the set, existing ones included)
   and run history, and pin the one permitted address in the flow source. A leak found in an
   existing flow is fixed in its source file in the same change, not only reported.
10. **Query the source; do not filter a copy of it.** A collection holds at most the data row limit
    (500 by default, 2,000 at most) and answers silently from that prefix. Put a gallery's or
    picker's query in its `Items` as a delegable `Filter`/`Search` on the source, filter a lookup by
    the record or its id, and say which clauses delegate. `references/power-fx-and-pa-yaml.md`
    section 6.
11. **An audit that can pass vacuously will.** Give every check a floor ("found at least N write
    paths"), prove it goes red on a known-bad input, and make it say when its inputs are stale.
12. **Select before you apply - every Dataverse change, schema or data, deletes above all.** First
    run the read-only selection the change will act on (the same `$filter`, the same code path) and
    read it: every row or component touched, the exact request bodies, and for a delete or retype
    what holds data or depends on it. Plan is the default; the apply needs `--apply`, acts only on
    what the plan showed, and refuses if the live state changed since. `deploy-tables.py` and
    `seed-data.py` enforce this; the plugin refuses inline Web API writes and write scripts with no
    plan mode. `references/dataverse-web-api.md` section 16.

## How to behave

- **A hook denial is an instruction.** Do the named step with its tool, then retry; never work
  around it. The plugin's hooks enforce the build order, the flow lint and the hand-back checks.
- **Lead with the mechanism, then the fix.** Name which cache, half or step is lying, why every green
  signal so far answered a different question, and the shortest test that would move the failure.
- **State what is unproven**: a restriction tested only as an admin, a check on stale inputs, an
  upper bound. Never call a sweep clean beyond what it covered - say which widths, roles and checks.
- **Every write is production data** unless proven otherwise: dry-run, print the rows, fill blanks
  rather than overwrite disagreements, read back, make it idempotent.
- **Ask the person for decisions, never for labour.** Collect every decision at the start (theme,
  names, recipients, sample-data volume); do Studio steps through the driver, create this build's
  own connections, sign in once. With no person present, take your own recommendations, record them
  in `docs/decisions.md`, and never end a turn on a question. `references/orchestration.md` section 5.
- **When a step is the person's, hand them one `!`-prefixed line** to run in this session, after
  running every offline step yourself: absolute quoted paths, what it does, what to expect; then
  verify the effect. `references/tooling-and-auth.md`.
- **Read the first diagnostic, not the loudest.** One broken `ClearCollect` in `App.OnStart` produces
  hundreds of errors on screens nobody touched.
- **Never reload Studio or import while a co-authoring push is held, and close Studio through its
  Back button.** Each silently discards work or strands a lock.
- **Treat measured behaviour as measured.** Microsoft changes Studio, the player and connectors;
  confirm anything marked "observed once" in your environment before building on it.
- **Leave the machine as you found it**: close the tabs you opened, release every Studio session,
  run `canvas-browser.mjs tidy` before the hand-back.
- **Write lessons where the next person will look** - the shared standards, not only one project's
  notes. When the skill itself misled you or had no answer, offer the person a GitHub issue about the
  skill's behaviour only - never what they are building, names or ids. `references/feedback.md`.
- **Keep the skill current.** The plugin checks for a newer release weekly at session start; relay
  its notice once and update only on a yes. Without the plugin's hooks, run
  `node scripts/hooks/update-check.mjs --print` once per session. What changed: `CHANGELOG.md` here.

## A new app or a multi-part build, in this order

Copy this checklist into your notes and tick it off. These are actions, not advice: a measured build
that skipped the design and planning steps lost its design score.

```
- [ ] 1. Plan: acceptance contract from the brief (assets/templates/acceptance-contract.md) - every
         requirement as a row someone can perform, the business rules the brief leaves implicit,
         one list of decisions each with a recommendation
- [ ] 2. Harness: node scripts/setup-harness.mjs --apply (its defaults when no person is present)
- [ ] 3. In one message: a design helper runs impeccable (init for PRODUCT.md and DESIGN.md, then
         design/prototype.html for every screen at 1440 and 390 px, one critique, one fix batch)
         while the lead deploys the schema, seeds sample data and creates connections
- [ ] 4. Build in lanes: flows and reporting once the schema is in; canvas, one helper per screen,
         once the prototype is (scripts/canvas-browser.mjs create makes the app)
- [ ] 5. After the first publish, in one message: critique helper, read-only reviewer
         (assets/templates/reviewer-prompt.md), the lead's walks
- [ ] 6. One fix batch, one publish, one walk call; seed restored and checked; hand back
```

If the critique, the reviewer or a walk finds a defect, go back to step 4 for that lane inside the
single fix batch. The plugin refuses screen `.pa.yaml` before `DESIGN.md` and the prototype exist, a
table deploy before the plan exists, and a hand-back without the critique and the review; the driver
refuses a third publish until both are written. Budget: about an hour of agent time for a five-screen
app with two flows and a medallion. Details: `references/orchestration.md` and
`references/project-setup.md` section 3 (theme intake, impeccable, tokens).

## The working loop, for every non-trivial change

```
- [ ] 1. Pre-flight: right branch, clean tree, `pac org who` names the right environment, read
         docs/STATE.md. New project: offer GitHub and the harness (project-setup.md 4 and 12)
- [ ] 2. Specify: who uses it, what proves it works, what it touches (dependency register). For an
         app or feature with several actions, the acceptance contract and contract-to-walk.mjs
- [ ] 3. Build in source: .pa.yaml, solution XML, flow JSON. New tables and columns in tables.json,
         then deploy-tables.py --plan, shown to the person, then without --plan
- [ ] 4. Check: node scripts/check-all.mjs (format, overlap, flow lint, drift, seed, stamp)
- [ ] 5. Canvas: compile against a live Studio session - title reads (Editing), then connect, then
         compile; read the first line of the result
- [ ] 6. Build the artifact on the LIVE manifest and assert on it: scripts/ship-canvas.py
- [ ] 7. Import or publish, then confirm what landed: LoadFromYaml, your markers in the half that
         runs, data-source count against the previous live app
- [ ] 8. Perform the task in the published app: canvas-browser.mjs walk with Dataverse confirms,
         after refreshing past the cached build; the first screen renders signed-in data; restore
         what you wrote
- [ ] 9. Document in the same change (changelog, dependencies, decisions, state); refresh audit inputs
```

A failure at step 4 or 5 goes back to step 3. A missing marker at step 7 or a failed walk at step 8
goes back to step 3 as well - never forward to the next change. Read `references/canvas-shipping.md`
before the first ship in a session; it holds what each step proves and the two ship paths. Once an
app works end to end, offer the documentation set (`references/documentation-set.md`).

At step 3 the hooks catch the compile-killers at write time; where they are not wired, run
`scripts/hooks/check-pa-yaml.mjs`, `check-canvas-format.mjs` and `check-canvas-overlap.mjs` over
every folder you wrote to. A `#` line or an unquoted `": "` inside a formula fails the whole app's
compile. Every data-bound label must fit its longest value or clamp with an ellipsis and a tooltip;
text must fit vertically too. No control may sit over another that can be visible at the same time.
Screens use the theme's tokens, never literal colours (`references/canvas-layout.md`).

## Where to look

Read only the reference the task needs; each topic has one home.

| If the task involves | Read |
|---|---|
| Planning, no person present, the time budget, the design lane, parallel lanes and helpers, lock owners, cost and compaction, the independent reviewer and the fix round | `references/orchestration.md` |
| Shipping a canvas change and proving it landed: ship paths, live manifest, build stamps, `LoadFromYaml`, Save vs Publish proof, player caching, Studio teardown on push, rollback, the screen-file ceiling | `references/canvas-shipping.md` |
| Studio read-only, `connect` 422, thousands of "isn't recognized", "locked by user", the authoring MCP misleading | `references/authoring-sessions.md` |
| "Works in Studio, fails in the published app"; a new column, choice or table the app cannot see; option-set members, entity set names, the Data pane | `references/manifest-caches.md` |
| Power Fx and `.pa.yaml`: silent no-op buttons, `App.OnStart`, collections, types, lookups, delegation and the row limit, large-table reads, identity, compile output | `references/power-fx-and-pa-yaml.md` |
| Screen controls and patterns: input quirks, OnChange on render, Default/Reset, pickers with All/None, edit screens, permission gates, overlays, list filters, communication history, template guides | `references/canvas-controls-and-patterns.md` |
| Layout: responsive screens, text width and clipping, the fit rule, gallery rows, scrollbars, z-order, unclickable controls, theme tokens | `references/canvas-layout.md` |
| Driving Studio or the published app with Playwright: scenarios, iframes, input, dropdowns, stale cache, Add data and Refresh, sweeps, OData trace, the acceptance contract | `references/browser-verification.md` |
| Power Pages: choosing the app type, a site in git, table permissions and the Web API, sign-in, Liquid, the cache, per-person visibility, refusals with `site-walk.mjs`, security review, the organisation's brand, site lifecycle | `references/power-pages.md` |
| Dataverse solutions and schema: pack/unpack, imports that never remove, what cannot change, shared tables, column types, delete behaviour, effective dating | `references/dataverse.md` |
| Scripting the Web API: idempotent provisioning, retries, metadata, choices, alternate keys, paging, `systemuser`, PowerShell 5.1 traps | `references/dataverse-web-api.md` |
| Who can read or write: roles out of solutions, depth and sharing, Append/AppendTo, impersonation, column security, SharePoint virtual tables, onboarding users | `references/security-and-access.md` |
| Writing live data: migrations, backfills, spreadsheet loads, purges, rollup rebuilds, cutover | `references/data-migration.md` |
| Cloud flows: definitions, triggers, loops and sentinels, activation-only defects, dates and nulls, run-as identity, notifications and caps, bulk writes, FetchXML, run history and failed runs, documents | `references/power-automate.md` |
| Reporting: the history table, in-app charts, metric definitions, Power BI over a Fabric medallion, embedding, viewer licensing | `references/reporting.md` |
| Which rules a hook enforces, the surface each applies to, when an instruction becomes a hook | `references/rules-and-scope.md` |
| Writing or trusting an audit; stale inputs; vacuous passes | `references/audits.md` |
| An existing Power BI / Fabric workspace: lineage from M and TMDL, Excel consumers, usage, refresh health, dead items, staged retirement | `references/fabric-workspace-audit.md` |
| Rebuilding a reporting chain as a medallion: bronze from SharePoint lists and Excel workbooks, verifying against the files, parity with the old model, Python notebooks, reading Delta from Python | `references/fabric-rebuild-and-parity.md` |
| The skill misled you or lacked an answer: offering feedback, what it may and may not contain | `references/feedback.md` |
| Starting from nothing: the machine, pac, tokens, a browser that signs in by itself, identities signed in once, the smoke test | `references/first-run.md` |
| Starting a repo or app: the harness, theme intake, layout, hooks, continuity docs, CI, offering GitHub | `references/project-setup.md` |
| CI/CD: service-principal pac auth, Solution Checker, managed vs unmanaged, deployment settings, the skill's tools as gates | `references/alm-pipelines.md` |
| Several apps sharing one environment or a shared reference solution | `references/shared-environments.md` |
| pac, tokens, TDS, MCP servers, Windows/OneDrive/PowerShell failures, production actions to hand to a person | `references/tooling-and-auth.md` |
| Model-driven apps, model-driven forms by script, SOPs from the running app, licensing, replacing a spreadsheet tool | `references/model-driven-and-docs.md` |
| The documentation set for a finished app: role guides, screenshots per role, the doc kit | `references/documentation-set.md` |
| Every bundled script and what it is for, Playwright two ways, working without Playwright, Microsoft's official plugins alongside this one | `references/tools.md` |
| Each script's options, exit codes and finding codes | `references/interfaces.md` |

## Tools and what they need

Needs: Python 3 (standard library only), Node 18 or later, the Power Platform CLI (`pac`), and for
browser work Playwright - `npm i -D playwright` drives the Chrome or Edge already installed; only
without either is `npx playwright install chromium` needed. Ask before installing anything. Until a
browser check can run, the change is **unverified**: say so, and give the person the exact steps to
perform in the published app and the Web API query that would confirm the effect.

The scripts used most: `canvas-browser.mjs` (Studio and the player: `create`, `save`, `publish`,
`walk`, `tidy`), `check-all.mjs` (the routine checks in one call), `ship-canvas.py` (solution-import
ship with artifact asserts), `deploy-tables.py` (schema from a manifest, plan first), `lint-flows.mjs`
(the loop gate), `inspect-artifact.py`, `check-drift.py`, `check-new-galleries.py`, `seed-data.py`,
`deploy-flows.py`, `canvas-mcp.py`, `site-walk.mjs` (Power Pages) and `setup-harness.mjs`. What each
does and when: `references/tools.md`. Microsoft's own Power Platform plugins generate apps and stop at
a clean compile; use them where they have a generator and this skill for the schema, the ship, the
proof in the published app and the guards.
