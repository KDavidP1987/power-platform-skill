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
  version: "0.1.0"
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
8. **A flow that writes back to its trigger table must guard on a value its own write changes.**
   The update trigger delivers the whole row, so any other guard loops forever, billed per run.
9. **Before any bulk write, ask what watches the table** - and count the messages that would go
   to real people, then park the sender.
10. **An audit that can pass vacuously will.** Give every check a floor ("found at least N write
    paths"), prove it goes red on a known-bad input, and make it say when its own inputs are stale.

## The working loop

Every non-trivial change moves through the same cycle. Skipping a step is how a change reaches a
user unproven.

1. **Pre-flight.** Correct branch, clean tree, `pac org who` names the right environment. Read
   the project's state file (`docs/STATE.md` or equivalent) before touching anything.
2. **Specify.** A written spec for anything non-trivial - an issue, or a backlog entry. Include
   who uses it, what proves it works, and what it touches (consult the dependency register).
3. **Build in source.** Edit `.pa.yaml`, solution XML, or flow JSON in the repo. Hooks check each
   write for the compile-killers in `references/power-fx-and-pa-yaml.md`.
4. **Audit.** Run the project's audit suite. Treat a stale-input result as unverified, not as a
   pass.
5. **Compile against a live Studio session** (canvas only). This is the only step that proves the
   formulas bind to real data sources. Open Studio first, confirm the title reads `(Editing)`,
   then connect, then compile, and **read the first line of the result** - a "no active
   coauthoring session" warning means it validated against nothing.
6. **Build the artifact on the LIVE manifest and assert on it.** Not the repo's stale `.msapr`.
   Strip security roles. Check the zip contains every component and every marker you changed.
7. **Import / publish.** Then confirm what landed: download the app, read `LoadFromYaml`, search the
   half that runs for your markers, compare data-source counts with the previous live app.
8. **Perform the task in the published app** with Playwright, after refreshing past any cached
   build and confirming the build stamp. Check the result in the database. Restore anything you
   wrote, and record what you touched.
9. **Document in the same change.** Changelog, dependency register, decisions log, state file.
10. **Refresh the audit inputs** so the next audit describes the app that now exists.

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
| Building or debugging a screen: TextInput/NumberInput/CheckBox/ComboBox/DropDown/Gallery/Timer quirks, OnChange firing on render, Default/Reset, edit screens and concurrency, permission gates, overlays, read-model tables, honest UX | `references/canvas-controls-and-patterns.md` |
| Layout: text width and clipping, gallery row slicing, scrollbars, z-order, unclickable controls, geometry audits | `references/canvas-layout.md` |
| Driving Studio or the published app with Playwright: scenarios, iframes, committing input, dropdowns, stale player cache (IndexedDB), save/publish proof, MCP startup timeouts, scenario design and negative tests, dead-click and clip sweeps, OData trace instead of Monitor | `references/browser-verification.md` |
| **Dataverse** | |
| Solutions and schema: pack/unpack, asserting on the artifact, imports that never remove, what cannot change after creation, solution membership and shared tables, retiring components, column types, schema hygiene, delete behaviour, effective dating | `references/dataverse.md` |
| Scripting the Web API: idempotent provisioning, payload ordering, which errors to retry, metadata PUTs, choice members, alternate keys, solution components, dependencies, paging and counts, `systemuser`, PowerShell 5.1 traps | `references/dataverse-web-api.md` |
| Who can read or write: roles kept out of solutions, `ReplacePrivilegesRole`, depth and record sharing, Append/AppendTo, impersonation, column security, SharePoint virtual tables, onboarding users | `references/security-and-access.md` |
| Writing live data: migrations, backfills, spreadsheet loads, crosswalks, agreement audits, purges, rollup rebuilds, cutover | `references/data-migration.md` |
| **Power Automate** | |
| Cloud flows: definition shape, triggers and message codes, `runtimeSource`, loops and sentinels, activation-only defects, dates and nulls, imports changing flow on/off state, run-as identity, notifications and safety caps, bulk writes, FetchXML, run history | `references/power-automate.md` |
| **Process and environment** | |
| Writing or trusting an audit; stale inputs; vacuous passes; reusable tool designs | `references/audits.md` |
| Starting a repo: layout, bootstrap, hooks, continuity docs, trackers, templates, CI, shipping without pipeline rights | `references/project-setup.md` |
| Several apps sharing one environment or a shared reference solution | `references/shared-environments.md` |
| pac, tokens, the TDS endpoint, MCP servers, Windows/OneDrive/PowerShell failures, and production actions Claude Code must hand to a person | `references/tooling-and-auth.md` |
| Model-driven forms by script, user guides/SOPs from the running app, licensing, weekly reporting from git, replacing a spreadsheet tool | `references/model-driven-and-docs.md` |

## Bundled tools

All are dependency-light and project-agnostic; each reads its configuration from the project rather
than carrying an id. Run any of them with `--help`.

| Tool | Use |
|---|---|
| `scripts/canvas-browser.mjs` | Playwright driver for the maker portal and the published player: `login`, `check`, `play`, `walk <scenario.json>`, `studio`, `save`, `publish`, `close-studio`, `shot`. `--fresh` clears the player's cached build, `--trace` records `$batch` traffic, and a scenario that writes must declare a `restore`. `lint` checks a scenario without a browser. Scenario verbs include `click`, `type`, `select`, `expect`, `absent`, `deadclick`, `clipcheck`. Needs `npm i playwright`. |
| `scripts/inspect-artifact.py` | Opens a solution zip or `.msapp` and reports what is really inside: root components vs built metadata, security roles, canvas `LoadFromYaml`, build stamp, data-source count, `DatabaseReferences` vs `DataSources.json`, marker search in the half that runs. Python 3 standard library only. |
| `scripts/lint-flows.mjs` | Static checks on cloud-flow definition JSON: invoker runtime on non-app triggers, self-write without a sentinel guard, apostrophes in expression literals, references outside the `runAfter` path, trigger message codes, sends chained after `Failed`, single-`@` property names, multiple triggers, date-only columns used as instants (`--date-only`), cross-flow cycles. Node 18+. |
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

## How to behave

- **Lead with the mechanism, then the fix.** When diagnosing, name which cache or which half or
  which step is lying, explain why every green signal so far was answering a different question,
  and give the shortest test that would move the failure (change one thing, ship it alone).
- **State what is unproven.** If a restriction could only be tested as an admin, if a check ran on
  stale inputs, if a count is an upper bound - say so in the output. Confidence you do not have is
  the most expensive thing you can give a Power Platform developer.
- **Every write is production data** unless proven otherwise. Dry-run first, print the rows, fill
  blanks rather than overwrite disagreements, read back after writing, make it idempotent.
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
