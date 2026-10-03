# Reporting: history first, then in-app charts, then Power BI

Reports for a Power Platform app come in two places, and both stand on the same foundation:

1. **History in Dataverse** - the past states that every trend chart needs (section 1), and the
   change log that explains variance, planned against unplanned (section 1b).
2. **In-app reports** - a canvas screen for the people doing the work, no extra licence (section 2).
3. **Power BI over a medallion** - cross-project views, leadership KPIs, volumes past the app's row
   limit (section 4), embedded in the app or linked from it (section 5).

Offer reporting when an app manages work, money, cases or requests over time. Ask who reads each
report and what decision it serves before building charts: a team lead deciding what to pull into
the next sprint needs a different view from a director comparing teams.

## Contents

1. History first - start it before anyone asks for a chart
1b. Change log and variance: plan against actual, planned against unplanned
2. In-app reports (canvas)
3. Metrics: definitions that survive scrutiny
4. Power BI over a medallion (Fabric)
5. Power BI inside the app: embed it, and always offer the link

## 1. History first - start it before anyone asks for a chart

A row holds the CURRENT state. Burn-down, burn-up, velocity, cumulative flow, cycle time and aging
all need PAST states, and history cannot be reconstructed later: every day an app runs without
recording it is a day no chart can ever show. Add the history table in the first reporting change,
even before the first chart.

**The event table pattern (append-only).**

- One row per change to the columns reports care about (for work tracking: status, sprint, points,
  assignee; for cases: stage, owner, priority), holding the record's state AFTER the change.
- Written by a cloud flow on the record's table: trigger Create-or-Update (message 4) with
  `filteringattributes` naming exactly those columns. The flow writes ONLY the event table, and no
  flow triggers on the event table, so it cannot loop (`lint-flows.mjs` proves it on the zip).
- Take the values from the **trigger body**, not a re-read of the row: a re-read can return a later
  state when two changes land seconds apart, and history then records the same state twice.
- Store related ids as **text columns** (project id, sprint id, assignee id) rather than lookups. A
  Dataverse-connector "Add a new row" with an empty `@odata.bind` fails the run; text ids never
  do, and reports join on them just as well. Keep one real lookup to the parent record (always
  present) for navigation.
- `ChangedOn` = the trigger body's `modifiedon`, falling back to `utcNow()`.
- A `Source` choice: Flow (live), Baseline, and Demo where the project needs a demo.
- Read-only for every app role, including administrators: history that users can edit is not
  history. The flow writes as its owner's connection.

**Baseline.** When history starts, write one Baseline row per existing record holding its current
state, dated now, with an idempotent script (skip records that already have a Baseline or Flow row).
Say plainly in the report that nothing before that date exists.

**Demo history**, when a demo project needs charts on day one: derive plausible past events from
each record's current state, label every row Source = Demo, keep each step at least a day after the
one before (same-timestamp steps make order ambiguous), never date anything after now, and touch
nothing outside the demo project. Never mix invented rows into real projects.

**Let the record carry its own commitment.** A sprint (or any time box, release, or plan) should
record what was committed when it started and what was completed and carried over when it closed:
the app writes those numbers on Start and Complete, before it moves unfinished work back to the
backlog. Otherwise "committed versus completed" is unrecoverable the moment items leave the sprint.

**State on a day = the last event at or before the end of that day.** Every chart below derives
from that one rule: scope added mid-sprint appears as scope, an item carried back to the backlog
leaves the sprint on the day it left, and a status that moved back and forth counts where it ended
the day.

**Inserting a past event means rewriting the events after it too.** A demo seed inserted "blocked
on day 3" and set the earlier events to not-blocked, but left a later backfilled event that still
said not-blocked. The derived change log then recorded a false "unblocked" at the backfill time, the
report showed two blocked periods, and the live flow (which diffs against the LAST event) would have
logged a false "blocked" on the item's next edit. When a script inserts a change at time t, set the
column on every event after t as well, then re-derive anything built from the events.

## 1b. Change log and variance: plan against actual, planned against unplanned

The event table answers "what was the state". Leaders also ask "what changed, when, was it planned,
and why". Add a change-log table beside the events, one row per changed FIELD:

- Columns: record lookup (plus text ids for the reporting joins), field (a choice), old and new value
  as display text (labels and names, not ids), numeric delta where it means something, the **stage**
  (the status before the change), a **kind**, an **Unplanned** flag, an **in-active-period** flag,
  who, when, a **Reason** that people fill in afterwards, and Source (Flow, Baseline, Demo).
- Written by the history flow, in the same run as the event: read the record's LAST event
  (`$orderby=changedon desc,createdon desc&$top=1`), compare it with the trigger body field by field,
  write one change row per difference, then append the new event. Set the trigger's **concurrency to
  1** so two quick edits diff in order; otherwise both compare with the same old event. Resolve labels
  for ids in one query per related table (an `or` filter over the ids involved, with the all-zero GUID
  as a harmless fallback when one is empty) rather than one lookup per field.
- Classify in the flow, from the old and new values and the stage, with rules written in the design
  doc and repeated exactly in any backfill script. A set that held up for sprint work:

| Field | Kinds | Unplanned when |
|---|---|---|
| Period (sprint) | Scope Added, Scope Removed, Carry-over, else Planned | added to or removed from an active period |
| Size or estimate | Planned (first value), Re-estimate | re-estimated during an active period |
| Due date | Planned (first value), Slip, Pull-in | slipped |
| Status | Rework (moved back from review or done), else Planned | rework |
| Owner | Planned (first), Reassignment | reassigned mid-work |
| Priority, team | Reprioritised, Team Change | during an active period |
| Blocked | Blocked, Unblocked | blocked |

- **Carry work into the next period by two separate moves, not one.** Closing a period returns its
  unfinished items to the backlog (one Carry-over each); planning them into the next period is a
  later, separate step (no period -> future period = Planned). Moving items straight from the closing
  period into the next is classified as Scope Removed from an active period - unplanned - and two
  writes to the same row seconds apart can race the history writer, which reads the previous state.
  Offer the planning step as one action ("add the items carried from the last period") driven by
  the change log's Carry-over rows.
- **Plan against actual needs the plan kept.** Store "original" columns (original points, original
  estimate hours, original due date) set ONCE, the first time the value is set, and never overwritten
  by the app; store actuals beside them (actual hours, started on, resolved on). A time box keeps its
  capacity and its committed figure at start. Variance is then a subtraction, and the change log
  explains it.
- Report it as a waterfall per period (capacity, committed, added, removed, re-estimates, scope now,
  done, carried), on-time against the ORIGINAL due date, effort variance, unplanned changes by kind
  over time, and the change log with reasons.
- Give the change table Read for every role and Write for the Reason only by convention; no Create
  or Delete in the app. A label that needs to change goes through the app, never a new choice option
  on a column the canvas app already binds (manifest-caches.md: the app never sees it).

## 2. In-app reports (canvas)

Use when the readers already use the app and the data fits under the row limit. No extra licence.

**Load once, compute locally.** A hidden "load" button collects the records, the time boxes and the
events for the selected scope (one project, or all) into collections; separate hidden "calc"
buttons compute each tab's chart collections; the screen's OnVisible initialises every scale
variable and selects "load". Recompute only the part whose filter changed.

**Charts are galleries of rectangles.** A horizontal gallery, one template per day, week or time
box; each bar is a Rectangle with `Height = value / Max(1, scale) * chartHeight` and
`Y = chartHeight - Height`. An ideal line is a 3 px rectangle per template at the ideal value. Axis
labels and gridlines are labels and 1 px rectangles outside the gallery. Horizontal bars in a
vertical gallery work the same way on Width. This renders identically in every player, compiles
from `.pa.yaml`, and the overlap and format checkers can read it; chart controls cannot claim all
three.

**Traps that broke a real build (each one compiles or renders wrongly with no useful message):**

- `ClearCollect(col, If(cond, Table(), ForAll(...)))` - the empty `Table()` gives the collection no
  columns, and every control that reads it fails to compile with "name isn't valid". Always run the
  `ForAll` and make the count zero instead: `ForAll(Sequence(If(cond, 0, n), 0) As k, ...)`.
- A bare field in a collected record (`{L: s.Name}`) can be left out of the Dataverse `$select`,
  so every row arrives with a blank value. Make each field an expression (`s.Name & ""`,
  `Coalesce(s.Points, 0) + 0`, `DateAdd(s.When, 0, TimeUnit.Days)`); read the player's `$batch`
  response to confirm what was actually selected (`browser-verification.md`).
- Galleries render before the load finishes: a scale variable that is still blank divides by zero
  and `Average` of a still-empty table errors, each raising a banner. Initialise scales to 1 in
  OnVisible, divide by `Max(1, scale)`, and guard averages with `If(CountRows(t) = 0, ...)`.
- `Text(date, "d")` is not a day-of-month format; use `Day(date) & ""`.
- "Age" means time in the CURRENT status: the first event of the trailing run of the current status
  (after the last event with a different status), not the latest event - a Baseline row written
  today would otherwise make every item zero days old.
- Collections stop at the data row limit. Say so on the screen and send larger or cross-project
  questions to Power BI.

## 3. Metrics: definitions that survive scrutiny

Define each metric on the screen or in the model, in one line, where its reader sees it.

| Metric | Definition | Needs |
|---|---|---|
| Burn-down | Points still to do at the end of each day of the time box; ideal line from the committed points to zero | events, committed |
| Burn-up | Scope (points in the box, excluding abandoned work) and done points per day; a rising scope line is added work | events |
| Velocity | Completed points per closed time box, last six, with the average | commitment fields |
| Say/do | Completed / committed points over the closed boxes that recorded both | commitment fields |
| Scope change | Scope now minus committed, + or - | events, committed |
| Throughput | Items (and points) finished per week, Monday weeks | resolved date |
| Cycle time | First "in progress" to first "done" after it, in days; report the median and 85th percentile, never the mean alone | events |
| Lead time | Created to done | created, resolved |
| Work in progress | Items in each active status now | current rows |
| Aging | Days each open item has been in its current status, oldest first, with a threshold colour | events |
| Cumulative flow | Items per status per day, stacked; widening bands are queues | events (best in Power BI) |
| Mix / investment | Share of finished points (or items) by type over 30 days; operations and incidents usually carry no points, so count items | type, resolved |
| Per person | Open, in progress, finished in 30 days - for balancing load, never for ranking; say so on the screen | assignee |
| Service levels (operations work) | Time to acknowledge and to resolve against targets by severity | acknowledged-on and target fields |

Points are a planning tool, not a productivity measure. A report that ranks individuals by points
or throughput invites gaming and usually measures the wrong thing; show team figures to leaders.

## 4. Power BI over a medallion (Fabric)

Use for cross-project and leadership views, history beyond the row limit, and anything that needs a
cumulative flow diagram or long trends.

**Layers, each defined as code in its own repo and deployed through the Fabric REST API:**

| Layer | Holds | Built by |
|---|---|---|
| Bronze | The app's Dataverse tables as landed, one dataflow per app, driven by a table manifest (tables, dropped columns, exclusions) | Dataflow Gen2 from Dataverse |
| Silver | Clean dimensions (keys readable, choice labels resolved, people from the shared person table) and the event-sourced daily snapshot: one row per record per calendar day from its first event to today, holding its end-of-day state | Dataflow Gen2, hand-written Power Query template with tokens |
| Gold | Facts at a stated grain: box x day burn, project x day x status flow, week throughput by type, item cycle and lead time, box velocity, open-item aging | Dataflow Gen2 |
| Semantic model | Direct Lake over gold, with the measures in section 3 | TMDL in the repo, deployed by API |

Build, deploy, run and verify each layer in order, and verify against Dataverse with concrete numbers
(a box's committed and completed points, day rows present up to today, the count of finished items
in the cycle-time fact) - not just "the dataflow succeeded". Record each gold table's grain in the
repo's design doc. Keep the Demo source filterable end to end.

**Rules that a real build needed** (each one cost a failed run or a wrong number):

- **Normalise ids to lower-case text in silver.** The Dataverse SQL endpoint returns upper-case GUIDs;
  a flow writing ids as text writes lower-case. Joins between them silently match nothing. Turn the
  all-zero GUID an app uses for "none" into null in the same function.
- **Fix the day convention once.** Use UTC calendar days unless a local day is required, and define a
  record's state on day d as its last event at or before the end of d. Write it in the design doc.
- **Put the record-day snapshot in silver, facts in gold.** Every chart groups over the snapshot, so
  gold stays plain group-bys. Gold carries its own copies of the dimensions, because a Direct Lake
  model reads one lakehouse.
- **One relationship path per table.** Facts with a record relate through the record dimension, box
  facts through the box dimension; only facts with no record relate to the project directly. Two
  paths to the project make every project filter ambiguous.
- **Facts hold only rows with output** (a week with nothing finished has no throughput row). Use the
  date dimension for zero periods rather than inventing rows.
- **Run order is bronze, silver, gold, then a model refresh.** Without the refresh, Direct Lake keeps
  serving the old frame and the report shows stale numbers after a successful data run.
- **A new dataflow's first refresh can fail with no detail; retry once.** When a run fails with a
  real cause, the job API hides the Power Query error: evaluate the failing query through the
  dataflow's query-execution API to read the actual M error.
- **Verify by recomputation, not by status.** A script recomputes each silver and gold table in SQL
  from the layer below and compares counts and sums, then runs a handful of the model's measures in
  DAX and checks they equal the SQL answer.
- **`MissingField.UseNull` fails the whole refresh when a column type is not nullable.**
  `Table.FromRecords(rows, type table [...], MissingField.UseNull)` with a non-nullable column type
  failed the dataflow with "failed without detail"; the query-execution API returned the real M
  error. Make every column type in such a table nullable.
- **A combined table keeps its types only if every part has them.** Appending a hand-built row
  (`Table.FromRecords({[...]})`, untyped) to a typed table turned the shared columns into type `any`,
  and the lakehouse destination silently dropped every `any` column: the name and key columns vanished
  from gold, and the model refresh then failed with "column not found in delta table". Build the extra
  row with the base table's type: `Table.FromRecords({[...]}, Value.Type(Base), MissingField.UseNull)`.
- **Give "none" a named member in gold; keep the null in silver.** Records that legitimately have no
  parent (work without a project) should map to one "None" row of the dimension in gold (an id such as
  `"none"`, a readable key and name), so users can select them. Silver keeps the honest null. Recompute
  checks in SQL with the same mapping: `ISNULL(parent_id, 'none')`, because a null never joins and a
  check that groups by it reports false mismatches.
- **Direct Lake lists "(Blank)" on a dimension even when nothing is orphaned.** `VALUES(Dim[key])` had
  one more row than `COUNTROWS(Dim)` while no fact failed `RELATED(...)` and SQL found no orphans or
  nulls. Prove the data clean with those two queries, then hide the member on every slicer with a
  visual-level filter (`NOT IN (null)`); otherwise a slicer offers it and an unfiltered single-select
  slicer can land on it and blank every visual.
- **Do not relate two sibling dimensions to each other.** With both a team and a project dimension,
  relating team to project gave some facts two paths to the same filter. Keep one path per fact:
  period facts reach team through the period, record facts through the record, aggregates directly.
  Check each fact for a second route before deploying the model.
- **Start an SLA clock where the policy says it started.** Measuring from the row's creation gave
  negative durations for imported and backfilled records ("raised" before the row existed). Use the
  record's stated start, or the target minus the policy hours for its priority, and record which one
  was used in a column.
- **Keep the workspace tidy as code.** Create a folder per app (the Fabric folders API) and deploy
  every item into it; keep the report as PBIR in the repo; refresh the semantic model from a small
  notebook (semantic-link) as the last pipeline activity, so data and model refresh in one run.
- **Name the refresh identity.** A dataflow on one person's Dataverse connection stops when that
  account does. Record it as an open decision until a service account or workspace identity owns it.

**Licensing, before promising a report to leaders:** viewing a Power BI report needs a Pro (or
Premium Per User) licence for each viewer unless the workspace sits on a capacity of F64 / P1 or
larger, where free-licence viewers can open what is SHARED with them (share the report or an app,
not a workspace role, when the model carries sensitive figures such as rates). Confirm which applies with whoever owns Microsoft licensing, in writing, alongside any
standard-licence or mirroring caveats the app already carries.

**Do not wire new gold tables into production reports** until the owner confirms the first live
period reconciles; build, verify, and hand over the model and the reconciliation numbers.

A dedicated Power BI and Fabric skill (reports, semantic models, DAX, custom visuals) is planned;
until it exists, this section is the pattern to follow.

## 5. Power BI inside the app: embed it, and always offer the link

- **Embed** with the canvas Power BI tile control: `AllowNewAPI: true`, `TileUrl` = the report's
  `reportEmbed?reportId=...&groupId=...&autoAuth=true&ctid=<tenant>` link, plus a URL filter;
  `LoadPowerBIContent` true only while its tab is visible. Keep both URLs (report and embed) in a
  settings table, not in formulas.
- **Filter by URL:** `&filter=TABLE/column eq 'value'` (table and column names are case-sensitive,
  the value quoted, the whole thing URL-encoded; `EncodeUrl()` the value). A filter on a column the
  deployed model does not have is ignored with only a warning icon in the filter pane - the report
  shows everything. Verify the filter pane reads "column is value", and test a value that matches
  nothing (every visual blank).
- **What users will see the first time:** the app asks once for consent to Power BI, and the tile
  shows "Sign in to view this report" until they select Sign in (a pop-up that closes itself).
  Neither is an error; say so in the guide. The tile does not render in the Power Apps mobile player.
- **Always add "Open in Power BI"** (`Launch()` with the same filter on the report URL). It works in
  every player, opens the full report with its pages and filter pane, and is the fallback when the
  tile cannot render.
- Viewers need access to the report itself (section 4, licensing); the app grants nothing.

