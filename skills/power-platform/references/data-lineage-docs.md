# Data lineage documents for Fabric medallions

A lineage document answers "where does this column come from, what touches it on the way, and who
reads it" for one output table, in a form a reviewer, an auditor or the next developer can use without
opening Fabric. `scripts/lineage.py` generates it from the dataflow and pipeline definitions in the repo,
and (with `--workspace`) checks them against the live workspace, read-only. Auditing a whole inherited
workspace is `fabric-workspace-audit.md`; this page documents one chain you own.

## Contents

1. When to make one
2. Generate it
3. What it traces, and what it cannot
4. The curated notes
5. Done means
6. Sharing it

## 1. When to make one

- An output another team depends on (Finance reads a gold table, a report is embedded in an app).
- An output that carries sensitive columns (pay rates, cost, personal data): the document names
  each sensitive column and every source column behind it, which an access review needs.
- A rebuild replacing a manual process: the document is the evidence that each old column has a
  defined source and rule.
- Before changing a shared source table: the document lists every output column that reads it.

## 2. Generate it

```
python scripts/lineage.py doc --dataflows fabric/dataflows --pipelines fabric/pipelines \
  --lakehouses fabric/lakehouses.json --focus GOLD_TABLE \
  --external "Finance dataflow=fabric/external/finance-query.pq" \
  --notes docs/lineage/<name>-notes.md --workspace <workspace id or name> \
  --title "..." --out docs/lineage/<name>
```

- `--dataflows` is a folder of Fabric Git-format dataflows (`<name>/mashup.pq`); `--pipelines`
  holds pipeline JSON. `--external NAME=FILE.pq` adds a consumer outside the medallion (a Gen1
  dataflow query, a workbook query) that reads a lakehouse through its SQL endpoint.
- `--workspace` reads the live workspace: lakehouse names, every dataflow's deployed definition
  (compared with the repo: drift), recent runs, pipeline schedules, and the producers of input
  tables made by dataflows outside `--dataflows` (shared bronze, another team's reference lists).
  Only GETs and `getDefinition`. Without it the document says which inputs have no known producer.
- Output: `PATH.html` (diagram as inline SVG, light and dark, prints cleanly), `PATH.md` (Mermaid),
  `PATH.json` (for tools). Commit all three next to the notes. Regenerate after any change to a
  dataflow in the chain; never edit the generated files.

## 3. What it traces, and what it cannot

Tables: Dataverse (`CommonDataService.Database` + `{[Schema, Item]}`), lakehouses (`Lakehouse.Contents`
handles, `*_DataDestination` queries for writes), SQL endpoints (`Sql.Database`, matched to the
lakehouse of the same name), SharePoint lists (`SharePoint.Tables` + `{[Id|Title = ...]}[Items]`, a list
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

Limits: a column whose name is built at run time (a function that renames every column) is matched by
name, and the note says so. DAX in a semantic model is not traced yet (ROADMAP). Comments in the M
(`// ...` above a step or query) are carried into the document as the reason for the step.

## 4. The curated notes

The generator cannot know purpose, ownership, consumers outside Fabric, the decisions behind a rule
or what the sensitive columns mean for access. Put them in `<name>-notes.md` (purpose, owner,
consumers table, refresh, the decisions that shape columns, sensitive data, how it is verified); the
document includes it under "About this data", marked curated. Keep names of people out of it: roles
and teams age better and the document may travel.

## 5. Done means

- Exit 0: every input table has a producer and every focus column is traced to a source column.
  Exit 1 writes the document with its "Gaps and checks" section to read (an input without a producer,
  an untraced column, a deployed definition that differs from the repo).
- Measured on a production timesheet chain (two Dataverse bronze dataflows, six SharePoint bronze
  dataflows, silver, gold and a Gen1 consumer): 33 tables in scope, 50 of 50 columns traced, no drift.
  The first live run traced 32: the SharePoint bronze dataflows read lists by GUID through generic
  helper functions, which is what section 3's last row now handles.
- Look at the HTML at desktop and phone width before handing it over: no sideways page scroll (the
  diagram and wide tables scroll inside their own frame), and the curated tables render as tables.

## 6. Sharing it

The document names sensitive columns and internal systems, never values. Check it against the data's
access decision before it leaves the audience that can already see the data, and publish it privately
first (an internal wiki page or a private page the owner shares).
