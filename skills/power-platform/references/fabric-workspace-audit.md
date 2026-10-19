# Auditing an existing Power BI / Fabric workspace before a rebuild

A workspace that grew by hand (Gen1 and Gen2 dataflows, Import and Direct Lake models, reports, an app,
Excel workbooks reading dataflows) cannot be cleaned up or replaced safely from its item list. Audit it
read-only first: what each item is, what it reads, who reads it, whether it refreshes cleanly, and whether
anyone uses it. Building a new medallion over Dataverse is `reporting.md` section 4; this page is for the
workspace you inherit.

## Contents

1. The rule: read-only, then plan, then apply
2. Snapshot the workspace
3. Lineage from the definitions, not from the lineage APIs
4. Consumers the APIs cannot see: Excel workbooks
5. Usage
6. Refresh health, cadence and order
7. Classify, then retire in stages
8. What an audit of a grown workspace typically finds

## 1. The rule: read-only, then plan, then apply

- The audit only reads: GETs, Fabric `getDefinition` (returns a definition, changes nothing), DAX queries,
  and `SELECT` on SQL endpoints. Nothing is refreshed, moved, disabled or deleted during it.
- Every later change to an existing item (move, schedule off, repoint, delete) follows must-hold 12:
  a script lists exactly which items it will touch, records that list, and the apply acts only if a fresh
  selection matches it. A refusal of a stale or changed plan is the point of the guard.
- **Test a guard's refusals on its functions or a `--selftest`, never by running the live apply.** A
  measured "refusal test" tampered with the recorded plan file, missed (wrong file name), and the
  untouched plan matched: the apply ran for real. It was additive that time; against a delete it would
  not have been.

## 2. Snapshot the workspace

Write everything to a dated, gitignored folder (definitions carry site paths and workbook names):

| What | Call |
|---|---|
| Items (all types, with `folderId`) and folders | Fabric `GET /workspaces/{ws}/items` (follow `continuationUri`), `GET /folders?recursive=true` |
| Gen1 dataflows | Power BI `GET /groups/{ws}/dataflows`; each `GET /dataflows/{id}` returns `model.json` with the M in `pbi:mashup.document` and the loaded entities |
| Gen1 refresh history | `GET /dataflows/{id}/transactions` (last 10 runs) |
| Models, reports, the app | `GET /datasets`, `/datasets/{id}/refreshes`, `/refreshSchedule`, `/reports` (`datasetId` binds report to model), `/apps`, `/apps/{id}/reports` |
| Definitions | Fabric `POST /items/{id}/getDefinition` (`?format=TMDL` for semantic models): Gen2 `mashup.pq` + `queryMetadata.json` + `.schedules`, TMDL, PBIR, pipeline JSON |
| Gen2, pipeline and notebook runs | `GET /items/{id}/jobs/instances` (about the last 30) |
| Lakehouse and warehouse tables | the **SQL endpoint**: `sys.tables`, then `COUNT_BIG(*)` per table |

Traps measured in a real audit:

- **The lakehouse tables API is not an inventory.** `GET /lakehouses/{id}/tables` returned 400 for three
  lakehouses and 12 of 45 tables for another. The SQL endpoint listed all of them. `sys.partitions` has no
  row counts for Delta tables (NULL); count with `COUNT_BIG(*)`.
- **PowerShell 5.1 `ConvertTo-Json` writes a one-item array as a bare object and `$null` as an empty
  file.** Readers of the snapshot normalise both.
- **`[IO.File]::WriteAllText` resolves a relative path against the process directory**, not the
  PowerShell location; pass full paths.
- Fetching every definition is slow (each is a long-running operation): about 25 minutes for 190 items.
  Run it in the background and analyse the REST parts meanwhile.

## 3. Lineage from the definitions, not from the lineage APIs

- `GET /datasets/upstreamDataflows` is reliable for model -> dataflow.
- **`GET /dataflows/{id}/upstreamDataflows` returned nothing for every Gen1 dataflow**, although nine read
  other dataflows, one through a helper function that takes the ids as strings. Build dataflow -> dataflow
  edges from the M: any known dataflow or item id in a query is a read; the entity name follows it
  (`entity = "..."` in a navigation record, or the next string argument of a helper).
- In M, sources to recognise: `SharePoint.Files` / `SharePoint.Contents` (file name from
  `[Name = "..."]`, folder from `[Folder Path] = "..."`, sheets from `[Item = ..., Kind = "Sheet"]`),
  `SharePoint.Tables` (list by `[Title = ...]` or by `[Id = "<guid>"]`), `PowerPlatform.Dataflows`,
  `Lakehouse.Contents` / `Fabric.Warehouse` (ids, and `*_DataDestination` queries are writes),
  `CommonDataService.Database`, `Sql.Database`, `Folder.Files` (a file share: a gateway dependency).
- In TMDL, a table's partition often reads a shared `expression`; resolve the expression to its source
  rather than attributing every expression to every table.
- **SharePoint lists referenced by GUID:** the Az token cannot read SharePoint (Graph returns no lists,
  SharePoint REST 401). In a signed-in browser, `GET <site>/_api/web/lists?$select=Id,Title,ItemCount,
  LastItemModifiedDate` names them, with item counts that show empty lists.

**Pace every SharePoint call.** A burst of unpaced browser calls (folder listings and a few multi-MB
workbook downloads) got the user throttled: every call returned 406 and pages redirected to
`/_layouts/15/Throttle.htm`. SharePoint throttles per user, and the same identity usually runs that user's
scheduled refreshes. Keep 2-3 seconds between calls, stop at the first 429, 406, 503 or Throttle page,
honour `Retry-After`, never retry in a loop. After about ten minutes single paced calls worked again.

## 4. Consumers the APIs cannot see: Excel workbooks

Workbooks that read dataflows (project templates, finance workbooks) appear in no API. Before calling
any entity unused, read the templates themselves:

- An `.xlsx` / `.xlsm` is a zip; its Power Query is in `customXml/item*.xml` as a base64 `DataMashup`
  (4-byte version, 4-byte package length, then a zip containing `Formulas/Section1.m`).
- In a signed-in browser, fetch the file (`GetFileByServerRelativeUrl('<path>')/$value`) and unzip it with
  `DecompressionStream('deflate-raw')`; return only the M text. `.xlsb` stores it differently; skip it.
- In a measured audit, one project template read 11 entities from four dataflows; four of them had been
  marked "no consumer" from the API data alone. Entities a template reads are a **contract**: names,
  columns and dataflow ids must survive any rebuild until the template is replaced.

## 5. Usage

- Query the workspace's **Report Usage Metrics Model** with `POST /datasets/{id}/executeQueries`
  (`EVALUATE INFO.VIEW.TABLES()` first). It holds about 90 days of views by report and user.
- **Its `ReportGuid` is upper case; REST report ids are lower case.** A case-sensitive join reports zero
  views everywhere. App copies have their own ids: add their views to `originalReportObjectId`.
- The older "Usage Metrics Report" model in a workspace can be years stale; check its refresh history
  before trusting it.

## 6. Refresh health, cadence and order

From the histories: runs, failures, last status and failure reason per item; median interval (cadence)
and median duration. Look for:

- **Unchained refreshes.** Models and combining dataflows on their own clocks read sources mid-refresh.
  A retry wrapper around dataflow reads in M is a sign of it. Fix with a pipeline per subject area: bronze,
  silver, gold, then the model, then a check.
- **Cadence above the change rate**: hourly reads of lists that change weekly; a list refresh that takes
  most of its own interval.
- **Items failing every run while still scheduled**, and schedules disabled by the service after failures.
- **One identity behind everything** (every Gen1 `configuredBy` and every connection the same person).

## 7. Classify, then retire in stages

| Class | Meaning | Action |
|---|---|---|
| A | No consumer anywhere, no views, or failing for months | Retire first |
| B | No consumer in the workspace, but a workbook may read it | Read the workbooks (section 4) first |
| C | Used, but superseded by a newer item | Retire after its readers move |

Retire in stages, each a planned apply: schedule off, watch a week (usage, no failing reader), move to a
retiring folder, delete after a month. Delete in the dependency order in `reporting.md` section 4
(teardown): reports and models first, dataflows before their lakehouses.

## 8. What an audit of a grown workspace typically finds

From one measured audit of about 190 items: a production chain of Gen1 dataflows feeding one Import model
with over a hundred auto date/time tables; a medallion attempt with one Gen2 dataflow per table whose
silver layer was placeholders that never ran, so bronze had no consumer; about 18 unchained refreshes an
hour under one person; 39 of 54 reports unopened in 90 days; and a template reading entities the APIs
called unused. None of these were visible from the item list.
