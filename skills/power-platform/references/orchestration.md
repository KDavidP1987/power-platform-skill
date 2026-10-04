# Orchestrating a build: lanes, helpers, cost and a hands-off person

How to build a whole Power Platform solution (schema, sample data, a canvas app, flows, a report)
quickly and cheaply without the parts colliding. Measured against a single-thread build of the same
brief, the single thread took 1.6 times as long and re-read twice the context, while a build that
handed screens to helper agents finished first. This reference is the pattern that closes that gap.

## Contents

1. The shape: one lead, lanes after the schema
2. The lane contract (what keeps parallel work from colliding)
3. What the lead keeps, and what it hands off
4. Cost discipline
5. Hands-off: the person gives decisions, not labour
6. Browser hygiene
7. The finish: one verification round, one fix batch, one confirm

## 1. The shape: one lead, lanes after the schema

```
lead: spec + acceptance contract + design (DESIGN.md, tokens, Power BI theme)
  |
  v
lane 0 (lead, serial): tables.json -> deploy-tables.py -> seed sample data -> read back
  |
  +--> lane A: canvas app   (create, data sources, one helper per screen, compile, ship)
  +--> lane B: flows        (definitions, lint-flows, deploy off, activate, run against seed rows)
  +--> lane C: reporting    (bronze/silver/gold, model, report with the theme, reconcile)
  |
  v
lead: acceptance walks, design critique, one fix batch, confirm, hand-back
```

- **Schema and sample data come first and alone.** Every other lane reads them. Seed enough
  realistic rows (`scripts/seed-data.py`, from a JSON or CSV file, idempotent by name or key) that
  each screen, flow condition and chart has something to show: overdue, due today, returned, edge
  lengths for the fit rule. Label the rows as sample data in a column so the report and cleanup can
  filter them.
- **Then the three lanes run at the same time**, each in its own helper agent, because none of them
  writes what another reads: the canvas lane writes `canvas/`, the flow lane writes `flows/`, the
  reporting lane writes `fabric/` and the workspace folder.
- **Inside the canvas lane, fan out again**: write `App.pa.yaml` (tokens, named formulas, data
  sources) and a short screen plan first, then one helper per screen writing only its own
  `.pa.yaml`. Compile once, after all of them return.
- **The lead runs the acceptance contract.** Helpers prove their own lane (the compile, a flow run, a
  reconciliation); only the lead walks the whole product end to end, because only the lead holds
  the contract.

## 2. The lane contract

Give each helper this, in its prompt, and nothing it does not need:

| Item | Example |
|---|---|
| Its files | `canvas/<app>/Src/ScreenLoans.pa.yaml` only |
| Its names | prefix, option-value range, flow name pattern, workspace folder |
| What it reads | `tables.json`, `canvas/theme.json`, `DESIGN.md`, the screen plan |
| Shared locks it may not take | the Studio co-authoring session (lead or canvas lane only), the solution import, the workspace model refresh |
| What "done" means | a stated check passes and its output is quoted |
| What it must never do | delete rows, change another lane's files, publish, email anyone but the owner |

- **One owner per lock.** Studio holds one co-authoring session per app: only the canvas lane holds
  it, and only for compile and push. A solution import from one lane while another holds Studio
  discards work. Fabric model refreshes run once, from the reporting lane.
- **Helpers return results, not transcripts**: what changed (files), what check passed (with the
  number), what is open. The lead never re-reads a helper's file dump.
- **A helper that is refused by a guard or a permission rule stops and reports.** The lead does not
  perform the refused action itself.

## 3. What the lead keeps, and what it hands off

| Lead keeps | Hand off |
|---|---|
| The spec, the acceptance contract, the design decisions | Writing screens, flow definitions, notebooks |
| Schema (lane 0) and anything shared between apps | Per-lane checks and fixes |
| The Studio lock schedule and the import | Screenshot sweeps and critiques at two widths |
| The final walks and the hand-back | Recomputation and reconciliation scripts |

Small, verifiable units go to helpers; anything that needs judgement across lanes stays with the
lead.

## 4. Cost discipline

The cost of a long build is mostly context re-read on every turn, not output.

- **Keep the lead's context small.** Read only the references the current step needs (the table in
  `SKILL.md`), not every one up front. Delegate anything that produces long output (screen files,
  Studio trees, run histories) and keep only its conclusion.
- **Batch checks into one script call.** Ten single-purpose shell calls re-send the whole
  conversation ten times. Write one check script that prints a compact table, and run it.
- **Use the bundled tools before writing new ones.** `deploy-tables.py`, `seed-data.py`,
  `deploy-flows.py`, `fabric.py`, `reconcile-report.py`, `canvas-browser.mjs` cover what a build needs;
  an agent that writes its own helper mid-build pays for it in time and tokens.
- **Do not patch the driver mid-build.** When the driver lacks a step, use the Playwright MCP tools
  for that step, record the gap, and fix the driver after the build.
- **Prefer a scenario walk to an interactive click-through** once a path works: re-running it costs
  one call.

## 5. Hands-off: the person gives decisions, not labour

The person is asked for decisions and for input only they have: the theme, a choice between
designs, a sign-in the machine cannot do for them, approval of something irreversible. Everything
else is the agent's work.

- Creating the app, adding data sources, turning on settings, saving and publishing in Studio:
  the browser driver (`canvas-browser.mjs create`, `save`, `publish`).
- Connections: create this build's own connections and connection references; never reuse another
  project's connection because it happens to exist (it ties this build's flows to someone else's
  lifecycle and its teardown).
- Approvals raised by your own flows during development: answer them in the owner's browser when
  the owner has allowed it for this project. Until then, hand the person one instruction per
  approval: the title, the response and where to click.
- Sign-in: once per identity, at the start (`references/first-run.md`), never repeated mid-build.
- When the person must act, give one line to run in the session and verify the effect yourself.
- Collect every decision you need at the start (theme, names, who receives messages, sample-data
  volume) so the build then runs without stopping.

## 6. Browser hygiene

- One browser, one tab per job. The driver reuses its first tab and closes the ones it opened
  (`canvas-browser.mjs tidy` closes blank and leftover tabs in a held session).
- With the Playwright MCP tools, close each tab you opened when you are done with it
  (`browser_tabs` close), and check the tab list before handing back.
- Close Studio through its Back button; never leave a held co-authoring session behind.
- At the end of a build: `tidy`, then confirm no Studio session is held and no about:blank tabs remain.

## 7. The finish: one verification round, one fix batch, one confirm

1. The lead walks every acceptance row in the published app, at desktop and phone width, and
   captures the screenshots the design critique needs.
2. Run the design critique (impeccable `critique`) on those screenshots and the report, and the
   clipping, overlap and dead-click sweeps. Truncation counts: text cut with an ellipsis where the
   full value matters to the task is a defect at phone width, not a pass.
3. Fix everything found in one batch, ship once, confirm once. Do not loop on polish.
4. The hand-back states what passed, what was not measured and why, and never says "clean" for a
   check that did not cover truncation, both widths and every role.
