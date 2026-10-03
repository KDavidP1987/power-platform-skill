# Dataverse solutions, schema and data

This file covers packaging and schema. Three companions carry the rest:

- `dataverse-web-api.md` - provisioning and changing metadata by script, payload shapes, the errors
  worth retrying, names, paging, tokens, the directory in `systemuser`.
- `security-and-access.md` - security roles, depth, record sharing, column security, virtual
  tables, onboarding users.
- `data-migration.md` - writing live data: crosswalks, loads, backfills, purges, read models.

## Contents

1. The unpacked source is not the exported form
2. Assert on the finished artifact
3. An unmanaged import adds and overwrites; it never removes
4. What cannot change after creation
5. Security roles: out of the solution (summary)
6. Connection references
7. Three copies of a workflow GUID must agree
8. Solution membership decides what an import writes
9. Retiring tables, relationships, columns and choice values
10. Choosing column types and table shapes
11. Schema hygiene that only bites in the app
12. Relationship behaviour is a design decision
13. Rules the schema cannot hold
14. Effective-dated tables
15. Hand-authoring entity XML
16. Creating schema with `deploy-tables.py`

---

## 1. The unpacked source is NOT the exported form

A solution **zip** carries every component inline in `customizations.xml`. The **unpacked source**
that `pac solution unpack` produces - and `pac solution pack` consumes - **shards** most components
into per-component files and leaves a **childless element** in `Customizations.xml` as a
placeholder. Both are valid XML; only one works in your repo.

So when you learn a component's layout by reading an exported zip, you have learned the wrong
shape. Unpack it and copy that:

```
pac solution export --name <Solution> --path probe.zip
pac solution unpack --zipfile probe.zip --folder probe-src --packagetype Unmanaged
# read probe-src/, not the zip
```

Put the inline shape into source and `pac solution pack` prints

```
Component: Workflows is a supported component type but has unexpected children in
Customizations.xml; this component's specific processing will be skipped.
```

then **exits 0** with a zip whose payload is present and whose component does not exist. **Treat a
pac "unexpected children" warning as a build failure.** Fail the build script on it.

A second silent skip has its own wording: declare a root component in `Solution.xml` without its
files and pack prints `Following root components are not defined in customizations`, again exit 0,
with a zip that declares a component it does not contain. Canvas apps are the usual victim
(`<CanvasApps />` must be childless and each app needs its `CanvasApps/<name>.meta.xml`; see
`canvas-shipping.md`).

Packaging facts that cost a build each:

- **A managed zip cannot be packed from unmanaged-unpacked source.** `pac solution pack
  --packagetype Managed` over an Unmanaged unpack fails with "Solution package type did not match
  requested type". Export the managed build from the dev environment (`pac solution export
  --managed true`). Unpacking with `--packagetype Both` should let one tree produce either - general
  pac behaviour, not exercised in these projects.
- **Sync deletions too.** When refreshing `solution/src` from an environment, pass
  `pac solution unpack --allowDelete true`, or components removed live stay in source and the next
  import puts them back.
- **Keep the byte-order mark.** Dataverse writes `Solution.xml` and `customizations.xml` with a
  UTF-8 BOM. A script that rewrites them should read with `utf-8-sig` and write the BOM back. One
  project imported BOM-less files without trouble, so treat this as safe practice, not a proven
  requirement.
- **Bump `<Version>` in `Solution.xml` on every delivery.** A build taken from an environment export
  carries the live version forward, so a good build and a broken one become indistinguishable.

## 2. Assert on the finished artifact, never on the exit code

Two levels; the first alone is not enough:

- **Payload present**: for every `<RootComponent>` of a type with files, the files are in the zip.
- **Metadata built**: the zip's own `customizations.xml` contains the component element. This
  catches the silent skip above.

Assert declared against present **per component type**: canvas apps (`type="300"` vs
`CanvasApps/*.msapp`), flows (`type="29"` vs `Workflows/*.json` **and** vs `<Workflow WorkflowId=`
elements in the zip's own `customizations.xml`), and refuse a zip with flows but no
`connectionreferencelogicalname=` at all. Also check: no `Role` components (section 5), canvas apps
carry the expected markers and data-source count (`canvas-shipping.md`).
`scripts/inspect-artifact.py <zip>` reports most of these.

**In PowerShell, `pac` failing does not stop the script.** `pac` is a native executable; a non-zero
exit does not trip `$ErrorActionPreference = 'Stop'`. Without an explicit check the script prints
"Built", leaves the previous zip in `out/`, and the next import ships it - one project's import
script even stamped a "successful import" record after a failed import.

```powershell
pac solution pack --zipfile $zip --folder solution/src --packagetype Unmanaged
if ($LASTEXITCODE -ne 0) { throw "pac solution pack failed ($LASTEXITCODE)" }
```

## 3. An unmanaged import adds and overwrites; it never removes

An unmanaged import creates and updates what the zip carries. It does **not** delete a component that
is absent from the zip. Consequences, all observed:

- A component dropped from source stays live. One clean-up found ten leftover components and ten
  orphaned global option sets in an environment whose source was "clean".
- Importing an **older** zip neither fails nor removes the newer components; it overwrites what it
  carries and reports success. This is why "import succeeded" says so little.
- A canvas app survives an import from a repo that no longer declares it; a connection reference
  created by hand persists without error.
- **An option value deleted live comes back** on the next import if the solution XML still holds it.
- **Live-only metadata can be reverted.** A required level cleared by script was set again after a
  later import (most likely re-applied from the packaged entity definition - inferred, not proven).

Rules:

- **Retire things with explicit, scripted deletes** after checking dependents (section 9), **and**
  change solution source in the same change.
- **Mirror every live metadata change into `solution/src`**, and re-dump metadata after imports.
- **Periodically diff a fresh export's component list against source.** Remember also that the repo
  is not automatically the authority for the component list: one project's source listed 18 tables
  while the live solution held 35, so an audit reading `solution/src` was auditing the repo, not the
  environment. Each audit section should say which one it read (`audits.md`).

## 4. What cannot change after creation

| Cannot change | What happens if you try | The way out |
|---|---|---|
| An attribute's **type** (Picklist to Lookup, Picklist to String, any pair) | `Error: Attribute <name> is a Picklist, but a Lookup type was specified.` | Drop and recreate while empty; after go-live, a migration |
| A lookup's **target table** | The import fails, **or appears to succeed and keeps the old target** | Parallel lookup + crosswalk (`data-migration.md`, section 4) |
| A **SchemaName**, including its casing; a publisher prefix | No API accepts it | Delete and recreate (lookup recipe in section 11) |
| **Table ownership** (User vs Organization) | Fixed at creation | Choose before the first import (`security-and-access.md`, section 6) |
| **DateTime behaviour**, except towards Date Only / Time-Zone Independent | User Local -> Date Only is allowed; never back | Create event stamps as User Local; read the behaviour back after creating |
| The **primary name column** | Must be supplied when the table is created | Get its name and length right first; widening its MaxLength by Web API was refused once (405, observed once) |

The cheap moment for all of these is **while the table is empty**. Once a canvas app binds a column,
its type is effectively frozen in the app's manifest too (`manifest-caches.md`).

Keep such changes as **numbered, idempotent migration scripts** (`scripts/migrate/NNN-*.ps1`) that
pre-flight the row count and refuse a non-empty table, support `-WhatIf`, verify afterwards (with
retries - metadata is eventually consistent), and state in the header **why** the change was made.

**Find every mismatch by diffing, not by reacting to the import error.** The type error names one
column; a re-targeted lookup may name none. Before a schema import, dump every attribute type **and
every relationship target** from live, diff both against source in one pass, and re-run the diff
after any change that alters a type. When a type or target must change, drop the stale relationship
first (which drops its lookup column, so check the table is empty), then delete leaf-first so no
delete is refused for a dangling dependency, then import.

## 5. Security roles: out of the solution (summary)

**A solution carrying security roles resets live access control on import** (one import left no
non-administrator able to open the app). Build roles in the target environment, keep them out of the
solution, and prove every table the app binds is granted by some role, by impersonation. Removing role
components permanently, roles as code with `ReplacePrivilegesRole`, depth, sharing, column security
and virtual tables are in **`security-and-access.md`** section 1 onward.

## 6. Connection references

A flow or connector-using component names a **connection reference logical name**; the actual
connection is chosen after import. Embedding a connection ties the artifact to one person's
credentials.

- Connection references stay **inline** in `Customizations.xml` (they are not sharded), under a
  lowercase `<connectionreferences>` element.
- **The connections must exist in the target environment before binding**, and creating them
  requires **interactive consent** - a person signs in once per connector. No CLI does this. Plan
  it as a deployment step, not a go-live surprise.
- **Supply values at import, not in source.** `pac solution create-settings` generates a settings
  file for connection references and environment variables; pass it to the import. Run
  `pac solution check` before importing to a shared environment.
- **Import a flow deactivated the FIRST time** (`StateCode 0` / `StatusCode 1`): an activated flow
  with unbound references has nothing to run as. **For flows already running, the import applies the
  repo's on/off state** - and an import has turned running flows off while reporting success. Keep
  the repo's `<StateCode>` in step with live, and diff flow state after every import
  (`power-automate.md`).

## 7. Three copies of a workflow GUID must agree

The `WorkflowId` attribute, the GUID in the filename, and the GUID inside `<JsonFileName>`. One
wrong and the component silently does not resolve. Audit it; it is never spotted by reading.

## 8. Solution membership decides what an import WRITES, not what an app can READ

An app reads any table its roles grant, whichever solution shipped it. Membership decides what an
import **overwrites**. Three consequences, each paid for:

- **A solution that carries another team's tables reverts them.** One solution listed nine tables
  owned by a shared-reference solution. Importing it for an unrelated change republished its stale
  copy over the owner's, silently removing a column another app had added. Nothing errors; the other
  app fails later on a column that existed yesterday. This is the same class of fault as shipping
  security roles. **Ship no table you do not own.**
- **But a canvas app's solution must reference every table the app binds.** After one import, every
  table the solution shipped worked and every table it omitted (18 of 31) raised `AppDataSourceError`
  "your data source is not configured correctly", with no network request issued; `App.OnStart` died
  at the admin lookup. The correlation was exact, the mechanism unproven. Gate the **pack** on "every
  bound table is in the solution" - it is an offline, one-second check (`manifest-caches.md`).
- **Resolve the two with a reference that carries no schema.** Add shared tables to the consumer
  solution with `AddSolutionComponent` and `DoNotIncludeSubcomponents = true`; remove ones it already
  carries with `RemoveSolutionComponent` (which unlinks, never deletes data). The payloads are not
  symmetric - see `dataverse-web-api.md`, section 10.
- **Check membership after you build lookups.** A lookup created into a shared table adds that table
  to your solution with every subcomponent (behavior 0), silently. Query `solutioncomponents` for
  `componenttype 1` and `rootcomponentbehavior`, and expect 1 for every table you do not own.

Around any import that touches shared tables:

- **Snapshot every shared table's metadata before and after, and diff.** One flat line per column
  (type, required level, create/update validity, every facet) so any change shows; expect zero
  differences. Prove the differ first by planting a changed column, a removed column and an entity
  change.
- **Create a column in its OWNER's solution.** A consumer adding a column to a shared table must send
  the owning solution's unique name (`MSCRM.SolutionUniqueName`), or the consumer's next export
  carries shared schema. Make the solution name a parameter of provisioning scripts, not a constant.
- **Import the shared solution first.** Dependent solutions that take lookups into it fail on missing
  dependencies otherwise. Encode the order in the deploy scripts.
- **Audit every solution for tables it ships but does not own**, and treat a hit as a finding.

## 9. Retiring tables, relationships, columns and choice values

Because imports never remove (section 3), every retirement is an explicit operation with its own
traps.

**Tables.** Deleting a referenced table is refused - "cannot be deleted because it is referenced by
N other components" - and the refusal can arrive after other deletes in the same run have already
gone through. Deleting the referenced table does not cascade the relationships on the surviving
tables. Drop stale relationships first, then tables, while empty, leaf-first.

**Relationship husks after a retirement.** One retired table left 15 relationships across 10 tables,
and 7 relationship schema names were claimed twice (bound to the live target and to the dead table).
Symptoms:

- An insert setting two such lookups failed every time with `Sql error ... Sql Number: 208`, while
  either lookup alone worked. Every audit was green; the fault is below the metadata layer.
- Dismissible OData banners on every app load naming the retired table. Those load errors are
  findings, not noise.

Find them by listing `RelationshipDefinitions/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata?$select=SchemaName,ReferencingEntity,ReferencingAttribute,ReferencedEntity`,
grouping by `SchemaName`, and flagging duplicates and any `ReferencedEntity` whose `EntityDefinitions`
lookup fails; read the per-table `ManyToOneRelationships` too and prefer whichever a live insert
agrees with. Before deleting a husk, **capture the column's values**: one delete dropped the shared
physical column, which then had to be recreated and restored. Re-measure over a period first -
part of what looks like a husk can be eventually-consistent nodes that clear on their own
(`manifest-caches.md`, section 9) - and check sibling apps for the same husks.

**Columns.** Before deleting one:

1. Search the **published** app, not the repo: download and unpack it, search recursively (pac puts
   the YAML three levels down, `<out>/Other/Src/`), and **require at least one file read**, or the
   gate passes vacuously.
2. Ask Dataverse what depends on it (`RetrieveDependenciesForDelete`, `dataverse-web-api.md`).
   Auto-generated "Information" forms reference columns and block the delete.
3. Re-read live usage counts just before, and delete only on explicit sign-off.

Move a column in this order: add the new one -> refresh the data source in Studio -> move the UI ->
publish -> drop the old. Dropping a column still referenced breaks the whole canvas compile.

**Choice values.** Dataverse has no "inactive" flag for an option.

- **To retire a member that history uses, keep it.** Keep label and value, write RETIRED in its
  Description, move it to the end of the order, exclude it from **entry** pickers by member
  reference, keep it in **filter** pickers so tagged records stay findable. Relabelling it
  "(retired)" rewrites what existing records say; deleting it blanks every row that holds it.
- **To narrow a set, delete in this order:** remap the rows holding the value (with the mapping read
  from the source data, not chosen); refuse to delete while any row still holds it; update solution
  source so an additive import does not bring it back; delete; **publish**; verify with retries.
  `DeleteOptionValue` returns success while the definition keeps serving the old value until a
  publish, so a verify run before publishing "fails" correctly. After deletion a write of the old
  integer is refused - tell every consumer.
- A replacement meaning is a **new** member; rename in place only when the meaning is unchanged.

## 10. Choosing column types and table shapes

Decide these while tables are empty (section 4).

**Yes/No added to a table with rows reads NULL, not its default.** `DefaultValue` applies only to
rows created afterwards. Measured on three tables (2,282, 24 and 1 existing rows: every one null). `= true` hides every old row - one filter dropped the only existing
administrator from an admin list - and `= false` hides them too. Filter `<> false` when "not
explicitly excluded" is meant; OData `ne false` returns the nulls and still delegates (measured).
Backfilling instead moves `modifiedon` on every row and fires every update flow on the table
(`data-migration.md`). Where the data cannot say which rows qualify, leave the third state and show
"Not set" rather than inventing Yes or No.

**One concept, one global choice.** A choice column with the same name and meaning on two tables is
two independent **local** option sets. They drift: one accepted 2 values, the other 4, and nothing
objected until a migration copied a value across and stopped half way with
`0x8004431a ... is outside the valid range. Accepted Values: ...`. The app's fallback then read the
uncopyable value as blank, and blank was treated as a default that decided whether approval was
required. Use one global choice per concept, treat blank as **unknown**, and audit agreement between
copies. Give a global choice a display name **no column already uses** - Power Fx names members
through it (`'Discount Applies To'.Everyone`), and a collision makes the enum ambiguous.

**A custom table must not share a display name with a system table.** A table displayed as "Team"
or "Teams" collides with the system Teams table once both are in a canvas app: the data source gets
a suffixed name and formulas bind to the wrong one. Qualify the name ("Tracker Team", "Work Team")
before the first app binds to it; renaming afterwards touches every formula that reads it.

**Value sets that carry metadata are tables.** A set with sort order, a kind, or an active flag
(scenario, geography) is better as a table with a lookup: it can be retired by flag and ordered by
column, and it avoids the two option-set caches in `manifest-caches.md` (that last benefit is
inferred).

**Multi-select choices are a poor fit for canvas apps** - neither delegable nor pleasant to filter in
Power Fx. For "which of N apps does this admin cover", N nullable Yes/No columns were additive and
filterable; a junction table is more extensible. Likewise a **manual N:N junction** (two required
lookups) keeps canvas filters delegable and edits a plain `Patch`/`RemoveIf`, where a native N:N
does not.

**Dates.** A date-only column needs **both** `Format = DateOnly` and `DateTimeBehavior = DateOnly`;
with the format alone the value is a UTC instant that shifts a day for users east of the org's
time zone. Conversely a moment ("approved at") must not be Date Only: it reads as midnight, and one
flow comparing it with `ticks(modifiedon)` decided every record had been edited after approval and
mailed a false "your record was changed". Date-only values reject a time part on write and travel as
`Edm.Date`. If an event column was created Date Only, take the moment from a log row's `createdon`.

**Amounts.** For a single-currency solution, Decimal avoids Money's transaction currency, exchange
rate and `_base` shadow columns (a design choice in one project, not a defect). With Money, every
display-name rename must cover the `_base` twin too, and its update may be refused. Set
`MinValue`/`MaxValue`: a Decimal's default range is roughly plus or minus 100 billion.

**Store what was true, derive what is relative.**

- A **snapshot** column freezes a value at the transaction: make it **text**, not a lookup or a
  choice bound to a live set someone can later edit.
- A **time-relative or derived flag** ("is current week", "is a manager") is right the day it is
  written and wrong afterwards; reports and flows reading Dataverse directly keep getting the wrong
  answer. Derive at run time and drop the column.
- A **rollup column** recalculates on a background schedule, so a total read straight after an edit
  is stale, and it cannot filter to a period the user picks. Write totals in the same write path and
  audit that every path maintains them, or use read-model tables (`data-migration.md`, section 8).
- A **current-value boolean that defines past scope** ("is an approver") rewrites history
  when edited in place. Model it as dated periods (section 14).
- **Do not mix grains in one table.** Annual and per-period rows together make every rollup
  double-count. When a column's meaning changes, mint a new column: relabelling "Monthly Cost" as
  "Annual Cost" leaves a logical name that lies forever.

**Denormalized columns are contracts.** If delegation forced a copy (a parent number on a child, an
email on a role row, a status rank, a "number - name" label for a large picker, a `|A|B|` membership
string), every create must set it and every update to the source must refresh it - including
**importers, migrations, admin forms and the model-driven app**, which bypass canvas logic. One roster
importer wrote only the child rows, so a flag copied onto the person was set for 1 of 158 people.
Make the backfill re-runnable: a non-zero repair count outside a migration means some writer is
creating rows without the copy. Audit it from source (`audits.md`).

**Define a business rule once and store it.** Two parts of one app defined "active" from two
different status columns; a record satisfied one and not the other, so it appeared in some totals
and not in the ones beside them. Store one `IsActive` computed by one rule, mirror it onto children
so loads filter on a plain delegable boolean, and have the save path, backfill and rebuild scripts
all compute it the same way.

**Lifecycle flags.** Canvas queries return deactivated (`statecode` inactive) rows unless every query
filters on status, so admin-maintained reference tables usually want their own Active flag that
pickers filter on (default Yes). To hide shared reference rows from one app's pickers, add a nullable
"relevant to <app>" column rather than reusing a shared lifecycle flag other apps read.

Implement Deactivate/Restore by patching the built-in status instead of calling `Remove()`:
`Patch(app_Orders, rec, {Status: 'Status (app_Orders)'.Inactive})`. Every table already has it (no
schema change), and it keeps "removed from use" separate from a business Active flag. Patching the
state alone normally lets the platform default the status reason, but some tables reject that and
need the matching `'Status Reason'` too - test one record per table after publishing. Once the "hide
inactive" rule exists, grep **every** reference to the table, not just pickers and galleries: totals,
tiles, rollups and `ForAll(app_Orders As r, ...)` forms. One app's first sweep used a regex that
matched only `Filter(app_Orders,` and still leaked deactivated rows from 17 sites, then 7 more,
including a financial rollup.

**Identity columns.** Email is a weak key: it changes, is recycled, or is absent, and it is not what
sharing, `GrantAccess` or flow ownership key on. Give a person table a nullable lookup to `systemuser`
(RemoveLink on delete, NoCascade on assign and share), keep email as the fallback for people without
accounts, and refuse two person rows pointing at one user. Power Fx `User()` gives Email, FullName and
Image, so the canvas "who am I" lookup usually stays on email; `User().EntraObjectId` exists in
current Power Fx and is more robust - unverified in these projects.

**Change logs.** A log the canvas app writes sees only the app; the maker portal, scripts, imports
and other clients leave no trace. A Dataverse-triggered flow sees every writer; native Dataverse
auditing may be enough. Keep owner, actor and "on behalf of" as separate lookups with name snapshots
beside them, and use `createdon` - which no app can write - as the event time.

**Who sprints: a team of one rather than a second owner type.** A tracker where sprints belong to
teams, people sprint alone too, and one person works in several teams used three decisions:

- **Every sprint has a team; an individual is a team of one** (a Team Type choice: Team or
  Individual). Boards, capacity, velocity and reports then have one owner shape, where a sprint owned
  by "team or person" would split every query and chart in two.
- **Membership is its own table** (team, person, role, allocation %, from and until dates, active),
  so one person can be 60% in one team and 40% in their individual team, and history survives a move.
  The app enforces what the schema cannot: one active membership per person per team, exactly one
  member in an individual team (section 13).
- **Project is optional on work items.** Durable teams work across many projects or none (run work).
  A display key falls back to the team's key when there is no project (`TEAM-1015`); with a global
  autonumber the number alone identifies the item, so a link typed with either prefix resolves.

## 11. Schema hygiene that only bites in the app

None are visible in the maker portal; all surface the first time a formula reaches the column.

- **A primary NAME column must not share a display name with the primary KEY.** If both display as
  e.g. *Request*, one project found both **unreachable** from Power Fx; another reached them through
  the disambiguated form `'Request (app_name)'` / `'Request (app_requestid)'`. Avoid the collision;
  treat the disambiguated form as the escape hatch for an inherited table. The import error names the
  entity, not the attribute.
- **Why it keeps recurring:** the table creator derives the key's display name from the table name,
  so naming the name column after the table - the natural choice - collides every time. One portfolio
  hit it six times. Call the name column "<Thing> Name" at creation; a display-name-only fix while the
  table is empty needs no migration.
- **No two columns on a table may share a display name**, for the same reason. A custom `Status`
  column forces the built-in to `'Status (statecode)'`, and plain `Status` silently binds the custom
  one.
- **Reserved companions.** Dataverse creates a virtual `<attribute>name` column for every lookup and
  picklist. Declaring a real column `app_licensename` beside lookup `app_license` fails with "An
  attribute with the specified name ... already exists", which never mentions the lookup. Likewise a
  custom `<prefix>_<noun>Id` collides with the table's reserved `<entity>id` ("column name specified
  more than once"): name code columns `...Code`. A "does this column exist" check must ignore the
  companions (`AttributeOf` set, `IsValidForCreate` false).
- **Create lookups with an all-lower-case SchemaName.** The navigation property takes the
  SchemaName's casing; lower case makes it equal the logical name and removes the whole casing-drift
  class (`manifest-caches.md`, section 7). Verify the navigation property after creating. Flows that
  read the raw `_<lookup>_value` keep working when casing drifts, so "the flows still work" is not
  evidence the lookup is healthy.
- **Fixing a wrongly cased lookup is delete and recreate**, because SchemaName is immutable:
  (1) snapshot every row's value; (2) delete the relationship, which drops the column; (3) recreate
  it with the intended casing; (4) write the values back by logical name and verify row by row.
  Expect eventual consistency: the recreate may be refused ("NavigationPropertyName ... is not
  unique") and the read-back may say the attribute does not exist. Retry rather than stack
  operations.
- **`<MaxLength>` and `<Length>` are paired**, `Length` being twice `MaxLength`. Setting one alone
  imports cleanly and truncates at a length nobody chose. A value over a text column's max length
  (`0x80044331`) rejects the **whole** create or update, not just that field.
- **The primary name column is marked only by a `PrimaryName` token in `<DisplayMask>`**. Omit it and
  the import fails with "PrimaryName attribute not found for Entity" - naming the entity, reading like
  a structural fault.
- **A date inside a record name is ISO** (`yyyy-mm-dd`): primary names are what maker-portal views
  sort on, as text. Dates shown to people use an unambiguous form ("30 Sep 2024").
- **Form and saved-query (view) GUIDs are unique across the organisation**, not per entity. A form
  copied from another entity dies with SQL error **2627** (duplicate key), naming no table or column.
  Regenerate both when cloning an entity.
- **`IsSecured` lives in `Entity.xml`.** It could not be set by a Web API PATCH, and a value set any
  other way is reverted by the next import (`security-and-access.md`, section 8).
- **A display-name rename is a breaking change for every canvas consumer**, because formulas bind by
  display name - one rename touched about 70 bindings. When another app reads a shared column, record
  the display name and value format as part of the contract (`manifest-caches.md`).
- **Do schema before screens**, and get types right while tables are empty. Column Descriptions show
  in model-driven forms; put business notes that are labels, not rules, there.

## 12. Relationship behaviour is a design decision

Decide delete (and share and assign) behaviour per link, and document it per table: a delete is
often more than one row.

| Link | Behaviour | Why |
|---|---|---|
| Header to its own lines and comments | **Cascade** | RemoveLink leaves children unreachable but still summed by anything reading the child table |
| Financial fact to a reference row (a time entry to its person or period) | **Restrict** | RemoveLink silently blanks the link and leaves a row that still adds up, with no person on it |
| History or audit row to its subject (changed by, approver) | **RemoveLink**, plus a **name snapshot** text column | History must never make a roster row undeletable, and must stay readable after the target goes |
| Person row to `systemuser` | RemoveLink, NoCascade on assign and share | A departed user must not make the person undeletable |

- **Restrict into a shared table stops every app deleting those rows** - which is why shared rows are
  deactivated, not deleted. Record it in the shared change log, and count inbound Restrict links
  before planning any delete of a shared row.
- **Sharing a parent does not share its children** unless the relationship's share cascade says so.
- Audit and log tables should denormalize their subject (whose record, which week), so the trail
  survives the record's deletion.

## 13. Rules the schema cannot hold

App-only rules hold until another route writes: a flow, an import, a second session, a retried
submit, the maker portal. Put what you can in the table:

- **Ranges**: column `MinValue`/`MaxValue`.
- **Uniqueness**: an **alternate key** (one row per person per week). Create it over the Web API -
  hand-authored `<EntityKeys>` were never proven, and a wrong guess fails the import naming the whole
  entity - and wait for its index to reach **Active**; a Pending key enforces nothing, and the index
  fails to build if duplicates already exist (`dataverse-web-api.md`, section 9). Prove it with a
  real duplicate and read the key's own error.
- **Ownership of children**: Cascade (section 12).

For the rest - "nobody approves their own work", "one rate per period", "blank approver means the
leader", non-overlapping ranges - document the rule beside the table, enforce it on **every** write
path with the identical guard, and audit live rows, because each was broken by seeded data at least
once (`audits.md`).

## 14. Effective-dated tables

Rates, assignments, delegations and approvers change over time; a row per window, with Effective
From / Effective To, keeps the past answerable. A correction to a current row rewrites what past
records were worth, so write new effective rows rather than editing history unless you mean to.

**Dataverse cannot enforce non-overlapping ranges** - no key spans a range. Options are a plug-in, a
flow on write, or the app as the single write path plus an audit. What worked:

- **The write path checks a proposed start against the subject's whole history**, not just the
  current row: a back-dated row can overlap a non-adjacent closed window.
- **Closing the previous window is a second, deliberate action**, never a side effect of saving, and
  overlaps are never auto-corrected. A change on the same day a window opened is a correction to patch
  in place; closing at `Today() - 1` produces an end before the start.
- **Close-then-open is two writes and not atomic.** If the second fails, re-open the closed row before
  reporting, or the subject has no current row while the app says "nothing was written".
- **Consumers refuse** when zero or more than one row covers the date, rather than picking one.

**Get the grain right.** Every reader filters on **every** key column. A rate lookup that omitted the
rate *type* found two rows for 80 of 96 people, so its "exactly one or refuse" rule would have failed
every approval from day one. The grain differs per table (per person; per person and rate type; per
role and applies-to). Measure matches per key on live data before switching on an exactly-one rule.
When the grain changes (a key column is added, say region on a per-year allocation), the duplicate
guard and the save path must key on the **complete new key** - a guard still on the old key blocks
legitimate rows or lets real duplicates through. The migration that introduces the column must
count the rows that would collide under the new key and refuse to run if any do, rather than
merging them silently.

**Resolve against the business date, never `Today()`.** An approval screen tested a delegate's cover
against today instead of the period being approved, allowing lapsed cover and refusing valid future
cover. Every effective-dated lookup takes the date as a parameter.

**Snapshot at the transaction.** Stamp the resolved value (text) at submit or approval. A backfill
uses the value in force for the period worked - 16 people changed rate inside one backfill range -
and where no value exists leaves the snapshot blank and reports it, never filling from the current row.

**Audit live rows**, because portal, script and bulk writers bypass the form: no end before start,
at most one open window per subject, every active subject has one, the open window agrees with any
current-value flag, no overlaps or gaps, no orphans, no row missing Effective From. Compare windows
pairwise. Do not group on a nullable key: orphans all share the key `None`, and an audit that did
reported unrelated people's windows as overlaps.

**Reference calendars are effective-dated data too.** Generate a fiscal calendar deterministically
(4-4-5 weeks, Monday starts, where the 53rd week goes) and make the generator throw unless periods are
contiguous and aligned. Once an app can edit period dates, changing one period's end without the
next one's start leaves a gap or overlap for every consumer - guard the write, do not just warn. A
calendar that starts after the oldest row being loaded makes those rows invisible to every screen
filtering by period (`data-migration.md`).

## 15. Hand-authoring entity XML

Where the pieces live in unpacked source:

- Each table is `Entities/<Name>/Entity.xml` plus a `<RootComponent type="1">` in
  `Other/Solution.xml`.
- **Relationships live in `Other/Relationships/<ReferencedEntity>.xml`**, indexed in
  `Other/Relationships.xml`. The lookup attribute in `Entity.xml` carries **no target**; pack derives
  it from the relationship.
- The primary name column is marked only by the `PrimaryName` DisplayMask token (section 11).

**Clone, do not compose.** About 700 of an entity file's 750 lines are ownership-specific
boilerplate. A generator that works: clone a known-good, imported entity's `Entity.xml`; swap the
name everywhere; rebuild custom attributes from per-type templates lifted from live attributes
(pairing `Length` = 2 x `MaxLength`, adding the `PrimaryName` token); regenerate form and saved-query
GUIDs; refuse a spec with a `<lookup>name` clash; and **print** the relationship and root-component
lines rather than guessing them. Spike-import one table of each attribute type before generating
many. Keep one spec per table (`scripts/entity-specs/<table>.json`) with keys recording intent.

Many projects find it easier to create schema through the Web API and sync it back into source
(`dataverse-web-api.md`, section 4). If you do, write down that `solution/src` is a mirror of live,
run the sync after every schema change, and record that the repo cannot yet rebuild the environment.

## 16. Creating schema with `deploy-tables.py`

The bundled `scripts/deploy-tables.py` is section 4 of `dataverse-web-api.md` as one command. The
schema lives in the repo as a manifest (`tables.json`; the shape, with every column type, is in
`assets/tables.example.json`), and the tool makes the environment match it:

```bash
python scripts/deploy-tables.py --manifest tables.json --org https://<org>.crm.dynamics.com --plan
python scripts/deploy-tables.py --manifest tables.json --org https://<org>.crm.dynamics.com
```

**Plan first, every time.** `--plan` issues GET requests only and prints every publisher, solution,
table, column, choice option and lookup it would create, the shared tables it would turn into
references, and any conflict. Show the person the plan before the apply. Without `--plan` it runs,
in order: publisher, solution, tables (the primary name column inside the create), scalar columns,
appended choice options, lookups once every table exists, `PublishAllXml`, shared tables as
references, then a read-back. The token comes from `--token-env`, `--token-cmd` or the Azure CLI, as
for `check-drift.py`, and is never printed. The account needs System Customizer or System
Administrator.

What it holds to, and why:

- **Additive and idempotent.** It creates what is missing and skips what exists, so a re-run is a
  no-op and a run that stopped part-way is finished by running it again. It never renames, retypes
  or deletes (section 4 says why that cannot be done in place anyway). A column that exists with
  another type, a lookup with another target, or a publisher with another prefix is a **conflict**:
  the run refuses before writing anything, and the remedy is a change to the manifest.
- **Choice options are append-only.** Option N of a choice gets the value
  `optionValuePrefix x 10000 + N`, so a new option goes at the **end** of its list; never reorder or
  remove options in the manifest. A live label that differs from the manifest is reported, never
  changed - relabel deliberately (`dataverse-web-api.md`, section 8).
- **Lookup schema names must be lower case.** The manifest is refused otherwise, because the
  navigation property takes the schema name's casing (section 11).
- **Shared tables become references.** A lookup created with the solution header pulls a table
  owned by another solution into yours with its whole schema (section 8). After the lookups, every
  table matching the manifest's `sharedTables` patterns, and every lookup target that does not carry
  the publisher prefix, is removed and added back with `DoNotIncludeSubcomponents`, then checked for
  `rootcomponentbehavior` 1.
- **Manifest errors are refused before any call** (exit 2): an unknown type, a name without the
  prefix, duplicate tables, columns or display names, a column on a reserved `<lookup>name` or
  `<table>id`, a mixed-case lookup, an empty choice, a `sharedTables` pattern that matches the
  manifest's own table.

**What a green run proves**, and what it does not. Exit 0 means every table, column (with its type),
choice option and lookup target in the manifest was read back live after the apply, and every shared
table in the solution is a reference. Exit 1 names each thing that is missing or wrong. It does not
prove a canvas app can see the new columns - the app's cached copy must be refreshed
(`manifest-caches.md`; `check-drift.py` says whether it is stale) - and it does not prove anyone can
read the tables.

**Security roles are deliberately not in it.** Roles must stay out of the solution (section 5), the
agent's safety layer correctly refuses to create or assign them, and granting access is a separate,
reviewed step proved by impersonation. Build them with `ReplacePrivilegesRole` as described in
`security-and-access.md` (sections 1 to 4), and grant every table the manifest creates.

Not covered by the tool, by design: global choices, alternate keys, many-to-many relationships,
column security and forms. Create those by script as in `dataverse-web-api.md`, after the tool has
run.
