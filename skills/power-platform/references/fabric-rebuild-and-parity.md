# Rebuilding a Power BI pipeline as a medallion: lists, workbooks, notebooks, parity

For replacing a grown reporting chain (Gen1 dataflows over SharePoint lists and Excel workbooks, feeding
an Import model) with a medallion that must give the same answers before anything switches over. Audit
the workspace first (`fabric-workspace-audit.md`); a new medallion over Dataverse is `reporting.md`
section 4. Every rule here cost a wrong number or a failed run in one measured rebuild, most of them on a
run the service reported green.

## Contents

1. Inventory from what production reads
2. Bronze from SharePoint lists
3. Bronze from Excel workbooks
4. The lakehouse destination's names
5. Verifying bronze against the files
6. Parity with the model being replaced
7. Code-first Python notebooks
8. Reading lakehouse Delta tables from Python

## 1. Inventory from what production reads

- **Take the source list from the production mashups, not from an earlier rebuild.** An inventory copied
  from a stalled earlier attempt missed a sheet production reads (a second sheet of a reference
  workbook), assumed production read through a gateway when it already read SharePoint, and treated the
  attempt's stale copies (3,840 rows against 5,867) as a reference. Read every production dataflow's M
  and the model's entity references: they give the sources, which entities the model uses, and which
  tables are data typed into the definition (list those as "not loadable from any file").
- **Keep discovery rules, not today's folder.** Production found year folders by pattern
  (`FYxx BUDGET/FYxx FINAL`); a hard-coded current folder silently stops at this year.
- Workbook sheets carry filled-down formula rows (9,996 of 10,022 in one sheet) and grand-total lines a
  raw load keeps. Note them per source; silver decides what drops.

## 2. Bronze from SharePoint lists

- **Never `try ... otherwise null` without recording the failure.** A widely copied list-flattening
  pattern types each untyped column from its first 100 values and converts every value with
  `try Number.From(v) otherwise null`: a later non-numeric value becomes null, row count unchanged,
  refresh green. A rebuild with explicit types found 184 such values (for example `Admin` in a
  project-number column). Type bronze from an explicit manifest; a value that does not convert lands null
  AND its column is named in a per-row `bronze_type_errors` column that the verify step counts.
- **Type code columns as text.** A code column holding `000000`, typed number by inference, arrived as
  `0.0` and stopped joining. In silver, treat any numeric code column as suspect: pad or reject.
- **Buffer a list once before walking its columns.** A flattening function that scans each column
  (`Table.Column` per column, several passes) re-read the list from SharePoint on every scan.
  `Table.Buffer` on the list items (and before a per-row check) cut a 28-list dataflow from 22.4 to 9.1
  minutes, and cut the calls made against the owner's per-user SharePoint throttling budget.

## 3. Bronze from Excel workbooks

- **Error cells fail the whole query.** An Excel `#N/A` is a cell-level error in Power Query: any step
  that touches the value (a blank-row test over `Record.FieldValues`, a type change) failed the query
  with "Invalid cell value '#N/A'". `Table.ReplaceErrorValues` to null hides them. Check each field
  inside `try`, write the failing columns to a per-row `bronze_cell_errors` column, then null them.
- **Drop each Excel table's totals row.** `Excel.Workbook` returns a table's totals row as data, so a
  folder combine adds one row per file and doubles the table's amount sums (an earlier load did exactly
  this: 41 rows against 37, every file's amount twice). The table XML carries `totalsRowCount`; remove
  that many rows per file (`Table.RemoveLastN`), and verify amounts per file.
- **Folder reads.** `GetFolderByServerRelativeUrl` answers 200 for a folder that does not exist, so check
  a folder by listing its files (Power Query navigation to it fails "The key didn't match any rows").
  `SharePoint.Contents` gives a file's own created/modified times and `SharePoint.Files` the list
  item's (created seconds to days apart), so a row comparison between the two load paths fails on every
  row: exclude file-time columns and check them separately.
- **Name a required column per sheet.** Archive workbooks built by pasting yearly extracts carry a
  filled-down label column far beyond the data (8,908 label-only rows per file in two years). A required
  business column (the year) drops them without guessing; a blank-row filter does not. Files may carry
  their own `File Name` / `Date Modified` columns: rename them before adding the combine's file columns.
- **Record the worksheet row number when order matters.** A lakehouse table written by Dataflow Gen2
  does not keep the sheet's row order, so a rule that keeps "the first" of duplicate lines (a Gen1
  `Table.Distinct`) cannot be reproduced downstream. Add the Excel row number in bronze
  (`Table.AddIndexColumn` before any row is dropped, offset by the header row): 102 of 277,885 rows that
  differed from production became 1. The blank-row filter must ignore the new column, and the empty
  template table needs the same typed column so `Table.Combine` keeps its type.

## 4. The lakehouse destination's names

- **The destination rewrites some characters in column names**: `( ) , ; { } =`, tab and newline are
  stored as `_`. A schema copied from an existing lakehouse therefore holds stored names, not source
  names; selecting those at the source found nothing and, with `MissingField.UseNull`, every value landed
  null while the row count stayed right. Keep source names in the manifest and sanitise only in the
  verifier.
- **The rule differs by load path.** An older destination with staging stored a trailing `.` as `_`; the
  CI/CD Gen2 destination without staging kept it. Never derive a name rule from another load path's
  tables: read `INFORMATION_SCHEMA.COLUMNS` after the first load and assert it.
- Both reject two names equal without case (`ani` and `ANI` in one sheet): rename before the load, and
  have the generator check case-insensitive clashes.

## 5. Verifying bronze against the files

- **Count the files independently**: rows and currency totals to the cent, per file, from the same file
  version, by a script that does not share code with the load.
- **Compare with an older copy by EXCEPT both ways, not by counts.** The all-null columns of section 4
  passed a count check; an EXCEPT showed all 2,085 rows different.
- **Round to the column's scale before summing.** A lakehouse currency column is `decimal(19,4)`, so a sum
  of many 1/3 splits stored 12,844,999.9968 where the workbook said 12,845,000.00. Round each value to 4
  places in the independent counter and the stored total is reproduced exactly.
- **Probe the engine's conversion rules before writing the counter.** POST a `customMashupDocument` to an
  existing dataflow's `executeQuery` endpoint (read-only, seconds, the real engine). Measured:
  `Currency.From("$96.00")` is 96; a date-formatted cell in a number column converts to its OA serial; an
  accounting dash `" -  "` raises "We couldn't convert to Number". Make the counter mimic the engine, and
  accept type errors only when it finds the same rows.
- **An older load may have normalised what the source did not.** Seen: each text column all null or all
  `''` (Excel gives both); a label column rewritten; the file column named `Name` beside a data `Name`.
  Diagnose in this order: per-file counts, distinct values per column, leave-one-column-out EXCEPT, null
  and `''` counts per column. Hold bronze to the files, and compare with the older load through named
  allowances (a column map, its own filter, empty-as-null), each with its reason recorded.

## 6. Parity with the model being replaced

- **`executeQueries` truncates silently.** A large `EVALUATE` returns fewer rows than the table holds, with
  no error or continuation marker. Dump in chunks (by period), run `COUNTROWS` per chunk, and split
  further when the rows returned fall short.
- **The model does not hold the source's text.** VertiPaq keeps one casing per distinct value (the first
  loaded wins) and drops trailing spaces. Compare text casefolded and right-trimmed against model data,
  but reproduce M joins and `Table.Distinct` case-sensitively (that is how M ran), and never infer the
  source casing from the model.
- **M is not SQL.** In M `null <> null` is false and `null <> "x"` is true (SQL gives null for both;
  `IS DISTINCT FROM` is not the same either); `Text.Contains(null, ..)` is null; a lookup returning `""`
  is not one returning null; a logical column typed text lands as `"-1"` / `"0"`; Int64 conversion rounds
  half to even. Port each comparison with explicit null rules.
- **Compare unrounded group sums within half a cent.** Rounding each group before comparing reported 703
  false one-cent differences (the model sums doubles; a group can sit 1e-9 either side of a boundary).
- **An index added after a sort is a row surrogate.** `Table.AddIndexColumn` after `Table.Sort` numbers
  rows inside equal sort keys in Power Query's internal order, which cannot be reproduced. Its ranges per
  sort-key group can: prove count and sum of the index per group (6,380 of 6,380 matched while 74,671
  rows differed inside their ranges) and leave it out of row comparisons.

## 7. Code-first Python notebooks

- **One generated cell runs the repo's own code.** Embed the module sources and data files line for line
  (so scanners and reviewers see real lines), write them to a temp folder, check a bundle hash, put the
  folder on `sys.path` and call the same entry point the local runner uses. Imports between modules and
  `__file__`-relative paths work unchanged, and the printed hash ties a run to a commit. Refuse a deploy
  from a stale build (a `--check` mode). Measured: the notebooks run locally produced every table
  identical to the local run (EXCEPT ALL both ways); the only difference was a float sum whose last bits
  depend on order, so sum as DECIMAL where outputs are compared.
- **Test under the notebook runtime's versions before deploying.** The Fabric Python (non-Spark) notebook
  runtime measured Python 3.11 with duckdb 1.2.2, deltalake 0.18.2 and pyarrow 17, far older than a
  current workstation. Code that ran locally failed its first Fabric run: an f-string expression with a
  backslash or `#` is a SyntaxError before 3.12, and `deltalake.QueryBuilder` does not exist in 0.18. Run
  the pipeline once in a pinned environment (`uv venv --python 3.11` plus the runtime's versions) and
  compare its outputs with the workstation run; that run found two more defects (section 8).
- **A failed notebook job hides its error.** A run started through the jobs API (`RunNotebook`) reports
  only `System_Cancelled_Session_Statements_Failed`; the traceback is only in the run's snapshot
  (Monitor > the job > item snapshot, or the notebook's recent runs). Read it there before guessing.
  A notebook that raises on purpose when a data-quality check fails ends the same way.
- **Tokens in memory only.** A local helper that cached hourly tokens in files under a git-ignored folder
  is still a token at rest, and a source scanner flagged it through the generated notebooks. Ask the
  signed-in session per process (Az PowerShell `Get-AzAccessToken -AsSecureString` through a subprocess,
  about 4 s, held in memory for 40 minutes); in a notebook, `notebookutils.credentials.getToken('storage')`
  kept in `storage_options` is fine.

## 8. Reading lakehouse Delta tables from Python

- **Tables written by Dataflow Gen2 use column mapping** (`delta.columnMapping.mode = name`, parquet columns
  named by GUID). `DeltaTable.to_pyarrow_table()` / `to_pyarrow_dataset()` (deltalake 1.6) returned the
  logical column names with every value null and no error. DataFusion
  (`QueryBuilder().register('t', dt).execute(...)`), Spark or the SQL endpoint map the names. Assert a
  non-null count on a key column after every read.
- **Cast a fallback read to the Delta schema.** Reading the parquet files by physical name (where the
  library has no column-mapping reader) returned timestamps without a zone, where DataFusion returned UTC;
  DuckDB's `timezone('UTC', x)` then shifted them by hours and every row hash changed.
- **An empty Delta table has no data files.** Both readers returned an Arrow table with no columns, and
  DuckDB refused to register it ("must have at least one column"); the next notebook in the chain failed.
  Build an empty table from the Delta log schema (`dt.schema().to_pyarrow()`), and test every pipeline
  with at least one empty table and with a re-run over existing tables.
- **Never number rows without a total order.** `row_number() OVER ()` follows scan order, which differs
  between DuckDB versions and thread counts, and a multi-file Delta table comes back in a different file
  order from each reader: 15,380 ids differed between runs. Sort each feed on all columns (`ORDER BY ALL`)
  before numbering, give every ordering a full tiebreak, and prove determinism by running twice under
  different runtimes and comparing with EXCEPT ALL.
