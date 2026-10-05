# Fabric medallion template

A working starting point for the reporting lane: Dataverse -> bronze (Dataflow Gen2) -> silver and
gold (notebooks) -> a Direct Lake semantic model -> a report themed from the app's tokens, all
deployed into one workspace folder by `scripts/fabric.py`.

## Use

1. Copy this folder to the project's `fabric/`. Replace, once, in every file:
   - `{PREFIX}` the item prefix (e.g. `APP`), `{prefix}` the publisher prefix (e.g. `app`);
   - in `dataflow-bronze/`, repeat the query pair for each table and replace `{table}`.
   `fabric.py` refuses to send a file that still holds one of these tokens.
2. `fabric.example.json` -> `fabric.json`: set the workspace, this build's folder, `orgHost`,
   `timezone`, `workspaceName`.
3. Fill `notebooks/silver.py` (columns, `CHOICES` from `dataverse/tables.json`, the brief's rules)
   and `notebooks/gold.py` (facts, dimensions, `STATUSES`), and the model's `tables/*.tmdl`.
4. Theme the report from the app's tokens (no default purple series):
   `python scripts/pbi-theme.py --tokens design/theme.json --report fabric/report --apply`
5. Plan, then deploy, then run:
   ```
   python scripts/fabric.py deploy --manifest fabric/fabric.json
   python scripts/fabric.py deploy --manifest fabric/fabric.json --apply
   python scripts/fabric.py run --manifest fabric/fabric.json DataPipeline {PREFIX}_Refresh_Pipeline --apply
   ```
6. Prove the figures: `report-checks.example.json` -> `report-checks.json`, then
   `python scripts/reconcile-report.py --checks fabric/report-checks.json` (exit 0 = every figure
   matches Dataverse). Only then screenshot the report as evidence.

## Placeholders

| Form | Filled by | Example |
|------|-----------|---------|
| `{PREFIX}`, `{prefix}`, `{table}` | you, when copying | `APP_Bronze`, `app_record` |
| `{{workspaceId}}`, `{{id:Type:Name}}`, `{{sqlEndpoint:Lakehouse}}`, `{{sqlEndpointId:Lakehouse}}`, `{{var:key}}` | `fabric.py deploy`, at deploy time | the lakehouse id the dataflow writes to |

## Notes from real builds

- The dataflow needs a Dataverse connection the signed-in person owns, created once in the portal;
  its first run binds it. A connection made for another build is not this lane's.
- A new lakehouse's SQL endpoint provisions after the lakehouse; `fabric.py` waits for it before
  the model, whose Direct Lake expression needs it.
- The gold notebook reframes the model at the end. Without the reframe the report serves the
  previous frame, and a reconcile run straight after the pipeline shows the old figures.
- "Today" is one time zone everywhere (silver, the flows, the reconcile checks), or "overdue"
  differs by a day between the email and the report.
- `pbi-theme.example.json` shows the generated theme for a sample blue/teal palette.
- The notebooks run on `environment/` (Spark runtime 1.3): a workspace's default runtime can be
  retired, and its settings are the owner's.
- `dataflow-bronze-webapi/` is the bronze for an environment whose TDS endpoint lists no tables
  (off, or tables too new): the Web API with one connection on the API base. Point the manifest's
  Dataflow `source` at it instead of `dataflow-bronze`.
