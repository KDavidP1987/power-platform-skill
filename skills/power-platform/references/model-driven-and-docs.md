# Model-driven forms, user guides, licensing, reporting and spreadsheet replacement

The work around a canvas app that still decides whether it succeeds: the model-driven companion
app that admins use, the user guides people learn from, the licences without which nobody can open
anything, the weekly report that tells management where things stand, and the spreadsheet the whole
thing is replacing.

## Contents

1. Customising model-driven forms by script
2. The model-driven app is a write path and a dependency
3. User guides and SOPs generated from the running product
4. The python-docx kit and Word automation
5. Licensing is a deployment dependency
6. Weekly reporting from git
7. Replacing a spreadsheet tool
8. Model-driven apps: when they fit, how this method applies, and verifying them

## 1. Customising model-driven forms by script

A model-driven app created with `pac model create` over new tables gets auto-generated main forms
("Information") that expose one or two fields - unusable for data entry until fields are added.
Forms can be customised from a script against the Web API, which keeps the change in git and
repeatable:

1. **Find the main form**:
   `GET systemforms?$filter=objecttypecode eq 'app_request' and type eq 2&$select=formid,name,formxml`
   (`type eq 2` is a main form; prefer the one named "Information" when there are several).
2. **Back up `formxml`** to a file before touching it.
3. **Make the edit idempotent and append-only.** Parse the XML, remove any tabs or sections *your
   script added on an earlier run* (give them names with your own prefix so they can be found), then
   append the new `<tab>`/`<section>` nodes with fresh `{GUID}` ids, `IsUserDefined="1"`, and labels
   carrying a `languagecode`. Never edit nodes you did not create.
4. **PATCH with `If-Match: *`** - update only, never create:
   `PATCH systemforms(<formid>)` with body `{ "formxml": "<form>...</form>" }` and header
   `If-Match: *`. An invalid `formxml` is rejected and leaves the form unchanged.
5. **Publish that entity only**:
   `POST PublishXml` with
   `{ "ParameterXml": "<importexportxml><entities><entity>app_request</entity></entities></importexportxml>" }`.
6. **Re-read and count** the tabs, sections and controls you expect.

A field control is one line:

```xml
<cell id="{new-guid}">
  <labels><label description="Amount" languagecode="1033" /></labels>
  <control id="app_amount" classid="{533B9E00-756B-4312-95A0-DC888637AC78}" datafieldname="app_amount" />
</cell>
```

The `classid` depends on the column type. These are platform constants, checked against the
forms of system tables (account, contact) and of custom tables in one environment, and against
Microsoft's form XML control list:

| Column type | classid |
|---|---|
| single-line text | `{4273EDBD-AC1D-40d3-9FB2-095C621B552D}` |
| multi-line text (memo) | `{E0DECE4B-6FC8-4a8f-A065-082708572369}` |
| whole number | `{C6D124CA-7EDA-4a60-AEA9-7FB8D318B68F}` |
| decimal | `{C3EFE0C3-0EC6-42be-8349-CBD9079DFD8E}` |
| floating point | `{0D2C745A-E5A8-4c8f-BA63-C6D3BB604660}` |
| currency | `{533B9E00-756B-4312-95A0-DC888637AC78}` |
| date and time | `{5B773807-9FB2-42db-97C3-7A91EFF8ADFF}` |
| Yes/No | `{67FAC785-CD58-4f9f-ABB3-4B7DDC6ED5ED}` |
| choice | `{3EF39988-22BB-4f0b-BBBE-64B5A3748AEE}` |
| lookup | `{270BD3DB-D9AF-4782-9025-509E298DEC0A}` |

An earlier version of this table gave a wrong id for whole number and the floating-point id for
decimal. Two habits keep that from recurring:

- **Read the map from the environment rather than a table.** `GET systemforms?$filter=type eq 2
  and (objecttypecode eq 'account' or objecttypecode eq 'contact')&$select=objecttypecode,formxml`,
  take each `<control datafieldname=... classid=...>`, and join `datafieldname` to the table's
  `Attributes` (`AttributeTypeName`). Every type that appears on a system form gets its classid from
  the platform itself; a type that disagrees with the table above is the one to distrust.
- **A file column has no entry.** No form in a measured environment showed one, so its classid could
  not be read from a form. Add a file column to a form in the maker portal once, then read that form,
  before scripting it.
- **A script that rewrites whole forms deletes what the designer added.** A file column placed in the
  maker portal (which a script cannot generate) was lost on the next full-form run. Keep the script
  append-only (step 3) and scope each run to one table (an `--only <table>` switch), so a run never
  touches a form it was not asked to change.

**Read-only fields on a scripted form.** For a calculated or system-maintained value, put
`disabled="true"` on the `<control>`: the form shows the lock and blocks typing. Cells in a
two-column section read **row-wise** (left, right, then the next row), so when the form mirrors a
paper form, order the field list as left/right pairs; a list in reading order down one column comes
out interleaved.

**A subgrid turns a parent form into a hub** where related rows are edited in context:

```xml
<control id="sub_lines" classid="{E7A81278-8635-4d9e-8D4D-59480B391C5B}" indicationOfSubgrid="true">
  <parameters>
    <ViewId>{public-view-guid}</ViewId>
    <IsUserView>false</IsUserView>
    <RelationshipName>app_request_app_requestline</RelationshipName>
    <TargetEntityType>app_requestline</TargetEntityType>
    <AutoExpand>Fixed</AutoExpand>
    <EnableViewPicker>false</EnableViewPicker>
    <ViewIds>{public-view-guid}</ViewIds>
    <RecordsPerPage>10</RecordsPerPage>
    <ChartGridMode>Grid</ChartGridMode>
  </parameters>
</control>
```

**An editable subgrid** (rows edited in the grid itself, measured: an edit in the grid read back from
Dataverse) keeps that classic control in the cell, given a `uniqueid="{U}"`, and adds a control
description that swaps in the Power Apps grid on every form factor:

```xml
<controlDescriptions>
  <controlDescription forControl="{U}">
    <customControl formFactor="0" name="Microsoft.PowerApps.PowerAppsOneGrid">
      <parameters>
        <data-set name="Items"><!-- the same ViewId, RelationshipName, TargetEntityType --></data-set>
        <EnableEditing static="true" type="Enum">yes</EnableEditing>
      </parameters>
    </customControl>
    <!-- the same customControl again with formFactor="1" and formFactor="2" -->
  </controlDescription>
</controlDescriptions>
```

Read the control name from the `customcontrols` table. Do **not** also list a
`<customControl id="{E7A81278-...}">` default entry: the form POST fails with `0x8004f036`
("dependent component CustomControl ... does not exist"). This is per form, so other apps and the
table's own list grid are unchanged; switching editing on for the table's grid changes every app.

`RelationshipName` is the one-to-many relationship's schema name. Resolve a public view id from
`savedqueries?$filter=returnedtypecode eq 'app_requestline' and querytype eq 0`, preferring the row
with `isdefault` true. When cloning entity XML by hand, regenerate form and view GUIDs - they are
unique across the organisation (`dataverse.md`).

**Editable grids: per form or per table.** The subgrid above is a per-form choice. A table's list
page (its home grid) is set by the table's `customcontroldefaultconfigs` row
(`primaryentitytypecode` = the table; every table has one, with an empty `<controlDescriptions />`
until set). To make it editable, copy the `controldescriptionxml` of a platform table that already
uses the Power Apps grid there (`asyncoperation` did, in a measured environment: one
`<controlDescription>` with no `forControl`, a `<customControl id="{E7A81278-...}">` default entry,
then `Microsoft.PowerApps.PowerAppsOneGrid` for form factors 0, 1 and 2), switch `EnableEditing` to
`yes`, PATCH it, and `PublishXml` the entity. This changes **every** model-driven app that shows the
table, so check the blast radius first: list the apps whose `appmodulecomponents` include the table,
and count only apps that exist (the union of `appmodules` and `RetrieveUnpublishedMultiple()`).
Measured: `appmodulecomponents` still held 14 rows for an app deleted months earlier, and a check
that counted them refused a safe change.

**A bulk-edit view shows identifiers through a link.** The Power Apps grid lets a person type into
every column of the row's own table that the view shows - keys and lookups included, which the app
depends on. Columns brought in through a `<link-entity alias="p">` (layout cell `p.app_code`) render
read-only ("This cell is not editable"). So put the fields that identify a row (the parent's code,
the period from a shared calendar) in the view through a link, and the row's own columns only for
what may be edited. Linked headers read "Field (Table)" and cannot be relabelled in the view.

**Grid events run on a form-hosted grid only.** Events on the Power Apps grid (`OnRecordSelect`, a
cell's `OnChange`), used to lock cells by rule, ran on a subgrid placed on a form and **never** on the
table's list page: a handler stored in `customcontroldefaultconfig.eventsxml` was accepted, but its
library never loaded (no request for the web resource; locked cells stayed editable). Register them
on the form instead: `<events><event name="OnRecordSelect" control="<subgrid id>">` with the
handler, plus the library in the form's `<formLibraries>`. To
govern bulk editing:

- Host the editable grid on a form and keep the table's list page read-only, so nothing can be
  edited outside the rules.
- A grid over **all** records works on any form: a subgrid with an empty `RelationshipName`. Measured:
  placed on a single "year" record's form, it showed about 3,200 rows and opened in about 7 s cold.
- `eventsxml` refuses a `<formLibraries>` element, an empty string and null alike (`0x80040216`);
  clear it with `<events />`.

**Form scripts run in a sandbox frame.** A value a form script set on `window` was not visible from
the page's top frame, while the cells it disabled plainly were. Verify a form or grid script by its
effect, not by a global: click the cell, press Enter, check whether an input took focus, press
Escape. The multi-row **Bulk Edit** dialog opens the main form with `formType` 6; a governance
script must handle 6 explicitly, or it applies its single-record rules to a many-record edit.

**Porting canvas rules to a web resource, with tests.** When a model-driven app must keep a canvas
app's editing rules (closed periods, locks, who may edit what), write them as one pure function -
`allow(context, field, row, period) -> { ok, why }` - that both the form script and a Node test file
call. The web resource exports it for Node with `if (typeof module !== 'undefined') module.exports
= ...`. Measured: 45 rule tests covered the roles an admin session cannot exercise, and the test
file was shown to fail with a rule broken on purpose. Browser checks as an admin then only need to
prove the wiring, and the rules still move server-side before non-admin roles get the app (section 2).

**Quick view forms take one-column sections.** `POST systemforms` with `type` 6 and a two-column
section returned `0x80040203` ("Columns in a section must be set to 1"). Embed one on a main form
with the standard quick view control classid, `datafieldname` = the lookup it follows, and the
`QuickForms` parameter = the escaped `<QuickFormIds>` XML naming the quick view form.

**A web resource panel shows live figures on a form.** An HTML web resource placed with the
standard web resource control (`PassParameters` true, `Data` = a custom string) reads `id`,
`typename` and `data` from its query string and calls the Web API from the same origin with FetchXML
aggregates, as the signed-in user. Measured: its totals matched a Dataverse query exactly. Size the
cell by `rowspan`: 6 left a blank band, 3 fitted a row of five cards.

**Check the layout as a person doing the task.** Screenshots of a scripted form caught one that put
context on the first tab and the fields the task needs on the second. Ask of every form: is the
reason to open it above the fold? One tab worked, with the task's fields on the left and context
(a quick view card, notes, a figures panel) on the right. Clear the browser cache before each look
(section 8): a republished form otherwise shows its previous layout.

## 2. The model-driven app is a write path and a dependency

- **It bypasses every canvas gate.** Hidden buttons and disabled inputs do nothing against the
  model-driven app (or Excel, or the Web API) when the role grants the privilege. Any rule that
  matters lives in roles, column security or the table itself. A canvas-level gate can be a
  documented choice - admin-configurable without role changes - recorded as an accepted risk with
  the conditions for revisiting it.
- **It must maintain what the canvas app maintains.** If the canvas save path keeps a denormalised
  mirror column (a key copied for delegation), a row created in the model-driven form without it
  vanishes from canvas filters. Either maintain the copy server-side or audit the drift: a
  re-runnable backfill whose repair count is non-zero outside a migration means some other writer is
  creating rows without the copy.
- **Forms block column deletes.** Dataverse refuses to delete a column a form references, and the
  auto-generated "Information" forms reference columns nobody remembers adding. Before retiring a
  column, ask Dataverse what depends on it -
  `RetrieveDependenciesForDelete(ObjectId=<attribute MetadataId>,ComponentType=2)`, resolving
  form dependents (type 60) through `systemforms(<id>)?$select=name` - and remove it from forms
  first. Put model-driven forms and views in the dependency register's change-impact checklist.
- **Column Descriptions are shown in the model-driven app.** Business notes that are labels rather
  than rules ("enter the invoice number exactly as printed") belong in the column's Description,
  where forms and reports surface them.

## 3. User guides and SOPs generated from the running product

The standard set (a guide per user role, a manager guide, an administrator guide and a developer
and platform guide), its chapter skeletons and the kit are in `documentation-set.md` and
`assets/doc-kit/`. This section is the method behind them.

A user guide written from memory describes the app someone intended. One generated from the
published app describes the app users have - and writing it that way doubles as an audit: in one
project it found seven live defects, and in another a stale date that no check read.

**The standard**

- Write for someone who has never seen the app. Name every control exactly as it is labelled.
- Read every fact from the product or its source: button names from control labels in `.pa.yaml`,
  validation messages quoted from where they really live (often seeded rows in a messages table),
  who-sees-what from each control's `Visible` expression and the live role setup - never from what
  an admin account happens to show.
- No table, column or option logical names in prose.
- **Never manufacture production data to make a screenshot look better.** Capture the empty state
  and describe the populated one; list screens that could not be captured populated, for recapture.
- Keep the guide's wording consistent with any in-app help panel (its glossary tab is the guide's
  glossary).

**The method**

1. A **shot list**, captured with Playwright from the **published** app (not Studio) at a fixed
   window size (1500x1000 worked), with the build stamp recorded - so a screen change means
   recapture and re-run, not a rewrite.
2. **Capture as the target role** where possible. Admin captures show admin-only banners and
   controls; crop them out or label them.
3. **Trim the player chrome automatically.** Detect the player's near-black command bar and the
   dark-grey letterbox by scanning a column clear of centred dialogs for low-saturation dark pixels,
   crop them, then trim trailing blank pale rows. Fall back to the full frame if detection leaves
   less than about 200 px. A `cut_band(y0, y1)` helper removes a role-only banner from the middle of
   a capture. Write trimmed images to a new folder - never overwrite the originals.
4. **Build the document from two parts**: a reusable formatting kit (cover, contents, headings,
   callouts, tables, figures, captions) and a separate words-only script per guide, so a
   non-developer can edit wording without touching layout. Chapters shared by a user guide and an
   admin guide are written once and called from both, so they cannot drift.
5. **Update fields through Word, render to PDF, read every page** (section 4).
6. **Keep the output out of git** - screenshots carry colleagues' names. Commit the scripts.

**Definition of done**: button names read from source; no logical names in prose; admin-only views
labelled; wording consistent with the in-app help; every page of the PDF read; screens needing
recapture listed.

## 4. The python-docx kit and Word automation

python-docx writes the file; it does not lay it out. Four details decide whether the result looks
professional:

- **Numbered lists restart.** Every "List Number" paragraph shares one numbering instance, so the
  second procedure in a document starts at 4. For each procedure, create a new `w:num` that points at
  the same `w:abstractNumId` with a `w:lvlOverride`/`w:startOverride w:val="1"`, and set that num id
  on the procedure's paragraphs.

  ```python
  def restart_numbering(doc, paragraph):
      numbering = doc.part.numbering_part.numbering_definitions._numbering
      abstract_id = ...  # the abstractNumId behind the 'List Number' style
      num = numbering.add_num(abstract_id)
      num.add_lvlOverride(ilvl=0).add_startOverride(1)
      paragraph._p.get_or_add_pPr().get_or_add_numPr().get_or_add_numId().val = num.numId
  ```

- **Fields are inserted, not computed.** Insert TOC, PAGE and NUMPAGES as complex fields marked
  `w:dirty="true"`, so Word evaluates them on open or on update.
- **Tables across pages.** Mark header rows `w:tblHeader` so they repeat on every page; mark every
  row `w:cantSplit`; set keep-with-next on every paragraph of short tables (8 rows or fewer) so they
  never strand a row on the next page.
- **Figures.** Keep the figure paragraph with its caption (keep-with-next), and size figures a little
  under the text width - full width pushed too many onto the next page.

**Update the table of contents through Word, not python-docx.** Drive Word over COM:

```powershell
$word = New-Object -ComObject Word.Application
$doc  = $word.Documents.Open($path)
$doc.Fields.Update() | Out-Null
foreach ($toc in $doc.TablesOfContents) { $toc.Update() }
$doc.SaveAs([ref]$path, [ref]16)      # 16 = .docx; 0 (Word 97-2003) failed here
$doc.SaveAs([ref]$pdf,  [ref]17)      # 17 = PDF
$doc.Close(); $word.Quit()
```

Then render the PDF pages to PNG and look at the page breaks - the only way to see a stranded
heading or a figure pushed onto a page of its own.

## 5. Licensing is a deployment dependency

Licences have lead time and block things that look like defects. Plan them like connections.

- **What needs a premium licence**: Studio's data panel warns that apps using the Dataverse connector
  need a premium per-user, per-app or pay-as-you-go plan at playback, and Dataverse-triggered flows
  are premium. Testers, approvers and flow owners all need the right one.
- **Observed blockers**: flows that built and switched on cleanly never ran until a Power Automate
  licence arrived; testers waited days for Power Apps licences, which blocked the first non-admin
  proof of any gate; an approver without a licence meant records routed to someone who could not
  open the app.
- **But diagnose before buying.** One team believed for eleven days that its Dataverse triggers were
  blocked on licensing and planned a purchase. Run history showed 103 runs whose trigger fired and
  whose action failed with `OpenApiOperationParameterTypeConversionFailed` - an authoring defect. A
  licence or DLP block returns 403 or suspends the flow; it does not produce a parameter error. Read
  the `flowrun` table first (`power-automate.md`).
- **Build licence requests from live data**, not retyped names: generating the list from the roster
  and the directory found a misspelled name and two wrong addresses.

**Onboarding a user to a canvas app takes four separate gates**, licence first:

1. a Power Apps licence;
2. the Basic User role plus the app's role, assigned directly (custom roles carry no platform
   privileges - assign Basic User beside them, do not clone it);
3. the app shared with them as "Can use" - without it the link says "you don't have access" before
   roles matter;
4. an identity row holding their exact sign-in address - without it they open the app as nobody.

Routing data (an approver on their assignment) is separate again.

## 6. Weekly reporting from git

One consolidated, email-ready progress report per week, across every repo, written from records
rather than memory.

**Gathering**

- A script walks every repo and collects, for a Monday-to-Sunday week:
  `git log --since=<monday> --until=<next monday> --date=short --pretty="- %ad %s"`, the dated
  changelog sections, and tracker items closed that week. File the week under its Sunday and write it
  the following Monday, so weekend work counts toward its own week (otherwise it reads as a quiet
  week followed by a double one).
- Use `git log --since/--until`, not `git diff @{date}`: the latter resolves through the reflog and
  warns or fails on older dates.
- The script **does not write the prose.** Commits are the reminder; judgement comes from each
  project's tracker and changelog.
- **Trap: nested repos are missed.** A collector that tests only `Test-Path <dir>\.git` one level
  below the root silently leaves out a repo nested inside a platform folder. Find repositories
  recursively (`Get-ChildItem -Recurse -Directory -Filter .git -Hidden`), and print the list of repos
  it found so a missing one is visible.
- **Reconcile the tracker before reporting.** Trackers drift (`project-setup.md`): one pass found 40
  finished items still open, and two of three numbers carried forward from an earlier report were
  wrong against live. A report written from an unreconciled tracker repeats its errors to
  management.
- Each project's own detailed weekly log is written first; the consolidated report is a compression
  of it, so nothing appears in it that is not already logged. A machine-readable marker per week
  (`<!-- week:YYYY-MM-DD -->`) lets a non-blocking Stop hook nudge when source changed and this
  week's entry is missing.

**The format: one screen** - a headline, completed, what remains, blockers.

- Completed bullets say what a person can now do and what proved it ("confirmed by putting a real
  record through", never "the build passed").
- Blockers are major only - stopped work the author cannot clear alone - each naming what is needed,
  from whom, and what is stopped. Three or four lines. An item stuck three weeks is escalated or
  dropped.
- No table or field names, no ticket ids, no internal audit statistics. Say the consequence, not the
  mechanism. Count honestly ("sixteen of seventeen"). Never describe a not-yet-approved project in
  go-live language.
- A demo week can add an item-by-item reference list pulled in by an include line, so the crib sheet
  and the email cannot drift.

Blockers that recurred week after week, and are worth anticipating in any plan: no non-admin test
account, licences for testers and approvers, an open platform support case, and owner or contact data
the features depend on.

**Pasting into Outlook.** Markdown pasted into Outlook keeps its `**`, rules and hard wraps. Convert
it to HTML with **inline styles only** (Outlook renders with Word and drops stylesheets), fold wrapped
bullet lines, and put it on the clipboard as **CF_HTML** - the byte-offset header is what makes
Outlook paste rich text rather than tags - with an `.html` fallback to open, select all and copy. Do
not choose "Keep Text Only" when pasting.

## 7. Replacing a spreadsheet tool

Most Power Platform projects replace a workbook. What the workbook's shape hides decides the data
model.

**Model**

- **Normalise wide period columns into period-grained rows.** A workbook with about 60 fiscal-period
  columns, re-columned every year, becomes one fact row per line per period, driven by a seeded
  fiscal calendar table. Make scenario (budget, forecast, actuals) a dimension on the row, not a
  separate table.
- **Keep integration-fed actuals in their own landing table**, separate from user-entered forecasts.
- **Do not rebuild in canvas a report Power BI already serves.** Before building a canvas report
  screen, check whether a published report already answers the question; link to it (the report URL
  is a setting) instead of maintaining a second implementation that will drift from it.
- **Version governance forms one-to-many with an is-current flag**, so approved snapshots survive
  later edits.
- **Every total over a fact table is scoped to one value of each additive dimension.** A headline
  "Forecast" figure that summed every scenario on the same lines overstated the total several-fold.
  When the scope of a number changes, change its caption with it ("Approved (active)").
- **Do not mix grains** (annual and per-period rows in one table double-count every rollup); a grain
  change is a new column or table, not a relabel.
- **Value sets that carry sort order or metadata are tables, not choices** - which also keeps them
  out of the option-set caches (`manifest-caches.md`).

**Canonical values and crosswalks.** Profile every distinct value across the source workbooks, define
a canonical set (with an active flag for retired values rather than deleting them), and a crosswalk
from each legacy spelling; load both as seed data so the migration cleans as it loads. Keep messy
free-text dimensions as text rather than forcing a choice set; leave junk blank rather than guessing,
and ship the admin screen so the business finishes the mapping.

**Reading the workbooks**

- **Macro-enabled workbooks can be read as XML** when Excel COM is blocked by their macros. The cell
  parser must handle self-closing `<c/>` elements - a first pass that did not attributed every value
  to the previous cell.
- **Find what people actually fill in** by diffing each live workbook's cells against the blank
  template: a value counts as hand-entered only if it is not a formula and differs from the template.
  Governance forms turned out to be mostly formulas (0 to 9 hand-entered values each), and some
  sheets were never filled (0 of 7) - their designed tables were dropped.
- **An empty source list is not proof a process is unused.** A list named for a process was empty
  because the process lived in a different list (155 of 189 rows there). Check where the *function*
  went before cutting it.
- **Workbook traps seen in loads**: about 15,000 phantom columns in a small sheet, text in numeric
  cells ("off board", formula fragments), merged subtotal rows interleaved with detail, two coexisting
  code schemes. Validate header layout before reading (a `(field, column, expected header prefix)`
  map), extract reference layers first, and hold financial detail until an authoritative version
  arrives.

**Loading**

- **A review workbook before a production load**, then dry run, trial load and read-back
  reconciliation. Its layout and the loading mechanics are in `data-migration.md`.
- **Splits must add back exactly.** Spreading a line total evenly across twelve periods left up to a
  few dollars of drift per line ($9 across one portfolio) - invisible in the UI, wrong in a financial
  tool. Put each line's remainder on one period and re-audit that line totals equal period sums to
  the cent.
- **Accruals are a point-in-time balance**: never sum them across periods and never copy them
  forward (year-to-date = actuals to date plus the current period's open accruals).
- **Sample data for demos**: take record identity from the real source list, generate fact values
  deterministically, reference real dimension values so every lookup resolves on load, and keep the
  generated files out of git (real names and financials); the generator rebuilds them. Tune values so
  every visual state shows (over and under capacity, positive and negative variance) and give every
  record child data - testers filed records with no children as bugs.
- **Keep source workbooks out of git.**

## 8. Model-driven apps: when they fit, how this method applies, and verifying them

### When model-driven fits better than canvas

- **Back-office maintenance over many related tables**: administrators editing reference data,
  rows with several child lists, bulk edit, views, Excel export, audit history and record sharing,
  all with no screens to build. A canvas app earns its cost where the task is a guided flow, the
  layout is the product, or people use it on a phone.
- **The licence is the same.** Both are premium when they use Dataverse; a model-driven companion
  for administrators adds no licence beside the canvas app.
- **Many teams end up with both**: a canvas app for the people doing the work and a model-driven
  app for the people maintaining it. Section 2 applies then - the model-driven app is a second write
  path that bypasses every canvas gate.
- **Bulk edit per parent is the parent form with an editable child grid** (section 1). Before
  copying another app's forms "to edit like that one", check whether its grids are editable: in one
  measured case the reference app's child grids were read-only subgrids and editing was one record
  per form, so a literal copy would not have given bulk editing. Until the canvas app's rules move
  server-side, limit such an app to administrator roles.

### How this skill's rules apply

None of these change because the app is model-driven:

- **Schema first, as a manifest in git** (`dataverse.md`, `deploy-tables.py --plan`). A generator
  that creates tables from a prompt is fine for a prototype; for anything that will ship, keep the
  tables in the manifest so they can be planned, reviewed and redeployed, and let the generator
  build on them.
- **Shared and reference tables stay read-only** (`shared-environments.md`). A model-driven app
  makes writing to a shared table one click away: leave shared tables off the sitemap, or give the
  app's role Read only on them, and check the role rather than the navigation.
- **Security roles by script**, with a `-Report` mode and a live read-back
  (`security-and-access.md`). The model-driven app shows exactly what the role allows; that is the
  point, so the role is the design.
- **Solution-aware from the start**: the app module, sitemap, forms and views all belong in the
  project's solution, or a later export ships without them (`alm-pipelines.md`).
- **Forms by script, append-only** (section 1), and every form and view in the dependency register.

### Creating the app module by script

The order that worked: find or create the app module, find or create its sitemap, `AddAppComponents`
(the sitemap, each table, its forms and its public views), `ValidateApp`, set the header theme, then
one `PublishXml` naming the web resource, the app module and the sitemap, and **last, the app's
roles**: `POST appmodules(<id>)/appmoduleroles_association/$ref` with
`{"@odata.id": "<org>/api/data/v9.2/roles(<role id>)"}`. Before the first publish that path returns
404 ("Entity 'appmodule' ... Does Not Exist") although `RetrieveUnpublishedMultiple` returns the
module, so assign roles after `PublishXml`; an app given no roles is left on the administrator roles
only. Print each `ValidateApp` issue's `ComponentId` and `ComponentType` as well as its message:
measured, seven warnings came back with a null `Message`. Four traps:

- **A form created after the app module exists is not in the app.** Add it with `AddAppComponents`
  (and publish), or the app keeps opening the auto-generated form.
- **A new app module is unpublished, and a plain query does not return it.** `GET appmodules?$filter=
  uniquename eq 'app_backoffice'` finds only published apps; until the first publish the module is
  visible only through `GET appmodules/Microsoft.Dynamics.CRM.RetrieveUnpublishedMultiple()`. An
  idempotent script must look in both, or a re-run after a failure before the publish creates a
  second app with the same name.
- **Sitemap ids are identifiers.** `Area`, `Group` and `SubArea` `Id` values must match the schema
  type `CRM_Identifier_SiteMap` - letters, digits and underscores, no spaces - so derive them from the
  label by keeping only letters and digits (`grp_referencedata`, not `grp_Reference Data`).
- **A new app gets the platform's default purple header.** Theme each app, not the environment:
  the app setting `CustomThemeDefinition` points one app at an XML web resource, and the
  environment's other apps keep theirs. This skill's no-purple rule makes it part of every app it
  builds. Create or update the web resource (`webresourcetype` 4, XML, content base64):

  ```xml
  <CustomTheme>
    <AppHeaderColors background="#1E3A5F" foreground="#FFFFFF" backgroundHover="#2B4C7E"
      foregroundHover="#FFFFFF" backgroundPressed="#0F6CBD" foregroundPressed="#FFFFFF"
      backgroundSelected="#0F6CBD" foregroundSelected="#FFFFFF" />
  </CustomTheme>
  ```

  then read `settingdefinitions?$filter=uniquename eq 'CustomThemeDefinition'` for its id, and
  create (or `PATCH` with `If-Match: *`) the `appsettings` row: `value` = the web resource's name,
  `parentappmoduleid@odata.bind` = `/appmodules(<app id>)`, `settingdefinitionid@odata.bind` =
  `/settingdefinitions(<id>)`, a `uniquename` with your prefix. Publish the web resource with the
  app. Take the colours from the project's design standard; check the header in the browser after a
  cache clear (below).

### Menus, icons and commands per app and per role

All three can be set by script for one app, with no ribbon solution and no change to table
metadata, so other apps that show the same tables are unaffected. Each has limits:

- **Menus per role.** A sitemap `SubArea` with `<Privilege Entity="app_adminsetting"
  Privilege="Write" />` (placed after its `Titles`) is hidden from roles without that privilege. A
  table only administrators can write works as the proxy for "administrator". Views inside a visible
  table cannot be hidden per role, only per app (the app's view components).
- **Icons per app.** `SubArea VectorIcon="$webresource:app_/icons/orders.svg"` sets the menu icon for
  this app only; a shared table keeps its own icon everywhere else.
- **Hiding a classic command in one app.** `POST appactions` with `name` = the command id, a
  `uniquename` with your prefix, `hidden` true, `location` (0 form, 1 main grid, 2 subgrid),
  `context` 1, `contextvalue` = the table's logical name, `origin` 1, `type` 0, and the navigation
  properties bound with the usual annotation: `ContextEntity@odata.bind` =
  `/entities(<EntityId from EntityDefinitions>)` and `AppModuleId@odata.bind` = `/appmodules(<id>)`.
  Then publish the app. The navigation names are PascalCase: lower case returned `0x80048d19`
  ("undeclared property"). Read command ids from the running page (each button's `data-id`).
  Measured: about 290 overrides hid Assign, Deactivate, Activate, Run Flow (form and main grid), Run
  Report, the Word and Excel templates, Email a Link, Visualize this view and New, with no effect on
  other apps. Three cautions:
  - **Not everything can be hidden this way.** Check Access (`AccessChecker.OpenDialog.<table>.Button`)
    and the Flow menu on a form subgrid still showed after the override rows were written and the
    cache cleared.
  - **A subgrid with no relationship** uses `Mscrm.SubGrid.<table>.NewRecord`, not `AddNewStandard`;
    hide both.
  - **Hiding frees space**, which brings buttons out of the overflow menu (a form's Reports appeared).
    Re-read the ids after each round.

### Reporting inside a model-driven app

The platform's dashboards and charts can be created by script, but in a measured build they could
not be relied on. A web resource page on the sitemap could.

- **A dashboard created by Web API may never open.** A `systemform` of type 0 that matched a working
  system dashboard in every column but `ismanaged`, published and in the app, was missing from the
  dashboard picker, and opening it (as the sitemap's default dashboard, by URL with its id, by URL
  with `type=system`) fell back to a system dashboard. On the way, `IsUserDefined` on its tabs and
  sections was refused (`0x8004e303`). The cause was not found, so do not promise a scripted
  dashboard: open it in the browser before relying on it.
- **Charts ignore their series colours.** A `savedqueryvisualization`'s `presentationdescription`
  stored `Color="R,G,B"` (with or without a custom palette), but Unified Interface drew its own
  palette: first a blue-violet, second a magenta. Under a palette that bans those hues, use one
  series per chart, or the page below. Chart XML traps: one `measurecollection` per series
  (`0x8004e003` otherwise), and an `order` on a grouped alias sits in the same entity or
  link-entity as the alias (`0x8004110a` otherwise).
- **The route that worked: a sitemap web resource page.**
  - Setup: `SubArea Url="$webresource:app_/pages/overview.html"`, with a shared `pages.js` and
    `pages.css` loaded by relative path.
  - Queries: FetchXML aggregates from the same origin run as the signed-in user, so each role sees
    only what it can read. A `groupby` on a lookup inside a link-entity works.
  - Navigation: `window.parent.Xrm.Navigation.navigateTo` with `entityrecord`, `entitylist` (with a
    `viewId`) and `webresource` (with a `data` string), for drill-down and links between pages.
  - Checks: the totals matched Dataverse to the unit; a group row expanded to the right number of
    records, and a person's row opened that person's page.
  - Colours: validate the chart palette with a checker. Two series and a dashed neutral reference
    line passed where three hues failed.

  It is branded, testable in the browser like any page, and needs no Power BI licence. For history,
  trends and cross-table questions, `reporting.md` still applies.

### Microsoft's app builder (not measured here)

Microsoft's official `model-apps` plugin (`microsoft/power-platform-skills`) builds a whole
model-driven app from a description: tables, relationships, forms with sub-grids, views, charts,
dashboards, security roles, the app module and sitemap, and generative pages (React pages inside the
app). It works from an app specification you approve, applies it idempotently, can verify the
deployed app against the specification, download a deployed app back into a specification, and tear
down only what it built (dry run by default). This skill has not run it; the pairing that follows
from the rules above:

1. Deploy the tables from your manifest first, then let the builder build on them as existing
   tables (it skips tearing down tables it did not create).
2. Keep its specification in git beside the manifest, as the source for forms, views and sitemap.
3. Review its plan against the shared-table rule before approving: no shared table on the sitemap
   with write access, no role with more than Read on reference data.
4. Verify in the browser as below, as a person with the app's role - not as the maker.

### Verifying a model-driven app in the browser (documented; confirm in your tenant)

The same standard as canvas: perform the task in the running app and confirm the effect in
Dataverse. What differs:

- **The URL shape.** `https://<org>.crm.dynamics.com/main.aspx?appid=<app id>` opens the app;
  add `&pagetype=entitylist&etn=app_order` for a table's list,
  `&pagetype=entityrecord&etn=app_order&id=<row id>` for one record, or
  `&pagetype=entityrecord&etn=app_order` for a new one. Read the app id from the `appmodules` table
  (`appmoduleid`, filtered by `uniquename`).
- **Add nothing else to the URL.** An unknown query parameter on `main.aspx` - a cache-buster such
  as `&v=2` - returns the generic "An error has occurred" page, which reads like a broken app.
- **Clear the metadata cache before every visual check.** Unified Interface caches form, sitemap
  and app metadata in the browser (IndexedDB, Cache Storage and a service worker for the org's
  origin), so a published change stays invisible in a profile that has opened the app before.
  Measured: after a form was PATCHed and published, a plain navigation still drew the old layout.
  Clear the origin's storage (in Playwright, delete every `indexedDB.databases()` entry and every
  `caches.keys()` entry, unregister the service workers, then reload) before checking a form,
  sitemap, command or theme change.
- **Recipes that worked.** A list opens on the app's first view by name, case-insensitive, so name
  the intended default to sort first. Open a specific view with
  `&pagetype=entitylist&etn=app_order&viewid=<id>&viewType=1039`. The list footer prints
  "Rows: N"; compare it with an aggregate FetchXML count of the same filter. Grid cells carry
  `col-id` = the attribute (or `alias.attribute` for a linked column) and rows carry `row-index`,
  which make stable selectors. The multi-row Edit and Export to Excel are on the list command bar
  (Excel under the overflow).
- **Verify a script by its effect.** Form scripts run in a sandbox frame (section 1): check what the
  script did on screen, not a variable it set.
- **Subgrids do not render on an unsaved record.** A related-rows section on a new form is empty
  until the parent is saved; that is the platform, not a defect. Check subgrids on a saved record.
- **An editable grid saves each cell when focus leaves it**, with no Save: measured, a test's
  select-all, Backspace, a failed type call and Enter wrote NULL to a production cell (restored by
  typing the value back). Record the original first; press Enter to edit, type the whole new value in
  one step (typing replaces the selected text), Enter, then read the row back over the Web API. Never
  clear a cell as a separate step.
- **No player iframe.** Unlike a canvas app, list and form controls are in the page itself;
  generative pages and embedded canvas or Power BI content are in frames of their own.
- **Wait for the form, not the page.** The shell renders before the record loads. Wait for a named
  field control to be visible, then for the record title, before reading anything. Generative pages
  can take several seconds longer.
- **Find fields by their label.** Field controls expose the column's display name as their
  accessible name; read values through the accessibility tree (`getByRole('textbox', {name:
  'Order Name'})`, `getByLabel(...)`), and snapshot before every click because references go stale
  when the form re-renders.
- **The command bar is per table and per role.** Locate Save, New and custom commands by name
  (`getByRole('menuitem', {name: 'Save'})` or the button's `aria-label`); an overflow menu
  ("More commands") hides commands at narrow widths. A missing command is a role or ribbon finding,
  not a selector failure - check the role before the selector.
- **Save, then prove it.** After Save, wait for the unsaved-changes marker to clear, then read the
  row back over the Web API and compare the values you typed. A business rule or plugin can change
  them; the read-back is the evidence, not the form.
- **Test as the role.** Open the app in a browser profile signed in as a person who holds only the
  app's role, or impersonate with `MSCRMCallerID` for the read-back. A maker sees everything, so a
  pass as the maker proves nothing about access.
