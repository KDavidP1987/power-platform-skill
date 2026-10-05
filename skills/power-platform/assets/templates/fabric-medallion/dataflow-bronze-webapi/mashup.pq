section Section1;
// Bronze over the Dataverse Web API, for when the TDS endpoint (dataflow-bronze) lists no tables: it can
// be off in the environment, and tables created minutes earlier can be missing from it (measured).
// One connection serves every table: Web.Contents on the API base with RelativePath (a per-entity
// URL makes the service ask for a credential per table), organizational account. No OData-Version
// header (it broke the connection test). Copy the query pair per table; replace {table}, {entityset}
// and the column list. Choices stay as option values, dates as text; silver types them.
// {{...}} placeholders are resolved by fabric.py deploy.
[DataDestinations = {[Definition = [Kind = "Reference", QueryName = "{table}_DataDestination", IsNewTarget = true], Settings = [Kind = "Automatic", TypeSettings = [Kind = "Table"]]]}]
shared {table} = let
  Columns = {"{table}id", "{prefix}_name", "statecode", "createdon", "modifiedon"},
  Fetch = (q as record) => Json.Document(Web.Contents("https://{{var:orgHost}}/api/data/v9.2", [RelativePath = "{entityset}", Query = q, Headers = [Accept = "application/json", Prefer = "odata.maxpagesize=5000"]])),
  Pages = List.Generate(() => Fetch([#"$select" = Text.Combine(Columns, ",")]), each _ <> null, each if Record.HasFields(_, "@odata.nextLink") then Fetch(Uri.Parts(Record.Field(_, "@odata.nextLink"))[Query]) else null, each _[value]),
  Rows = List.Combine(Pages),
  Data = Table.FromRecords(Rows, Columns, MissingField.UseNull)
in
  Data;
shared {table}_DataDestination = let
  Pattern = Lakehouse.Contents([CreateNavigationProperties = false, EnableFolding = false]),
  Navigation_1 = Pattern{[workspaceId = "{{workspaceId}}"]}[Data],
  Navigation_2 = Navigation_1{[lakehouseId = "{{id:Lakehouse:{PREFIX}_Bronze}}"]}[Data],
  TableNavigation = Navigation_2{[Id = "{table}", ItemKind = "Table"]}?[Data]?
in
  TableNavigation;
