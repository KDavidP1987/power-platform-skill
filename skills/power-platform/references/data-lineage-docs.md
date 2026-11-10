# Data lineage documents for Fabric medallions

A lineage document answers "where does this column come from, what touches it on the way, and who
reads it" for one output table, in a form a reviewer, an auditor or the next developer can use without
opening Fabric. `scripts/lineage.py` builds it from the dataflow and pipeline definitions in the repo,
checks them against the live workspace (read-only), and evaluates a document later. Auditing a whole
inherited workspace is `fabric-workspace-audit.md`; this page documents one chain you own.

## Contents

1. When to make one
2. Build it, step by step
3. What it traces, and what it cannot
4. The curated notes
5. Evaluate a document
6. Evaluate a lineage document the tool did not make
7. Sharing it

## 1. When to make one

- An output another team depends on (Finance reads a gold table, a report is embedded in an app).
- An output that carries sensitive columns (pay rates, cost, personal data): the document names each
  sensitive column and every source column behind it, which an access review needs.
- A rebuild replacing a manual process: the document is the evidence that each old column has a
  defined source and rule.
- Before changing a shared source table: the document lists every output column that reads it.

Pick the output with the most at stake first: in production, read outside the team, sensitive, or
crossing apps. One document per output table another team reads; not one per table.

## 2. Build it, step by step

1. **Inputs in git.** The dataflows in Fabric Git format (`<name>/mashup.pq`), pipelines as JSON, a
   lakehouse map (`{"bronze": {"name": ..., "id": ...}}`). A consumer outside the medallion (a Gen1
   dataflow query, a workbook query) is saved as a `.pq` file next to them.
2. **Offline first.** `python scripts/lineage.py doc --dataflows DIR --pipelines DIR --lakehouses
   FILE.json --focus TABLE --external "NAME=FILE.pq" --out docs/lineage/<name>`. Read the gaps: an
   input with no producer is usually a shared bronze dataflow outside the repo.
3. **Live.** Add `--workspace <id or name>` (signed-in Az or `--token-cmd`). It reads lakehouse names,
   every dataflow's deployed definition (drift against the repo), recent runs, pipeline schedules, and
   the producers of inputs made outside the repo. GETs and `getDefinition` only.
4. **Close the gaps.** Exit 0 means every input has a producer and every focus column reaches a source
   column. For an untraced column, read the step the trace stopped at (the gap names the query and
   column) and either fix the pattern in the M or record the column in the notes as a known limit.
5. **Write the curated notes** (section 4) from `assets/templates/lineage-notes.md`, and generate again
   with `--notes` and `--title`.
6. **Look at it.** Open the HTML at desktop and phone width, light and dark: no sideways page scroll
   (the diagram and wide tables scroll inside their frames), curated tables render as tables, the
   sensitive columns are the ones you expect and no others.
7. **Evaluate** (section 5), then commit the `.html`, `.md`, `.json` and the notes together, with a
   README in `docs/lineage/` holding the exact regenerate command.
8. **Keep it current.** Regenerate after any change to a dataflow in the chain; `evaluate` fails a
   document whose chain changed since it was made. Never edit the generated files.

Measured on a production timesheet chain (two Dataverse and six SharePoint bronze dataflows, silver,
gold, a Gen1 consumer): 33 tables in scope, 50 of 50 columns traced, no drift, evaluate 7 of 7. The
first live run traced 32: the SharePoint bronze dataflows read lists by GUID through generic helper
functions, which section 3's last row now handles.

## 3. What it traces, and what it cannot

Tables: Dataverse (`CommonDataService.Database` + `{[Schema, Item]}`), lakehouses (`Lakehouse.Contents`
handles, `*_DataDestination` queries for writes), SQL endpoints (`Sql.Database`, matched to the
lakehouse of the same name), SharePoint lists (`SharePoint.Tables` + `{[Id|Title = ...]}[Items]`; a list
read by GUID is named after the query that reads it).

Columns, step by step back from the output's result step:

| Step | Recorded as |
|---|---|
| `Table.RenameColumns` | renamed, from the old name |
| `Table.AddColumn` | computed, with its expression and the fields it reads (lookups into other queries followed) |
| `Table.NestedJoin` + expand, a record built in `AddColumn`, `Table.Group` with a `Row` record | joined, from the other side's column |
| `Table.Join` | follows the side whose column list names the column |
| `Table.FromRecords(Table.TransformRows(..., (r) => [F = ...]))` | computed per field |
| `Table.ReplaceValue`, `Table.TransformColumns` | a "Then:" note on the column |
| A step calling a local generic function (`Norm(#"Navigation 1")`) | passed through by name, with a note naming the function |

Not yet: notebook (Python or Spark) transforms, DAX in semantic models, Gen1 dataflows as producers
(ROADMAP 17). A column whose name is built at run time is matched by name, and the note says so.
Comments in the M (`// ...` above a step or query) are carried in as the reason for the step;
banner lines (`// =====`) are dropped. Sensitive columns: whole-word rate, salary, wage, pay,
compensation, bonus, ssn, birth date, a column named Cost, names ending Amount; `--sensitive REGEX`
replaces it.

## 4. The curated notes

The generator cannot know purpose, ownership, consumers outside Fabric, the decisions behind a rule or
what the sensitive columns mean for access. Start from `assets/templates/lineage-notes.md`:

| Part | What it holds |
|---|---|
| Purpose | What the output is for, what it replaced, the design document |
| Owner | The owning team and the source apps |
| Consumers | Each reader outside the chain: how it reads, since when, what it depends on (a personal connection, a gateway) |
| Refresh | The pipeline and schedule, and sources on their own schedules (how stale reference data can be) |
| Rules | The decisions that shape columns, numbered as in the design document |
| Sensitive data | Each flagged column by name, why it is sensitive, the access decision that governs it |
| Verification | The checks that prove the output and when they last ran |

Keep names of people out of it: roles and teams age better and the document may travel.

## 5. Evaluate a document

```
python scripts/lineage.py evaluate --doc docs/lineage/<name> --dataflows DIR [--max-age-days 90]
```

| Check | FAIL when | WARN when |
|---|---|---|
| coverage | a focus column has no source column | |
| gaps | an input has no producer | |
| drift | a deployed definition differs from the repo | generated without `--workspace` |
| age | | older than `--max-age-days` |
| freshness | a dataflow in the chain changed since the document was made (hashes in the JSON) | the JSON records no hashes |
| curated notes | missing, or no purpose, owner, consumers, refresh or verification | |
| sensitive columns | a flagged column is not explained in the notes | |
| consumers, refresh | | none named |

Exit 0 no FAIL, 1 a FAIL, 2 cannot run. Run it before relying on a document, in CI after a dataflow
change, and before a release review; a failing document is regenerated, not edited.

## 6. Evaluate a lineage document the tool did not make

A hand-written lineage page, a Fabric lineage-view screenshot or a catalogue export is judged on the
same questions. Score each, and treat any "no" in the first four as not fit to rely on:

1. **Column level?** Item-to-item arrows (what Fabric's lineage view and most catalogues show) do not
   say which source column a figure comes from. Needed for any sensitive or contested column.
2. **Built from the definitions?** Lineage written from memory or from a design that the M no longer
   follows is wrong silently. Compare three columns by hand against the M: rename, join, computed.
3. **Current?** Dated, with the definitions it describes, and newer than the last change to them.
4. **Complete?** Every input has a producer, including shared bronze and reference lists outside the
   team's repo; every reader outside Fabric (workbooks, Gen1 dataflows, other apps) is named.
5. **Rules with reasons?** Filters, joins and computed columns stated with the decision behind them.
6. **Sensitive columns named** with their sources and the access decision.
7. **Refresh and verification** recorded: schedule, order, the checks that prove the output.

Where a hand-written document exists, generate one with `lineage.py` and diff the column table against
it: each disagreement is either a stale document or an M change nobody recorded.

## 7. Sharing it

The document names sensitive columns and internal systems, never values. Check it against the data's
access decision before it leaves the audience that can already see the data, and publish it privately
first (an internal wiki page, or a private page the owner shares).
