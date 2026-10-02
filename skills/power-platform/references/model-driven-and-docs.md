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

The `classid` depends on the column type. The values one project used successfully (platform
constants; **verify each against a form exported from your own environment before relying on it**):

| Column type | classid |
|---|---|
| single-line text | `{4273EDBD-AC1D-40d3-9FB2-095C621B552D}` |
| multi-line text (memo) | `{E0DECE4B-6FC8-4a8f-A065-082708572369}` |
| whole number | `{C6D124CA-7EDA-4a60-AA9D-787E6A8D8C7B}` |
| decimal | `{0D2C745A-E5A8-4c8f-BA63-C6D3BB604660}` |
| currency | `{533B9E00-756B-4312-95A0-DC888637AC78}` |
| date and time | `{5B773807-9FB2-42db-97C3-7A91EFF8ADFF}` |
| Yes/No | `{67FAC785-CD58-4f9f-ABB3-4B7DDC6ED5ED}` |
| choice | `{3EF39988-22BB-4f0b-BBBE-64B5A3748AEE}` |
| lookup | `{270BD3DB-D9AF-4782-9025-509E298DEC0A}` |

The cheapest way to check: export the solution, find a form with a column of that type, and copy
its `classid`.

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

`RelationshipName` is the one-to-many relationship's schema name. Resolve a public view id from
`savedqueries?$filter=returnedtypecode eq 'app_requestline' and querytype eq 0`, preferring the row
with `isdefault` true. When cloning entity XML by hand, regenerate form and view GUIDs - they are
unique across the organisation (`dataverse.md`).

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

- **A review workbook before a production load**: an issues tab with ids, "question for" and
  severity (decision / follow-up / fix at source / cleaned / info), hyperlinks between each issue and
  its row, the original values kept beside correction columns, a load yes/no column, the exact cell
  tinted, and a reconciliation tab against control totals to the cent. The loader reads the reviewed
  copy, then: dry run, trial load, read-back reconciliation. The mechanics of loading and reconciling
  are in `data-migration.md`.
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
