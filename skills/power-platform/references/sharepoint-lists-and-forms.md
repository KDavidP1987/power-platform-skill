# SharePoint lists, site pages and customised list forms

For work whose data lives in a SharePoint list rather than Dataverse: creating the list from source,
putting a canvas app on a site page, and customising the list's own New / Edit / View form with Power
Apps (Integrate > Power Apps > Customize forms). Every rule here was measured on one list with two
front ends, a planner canvas app and a customised form over the same items.

## Contents

1. Choosing the front end
2. Creating a list from source (REST, in the signed-in browser)
3. A site page with a canvas app on it
4. A customised list form: what is different from a canvas app
5. Size and layout of a form
6. Pages, a summary and actions in a form
7. Shipping and verifying a form
8. Saving and deleting items from an app

## 1. Choosing the front end

- **A canvas app on a site page** suits a planner or dashboard: several views over many items,
  overlays, any layout and any size (`canvas-layout.md`).
- **A customised list form** suits editing one item where people already work in the list. It opens
  from the list's own New, Edit and View, it saves with the classic form's SubmitForm, and it is
  hosted at a fixed size (section 5). Both can run over the same list, with the same role rules
  written twice. Keep each rule in one named formula per app so the two stay in step.
- Neither gives column-level security. A rule such as "only the approver sets the amount" holds in
  the apps only; the list grid stays editable for anyone with edit rights, and version history shows
  who changed what. Say so in the decisions record.

## 2. Creating a list from source (REST, in the signed-in browser)

The Az token cannot write to SharePoint; run the provisioner inside the signed-in browser session
(`fabric-workspace-audit.md` covers reading the same way). Keep it in the repo, plan first, apply
second, idempotent, never deleting (must-hold: select before apply).

- **Columns:** `POST <site>/_api/web/lists/getbytitle('<list>')/fields/CreateFieldAsXml` with the
  field's schema XML (internal name, display name, choices, defaults, required, indexed). Column
  formatting is the field's `CustomFormatter` JSON, set with a MERGE on the field.
- **Views:** one `views/add` call with `ViewFields` listed in the body, not one `addviewfield` call
  per field per view: the per-field calls tripled the write count and brought on throttling. Totals
  are the view's `Aggregations` (for example `<FieldRef Name="Amount" Type="SUM"/>`).
- **Board and Gallery views** have no documented REST create. Make them once in the list UI
  (Add view). They read back as `ViewType2` `KANBAN` and `TILES`, and their card fields are the
  view's fields, so the provisioner can keep the card fields after that. **Keep a Board's
  organising column in its view fields**: removing it made the view fail to load for the user.
- **Pace writes at 3 s and stop at the first 429 or 503.** At 1.5 s a run was refused after about 40
  writes. Reads tolerate 2-3 s (`fabric-workspace-audit.md`); writes need at least the same.
- **Verify a view by its id.** `AllItems.aspx` without `viewid` reopens the last view used in the
  session, so a check of "the default view" can read another view.
- **Driver mechanics.** Playwright's `browser_run_code` has no `require()`, and its `filename`
  option reads only inside the workspace roots. Run a repo script through a small generated wrapper
  placed in the Playwright output folder, which reads the script and evaluates it in the page.
- **A multi-select choice column cannot group a view or organise a board.** Group and board on a
  single-value column (a status, a week date).

## 3. A site page with a canvas app on it

- Create the page with `POST <site>/_api/sitepages/pages`, then `checkoutpage`, then
  `SavePageAsDraft` (`savepagedraft` is 404), then publish.
- **Read the Power Apps web part's id from `<site>/_api/web/GetClientSideWebParts`, never from
  memory**: a remembered id turned out to be another web part. Look for the web part titled Power Apps;
  its property is `powerAppId` (the app id).
- Opening the page in the browser ends the REST editing session. Check the page out again before
  the next save, or the save answers 409.
- People see the app on the page only once the app is shared with them.

## 4. A customised list form: what is different from a canvas app

A form app is a canvas app with a `SharePointIntegration` control and one classic `Form` bound to the
list. Most of the skill applies; these do not, or apply differently.

- **Turn co-authoring on first.** A new form app has it off; the authoring server's `connect` fails
  with "Coauthoring is not enabled for this app". Settings > Updates > Coauthoring, then Save and
  reload Studio.
- **The SharePointIntegration handlers are not in the source.** `OnNew`, `OnEdit`, `OnView`,
  `OnSave` and `OnCancel` do not sync to `.pa.yaml`, so source cannot read or set them; the defaults
  (NewForm, EditForm, SubmitForm, ResetForm) apply. Put every rule on the form's cards instead:
  `Default` for defaults, `Update` for what is written, `DisplayMode` for role locks, and the form's
  `OnSuccess` for what happens after a save (`ResetForm(Self); RequestHide()`).
- **The list's column defaults are not applied in New mode.** Give each card its own:
  `Default: =If(SharePointForm1.Mode = FormMode.New, {Value: "Backlog"}, ThisItem.Status)`.
- **Rules as card formulas** (all measured in the player):
  - snap a date to its Monday in the date card's `Update`:
    `DateAdd(d, 1 - Weekday(d, StartOfWeek.Monday), TimeUnit.Days)`;
  - set a dependent column in its own card's `Update`, reading the other card's control (Status
    becomes Planned when a week is first set; Completed becomes Today() when Done);
  - write a fill-in choice the column does not list with `{Value: "<name>"}`;
  - role locks: `If(Parent.DisplayMode = DisplayMode.Edit && !(<role>), DisplayMode.Disabled,
    Parent.DisplayMode)`, so View mode stays View.
- **Studio's generated card names hold spaces and parentheses** (`Amount (USD)_DataCard1`).
  `check-pa-yaml.mjs` reads them (0.38.0); rename them when you rebuild the screen from source anyway
  (`dcAmount`), because shorter names keep formulas readable.
- **The classic combo box can list empty rows.** In one form app every classic ComboBox dropdown
  showed 15 empty rows (the generated cards and a bare test box with three literal items), in Studio
  preview and in SharePoint, while selected values still showed. A classic DropDown and a
  ModernCombobox beside it listed correctly. Test a bare box first; if it is empty too, replace each
  card's value control with a `ModernCombobox` of the **same name** and `MetadataKey: FieldValue`,
  so the card's `Update`, error label and Y references still hold: `Items: =Choices(DS.<column>)`,
  `ItemDisplayText: =ThisItem.Value`, `DisplayMode: =Parent.DisplayMode`, and for a lookup
  `Update: =<box>.Selected`.
- **`Parent.Default` is untyped inside that ModernCombobox.** `DefaultSelectedItems:
  =Filter(Choices(...), Value = Parent.Default.Value)` fails to compile. Read the item directly:
  `With({d: If(Form.Mode = FormMode.New, "Backlog", ThisItem.Status.Value)}, Filter(Choices(DS.Status),
  Value = d))`; a lookup filters on `Id = ThisItem.<lookup>.Id`. A multi-select box takes
  `=Parent.Default` (a table) as it is.
- **A blank classic DatePicker shows "12/31/2001"** as its placeholder. Set `InputTextPlaceholder`
  to what blank means ("Not scheduled").
- **Attachments:** the card's `DataField` is `"{Attachments}"`, with braces
  (`canvas-controls-and-patterns.md`, section 12).

## 5. Size and layout of a form

- **A form is hosted at a fixed size and scaled, not responsive.** Settings > Display offers only
  orientation and size (no Scale to fit, no Responsive). Landscape Large opens as a centred 1185 x
  790 dialog at every window width; Portrait opens as the narrow side panel. App.Width stays the
  design width, so a breakpoint never fires inside SharePoint. A 1024 px window and a tablet got the
  1185 px frame, scrolled or clipped. **One form cannot be both desktop and tablet**: choose
  Landscape for desktop or Portrait for any device, and say which in the decisions record.
- **Lay the cards out from App.Width anyway**, so a change of orientation needs no card edits. A
  six-unit grid works in a classic form: cards sit side by side by (Y, X); give each
  `Width: =If(lyWide, lyU * n, lyGridW)` and `WidthFit: =true` on the last card of each row (measured
  at 1185 and 760 px). Whether full-width cards sharing a Y wrap to one column has not been measured.
- **Studio rewrites the card geometry when the form's size changes**: a change in Settings > Display,
  **and a push that changes the Form control's own Width**. Both rewrote every card's Width to a
  literal and reflowed the cards one per row (and dropped MinScreenWidth). Pushing the identical
  source a second time, with the form already at the new size, kept the formulas. So after any
  size change: sync, compare a card's `Width`, and re-push if it became a number.
- **The full-page Edit view** (`EditForm.aspx?ID=n`) adds SharePoint's Comments pane, which
  narrows the page so a Landscape frame scrolls sideways. The New page and the dialog do not.

## 6. Pages, a summary and actions in a form

- **Pages (tabs) by card visibility.** A horizontal gallery of tab names sets a variable; each card
  gets `Visible: =Coalesce(gblTab, "details") = "<tab>"`. Hidden cards collapse out of the layout,
  keep their grid, and **still submit**, so SharePoint's one Save writes every tab. Reset the tab in
  `OnSuccess` and the form's `OnReset`.
- **A required card on a hidden tab.** SharePoint checks validity before it submits and shows a
  banner naming the field ("Field(s) with problems: 'Category'"); the form's `OnFailure` does not
  run, so it cannot switch tabs. Put a checklist in view that names what is missing and jumps to its
  tab on select.
- **A summary beside the form follows unsaved edits.** Controls outside the Form can read the
  cards' controls (`<combo>.Selected.Value`, `<date>.SelectedDate`, `<text>.Text`), so status pills,
  a capacity bar or a variance update before Save. App.Formulas cannot reference controls, so hold
  a shared aggregate (a week's total from a delegable date filter) in one hidden label's `Text` and
  read `Value(<label>.Text)` elsewhere: the list is queried once, not once per control.
- **Lock captions.** Append who sets a field to its key label when the card is disabled:
  `Parent.DisplayName & If(Parent.DisplayMode = DisplayMode.Disabled, "   (set by <role>)", "")`.
- **Actions beyond SubmitForm work.** A full Patch workflow (patch this item, create related items
  with ForAll, then link them) ran in the form unchanged from the canvas app, reading the saved item
  with `LookUp(DS, ID = SharePointIntegration.Selected.ID)`. End it with `ResetForm(<form>);
  RequestHide()`: otherwise a later Save writes the form's now-stale values over what the action
  patched. Tell the user the form closes, and that the action uses the saved item.
- **`SharePointIntegration.Selected` is the item being edited**; in New mode it can hold the last
  item opened. Gate anything that reads it on `SharePointForm1.Mode <> FormMode.New`.

## 7. Shipping and verifying a form

- **Publishing is "Publish to SharePoint"** (the publish dialog's button), not "Publish this version".
  `canvas-browser.mjs publish` recognises and clicks it in any frame (0.39.0); it then reads Studio's
  "All changes are saved and published." notice. A form app has no Dataverse `lastpublishtime`, so
  the proof is the form's build stamp read in the list.
- **A push does not mark Studio dirty here either** (`canvas-shipping.md`, section 4): make a trivial
  edit, Save, read the save time, then publish. Studio's "Publish successful" toast can show an
  earlier publish; judge by the form itself.
- **Put a build stamp in the form, with App.Width**, visible to the owner only
  (`"Form build <id>, " & App.Width & " px"`). After a publish the list served the previous build on
  the first one or two reloads, and the dialog size lagged one publish. Read the stamp after each
  reload; space the reloads (quick reloads got the site throttled: `Throttle.htm`, then connector 429
  and 504).
- **A throttled walk proves nothing.** Under throttling the player showed a banner naming
  `Throttle.htm` ("does not match any known API routes"), and a save then said "Item saved." while the
  item was unchanged on REST; the same walk passed ten minutes later. `canvas-browser.mjs walk` reports
  such a run INVALID (exit 13) and stops the rest of the call. Wait, then repeat one walk call.
- **Walks spend the signed-in person's quota.** The walks run as the person's own account, and
  SharePoint throttles per person: about fifteen player loads plus Studio and REST reads in two hours
  left the owner seeing the throttle error in normal use the next morning. Budget the loads (one walk
  call per build, several scenarios in it, reloads spaced), and say in the hand-back that the walks
  used their account, so an error they meet afterwards has a known cause.
- **Walk it in the list**: New from the command bar (the form sits in two frames,
  `webPlayer-iFrame-1` then `fullscreen-app-host`), or `NewForm.aspx` / `EditForm.aspx?ID=n` as full
  pages. Save is SharePoint's own command bar button, outside the frames. Read the item back over
  `_api/web/lists/getbytitle('<list>')/items(<id>)` with the internal column names, and recycle test
  rows with `items(<id>)/recycle()` and a request digest.
- **Studio's Fields pane** (Add field) needed `click({force: true})` on the field checkboxes.
- **Modern combo box popups** in the player were not reachable by locator from the outer page;
  click them by coordinates read from a fresh screenshot.

## 8. Saving and deleting items from an app

- **Hide a required column by writing it silently, never by dropping it from the write.** Removing a
  required choice column from a canvas app's `Patch` (to hide it from the app) made every save fail in
  the player with "Field '<column>' is required", new items included. The compile and the app checker
  said nothing; only performing the save found it. Keep the column out of the UI and keep writing it:
  the item's own value on edit, the column's default on a new item
  (`Category: If(IsBlank(rec), {Value: "Standard"}, rec.Category)`). In a form app, move the card to a
  tab that is never shown, so `SubmitForm` still sends it (section 6). Before removing any column from
  a write, read its `Required` flag (`_api/web/lists/getbytitle('<list>')/fields?$select=InternalName,Required`).
- **`Remove()` sends a SharePoint item to the site recycle bin.** `Remove(Orders, LookUp(Orders, ID =
  x))` from a canvas app left the item in `<site>/_api/web/RecycleBin` (with the list's folder as
  `DirName`), so a site owner can restore it; prove a delete with that read, not only with the item's
  absence. Put a confirmation before it: a dialog that names the item and counts the items that link
  to it (a parent or predecessor lookup, which resolves blank after the delete), then `Remove` and
  check `Errors(Orders)` before closing the dialog.
