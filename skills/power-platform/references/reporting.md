# Reporting: history first, then in-app charts, then Power BI

Reports for a Power Platform app come in two places, and both stand on the same foundation:

1. **History in Dataverse** - the past states that every trend chart needs (section 1).
2. **In-app reports** - a canvas screen for the people doing the work, no extra licence (section 2).
3. **Power BI over a medallion** - cross-project views, leadership KPIs, volumes past the app's row
   limit (section 3).

Offer reporting when an app manages work, money, cases or requests over time. Ask who reads each
report and what decision it serves before building charts: a team lead deciding what to pull into
the next sprint needs a different view from a director comparing teams.

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
- **Name the refresh identity.** A dataflow on one person's Dataverse connection stops when that
  account does. Record it as an open decision until a service account or workspace identity owns it.

**Licensing, before promising a report to leaders:** viewing a Power BI report needs a Pro (or
Premium Per User) licence for each viewer unless the workspace sits on a Fabric capacity of F64 or
larger. Confirm which applies with whoever owns Microsoft licensing, in writing, alongside any
standard-licence or mirroring caveats the app already carries.

**Do not wire new gold tables into production reports** until the owner confirms the first live
period reconciles; build, verify, and hand over the model and the reconciliation numbers.

A dedicated Power BI and Fabric skill (reports, semantic models, DAX, custom visuals) is planned;
until it exists, this section is the pattern to follow.
