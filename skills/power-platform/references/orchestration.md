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
lead: acceptance contract + every decision with its recommendation          (~5 min)
  |
  +--> design helper: impeccable init -> DESIGN.md -> design/prototype.html (every screen at
  |      1440 and 390, report mock) -> one critique -> one fix batch -> tokens  (~15-20 min)
  +--> lead, lane 0: tables.json -> deploy-tables.py -> seed -> read back -> this build's
  |      connections (Dataverse, Outlook, Approvals reference, Fabric)         (same time)
  |
  +--> after lane 0:      lane B flows, lane C reporting (both in one message)
  +--> after the design:  lane A canvas (App.pa.yaml, then one helper per screen, compile, ship)
  |                                                                            (~25 min)
  v
lead: walks in the foreground at both widths, screenshots, critique from screenshots
  |   + independent reviewer (fresh helper) at the same time                  (~10 min)
  v
lead: one fix batch, ship once, confirm once, seed re-applied, report refreshed last, hand-back
```

- **Plan and decide first, in minutes.** The acceptance contract is the plan: every numbered
  requirement as a row someone can perform, the business rules the brief leaves implicit (what a
  pending request reserves, which state wins when two answers race, what a malformed date says),
  and one list of decisions, each with a recommendation. `contract-to-walk.mjs` turns the rows into
  walks. Every decision the build needs is made here, so no lane stops to ask.
- **No person present (a headless run, or `"unattended": true` in `scripts/canvas-app.json`) means
  no questions.** Take each recommendation, record it in
  `docs/decisions.md` ("taken unattended"), and carry on. A step only the person can do (a licence,
  a sign-in with no browser path) is recorded as open in `docs/STATE.md` and the build continues
  around it; the hand-back lists it. A measured build stopped three times to ask questions it had
  already answered with a recommendation; the plugin's Stop gate now blocks a headless turn that ends
  on a question.
- **Planning with DOD (opt-in, capped).** DOD (`dod@dod-skill`) plans a feature across fifteen
  layers and closes with a prediction rate. Use it only when the person asks for it, or for a
  multi-week feature with a person present. In a measured build of this size it raised quality a
  little (its reviews caught real defects) at four times the time and cost of the build before it:
  twelve review rounds, twenty amendments, and the plan kept changing through the build. When you
  use it: at most two review rounds, then approve with the open findings recorded as assumptions;
  freeze the plan when building starts (a build-time fix that does not change what an item claims
  is a Log note, not an amendment and a re-review); advisory findings after READY go to the Log;
  point an item's check at a bundled script (`check-all.mjs`, `seed-data.py check`, the walks)
  instead of writing a parallel one; and read the items, not the whole plan, while building.
- **Design runs beside the schema, in HTML, in a helper.** The design helper invokes impeccable
  (`init` writes `DESIGN.md`, creating the theme when none is given), builds
  `design/prototype.html` from `assets/templates/design-prototype.html`, critiques it once with
  impeccable (its detector and browser checks work on HTML) and fixes it once; it does not loop on
  polish. The screen helpers start when it returns, each with its frame of the prototype and the
  tokens; the reporting lane gets the report mock. The build whose design the person rated best was
  the first to run this step; builds that left design to "required" in the guidance skipped it
  (`project-setup.md` section 3).
- **Ship in batches, walk in one call.** A measured build that met every requirement still took 107
  minutes, mostly in Studio churn: 29 Studio opens, 27 saves, 21 publishes, 81 walk calls and 472
  single shell calls. The driver now refuses a publish when the canvas source has not changed since
  the last one (`--again` overrides), counts publishes, and runs every scenario in one call
  (`canvas-browser.mjs walk canvas/walks`); the plugin reports the shell-call count and the elapsed
  time against the budget. Fix a whole batch, push it, save, publish once, walk once.
- **The fix round has a budget too.** After the screenshot critique and the reviewer, fix every high
  and medium finding in one batch; list the low ones in the hand-back instead of shipping for each.
  Most findings in a measured fix round (phone width, pill and tag styles, banners, dialog
  spacing) were visible in the prototype: take the prototype critique at 390 px seriously, and run
  `check-canvas-format.mjs` and the clip sweep before the first ship, not after.
- **The time budget.** For a five-screen app, two flows and a medallion, about an hour of agent
  time: decisions 5 minutes, design and schema together 15 to 20, lanes 25, walks, critique and
  review together 10, the fix batch and the final refresh 5. Microsoft's plugins built this brief in
  63 minutes; a build that spends more is spending it on rework or on bookkeeping, so check which.

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
- **Never end a turn while helpers or background commands are running.** Wait for every helper's
  notification before the final message. A headless run (`claude -p`) is terminated 600 s after the
  lead's turn ends while background helpers continue; the harness sets
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` for scripted runs, but that covers helper agents and
  workflows only, not a shell command started in the background: a measured build started its walk
  batch that way, ended its turn ("I'll continue when they report") and lost the session twice.
  Run walks and any check you need the answer to in the foreground (a timeout up to 600000 ms, split
  a longer batch) or inside a helper; the plugin's Stop gate blocks a turn that ends with background
  shell work still running.
- **Start the lanes in one message.** Spawn the flows and reporting helpers in the same message,
  straight after lane 0, and the screen helpers together in one message; a build that ran one
  helper at a time lost the parallel gain.
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
  conversation ten times. `node scripts/check-all.mjs` runs the format, overlap, flow-lint, drift,
  seed and build-stamp checks together and prints one compact table; use it, or one check script of
  your own that does the same, instead of a call per check. A measured lead made 190 small shell
  calls.
- **Use the bundled tools before writing new ones.** `deploy-tables.py`, `seed-data.py`,
  `deploy-flows.py`, `fabric.py`, `reconcile-report.py`, `canvas-browser.mjs` cover what a build needs;
  an agent that writes its own helper mid-build pays for it in time and tokens.
- **The design step is a lane of its own, run first by the lead**: invoke the impeccable skill
  (`init`, then the tokens) before handing out screens; the end-of-turn hook blocks a hand-back
  without `DESIGN.md` and a critique record. A build that left it to "required" in the guidance
  skipped it.
- **Do not patch the driver mid-build.** When the driver lacks a step, use the Playwright MCP tools
  for that step, record the gap, and fix the driver after the build.
- **Compact early, and keep the state in files so nothing is lost.** The harness sets
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=40` in the project's `.claude/settings.json`, so the session
  compacts at 40% of the window instead of carrying (and re-reading) a near-full context every turn.
  Some Claude Code versions are reported to ignore that key in `settings.json`; for headless or
  scripted runs also set it in the shell that launches `claude`, and check with `/context` that a
  long build stays below half the window. Compaction is safe only when what matters is written
  down: update `docs/STATE.md` at every lane boundary (what passed, with numbers; what is open;
  decisions; ids of apps, flows, connections and items), and the pre-flight hook, which also runs
  when a session resumes after compacting, puts it back in front of the agent. Compact between lanes
  or after a fix batch, never in the middle of a diagnosis; a manual `/compact` takes a focus
  ("keep the acceptance results and the open defects").
- **Spend the expensive model on judgement, not on errands.** Quality is the first measure:
  building screens, flows and the model, and every review or critique, stay on the strongest
  model. Read-only errands (listing items, scanning a long log or run history for one fact,
  capturing a screenshot set) can go to a smaller, cheaper helper model, which returns only the
  fact or the file paths.
- **Read narrowly.** Read the part of a large file you need (a line range, a `grep` first), ask
  tools for compact output (`--json`, a count, the first failing case), and never paste a Studio
  tree, a whole run history or a full transcript into the lead's context.
- **Prefer a scenario walk to an interactive click-through** once a path works: re-running it costs
  one call.

## 5. Hands-off: the person gives decisions, not labour

The person is asked for decisions and for input only they have: the theme, a choice between
designs, a sign-in the machine cannot do for them, approval of something irreversible. Everything
else is the agent's work.

- Creating the app, adding data sources, turning on settings, saving and publishing in Studio:
  the browser driver (`canvas-browser.mjs create`, `save`, `publish`).
- Connections: create this build's own with `canvas-browser.mjs connection` (account and
  environment checked, consent finished in the signed-in browser); never reuse another project's
  connection because it happens to exist, and never ask the person to create one. Offer the
  permission rule that allows the command at the start (`tooling-and-auth.md` section 6), with the
  other decisions.
- **Approvals is the exception: one connection per user per environment.** Creating a second is
  refused by the platform (measured). Bind this build's own connection reference to the owner's
  existing Approvals connection; that does not change the connection or anything that uses it, so
  it needs no question. Do not replace the Approvals action with an Outlook options email to avoid
  sharing it: a measured build did, and nothing reached the approval centre.
- **Approvals your own test rows raise, sent to the owner: answer them yourself** in the signed-in
  browser (Power Automate, Approvals, Received), one approve and one reject, and confirm both
  outcomes in Dataverse and the run history. Only approvals raised by this build's own test rows
  (the `[TEST]` prefix), never any other. A build that left them unanswered could not show its
  approve and reject paths working.
- **The Fabric connection needs no person either**: create it in the signed-in browser profile the
  driver uses (`reporting.md`, "The refresh runs in Fabric").
- Sign-in: once per identity, at the start (`references/first-run.md`), never repeated mid-build.
- When the person must act, give one line to run in the session and verify the effect yourself.
- Collect every decision you need at the start (theme, names, who receives messages, sample-data
  volume) so the build then runs without stopping.

## 6. Browser hygiene

- One browser, one tab per job. The driver reuses its first tab, closes blank tabs after every
  command, and `second-tab` closes the older Studio tab once the new one is in edit mode; never open
  Studio tabs with your own scripts (a measured build had three Studio tabs open when Studio raised a
  dialog in one of them, and the evaluator later closed 28 blank tabs).
- Studio's "Accept Coauthoring preview terms?" dialog is answered by the driver: the skill turns
  Coauthoring on because the authoring server needs it, so accepting is the recommendation, listed
  with the other up-front decisions; `"acceptCoauthoringTerms": false` in `scripts/canvas-app.json`
  makes the driver stop and report instead.
- With the Playwright MCP tools, close each tab you opened when you are done with it
  (`browser_tabs` close), and check the tab list before handing back.
- Close Studio through its Back button; never leave a held co-authoring session behind.
- At the end of a build: `tidy`, then confirm no Studio session is held and no about:blank tabs remain.

## 7. The finish: one verification round, one fix batch, one confirm

1. The lead walks every acceptance row in the published app, at desktop and phone width, and
   captures the screenshots the design critique needs. The walks run in the foreground (see
   section 1). Report screenshots show the report canvas only: never the Power BI header (it shows
   the signed-in person's photo and the organisation's logo) or the workspace rail.
2. Run the design critique (impeccable `critique`) on those screenshots and the report, and the
   clipping, overlap and dead-click sweeps. Truncation counts: text cut with an ellipsis where the
   full value matters to the task is a defect at phone width, not a pass.
3. **An independent reviewer before the fix batch.** Start a fresh helper agent with no build
   context, using `assets/templates/reviewer-prompt.md`: it walks the acceptance contract against the
   published app and Dataverse, runs `seed-data.py check` against the seed manifest, reads
   `docs/design-critique.md` against the prototype, and looks for what a user would hit that the
   contract does not say. It returns findings only (`docs/review/findings.json`); it changes nothing
   but its own test rows, and never answers an approval it did not raise. The lead does not argue
   with a finding: it fixes it or records why not. A blind evaluator found three failures a measured
   build's own walks had passed (seed rows left changed, a refresh that served stale data, a stamp
   shown to users); a reviewer with fresh eyes is cheaper than the rework.
4. Fix everything found (critique and reviewer) in one batch, ship once, confirm once. Do not loop
   on polish.
5. **Put the data back.** Walks that lend, return or approve change the seed rows. Re-apply the seed
   (`seed-data.py seed --update --apply`) after the last walk, and list any evidence rows you leave
   (prefixed so a cleanup can find them). A measured build left two seed assets in the wrong state,
   which failed its own data row and hid an item from a filter.
6. The hand-back states what passed, what was not measured and why, and never says "clean" for a
   check that did not cover truncation, both widths and every role. It includes both design
   scores (prototype and product), the reviewer's findings and what was done with each, and, when
   DOD was used, `dod close` and its prediction rate.
7. **Refresh the report last.** After the last walk and the seed re-apply, run the pipeline once
   more from Fabric and reconcile, so the report and Dataverse agree at hand-back.
