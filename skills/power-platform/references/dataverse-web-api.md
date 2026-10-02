# The Dataverse Web API from scripts

Recipes and traps for provisioning schema, changing metadata and reading data over the Web API
from PowerShell or Python. What to build and why is in `dataverse.md`; who may read what is in
`security-and-access.md`; writing live business data is in `data-migration.md`.

## Contents

1. Tokens, headers and a read-only query helper
2. Names: entity sets, navigation properties, logical vs schema names
3. Print the server's error, and never a false success
4. Idempotent provisioning: publisher, solution, choices, tables, columns, lookups
5. `@odata.type` goes first in a metadata payload
6. Retry the eventual-consistency signatures, and nothing else
7. Updating an attribute: a full PUT with the type cast
8. Choice members: insert, relabel, order, delete
9. Alternate keys
10. Solution components: Add and Remove are not symmetric
11. Ask what depends on a column before deleting it
12. Reading data: counts, paging, the TDS endpoint
13. Model-driven forms by script
14. The directory is already in Dataverse
15. Windows PowerShell 5.1 traps

---

## 1. Tokens, headers and a read-only query helper

- `pac org who` confirms which environment the CLI is pointed at; check it at session start, and
  have every import script print it before importing.
- A Web API token: `az account get-access-token --resource https://<org>.crm.dynamics.com` (Azure
  CLI), or a small device-code helper that caches a refresh token **outside the repo**. Give scripts
  a fallback chain: an `-AccessToken` parameter, else the cached helper, else `az`.
- **Device-code helper specifics.** POST to
  `https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode` with a public client id and
  scope `https://<org>.crm.dynamics.com/.default offline_access`; poll the token endpoint at the
  returned interval, continuing on `authorization_pending` and adding 5 s on `slow_down`. Cache only
  the refresh token, in the user profile; redeem it with `grant_type=refresh_token` and **save the
  rotated refresh token** each time; fall back to a fresh device code on failure; offer `-Reset`.
  Fetch a fresh access token before each long step so a long load never runs past expiry.
- **Treat the cache as a credential.** The device code expires in about 15 minutes; the refresh
  token then gave about 90 days of silent access in one tenant, to every app the account can reach.
  Lifetimes and whether a public client may be used are tenant policy. If the default public client is
  not consented in the tenant, register a public-client app with Dataverse `user_impersonation` and
  pass its client id.
- Reading schema needs at least System Customizer.
- Where only Az PowerShell is available, `Connect-AzAccount` through the Web Account Manager broker
  failed in an embedded console with a "window handle" error; `Update-AzConfig -EnableLoginByWam
  $false` once fixed it (observed in one environment).
- Headers worth always sending on reads:
  `Prefer: odata.maxpagesize=5000,odata.include-annotations="*"` - the annotations give formatted
  values (choice labels, lookup display names) without extra joins. On creates,
  `Prefer: return=representation` returns the new row, id included, without a read-back query
  (still read back to verify; section 3).
- Keep a tiny read-only query helper in every repo (`dv-query`) that resolves entity set names from
  metadata. It settles "what does the data actually say" instead of inferring it from a seed script.

## 2. Names: entity sets, navigation properties, logical vs schema names

- **The entity set is not the naive plural**, and can be a different word entirely (a `calendar`
  table had the set `calendarweeks`, from its display collection name). Guessing gives a bare 404.
  Resolve every set in one call: `EntityDefinitions?$select=LogicalName,EntitySetName`.
- **Data operations take lower-case logical names.** Posting `{"app_Amount": 5}` fails with "The
  property 'app_Amount' does not exist on type ...", which reads exactly like the column was never
  created. Only the **navigation property** in `X@odata.bind` keeps schema casing.
- **The navigation property is not always the schema name**; its casing varies with how the column
  was created (`app_Person@odata.bind` on one table, `app_person@odata.bind` on another). The wrong one
  gives a 400: *"An undeclared property 'X' which only has property annotations in the payload but no
  property value"* - which reads like a payload bug. Resolve it:
  `GET EntityDefinitions(LogicalName='app_request')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencingEntityNavigationPropertyName`.
  Lower-case lookup schema names avoid the problem (`dataverse.md`, section 11).
- **Rebind a lookup with PATCH and `@odata.bind`**, not `PUT .../$ref`: with a lower-case name the
  segment resolves to the attribute ("The URI segment '$ref' is invalid").
- **A schema name and a logical name differ in case** (`app_Role` vs `app_role`). Case-fold both
  sides of any comparison between solution components and canvas data sources. When printing a
  case-only drift, print both names with their code points - it is invisible in every error message.
- **Read choice integers from metadata, not from constants** in loaders. A hard-coded integer silently
  writes the wrong option after a set is regenerated.
- **Escape a single quote in an OData literal by doubling it** (`'O''Brien'`) before URL-encoding; an
  apostrophe in one name aborted a seed load.

## 3. Print the server's error, and never a false success

Dataverse puts the real complaint in the response body. A client that reports "HTTP Error 400" turns
a two-minute fix into an afternoon.

- **Windows PowerShell 5.1:** by the time a `catch` runs the response stream is consumed, so reading
  it returns "". The body is in `$_.ErrorDetails.Message`; parse it as JSON and print `error.message`.
- **Exit non-zero when any operation failed.** One removal script printed a success line after nine
  consecutive 400s. An empty `catch {}` is worse: a mis-escaped regex threw, was swallowed, and a
  metadata script reported its 500-row fallback as if it had read the app. A fallback must announce
  itself and the direction of its error ("findings are over-reported").
- **An existence probe in try/catch is not an existence check.** A per-column GET treating any
  exception as "does not exist" turned a throttle into "missing", and the rerun died recreating an
  existing column (`0x80047013`). Read the table's attribute list once and test membership.
- **Verify writes by re-reading**, not from the POST response or the status code. A 204 means
  accepted.

## 4. Idempotent provisioning: publisher, solution, choices, tables, columns, lookups

Schema can be created from a manifest (JSON or one spec per table), idempotently, without modules.
The bundled `scripts/deploy-tables.py` does steps 1, 2, 4, 6 and 7 below from one JSON manifest,
with a plan mode, shared tables turned into references and a read-back (`dataverse.md`, section 16).
Order matters:

1. **Publisher** (`publishers`, with `customizationprefix` and `customizationoptionvalueprefix`).
   Option values are `customizationoptionvalueprefix x 10000 + offset`.
2. **Solution** (`solutions`, `publisherid@odata.bind`).
3. **Global choices** (`GlobalOptionSetDefinitions`, an `OptionSetMetadata` with `IsGlobal: true`).
4. **Tables and scalar columns** (pass 1). `POST EntityDefinitions` with the **primary-name
   attribute inside the `Attributes` array** (`IsPrimaryName: true`) - it cannot be added afterwards.
   Then `POST EntityDefinitions(LogicalName='x')/Attributes` per column, each with its typed
   `@odata.type`. Date-only needs `DateTimeBehavior: {Value: "DateOnly"}` as well as the format;
   Money needs `PrecisionSource`.
5. **Choice columns**, bound to a global set by `GlobalOptionSet@odata.bind` pointing at the set's
   **MetadataId** (binding by `Name=` was answered "Guid should contain 32 digits"), and only after the
   set is published ("IsGlobal is not specified" otherwise).
6. **Lookups** (pass 2, once every target exists, including tables from other solutions):
   `POST RelationshipDefinitions` with a `OneToManyRelationshipMetadata` embedding a
   `LookupAttributeMetadata` and an explicit `CascadeConfiguration` (`dataverse.md`, section 12).
   Check the target exists before each one.
7. **Publish**: `PublishXml` for the touched entities, or `PublishAllXml`.

**Notes (annotations) need `HasNotes` on the table first.** A `POST annotations` with
`objectid_<table>@odata.bind` on a table created without notes fails with "undeclared property
objectid_<table>". Set it at creation (`HasNotes: true` on the `EntityMetadata`), or afterwards with
a full `PUT EntityDefinitions(LogicalName='<table>')` carrying `HasNotes: true` and the header
`MSCRM.MergeLabels: true` (so labels are not wiped), then `PublishXml` for the table. Keep the flag in
the manifest so a rebuild keeps it.

**URL-encode string values in `$filter`.** An unencoded `+` in a query string is read as a space:
`$filter=app_name eq 'Plan +2 - Day 3'` matched nothing, and an idempotent "find, else
create" seed would have created duplicates. Encode the literal (`[uri]::EscapeDataString(...)`,
`urllib.parse.quote`) after doubling any apostrophe.

Rules for every step:

- **Send `MSCRM.SolutionUniqueName: <solution>` on every metadata create**, naming the solution that
  **owns** the component. Without it the component lands in the Default solution and the next export
  does not carry it.
- **A lookup to ANOTHER solution's table drags that table in whole.** Creating the lookup column with
  your solution header adds the referenced table to your solution as a root component WITH all its
  subcomponents (`rootcomponentbehavior` 0) - measured on a new app whose three lookups into a shared
  reference layer put all three shared tables in its solution, schema included, before any app
  existed. Read `solutioncomponents` after provisioning, and turn any foreign table into a reference
  (remove, then add with `DoNotIncludeSubcomponents`; section 10). `ship-canvas.py` refuses a zip
  that carries an `externalTables` table with behavior 0.
- **Check existence by reading the list once** (section 3); treat "already exists" as success.
- **Settle after creating a table.** A column POST straight after `CreateEntity` hit a metadata race
  and returned a spurious 400; pausing about 3 s and retrying the signatures in section 6 fixed it.
- Retry 429 honouring `Retry-After`, and 503/504 with backoff.

```powershell
$h = @{ Authorization = "Bearer $token"; 'MSCRM.SolutionUniqueName' = $solution
        'Content-Type' = 'application/json; charset=utf-8' }
$col = [ordered]@{
  '@odata.type' = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'   # first - see section 5
  SchemaName    = 'app_reference'                                     # lower case for lookups too
  MaxLength     = 100
  RequiredLevel = @{ Value = 'None' }
  DisplayName   = @{ LocalizedLabels = @(@{ Label = 'Reference'; LanguageCode = 1033 }) }
}
$existing = (Invoke-RestMethod -Headers $h -Uri "$api/EntityDefinitions(LogicalName='app_order')/Attributes?`$select=LogicalName").value.LogicalName
if ($existing -notcontains 'app_reference') {
  Invoke-RestMethod -Method Post -Headers $h -Body ($col | ConvertTo-Json -Depth 10) `
    -Uri "$api/EntityDefinitions(LogicalName='app_order')/Attributes"
}
```

Security roles can be built the same way and converged with `ReplacePrivilegesRole`
(`security-and-access.md`, section 4).

## 5. `@odata.type` goes first in a metadata payload

A PowerShell hashtable has no order, so `ConvertTo-Json` can emit `@odata.type` **after** the
properties it types. A metadata create then fails with a bare `0x80040216` "An unexpected error
occurred". Three bodies identical except for key order proved it. Use `[ordered]@{...}` for every
metadata body, nested ones included.

## 6. Retry the eventual-consistency signatures, and nothing else

Metadata is eventually consistent after a create, and the failures look like real errors. Each of
these was observed and cleared on retry:

| Signature | When |
|---|---|
| `0x80040216` "An unexpected error occurred" | Adding a second column to a just-created table; on re-run the existence check said absent while the create said already present. (Rule out key order first - section 5.) |
| Spurious HTTP 400 | The first column POST straight after `CreateEntity` |
| `0x80048d19` "property ... does not exist on type" | Inserting a row straight after creating the column, even after `PublishAllXml` |
| "IsGlobal is not specified" | Binding a choice column before its global set has committed |
| "NavigationPropertyName ... is not unique" | Recreating a relationship just deleted |
| Read-back says the attribute does not exist; a renamed label reads old | Verifying immediately (labels change only after publish) |

Retry **only** these, with bounded backoff and a publish between attempts, and rethrow everything
else. Treat "already exists" as success: an idempotent migration that cannot be re-run part-way is
not idempotent. Do not stack further operations on top of one that has not settled.

## 7. Updating an attribute: a full PUT with the type cast

`PATCH` on an attribute, and `PUT`/`PATCH` on `.../DisplayName`, are refused. The update that works:

1. `GET` the attribute; note its `@odata.type`.
2. Change one field in the returned object.
3. `PUT` it back to the **type-cast** URL:
   `.../EntityDefinitions(LogicalName='app_order')/Attributes(LogicalName='app_total')/Microsoft.Dynamics.CRM.MoneyAttributeMetadata`.
   Without the cast segment, Money columns gave a bare 404 while Integer and DateTime worked.
4. Re-attach `@odata.type` to the body (dropping it failed "Invalid property ImeMode").
5. Send `MSCRM.MergeLabels: true`, or every other language's label is wiped.
6. Publish, then read back. Until the publish, a display-name change reads back old, which looks like
   a failed write.

A Money column's `_base` companion may refuse the same update; report it and carry on rather than
aborting the run. `IsSecured` could not be changed by PATCH (405 in every form tried) and belongs in
solution source anyway (`security-and-access.md`, section 8).

## 8. Choice members: insert, relabel, order, delete

For a small choice change these actions have exactly the blast radius intended, unlike a solution
import that also reships the canvas app.

- `InsertOptionValue`, `UpdateOptionValue` (send `MSCRM.MergeLabels: true`), `DeleteOptionValue`,
  `OrderOption`. A global set is addressed by `OptionSetName`; a **local** set cannot be
  (`0x80048403` "the option set is not Global") - address it with `EntityLogicalName` +
  `AttributeLogicalName`.
- **A new member without an explicit value gets the publisher's base value, and sorts FIRST** in
  every picker. Members added with explicit values append out of display order. Fix with
  `OrderOption`, which **replaces the whole order** - pass every member. Never delete and re-mint a
  value to move it; that orphans the rows holding it.
- **Verify the order by printing the stored order unsorted.** A script that piped through
  `Sort-Object Value` reported a tidy 1..10 while the stored order was scrambled.
- `DeleteOptionValue` returns success while `GlobalOptionSetDefinitions` keeps serving the old value
  until a publish. Publish, then verify. The retirement procedure is in `dataverse.md`, section 9.
- Publish a single entity rather than everything:

```xml
<importexportxml><entities><entity>app_order</entity></entities></importexportxml>
```

  sent as `ParameterXml` to `POST PublishXml`.

## 9. Alternate keys

`POST EntityDefinitions(LogicalName='app_order')/Keys` with an `EntityKeyMetadata`
(`SchemaName`, `DisplayName`, `KeyAttributes`). The index builds asynchronously:

- **Poll `EntityKeyIndexStatus` until `Active`**, and report the real status. A Pending key enforces
  nothing.
- **Index creation fails if duplicates already exist** - clean the data first.
- A second key over the same columns collides on the index, not the name.
- **Prove it** by attempting a duplicate and reading the key's own error message.

## 10. Solution components: Add and Remove are not symmetric

**Add** takes a GUID:

```json
{ "ComponentId": "<table MetadataId>", "ComponentType": 1,
  "SolutionUniqueName": "app_solution", "AddRequiredComponents": false,
  "DoNotIncludeSubcomponents": true }
```

`DoNotIncludeSubcomponents: true` references another team's table without shipping its columns
(`dataverse.md`, section 8).

**Remove** takes an entity reference. The documentation and SDK say `ComponentId`; the org's
`$metadata` defined `RemoveSolutionComponent(SolutionComponent, ComponentType, SolutionUniqueName)`
with no `ComponentId`, and the platform derives it from the **key** of the reference - so key it on
the component's **object id** (the table's MetadataId, or `roleid` for a role):

```json
{ "SolutionComponent": { "@odata.type": "Microsoft.Dynamics.CRM.solutioncomponent",
                         "solutioncomponentid": "<the COMPONENT's objectid>" },
  "ComponentType": 1, "SolutionUniqueName": "app_solution" }
```

Errors that mean "wrong shape", not "absent component":

- Sending `ComponentId`: "'ComponentId' is not a valid parameter".
- Other shapes: "Required field 'ComponentId' is missing", or a bare 400 with an empty body.
- Keying the reference on the membership row's own `solutioncomponentid`: it resolves, then fails
  "Cannot find solution component Entity <id> in solution ...", which reads as if the table were not
  in the solution.

Read action signatures from `$metadata` when the documentation disagrees with the org. Removal only
unlinks; the table and its data remain.

## 11. Ask what depends on a column before deleting it

```
GET RetrieveDependenciesForDelete(ObjectId=<attribute MetadataId>,ComponentType=2)
```

Resolve dependents of type 60 (forms) with `systemforms(<id>)?$select=name`. Auto-generated
"Information" forms are the usual blocker. Combine with a search of the published app
(`dataverse.md`, section 9).

## 12. Reading data: counts, paging, the TDS endpoint

- **A cheap live row count**: `GET <set>?$count=true&$top=1` and read `@odata.count`. A missing
  count degrades to "unknown", never to "fine".
- **Server-side reads have no 2,000 ceiling, but they are paged.** Follow `@odata.nextLink` until it
  is absent. A rebuild script that reads one page reintroduces exactly the truncation it exists to
  remove; a `$top=5000` read of the `privileges` table silently truncated. Print what was read as a
  count, and where it feeds a canvas app, as a percentage of the app's row cap.
- **A helper that pages on a `value` array returns nothing for a single-entity response** (one
  metadata entity), and a check built on it passed. Raise on an unexpectedly empty result.
- **Exact counts over TDS.** The Dataverse TDS (SQL) endpoint, port 5558, accepts a SqlClient
  connection with an Entra access token (`SqlConnection.AccessToken`) and answers `SELECT COUNT(*)`
  per table - useful for reconciling a downstream copy without paging. It is read-only and must be
  enabled for the environment.
- Formatted values: with `odata.include-annotations="*"`, a choice's label arrives as
  `<column>@OData.Community.Display.V1.FormattedValue`. Print code **and** label when reading a
  source system's codes (`data-migration.md`, section 2).

## 13. Model-driven forms by script

Form XML is edited through `systemforms` with `PATCH` + `If-Match: *` and published with
`PublishXml`. The full procedure - idempotent append-only edits, control classids by field type,
subgrids, verification - is in `model-driven-and-docs.md`, section 1.

## 14. The directory is already in Dataverse

Every environment mirrors Entra ID into **`systemuser`**, readable with an ordinary Dataverse token.
Before adding the Office 365 Users connector, requesting a Graph scope, or asking someone for a
directory export, query it:

```
systemusers?$select=fullname,firstname,lastname,internalemailaddress,domainname,
                    title,isdisabled,accessmode,applicationid
```

- **Filter out application users** (`applicationid` non-null): service principals, not people.
- **A disabled account's address may be mangled** - a 32-character GUID prefixed onto
  `internalemailaddress` on soft-delete. Strip it or you write an address that can never receive
  mail. `isdisabled` is the cheapest reliable "has this person left?".
- **Many people hold two accounts** (a normal one and an admin one). Prefer the one whose local part
  is `first.last`, then a non-admin pattern, then the company domain over `onmicrosoft`, then
  interactive access mode; writing an admin account as someone's identity breaks sign-in matching.
- **Matching people by name: a prefix is not a nickname.** "Chris" begins Christopher, Christina and
  Christine; a prefix match once moved a departed person's records onto a different, active person,
  and uniqueness did not catch it. When either side is a known short form, compare formal names
  only; keep prefix matching for names that are nobody's nickname, with a minimum length; lock the
  cases that went wrong into a self-test. More matching rules: `data-migration.md`, section 3.
- **Directory data is identity, never authority.** Names and addresses may come from `systemuser`;
  who approves whom must not - the approval line is often not the line manager, and derived
  membership was wrong in both directions against real data. Job titles are HR free text with typos:
  never a taxonomy or join key. The UPN local part is not an HR network id for most people. Fill only
  blank fields and send the rest to a review file for a person.
- `systemuser` is read-only for this purpose. Never write to it.

## 15. Windows PowerShell 5.1 traps

Windows PowerShell 5.1 is often the only shell on a managed machine (`pwsh` may not exist - write
`powershell -File`). Each of these broke a Dataverse script:

- **Non-ASCII in POST bodies is corrupted** by `Invoke-RestMethod` unless sent as UTF-8 bytes; a
  mangled en-dash broke primary-name idempotency and created a duplicate row. Send
  `[Text.Encoding]::UTF8.GetBytes($json)` with `charset=utf-8`, or normalise seed text to ASCII.
- Force TLS 1.2 (`[Net.ServicePointManager]::SecurityProtocol = 'Tls12'`).
- `Invoke-WebRequest` needs `-UseBasicParsing` non-interactively, or it throws a null reference -
  after the POST has already succeeded.
- **Native exit codes do not throw** - check `$LASTEXITCODE` after every `pac` call (`dataverse.md`,
  section 2).
- **Collections unroll.** A one-element array returned from a function arrives as a scalar with no
  `.Count`; an empty HashSet arrives as `$null`. Wrap with `@()` at the assignment. One destructive
  script's preview printed "leaving -1" because of it.
- `$row[$col]` silently yields nothing on an `Import-Csv` row; use `$row.$col`. (0 rows created.)
- `$pid` is a read-only automatic variable, and **variable names are case-insensitive**:
  `$appendix` and `$APPENDIX` are one variable.
- A `[string[]]` parameter given `"a,b"` through `powershell -File` arrives as one string; use two
  parameters. `$PSScriptRoot` can be empty inside `param()` defaults in some hosts.
- A dot-source guard (`if ($MyInvocation.InvocationName -eq '.') { return }`) lets one script be both
  a runnable provisioner and a helper library.
