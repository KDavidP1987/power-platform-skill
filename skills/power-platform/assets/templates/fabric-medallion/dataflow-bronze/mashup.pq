section Section1;
// Bronze: Dataverse tables landed as they are, one query pair per table. Copy the pair for each
// table and replace {table}. {{...}} placeholders are resolved by fabric.py deploy.
[DataDestinations = {[Definition = [Kind = "Reference", QueryName = "{table}_DataDestination", IsNewTarget = true], Settings = [Kind = "Automatic", TypeSettings = [Kind = "Table"]]]}]
shared {table} = let
  Source = CommonDataService.Database("{{var:orgHost}}", [CreateNavigationProperties = false]),
  Data = Source{[Schema = "dbo", Item = "{table}"]}[Data]
in
  Data;
shared {table}_DataDestination = let
  Pattern = Lakehouse.Contents([CreateNavigationProperties = false, EnableFolding = false]),
  Navigation_1 = Pattern{[workspaceId = "{{workspaceId}}"]}[Data],
  Navigation_2 = Navigation_1{[lakehouseId = "{{id:Lakehouse:{PREFIX}_Bronze}}"]}[Data],
  TableNavigation = Navigation_2{[Id = "{table}", ItemKind = "Table"]}?[Data]?
in
  TableNavigation;
