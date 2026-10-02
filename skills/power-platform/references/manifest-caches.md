# The app manifest caches: why the published app disagrees with Dataverse

## Contents

1. The one idea
2. The signature - recognise it in a minute
3. Cache 1: option-set (choice) members, stored twice - and Studio's own copy
4. Cache 2: column types
5. Cache 3: entity set names
6. Cache 4: the column list - a new or renamed column does not exist yet
7. Cache 5: lookup navigation properties and schema-name casing
8. The data-source list exists twice; only one runs
9. Studio's Data pane: add, remove, refresh, and what they really do
10. Environment-side staleness: half the nodes serve an old schema
11. What to put in the ship script

---

## 1. The one idea

A canvas app does not look Dataverse metadata up at run time. When a data source is added, the
app freezes a copy of the table's metadata into its manifest (`References/DataSources.json` inside
the `.msapp`, plus `Properties.json` and the solution's canvas-app metadata). **The published
player resolves against that frozen copy.** Studio, Studio Preview, the authoring server's compile
and most probes resolve against **live** metadata.

So the same formula can compile clean, work perfectly in Preview, pass every source audit - and
fail in the published app for every user. Nothing you click in normal use reliably refreshes these
caches: not a solution import, not `pac canvas download`, usually not the Data pane's own Refresh.

The scale is worth knowing: each table entry's `TableDefinition` is a JSON **string** of roughly
190 KB of embedded entity metadata, with further JSON strings nested inside it. Nobody reads these
by eye; tools parse them level by level.

## 2. The signature

- **It works in Studio Preview and fails in the published app.** That split IS the diagnosis -
  suspect manifest drift before anything else. (Preview reads live metadata, so it hides exactly
  this class of fault.)
- **A button does nothing** - no dialog, no error, no write. A read against a stale source returns
  an error, the error propagates into a global, and a behaviour formula that touches it abandons
  every statement after it, silently (see `power-fx-and-pa-yaml.md`).
- **Lists come back empty for a table that has rows.** Every read of the affected source fails,
  which presents as missing data rather than a binding fault.
- **The app's own "we cannot identify you" message renders with an empty value in it.** Not an
  identity fault: a formula above the identity `Set()` in `App.OnStart` threw, and a throw in
  `OnStart` abandons everything after it.
- **Behaviour changed with no commit.** After a routine Data-pane refresh re-snapshotted a schema,
  buttons lost their text with no repo change. When a regression has no commit, suspect the last
  refresh.
- **A clean compile says nothing**, because the authoring server reads live metadata too.

**Read the error before blaming a cache.** A stale or missing column gives an error that **names the
column**. A per-table option-set type mismatch (copying one table's Yes/No into another's record)
names **only the control and property**. One project spent a day on the wrong suspect because a
recently extended source looked like the obvious culprit; its cached `DataSources.json` was
correct. Open the cache and check before you call it stale.

The meta-lesson that cost more than any single bug: a plausible mechanism that explains every
symptom is not a diagnosis. **Change only the thing you believe is the cause, ship that alone, and
see whether the failure moves.** Bisecting takes one cycle; reasoning about it can take five, and a
correct theory fixed incompletely gets wrongly retracted. One dead-source incident went through
four theories - metadata cache, a data source inside `ForAll`, `MaxGetRowsCount`, `Refresh()`
faulting the source - each built, shipped, disproved and reverted (including an audit written on
the false premise) before the real cause (section 8) was found days later. Revert every non-fix and
every diagnostic label you shipped, and delete an audit whose premise is disproved: a confident
wrong rule in an audit is worse than no audit.

## 3. Option-set members are cached in TWO places, and the app reads the second

Add members to a global choice and publish: every formula naming them compiles, and the published
app then fails for every user. Both caches live in `DataSources.json`:

| | Where | Shape |
|---|---|---|
| 1 | the `OptionSetInfo` entry for the choice | `OptionSetInfoNameMapping`: flat `{value: label}` |
| 2 | the owning table's `NativeCDSDataSourceInfo` entry | `TableDefinition` -> `PicklistOptionSetAttribute` -> `value[].OptionSet.Options` |

**The published app resolves against the second.** Fixing only the first reproduces the outage.
In (2), `TableDefinition` is a JSON **string** and `PicklistOptionSetAttribute` inside it is
**another** JSON string: parse and re-serialise each level, or the loader sees nothing.

Neither a solution import nor Studio's data-source Refresh updates them (verified with both Save
paths against a fresh download). **Reconcile them at build time**, in the ship script:

- read live option sets from the Web API (`GlobalOptionSetDefinitions`, and
  `EntityDefinitions(...)/Attributes/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$expand=OptionSet,GlobalOptionSet`);
  local option-set entries are named `<entity>_<column>`, so group them by entity and make one
  metadata call per table;
- reconcile only member-extensible kinds (Picklist). `statecode`/`statuscode` are State/Status
  metadata and Yes/No is Boolean - expect them to read "unverifiable" and leave them alone;
- rewrite both caches; print what changed;
- **add and relabel, never remove.** A lingering cached member breaks nothing; deleting from a blob
  whose contract you do not fully understand can;
- **never blank a mapping you could not verify** - an empty mapping breaks every formula naming
  that set, which is worse than staleness;
- **clone a new option from one already in the blob** rather than constructing one, so the shape
  is whatever the producer actually writes;
- rewrite the archive preserving every other entry byte-for-byte under its original name, read it
  back, and refuse if a correction did not survive;
- gate the ship by grepping the finished artifact for the new member's label in **both** caches.

Capture any subprocess output as bytes and decode UTF-8 yourself: text mode decodes with the console
code page and dies on the first non-Latin-1 label, failing the reconcile for a reason that names an
encoding.

### Studio has its own copy of global choices

After **renaming** option-set labels (or a column), formulas that coerce to text
(`(app_status & "") = "Forecast"`) recovered once the owning source was refreshed, but member
references (`app_measure = 'Lock Measure'.Forecast`) kept failing with "Name isn't valid" through
two more refreshes. A data-source refresh updates that source's columns; it does not reload global
choice definitions, and a page refresh is not enough either. Sequence that worked:

1. Rename in Dataverse.
2. Refresh every table carrying the column, and the table that owns the choice.
3. **Close the browser tab completely and reopen Studio.**
4. Compile.

Closing the tab discards any held push - the source is in git, recompile. Expect the published
app's caches to need the same treatment as any other choice change.

Member reference and text comparison fail in opposite directions: a member reference breaks
**loudly at compile** when a label is renamed; a text comparison breaks **silently at run time**.
Use member references for anything that gates (a lock, a permission); keep a list of every
text-matched label and check it before renaming a member.

**Choice display-name collisions make member references ambiguous.** Power Fx names a choice's
members through the option set's display name (`'Applies To'.Everyone`). If another bound table
already has a column with that display name, the reference becomes ambiguous. Give a new global
option set a distinctive display name, and check display names across every bound table first.
(Modelling a value set that carries sort order or metadata as a lookup table instead of a choice
also sidesteps both option-set caches.)

## 4. Column types are cached, and no click path refreshes them

`TableDefinition -> EntityMetadata.Attributes` records each column's type. Convert two text columns
to choices: Dataverse is perfect, the app never sees it - Data pane Refresh, a Studio reload, even
**removing and re-adding the data source** left the cache unchanged in one measured case. The tell
that it is stale rather than wrong: the cache still listed a column the migration had deleted.

At run time the cache says `String`, the column is a `Picklist`, Dataverse returns the integer, and
`Col & ""` yields `"105000220"` instead of the label. Every label comparison fails; in that case,
message dialogs rendered with **no buttons**, with nothing logged.

**Rule: treat a column's type as immutable once a canvas app binds it.** Get it right before the
data source is added. If a change is unavoidable, reverting the schema is usually cheaper than
teaching the reconciler to rewrite attribute types. (The project above reverted to text and guarded
the values with allow-list validation in its loader instead.)

## 5. Entity set names are cached in three places

The app freezes each table's OData entity set name into:

1. `References/DataSources.json` -> `EntitySetName`
2. the same entry's `TableDefinition` string
3. `Properties.json` -> `LocalDatabaseReferences` (`{entitySetName, logicalName}`)

- and Studio can write a fourth, outside the `.msapp` (section 8).

Dataverse pluralises irregularly (a `y`-ending name has come out as `-ies` in one build and `-ys` in
another; some names gain a word), and dropping and recreating a table can **change** the name under a
bound app. Compile passes (live), source audits pass (`.pa.yaml`
names the data source, never the set), and the app fails at run time with
`Resource not found for the segment '<name>'` - which surfaces as a dead button. **Reconcile set
names against live on every ship and assert it on the finished artifact.** A ship script that
proves its changes by scanning `Src/` proves nothing about a manifest-level fix.

How one reconciler does it safely, given the name sits inside three levels of escaped JSON:

- live names come from one call: `EntityDefinitions?$select=LogicalName,EntitySetName`;
- a **bounded byte-level token replace** with identifier lookarounds,
  `(?<![A-Za-z0-9_])old(?![A-Za-z0-9_])`, applied to **every** entry in the archive;
- **refuse outright if the stale name is a prefix of any other live set name** - the bounded
  replace is safe only while the token is unambiguous;
- read back and assert zero occurrences of the old name anywhere.

## 6. The column list: a new column does not exist until you re-add the source

`TableDefinition -> EntityMetadata.Attributes` is the column list **as of when the source was
bound**. Add a column in the morning, ship a formula using it the same day, and the published app
dies silently - not only that formula: **every read of that table** returned nothing in the
measured case, so it looked like missing data.

Every gate passed, each answering a different question: compile (live), Studio Preview (live), the
marker check (formula is in `Src`), `LoadFromYaml` and the build stamp, every audit, and a
data-source probe (asks the authoring server). Only the published app failed.

Import and download do not refresh it, and the Data pane Refresh usually does not. (In one case a
Refresh did rebind a new column for one source while other evidence says it does not; conditions
unknown. Never trust it - verify by downloading the published app.) The cure:

1. In Studio: **Remove** the data source, **Add data** it back (section 9 for what that click path
   really does).
2. **Save and Publish from Studio** (a save alone never reaches the shipping path, because
   `pac canvas download` returns the PUBLISHED app).
3. Confirm the new columns in a fresh download.
4. Re-ship from git, and confirm `LoadFromYaml` is true again (publishing from Studio flipped it).

A freshly added source can also snapshot **incomplete** metadata: a junction table's first snapshot
lacked one lookup column, and a Studio refresh fixed it. Check a new source's columns before
building on it.

**Guard it by detecting, not repairing.** There is no cached entry to fix and hand-forging entity
metadata is the "read the file instead of asking the server" habit that causes worse incidents.
A column-cache check that stays honest:

- compare live column **display** names
  (`EntityDefinitions(LogicalName='app_order')/Attributes?$select=LogicalName,DisplayName,AttributeType,IsValidForRead`)
  with the display names cached in `TableDefinition -> EntityMetadata.Attributes`;
- skip system columns (created, modified, owning, owner, overridden, import, versionnumber,
  statecode, ...) and `IsValidForRead = false`;
- a missing name is **blocking only if a formula references it** - quoted (`'Order Total'`) or as
  a bare identifier; a new column nothing references is information, not failure;
- exit with a distinct "could not run" code (not a pass) when live metadata was unreachable for
  every table;
- print the cure (remove, add, save, publish, re-ship) with the finding.

**The rule this makes explicit: a schema change and the canvas change that depends on it cannot
ship in one step.** The schema lands, the source is re-added and published in Studio, then the app
that uses it ships. Budget that round trip into any work that adds a column. Do not stage UI that
references an unbound column into `Src` meanwhile - the whole-app compile fails and blocks every
other push. Keep such edits as a pre-staged script that asserts its anchors and applies after the
refresh. The order for moving a column: add -> refresh the source -> move the UI -> publish ->
drop; dropping a column still referenced breaks the compile.

### A display-name rename is a breaking change

Power Fx binds columns by **display** name. Rename one and every formula using it breaks at the next
refresh. Order: rename the metadata -> refresh the source in Studio -> immediately rewrite every
reference; errors everywhere in between are expected, so do not publish in that window. One rename
touched about 70 bindings, 56 display strings and 36 collection fields. When another app reads the
column, its display name (and the text format of any value it parses, such as a month label) is now
part of a contract - record the dependency so the column's owner knows. Renaming a column or
choice also needs the full tab close in section 3 before the new name binds.

## 7. Lookups are keyed by schema name, and a rebuilt lookup may change its casing

A formula names a column by display name; for a lookup, the field in the record type is keyed by
the relationship's **navigation property**, which takes the attribute's **schema** name, casing
included. Rebuild a lookup in the maker portal and Dataverse may assign `app_Approver` where your
solution source says `app_approver`:

```
The specified column 'Approver' does not exist.
The column with the most similar name is 'Approver'.
```

The column names itself as its own nearest match. It is unreadable and unwritable, and a `Patch`
that sets it fails to bind, taking out the whole formula. The build reads live (self-consistent),
audits read source (self-consistent), and a manifest-vs-live reconciler matches (live is what
drifted). **Compare LIVE against SOLUTION SOURCE** - the one pair nothing else compares - and be
type-aware: a drifted lookup is a fault; a scalar's casing is cosmetic and flagging it just makes the
suite permanently red.

- **Working flows are not evidence the lookup is healthy.** The logical name did not change, so
  every flow reading the raw `_app_approver_value` kept working; only the canvas connector,
  `$expand` and `@odata.bind` broke.
- **A reconciler for the cached copy cannot be a text replace.** In one table's blob the drifted
  name appeared seven times and only two were wrong: the attribute's `SchemaName` and the
  relationship's `ReferencingEntityNavigationPropertyName`. `LogicalName`, `AttributeOf`,
  `ReferencingAttribute` and the relationship names must stay lower case. Parse `TableDefinition`
  -> `EntityMetadata`, rewrite those two fields matched on the attribute's logical name (which never
  changes), skip platform lookups (`createdby`, `ownerid`, `owningbusinessunit`, ...), and trigger
  only on "cached differs from live", never on "case differs" - many lookups legitimately have
  camel-cased navigation properties. Prove a re-run is a no-op.
- **Prevent it:** create lookups with an all-lower-case SchemaName so the navigation property
  equals the logical name (`dataverse.md`).

**A re-targeted lookup that kept its old column name fails at run time.** After some lookups'
targets moved to a shared table, the published app raised
`Could not find a property named '<old>id' on type 'Microsoft.Dynamics.CRM.<table>'`. Compile was
clean and no audit caught it. After re-targeting a lookup, read the published app's console and
compare the navigation target in live metadata with the app's cached `TableDefinition`.

## 8. The data-source list exists twice, and only one of them runs

| File | Written by | Governs |
|---|---|---|
| `References/DataSources.json` inside the `.msapp` | the editor / `pac canvas pack` | what the app **binds**: compile, Studio Preview |
| `<DatabaseReferences>` (and `<CdsDependencies>`) in the solution's canvas-app metadata | the service, on publish | what the **published player initialises** at start |

Nothing keeps them in step and no tool warns. A source in the first and absent from the second is
**dead in the published app**. Its two symptoms, worth memorising because they separate a dead
source from a bad formula:

1. **No network request is issued at all** - the table never appears in the OData `$batch` trace,
   while another table on the same button does.
2. **`CountRows(Source)` errors** rather than returning 0. Bind a label to
   `If(CountRows(Source) = 0, "A", "B")`: both branches are text, so a **blank** label means the
   expression faulted - the fault is the source.

Both tells assume something reads the table. **A source the app only writes to has no visible
symptom**: a change-log table the app only created rows in was dead for days and recorded nothing,
and another dead source was dismissed as "it has no rows anyway" - dead and empty look identical.
After any import, query write-only tables for recent rows.

Re-adding the source in Studio "fixes" it because publishing from Studio rewrites the second list
as a side effect - and the fault returns on the next import built from a stale `solution/src`.
Every comparison made *inside* the `.msapp` shows a dead source and a working one identical field
for field; the file that disagrees is outside it. The fault was first written up as "a corrupt
data-source instance, invisible in every file, only fixable by re-adding in Studio". **When a
click path cures a fault no file explains, diff every artifact that click path writes** - including
solution-level canvas metadata - before concluding the cause is unobservable.

Where that metadata lives depends on how the solution was produced - getting it wrong means
finding nothing to repair:

- `pac solution unpack` (a `solution/src` tree): `CanvasApps/<name>.meta.xml`
- `pac solution export` (a zip): inline in `customizations.xml`, with only the `.msapp` under
  `CanvasApps/`

The exact shapes, so a repair can be written without guessing:

```
// <DatabaseReferences>
{"default.cds": {"dataSources": {"Orders": {"entitySetName": "app_orders", "logicalName": "app_order"}}}}
// <CdsDependencies>
{"cdsdependencies": [{"componenttype": 1, "logicalname": "app_order"}]}
```

**Compare by name AND by value.** After a source was removed and re-added in Studio, the solution's
copy kept the old entity set name under the same display name, so a names-only comparison called it
in step. **Studio's re-add can also write a bad entry**: twice it put a wrong one into
`<DatabaseReferences>` - once an irregular `-ies` plural the environment no longer served, once a
second entry keyed by the logical name. Run the reconcilers on the first ship after every Studio
data-source operation, and make the repair rewrite an entry whose metadata differs, not skip one
whose name already matches. The locator must **raise** when it cannot find the metadata file -
a repair that finds nothing to repair is silent.

**The repo copy drifts every time a source is added in Studio.** Nothing updates
`solution/src/CanvasApps/*.meta.xml`. In one project it fell behind live three times (22 vs 24,
then 24 vs 25); the next plain-packer import would have killed the newest sources, including the one
that decides who is an admin. The audit missed it because it preferred the live export. Ask both
questions - "is live right" and "is the repo right" - and compare the app's bound sources against
the **repo** copy always.

The solution's component list is a third list with the same failure shape: a table the app binds
but the solution does not carry imports unresolved (`canvas-shipping.md`, section 6).

**In every canvas project:**

1. Treat `References/DataSources.json` as the source of truth for what the app binds.
2. Reconcile `<DatabaseReferences>` and `<CdsDependencies>` to it **as part of the ship** (keep the
   existing order, append new sources, regenerate `CdsDependencies`), and refuse an artifact whose
   halves disagree (`inspect-artifact.py` reports the comparison).
3. Audit both questions: "does the solution ship the table" and "will the player initialise the
   source" have different answers.
4. When a data source is added to a canvas app, the canvas metadata in `solution/src` is part of
   that change. Nothing else will notice.

## 9. Studio's Data pane: add, remove, refresh, and what they really do

**Ask the server before believing the pane.** After an import Studio flagged 10+ sources with
"please try to delete and re-add the datasource", and Refresh did not clear the badges. Calling the
authoring server's `get_data_source_schema` for every source showed all 36 healthy (a broken one
returns no columns). Acting on the pane would have removed working sources; an earlier
remove-and-re-add of healthy sources had failed and cost a version restore. The pane is a
client-side cache: it clears on a full tab close and reopen, not a page refresh. Escalation order
for a client-cache fault: full browser close, an InPrivate window, clear site data, version restore.
Treat Remove as a destructive step that needs evidence. (`Connections.json` being `{}` is the
normal shape for Dataverse implicit connections, not a regression.)

The opposite case also exists: twice after an import, a **subset** of sources genuinely came up
with a broken cached schema. The probe names which; Remove-then-Add is the cure for those only.

**A source can be broken in its binding while every file looks right.** A directory picker over
`systemuser` showed "Error when trying to retrieve data from the network"; the raw OData query
worked, the cached column list matched live, and the network log showed no request for the table.
The binding carried an older connector shape (`ApiId: /systemuser`, `CdsActionInfo`) that no other
table had. Studio's **App checker, Runtime tab** named the failing `Control.Items` and said "delete
and re-add the data source"; the pane showed a red badge on that row; remove and re-add fixed it.
Instrument order when a control errors and no request leaves the browser: App checker Runtime, the
Data-pane badge, the network log, then the formula.

**The Add-data picker:**

- lists tables by display name - observed both ways: by the **singular** name in one build, and
  in a later one (2026-10) by the **plural** (collection) name only, where a search for "Order
  Line" found nothing and "Order" found "Order Lines". Search a stem of the name;
- **hides tables the app already binds**, so searching for one you have can surface a legacy table
  with the same display name;
- adding a second source whose name is taken creates `Orders_1`. Treat `_1` as the tell, confirm
  the logical name (hover the pane entry), and remove it before saving unless you meant it.
- when two tables share a display name and the app has neither, the picker lists both with nothing
  to tell them apart; the order followed the logical name (`aaa_person` before `bbb_person`). Add
  one, hover it in the Data pane to read the logical name, and remove it if it is the wrong one
  before adding the other.

Before adding an ambiguous name, query `EntityDefinitions?$select=LogicalName,DisplayCollectionName`
for collisions, and rename your own table while it is empty. When the `_1` source is deliberate (a
shared table beside a retiring local one during a migration), every formula and tool must expect it:
`Orders_1` is a strict superstring of `Orders`, so any audit resolving sources by substring must
break ties by longest match. A re-added source can also come back under a different name and break
every screen bound to the old one - check the name before pushing.

**Map app source names to logical names from the app itself, never from a hand list.** Names do
not follow one rule (`_1` suffixes, plurals that differ from the table, prefixes that differ
between layers). Each `DataSources.json` entry with `Type == "NativeCDSDataSourceInfo"` carries
both `Name` and `LogicalName`; read the map from a fresh download every run. A ported hand list once
still belonged to a third project.

**Remove has side effects:**

- **Removing a source that formulas still reference re-adds it immediately.** The pane never shows
  it gone. That automatic re-add IS the remove/re-add round trip; do not keep clicking Remove.
  Follow with Save, Publish, a fresh download showing the new columns, then re-ship from git.
- **Removing a source drops the option sets it brought in.** An accidentally added table from
  another app had dragged in seven option sets, which left with it. Expect the app's option-set
  list to change on a remove.
- **Removing one source can break another.** One source carried an option-set pointer to a choice
  it resolved through a second source; removing the second, "unused" source nulled the pointer and
  caused a regression (mechanism inferred). Check cross-source option-set references, and ask the
  server, before removing anything.
- In a shared environment, check every bound source against the app's own prefix plus the declared
  shared layer: an app can pick up a sibling app's table by accident in Add data.

**Other things the manifest holds that behave the same way:**

- **A Power Automate flow is a manifest entry like a data source.** A formula naming a flow the app
  has not added fails to bind and breaks the whole compile. Add the flow in Studio (it must live in
  the solution, not "My flows", or a solution-aware app cannot see it), save and publish, then ship
  the formula.
- **The data row limit is an app setting cached in `Properties.json`**:
  `DefaultConnectedDataSourceMaxGetRowsCount`. Anyone can change it in Studio without telling
  anyone, and it is "saved but not published" like any Studio change. Read it at audit time rather
  than assuming 2,000. If it cannot be read, fall back to the default of 500 - which over-reports -
  and say that you fell back. (The "500" in delegation warning text is generic boilerplate, not
  your app's limit.)

## 10. Environment-side staleness: half the nodes serve an old schema

Dataverse metadata is **eventually consistent** after a schema change. A verify run right after
adding or dropping an attribute can be wrong in both directions; retry verification rather than
reading once.

Worse, after a table is retired, ask the same question several times:

```
EntityDefinitions(LogicalName='<retired table>')?$select=LogicalName
```

One environment answered EXISTS four times and "does not exist" four times out of eight - part of
the front end was still serving the pre-retirement schema. Consequences:

- `RelationshipDefinitions` and a per-entity `ManyToOneRelationships` expand contradict each other,
  in both directions. The disagreement is the finding.
- It looks like it fixes itself (0/3, 4/8, 6/10, 12/12) and comes back.
- **It is per session.** A browser session sticks to one front-end node, so a stale node reads as
  permanently broken to one user and fine to the next. `globalmetadataversion` was identical on
  succeeding and failing responses, so it does not track the divergence.
- There is nothing to delete. A delete aimed at the "husk" fails on the healthy nodes, and on a
  lookup it can take the shared **column** with it. Capture the column's values before any such
  delete.
- Publish All Customizations does not clear it.

**Husk relationships can claim a live lookup's name.** After one retirement, 15 relationships across
10 tables still pointed at the dead table and 7 relationship schema names were claimed twice (bound
to the live target and to the dead one). Creating a row that set two such lookups failed with
`Sql error ... Sql Number: 208` every time while either lookup alone worked - with every audit
green, because the fault is below the metadata layer. It surfaced earlier as dismissible OData
banners on app load naming the retired table; **load errors like that are findings, not noise**.
The detailed detection query and clean-up belong to `dataverse.md`; re-measure over a period
before deleting, since in one case part of it was propagation that cleared on its own.

**What users see:** intermittently, and only from `OnVisible`, a screen opens with nothing selected,
every control disabled and a generic fallback message, because the variable holding the reason was
never set. Anything that re-runs the same reads fixes it - which makes it look like a fluke.

**Working around it:**

- **Read the related row from its own table by key instead of through the navigation property.**
  One app replaced `Week.'Period'` traversals with a lookup of the period table by date range,
  resolved once per week change, and wrote that record - it never crosses the bad relationship.
  Count the traversals first (one app had 35 across 8 files) and treat `App.OnStart` with care.
- **Probe it as a standing audit**, since convergence came back once: ask the same question N times
  and print a per-probe string such as `E-E--E-E` plus a verdict, include a CONTROL lookup that never
  misbehaves, and resolve every navigation property from live metadata inside the probe - a
  hard-coded name once produced a confident "fails 8 of 8" that was the probe's own typo. Plain
  output doubles as the support-ticket attachment.
- Do not build an audit on the global relationship list (it reports cache noise). During a pilot,
  tell testers the retry and ask them to report every occurrence - frequency is the data. Raise it
  with Microsoft.

## 11. What to put in the ship script

| Reconcile in place (a name that can be corrected) | Detect and refuse (cannot be safely forged) |
|---|---|
| option-set members, both caches (add and relabel only) | a column the formulas use that the cached list lacks |
| entity set names, every place, whole archive | a lookup whose live schema name differs from solution source |
| lookup navigation/schema-name casing, parsed | data-source count lower than the live app |
| `<DatabaseReferences>` / `<CdsDependencies>` vs `DataSources.json`, by name and value | a bound table missing from the solution's component list |

A reconciler contract that held up:

- takes a `.msapr` or `.msapp` and locates `References/DataSources.json` under either path
  separator (and the `msapp/References/...` nesting of an unpacked `.msapr`);
- asks live metadata through one read-only query helper;
- `--dry-run` prints what it would change; a rewrite prints every change it made;
- **never blanks what it cannot verify**;
- rewrites the archive preserving all other entries, then reads it back to prove the correction
  survived;
- `--check` exits non-zero on any drift, so the ship can re-run every reconciler against the
  **finished** zip.

Assert on the finished artifact, not on `Src/`.
