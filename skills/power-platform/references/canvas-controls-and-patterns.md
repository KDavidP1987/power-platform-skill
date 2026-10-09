# Canvas controls and screen patterns: behaviour the source does not show

Every item here compiled clean and passed audits before someone performing the task found it.
Formula-language traps, delegation and `.pa.yaml` syntax are in `power-fx-and-pa-yaml.md`; layout
geometry (clipping, row pitch, z-order, dead clicks) is in `canvas-layout.md`; driving controls with
Playwright is in `browser-verification.md`.

## Contents

1. Control property facts
2. TextInput and live search
3. Inputs: Default, Reset and OnChange
4. CheckBox: initial state
5. ComboBox: pickers
6. DropDown and DatePicker
7. Gallery
8. Timer
9. Changing or repurposing a control
10. Screens, navigation and overlays
11. Large data: read models and scoped collections
12. Saving: write handlers, concurrency, partial failure
13. Permission gating in canvas
14. Errors and diagnostics users can see
15. UX and data honesty
16. Lists: filter, search, group, sort
17. Communications: last sent, history and resend
18. Template guide and live preview for administrators

---

## 1. Control property facts

Modern (Fluent) and classic controls take different property sets, and documentation often
describes the other one. These were rejected or accepted by the compiler in real apps; control
versions move, so settle doubt with `describe_control` (`power-fx-and-pa-yaml.md`, section 12) or by
copying a working control from the same app.

| Control | Does NOT take | Use instead / note |
|---|---|---|
| Modern Button | `Tooltip` (hard bind error), `Size`, `TabIndex`, `Weight` | `AccessibleLabel`; text scales with `Height`; focusable by default |
| Modern Button, `Appearance` Secondary | honours `BasePaletteColor` (computed colours identical for two palettes) | switch `Appearance` (Primary honours the palette) to signal state |
| Modern TextInput | `Default`, `HintText`, `Format`, `Size`, `VerticalAlign`, `DelayOutput`; `Mode: =TextMode.MultiLine` compiles and is ignored (one line) | `Value`, `Placeholder`, read back as `.Value`; `TriggerOutput` (section 2); pad instead of aligning; `Mode: ='TextInputCanvas.Mode'.Multiline` |
| NumberInput | `Size` | `FontSize`; `Step: =0` to remove the spin arrows (section 3) |
| Modern DropDown | `Tooltip`, `Value`, `DisplayFields` | shape `Items` to one `Value` column with `Distinct()` or a literal `Table`, not a `ForAll` projection (section 6) |
| Fluent Text | `FontWeight`, `Radius*` | `Weight`, `BorderRadius*` - the way to draw a rounded pill (a classic Rectangle has no radius) |
| Modern DatePicker | - | `SelectedDate`; the control is `DatePicker`, not `DatePickerCanvas` |
| ComboBoxDataField | `DisplayName`, `Value` | `FieldName`, `FieldType`, `FieldDisplayName`; the control is not `ComboBoxField` |
| Classic CheckBox | `AccessibleLabel` | its `Text` is the accessible name |
| Classic Label | `AccessibleLabel` | `Text` is the name; takes `Tooltip`; a clickable Label needs `TabIndex: =0` |
| Classic DropDown | - | takes `Tooltip` |

- **Fluent "Subtle" buttons are unreadable on dark bars.** On a navy header they rendered grey chips
  with unreadable text. Navigation items, tabs and back-links built as classic Labels with an
  explicit `Color`, an `OnSelect` and `TabIndex: =0` gave guaranteed contrast. A count badge can live
  in the label text ("Approvals (3)", capped at "9+") without re-laying out every screen.
- **`TabIndex`/`FocusedBorderThickness` on classic Button and DropDown** were reported rejected in
  one review and not re-tested; check with `describe_control` before mass-applying.
- **Image, Icon and Gallery need an explicit `AccessibleLabel`** - there is no text to fall back on.
  Row buttons labelled only "Edit" need the record's name in the accessible label.
- **Do not give a dismiss scrim a tab stop, or a labelled control a second name.** What an
  accessibility audit should flag and exempt is in `audits.md`, section 11.

- **A Radio group needs the height of all its options.** A classic Radio sized like a text input
  clipped its circles top and bottom and drew a scroll arrow beside the last option, at desktop and
  phone width alike, and the build's own 390 px sweep still called the screen clean. Height = options
  x row height (about 40 per option at Size 13) plus padding, or `Layout.Horizontal` with enough
  width; screenshot the control, since a clip check on text alone does not see clipped circles.

## 2. TextInput and live search

- **A modern TextInput publishes `.Value` on blur by default.** A list bound to a search box does
  not move until the user clicks away, which cost one project two rewrites of a search that was
  never broken. For a search box set the trigger explicitly:

  ```yaml
  - txtSearch:
      Control: TextInput
      Properties:
        Placeholder: ="Search orders"
        TriggerOutput: ='TextInputCanvas.TriggerOutput'.Keypress
  ```

  `Delayed` (publishes after a short pause) also worked and is kinder to a server-side query. Leave
  comment and note boxes on the default. Automation that types must still commit the value
  (`browser-verification.md`).
- **`DelayOutput` is a classic property.** Adding it to a modern TextInput fails ("Unknown property
  'DelayOutput'"). If you convert to `Classic/TextInput` instead, the mapping is four-part:
  `Value` -> `Default`, `Placeholder` -> `HintText`, drop `Type`/`Appearance`, and every `.Value`
  read -> `.Text` - scoped **by control name**, because sibling checkboxes and number inputs
  legitimately keep `.Value`. Add `Clear: =true`. Prove it with real keystrokes, not a fill.
- **A search test must target a record that is not row 1** - see `browser-verification.md`.
- **Do not gate a Save button's `DisplayMode` on a modern TextInput.** The box publishes `.Value`
  when it loses focus, so a button disabled until `Len(Trim(txtUrl.Value)) > 0` is still disabled at
  the moment a person types and reaches for it (a test that fills without `Tab` sees the same). Keep
  the button enabled and validate in its `OnSelect`:

  ```
  If(IsBlank(Trim(txtUrl.Value)),
     Notify("Enter the link before saving.", NotificationType.Warning),
     Patch(...))
  ```

  The click itself blurs the box, so `OnSelect` reads the committed value. This is the form of
  "a disabled control must say why" (section 15) for inputs.
- **Multi-line on a modern TextInput is `Mode: ='TextInputCanvas.Mode'.Multiline`.** The classic
  `TextMode.MultiLine` compiles with no diagnostic and the box renders on one line; it was seen in the
  player on two screens. `check-canvas-format.mjs` reports `textmode-on-modern-input` (an error, so
  the write hook refuses it).

## 3. Inputs: Default, Reset and OnChange

- **An input's `Default`/`Value` applies only at load and at `Reset()`.** An edit screen entered
  with `Set(gblRec, ThisItem)` showed record A's unsaved edits when record B was opened, while the
  database held B's values; Save would have written A's edit onto B. Reset every input in the edit
  screen's `OnVisible`, in order: first inputs whose `OnChange` writes a context variable, then seed
  the context variables, then reset the inputs that read them. Verify by opening two records in
  sequence.
- **Context variables persist per screen for the whole session.** An overlay left open on one record
  reappeared, open, on a different record. Reset overlay state in `OnVisible` too.
- **`Reset()` in the same chain as the `UpdateContext` that feeds the Default can restore the OLD
  value** - the Default has not re-evaluated yet (worse when the update is nested in `With()`,
  `power-fx-and-pa-yaml.md` section 8). Write `UpdateContext(...)` as a plain statement, seed the
  control in the same `UpdateContext` that makes it visible, and `Reset()` last. Binding a small
  editor to a one-row collection was a working alternative.
- **After Save, a MODERN input can show the value from before the edit, and `Reset()` last does not
  fix it.** A NumberInput bound to `locPoints`, edited 1 -> 2 and saved: the row held 2, the variable
  held 2, the box showed 1, and saving the screen again would have written 1 back. The control keeps
  a snapshot of `Value` and refreshes it only when `Value` changes to something other than what it
  displays; the reload set the variable to exactly what the box already showed, so the snapshot stayed
  stale and the reload's `Reset()` restored it. Moving the `Reset()` before the `UpdateContext` in the
  reload did not help either. What worked: `Reset()` every input in the SAVE formula, before the
  queued `Select(btnLoad)` - the boxes drop back to the old values, and the reload's change is then a
  real change they apply. Opening a different record first hides the bug, so test it by saving a
  change and reading the box, in both directions.
- **NumberInput spin arrows change the box, not `.Value`.** A click on an arrow moved the display
  from 38888 to 38889 while `.Value` stayed 38888; Save pressed next wrote 38888 (pressing `Tab`
  first commits). No property hides the arrows, but `Step: =0` makes the player draw none - one app
  set it on 67 inputs and a typed save then wrote the typed number. Set `Step: =0` on every amount
  input; `check-canvas-format.mjs` warns `number-spin-arrows` where it is missing. A browser test of
  a NumberInput must drive the real mouse on the real control, because a `fill()` never meets the
  arrows (`browser-verification.md`).
- **`Reset()` cannot reach a control that is not rendered**, and a control hidden at load never
  applies its Default (section 4).
- **An input fires `OnChange` when its bound value RESOLVES, not only when a person types.** A
  NumberInput in a gallery template with a per-cell `Patch` on `OnChange` passed compile, eight
  audits and the write-path and permission audits; opened in Preview with nothing touched, the
  status already read "Saved". 156 live rows had `modifiedon` bumped within a minute with no value
  changed - one write per visible row per re-render - caught only because the column happened to be
  empty. **Never put a write on a bound input's `OnChange`, and never write when a screen opens**;
  write on an explicit Save the user presses.
- **An overridable calculated field.** A "touched" flag set in `OnChange` does not work (a `Reset`
  re-fires `OnChange`). Seed the Default from a context variable, recompute only while the value
  still equals the seed, and add a "use calculated value" button.

## 4. CheckBox: initial state

- **A modern CheckBox ignores `Checked:` as a starting value.** `Checked: =true` compiled, packed and
  published, and rendered unchecked; every record created through that form silently wrote false.
  (`Checked: =false` is harmless - it renders false anyway.) Use `Classic/CheckBox` with `Default:`
  where the initial state matters, read as `.Value`.
- **That is necessary but not sufficient: a checkbox hidden when the screen loads never applies its
  `Default`.** On a tab or panel whose `Visible` was false at load, the Default never took, and
  `Reset()` on the unrendered control was a no-op. On a hidden settings tab the same bug would have
  written false over a setting nobody touched.
- **The pattern that holds:** keep the state in a context variable set by whatever opens the form;
  `OnCheck`/`OnUncheck` write clicks back to it; Save reads the variable, not the control. For an
  on/off setting, a Button whose caption is computed from the stored row and whose `OnSelect`
  patches the opposite value has no state to lose. Audit rule: a checkbox with a formula `Visible`
  and an initial state must define both `OnCheck` and `OnUncheck`. Prove by reading back true, false
  and blank from Dataverse.

## 5. ComboBox: pickers

- **A modern ComboBox with no `ComboBoxDataField` child renders an EMPTY list**, silently - compiles,
  audits and ships clean. The obvious diagnosis ("my collection is empty") is wrong; the tell is
  the list is empty **even with the search box cleared**. Shape:

  ```yaml
  - VendorPicker:
      Control: ComboBox
      Properties:
        Items: =Sort(colVendorChoices, Label)
        IsSearchable: =true
      Children:
        - VendorPickerField:
            Control: ComboBoxDataField
            Variant: textualColumn
            IsLocked: true
            Properties:
              FieldDisplayName: ="Label"
              FieldName: ="Label"
              FieldType: ="s"
              Order: =1
  ```

  Over a collection, give it one explicit label column and point at that.
- **`ComboBoxDataField.FieldName` is a raw string with no bind check.** Repoint a picker to another
  table and a stale `FieldName` compiles clean and renders a blank column. Grep every `FieldName:`
  when repointing a data source.
- **With no declared display field, a picker over a table whose primary name is an autonumber code
  falls back to showing the row GUID.** A table-bound modern DropDown in that situation is better
  converted to a searchable ComboBox.
- **A collapsed ComboBox shows only its first display field.** To show "number - name", build ONE
  label column. An inline `AddColumns(T, Label, Number & " - " & Name)` is fine at 22 rows but is not
  delegable: at 2,282 rows the projection fetches the 2,000-row maximum and silently drops the rest
  from list and search. Store the label as a real column, backfill it idempotently, and re-run the
  backfill after every bulk load that changes its parts (it moves `modifiedon` on every row it
  writes).
- **How many items a modern ComboBox can search - test it.** With `Items` bound to a large
  COLLECTION, one app found search reached only about the first 900 items, silently, with no
  property to raise it: rows past that were unreachable by typing and scrolling alike. Another app
  bound a ComboBox directly to a delegable Dataverse table (2,282 rows) with `IsSearchable` and
  concluded that search delegates and row count does not matter - never tested past row 900. Before
  relying on either, search for an item past row 900 in the browser. Either way, keep everyday
  pickers small (filter candidates on the server, open items only) and give the rare case its own
  narrow opt-in read. The classic ComboBox does not delegate `SearchFields` on Dataverse and rendered
  rows blank over a delegated `Items`.
- **Above the row limit, a picker is a TextInput plus a gallery.** The pattern: a modern TextInput
  with `TriggerOutput` `Delayed`; a gallery with
  `Items: =SortByColumns(Filter(Vendors, StartsWith('Vendor Name', txtVendor.Value)), "app_name")`,
  visible from two typed characters; an empty-state label. Because modern inputs paint over a gallery
  whatever the declaration order, the results list cannot overlay the form - push the controls below
  down with a hidden spacer whose `Height` equals the list's (`canvas-layout.md`). For a directory
  search, `fullname` is first-name-first; say so in the hint.
- **`Combo.Selected` read inside a `Filter` over a collection overflowed the player's call stack.**
  Reading a modern ComboBox's `Selected.<field>` in the predicate of a `Filter` over a collection with
  a record-typed column threw `RangeError: Maximum call stack size exceeded` in the published player:
  the list was empty, nothing showed on screen, the compile was clean. Copy the selection into a
  context variable in the box's `OnChange` and filter on that (observed in one app; mechanism
  unconfirmed). Check the player console when a filtered list is unexpectedly empty.
- **A ComboBox over `Choices(...)` yields records**; `Patch` wants `Combo.Selected.Value`.
- **Multi-select predicates**: `r.Region.Name in cmbRegion.SelectedItems.Value` works; test
  emptiness with `CountRows(cmbRegion.SelectedItems) > 0`, not `IsBlank`.
- **A single-select ComboBox gives users no way to clear it** (unverified across versions). Filter
  screens need an explicit Clear that resets every filter.
- **`DefaultSelectedItems` fed from a lookup read off a row is a partial record**
  (`power-fx-and-pa-yaml.md`, section 5): blank second columns, or a GUID.
- **One picker for "All", "None" and real records: sentinel ids.** A filter that needs "All work",
  "No project" and each project builds one collection with two fixed rows ahead of the records, so
  the selection is always an id and every formula compares ids:

  ```
  Set(gblAll,  GUID("00000000-0000-0000-0000-000000000000"));
  Set(gblNone, GUID("00000000-0000-0000-0000-000000000001"));
  ClearCollect(colProjPick, {Id: gblAll, L: "All work"}, {Id: gblNone, L: "No project"});
  Collect(colProjPick, ForAll(colProjects As p, {Id: p.Id, L: p.Name}))
  ```

  On save, write `If(sel <> gblAll && sel <> gblNone, LookUp(Projects, Project = sel))` - blank for
  both sentinels. On a form whose field is optional, a "None" row is clearer than a picker the user
  cannot clear (above). The query side, where "None" is a blank lookup, is in
  `power-fx-and-pa-yaml.md` section 5.
- **A picker that fills slowly reads as broken.** One that filled only after several queries showed
  an empty box for tens of seconds; its placeholder now says "Still loading..." and then the count.

## 6. DropDown and DatePicker

- **A classic DropDown always presents a value on first render** - its first item. Two filter
  dropdowns switched themselves on at load and emptied the screen; an entry dropdown stamped the
  first region on every new record. `Default: =""` did not fix it. For a FILTER, give the list a
  leading blank row: `ClearCollect(colRegionFilter, {Value: ""}); Collect(colRegionFilter, ...)`.
  For ENTRY, use `AllowEmptySelection` so it starts blank, plus an explicit "picked" flag that gates
  Save. `AllowEmptySelection` adds no blank row, so once a value is chosen "not set" is unreachable -
  add a Clear button that writes Blank.
- **Screens that "showed nothing until Clear was pressed"** were fixed by having `OnVisible` perform
  the same `Reset()` calls as the Clear button. `.SelectedItems` is not reliably initialised when
  `OnVisible` runs, so a collection built from it there can be empty (mechanism inferred).
- **Changing a filter dropdown's display text can silently filter everything out** when a value is
  compared downstream; classify every use before a rename (`power-fx-and-pa-yaml.md`, section 4).
- **DropDowns over small text collections, resolved back to a record by name in `Patch`**
  (`LookUp(Teams, 'Team Name (app_name)' = ddTeam.Selected.Value)`) sidestep display-column
  ambiguity - but only while names are unique in the target table (section 15).
- **Feed a modern DropDown `Distinct()` or a literal `Table`, not a `ForAll` projection.** A person
  picker with `Items: =ForAll(Sort(colRoster, Name) As r, {Value: r.Name})` listed numeric keys
  (4998, 5009 ...) in the published player, both with the full record and after projecting to one
  `Value` column. `Sort(Distinct(colRoster, Name), Value)` showed the names and the assignment saved.
  `check-canvas-format.mjs` warns `dropdown-forall-items`; resolve the pick back to a record by name
  as above, so the names must be unique.
- **A DatePicker cannot exclude days.** Where a value must be, say, a week start, offer a dropdown of
  valid dates ("Week beginning 6 Oct 2025") rather than a DatePicker that can only be corrected after
  the fact.
- **Use the control type Studio itself writes.** The authoring server accepted and compiled both
  `DatePicker` and `ModernDatePicker`; Studio's Insert > Date picker serialises as
  `ModernDatePicker` (input `DefaultDate`, output `SelectedDate`, enums `Appearance.Outline`,
  `DatePickerFormat.Short`). Before generating a control type the app has never contained, insert
  one by hand, `sync_canvas` into a scratch folder and copy its name and properties. Use the short
  format in narrow cells - the long format truncated on a phone. In the player the calendar's days
  are buttons named like "15, October, 2026", which is how automation picks one.
- **A canvas DropDown renders as a `<select>` with no accessible name**; automation addresses it by
  index (`browser-verification.md`).

## 7. Gallery

- **Gallery-level `OnSelect` may not fire on a row click in the player.** Give each row a visible
  "Open" button; the overlay alternative and why transparent buttons fail are in `canvas-layout.md`
  section 3.
- **A template child written in `.pa.yaml` does not pass its click to the row.** Studio gives a
  control it inserts into a gallery `OnSelect: =Select(Parent)`; a control written in source has no
  `OnSelect`, so a click on a row's label did nothing and the gallery's `OnSelect` never ran. Give
  every label, image and shape in the template that a person can click on `OnSelect: =Select(Parent)`:

  ```yaml
  - galPeople:
      Control: Gallery
      Properties:
        OnSelect: =Set(locSel, ThisItem)
      Children:
        - lblName:
            Control: Label
            Properties:
              Text: =ThisItem.Name
              OnSelect: =Select(Parent)
  ```

  `check-canvas-format.mjs` warns `row-click-lost` on a gallery with an `OnSelect` whose template
  text or shapes have none. An accessibility audit should not flag those children as mouse-only: the
  row itself stays keyboard-selectable (`audits.md` section 11).
- **Use `AllItemsCount`** for counts and empty states (`power-fx-and-pa-yaml.md`, section 9).
- **Guards built on a control's state die with the control.** A duplicate check counting
  `Grid.AllItems` could never fire while the grid was broken (empty AllItems), so it silently allowed
  duplicates. Derive guards from the data source.
- **Nested galleries**: pass the outer row in with `With({ln:ThisItem}, AddColumns(...))`
  (`power-fx-and-pa-yaml.md`, section 8).
- **Gate tab content on `Visible`, not only `DisplayMode`.** Two Request buttons gated only by
  `DisplayMode` were both visible and stacked at identical coordinates, so a click could hit the wrong
  handler.

## 8. Timer

- **A background refresh timer**: `Repeat: true`, `AutoStart: true`, `Visible: false`, a duration of
  60-120 s. `OnTimerEnd` should only call an existing reload, and only when no panel is open, no
  editor is up and no input holds text - a `ClearCollect` under a half-typed note loses it. An
  undismissed message panel is a gate like any other.
- **Browsers throttle timers in background tabs**, so a timer test in a background tab appears to
  fail. Keep the tab under test in front.

## 9. Changing or repurposing a control

- **Changing a control's TYPE needs a new control name.** Converting a TextInput to a ComboBox under
  the same name compiled, bound and passed every audit, and the packaged `Controls/*.json` even
  carried X 56, Y 248 - yet the authoring service kept the old control and applied only the
  properties that suited it, so Studio rendered it at 0,0, 320x32 on template defaults, with geometry,
  appearance and accessible label discarded. Rename the control (and its data-field children) and
  every reference to it.
- **Repurposed controls can fail to paint too.** Same-type controls moved into a different layout
  rendered their panel and not their body until renamed - once, twice in a row. Renaming is free.
- **Leftover properties of the old type break the compile** (`AllowEmptySelection` left on what is
  now a TextInput). Re-check the whole property set after any type change.

## 10. Screens, navigation and overlays

- **A result message must not cover navigation.** A full-width toast under the masthead sat over
  the Back link, so the next action after any save was blocked until it was dismissed. Right-align
  it at a bounded width (`Min(contentWidth, 560)`), let a long message wrap to two lines, dismiss it
  on select, and **clear it in every `Navigate`** so a stale result never greets the next screen.
- **Navigate by key, and let the target screen look the record up.** Every entry point sets a key
  (`Set(gblOrderKey, ThisItem.Order)`) and the destination's `OnVisible` does one delegable `LookUp`
  on the source. Passing a record taken from a collection breaks the day that collection is narrowed
  ("active only"): `LookUp(colOrders, ...)` returns blank for a completed item that a delegable
  gallery can still show. It also removes hand-copied projections across entry points - which is how
  one navigation item silently fell out of five screens.
- **Re-resolve by id, never by display name.** An editor that re-found a category by label, where
  two active categories shared a name, preselected the wrong one; saving would have moved spend
  between cost centres with nothing visible on screen (section 15).
- **Return context: stamp it on the way in.** An edit screen left to different places depending on
  the button (Save used `Back()`, Cancel a hard `Navigate`). `Back()` is not a general fix: a
  sub-screen visited from the editor pushes onto the stack, so Save's `Back()` returned to the
  sub-screen. Stamp a return-target global at each entry point, have every exit honour it, and switch
  the back button's caption with it. A value set at the call site before `Navigate` is overwritten by
  the target's `OnVisible` if that recomputes it - use an explicit "wanted" flag that `OnVisible`
  consumes.
- **`OnVisible` fires on `Back()`.** A tab variable reset there throws users to the first tab, and a
  list screen that reset its filters there lost them on every return. Keep the tab global and reset
  it only when the target record changed; set filters on first visit only. A fix here changes every
  entry point: a "remember the last tab" fix moved where two other entry points landed, and an
  `OnVisible` reset collided with a later "keep my filters after editing" request (resolved with a
  flag set on every exit path, including Cancel). Review every entry point and every consumer of a
  changed variable.
- **Each tab loads its own data on arrival.** A picker fed by a collection that another tab's Load
  button built was empty, with no explanation, for anyone who went straight there. Each tab calls its
  own loader; a Refresh button calls each in turn.
- **Use an overlay, not a separate screen, when unsaved state lives on the screen.** Navigating away
  and back re-runs `OnVisible` and discarded staged rows, so reference panels became overlays on the
  editing screen. An overlay shares its screen's Save scope.
- **Folding a screen into an overlay** (also the way to stay under the file ceiling,
  `canvas-shipping.md`): check app-wide control-name collisions; move the controls verbatim, keeping
  absolute X/Y, over a full-screen backdrop; gate every top-level moved control on one context flag
  (gallery children inherit); entry becomes `UpdateContext({locOverlay:true})` and Back becomes Close.
  **An overlay has no `OnVisible`**: move that logic into the opening button's `OnSelect` (and check
  any recompute the overlay needs already exists). Delete the screen file and confirm no
  `Navigate(<Screen>` remains.
- **A hidden advanced filter keeps filtering.** Collapsing the panel only toggled visibility; its
  controls kept their values and the gallery kept applying them, so the visible dropdowns looked
  dead. Show "(2 on)" on the toggle, derived from the same accessors the predicate uses, and make
  Clear reset every filter, including "show inactive" checkboxes.

## 11. Large data: read models and scoped collections

- **Portfolio views read pre-aggregated rollup tables; detail loads per parent.** When detail volume
  exceeds the row limit (`power-fx-and-pa-yaml.md`, section 7), keep detail scoped to one parent and
  have portfolio screens read denormalised rollup ("read model") tables - for example parent x year x
  scenario, plus period x scenario with no parent key to keep it small. Rules learned:
  - A rollup must carry every dimension any consuming view groups by - read all consumers first.
  - The filter it is read with must itself be delegable, so ride status and active flags onto the
    rollup row; a table with no parent key cannot be filtered by parent attributes, so scope it at
    build time and adjust by hand on a status change.
  - Maintain it on save with a delta (and mirror the delta into the in-memory collection), and keep
    an idempotent server-side rebuild that follows `@odata.nextLink` - reading one page reintroduces
    the truncation it exists to remove - and checks each read model's size against the limit.
  - Never hard-code flags in the maintenance: a save path writing `IsActive: true` would have pulled
    finished work into totals on any edit.
  - Reconcile rollup totals to source to the cent, and prove the delta logic by performing an edit
    and its revert, landing exactly on the baseline (`browser-verification.md`).
  - A Dataverse rollup column is not a substitute: it recalculates on a schedule, reads stale straight
    after an edit, and cannot follow an app-chosen period (`dataverse.md`).
- **One definition of "active", stored on the row.** Two collections filtered "active" on two
  different status columns and disagreed on live data, so one record was in some totals on a screen
  and not in others beside them. Store one flag computed by one rule, mirror it onto child rows so
  loads filter on a plain delegable boolean, and have the app's save path, the backfill and the
  rebuild compute the same rule.
- **Split a collection rather than filter it: excluded from totals is not unreadable.** Scoping a
  shared collection to active records would have emptied the detail screen for every inactive one.
  Keep an active-only portfolio collection plus a per-record collection loaded in the detail
  screen's `OnVisible` on a delegable key. The two must share an identical projection - a field
  present in one and absent in the other is a runtime error on whichever screen reads it.
- **A membership-by-id collection beats a two-hop traversal.** Resolve "records I have a stake in"
  once in `OnStart` (owner, contact, leader of the record's cost centre) into `colMine`, then gate
  with `!IsBlank(LookUp(colMine, Id = ThisItem.Id))`.
- **Build screens against mock collections in the final shape, then rebind by rewriting only
  `OnStart`.** One app's first build ran on sample rows; rebinding to Dataverse projected the live
  tables into the same shapes with no screen edits, isolating choice coercion and lookup navigation
  in one place. The cost: whole-table collection reads that later had to be scoped.
- **Group once, load once, invalidate on write, never show a part total.** A per-row
  `Filter(colLines, Key = r.Key)` inside `ForAll(colParents As r, ...)` is O(parents x lines): at 269
  parents and 3,228 lines a screen took about 3 minutes to open. One `GroupBy` pass over the lines
  and a `LookUp` per parent did the same work in about a second:

  ```
  ClearCollect(colByParent, AddColumns(GroupBy(colLines, Key, grp), Total, Sum(grp, Amount)));
  ClearCollect(colRows, ForAll(colParents As p, {Key: p.Key, Name: p.Name, Total: Coalesce(LookUp(colByParent, Key = p.Key).Total, 0)}))
  ```

  Pair it with a load-once cache: keep the key it was built for (`Set(gblRowsFor, gblSelectedYear)`)
  and rebuild only when the key differs, and have every save that touches the lines clear that key,
  so the next visit rebuilds. While it builds, show a Loading state in place of the figures: a total
  drawn from half-loaded collections is a wrong number that looks right. The per-cell form of the same
  cost is in `power-fx-and-pa-yaml.md` section 9.
- **A "who is missing" list needs its own query.** A not-submitted list computed as roster minus
  whatever the filter bar had loaded made everyone else "missing" when one person was selected. Any
  whole-population question (missing, overdue) issues its own query, independent of the view.

## 12. Saving: write handlers, concurrency, partial failure

- **Create-and-select needs a fallback.** `Set(rec, Patch(T, Defaults(T), {...}));
  Set(gblSelId, rec.'Primary Key')` left one newly created row unselected, while the identical
  pattern worked on two other tables in the same app. Reload the list, then select
  `Coalesce(LookUp(colList, Id = rec.'Primary Key').Id, First(Sort(colList, CreatedOn, SortOrder.Descending)).Id)`,
  and test creation on every table that uses it.
- **Every save handler refreshes the table it patched.** A sweep found 24 save-and-return handlers
  across 17 editors and none called `Refresh`; the reported screen was just the one someone hit.
  Refresh at the write, not in the list's `OnVisible`, so every destination - including reopening the
  same record - is current. Totals built from a session collection go stale the moment a row is
  patched; rebuild or hide them.
- **Recompute whatever gates the button after a state-changing write.** Edit flags computed on
  arrival were not refreshed after Submit, so the grid stayed editable and a second press wrote and
  logged a second submission. Re-run the gating reads after a successful `Patch` (or navigate away),
  back it with an alternate key, and test by pressing twice.
- **Upsert per-period records.** A "post monthly status" action that always used
  `Patch(T, Defaults(T), ...)` created a second row every time a user revised the same period. For
  anything unique per (parent, period), look the row up and patch it:

  ```
  Patch(Facts,
        Coalesce(LookUp(Facts, Line.Line = gblLineKey && Period.Period = gblPeriodKey), Defaults(Facts)),
        {Amount: Value(txtAmount.Value)})
  ```

  When the row is new, also set its lookups and a primary name. Iterate the calendar or definition
  table, not existing fact rows; skip blank-and-absent cells so Save does not manufacture empty rows;
  guard against a blank period. `ForAll(Table({p: ..., v: ...}, ...) As r, ...)` writes twelve periods
  in one formula.
- **Recompute derived child rows in place; do not delete and recreate them.** A header's frozen
  cost grid, month grid or approval rows are recomputed when the header changes. Deleting them and
  writing new ones loses columns people entered on the children and signatures already given. Load
  the existing children into a collection, then upsert each key and retire the ones that dropped out:

  ```
  ClearCollect(colEx, Filter(app_OrderLines, Order.Order = gblOrderId));
  ForAll(colNew As n,
    Patch(app_OrderLines,
          Coalesce(LookUp(colEx, Key = n.Key), Defaults(app_OrderLines)),
          {Key: n.Key, Amount: n.Amount, Order: gblOrder}));
  ForAll(Filter(colEx As e, IsBlank(LookUp(colNew, Key = e.Key))) As gone,
    Patch(app_OrderLines, gone, {Amount: 0}))
  ```

  Approval rows no longer needed are set to a "Not Required" status rather than removed. The result
  is idempotent - run it twice and nothing changes - and it keeps entered columns and signed rows.
  Measured on one build: 18 cost rows and 4 month rows reconciled to the header after a recompute.
- **`If(cond, Patch(...))` with no else skips silently.** A copy-forward written as
  `If(!IsBlank(target), Patch(...))` skipped every source row without a target (20% of rows) while its
  toast reported the SOURCE count. Add the create branch, and report what was WRITTEN as a
  before/after difference, not what was read.
- **Multi-step `Patch` chains are not atomic - order them so a failure skips rather than destroys,
  and re-read before reporting.** A save that closed the current effective-dated row and then opened
  the next failed between the two, leaving zero current rows while saying "Nothing was written"; it
  now re-opens the row it closed on failure. A submit that patched the header and then failed left a
  record submitted-but-not-locked while the app said "Nothing was submitted". Both error branches now
  re-read the row and report what landed. Put a dependent rewrite where a failure of the first step
  skips it (not in its else branch, where it runs after the failure).
- **Effective-dated checks use the record's date, not `Today()`.** An approval screen tested a
  delegate's cover against today instead of the period being approved - it allowed lapsed cover and
  refused valid future cover. Validate a new effective date against the subject's whole history; a
  change on the same day a window opened is a correction in place (closing at `Today() - 1` gives an
  end before the start).
- **Every save path needs the same validation.** The user's Submit validated everything; a manager's
  "save on behalf" path validated nothing, and users found it by entering bad data. Use the identical
  guard expression inline on every button that writes the record.
- **The staging-collection submit** for a multi-line entry grid: an add-row form validates the line,
  `Collect`s it into a local staging collection the gallery binds to, and Submit runs one
  `ForAll(colStage As r, Patch(...))` - safe because it iterates a collection, not the table it
  patches. Pair it with the concurrency check and an alternate key.
- **A warning dialog's "Yes" must resume the action.** A confirmation whose Yes only set an
  "acknowledged" flag and closed, expecting a second press of Submit, was reported as "submit does
  nothing". Have Yes run the action - `Select(btnSubmit)` guarded by a resume flag is safe here
  because nothing after it depends on the result. Prove with one click and a database read.
- **Optimistic concurrency without a platform lock.** `Patch` is last-writer-wins, and a
  delete-lines-and-rewrite save silently replaced another person's save. Three layers worked:
  - *Signature check at save.* At load, record a signature: header status, lock and total, plus line
    count and newest line `Modified On` (`First(Sort(Lines, 'Modified On', SortOrder.Descending))`).
    Re-read it **inline** - not via `Select()` - before every write; if it moved, write nothing and
    open a panel naming who changed it and when, with Reload/Cancel. Re-take the signature after
    every successful save, or the same person conflicts with themselves. Settings saves refuse when
    the row's `Modified On` moved.
  - *Soft editing marker.* On open, write `EditingBy`/`EditingSince` (a DateTime, not DateOnly); blank
    both inside every business `Patch`, clear in `OnHidden`, re-write from a timer tick, and ignore
    markers older than about 15 minutes. Leave the marker and the header's own `Modified On` out of
    the signature. The marker is a write to a watched table - check what flows it wakes
    (`power-automate.md`, bookkeeping writes).
  - *Timer refresh* of read-only lists every 60-120 s, gated as in section 8.

  Verify with two browser tabs on one fixture, the "other user" simulated through the Web API (a
  banner appeared 42 s later in one measurement).
- **An app-written change log sees only the app.** Writes from the maker portal, scripts, imports
  and other clients leave no trace in a log the canvas app writes; a Dataverse-triggered flow sees
  every writer. Patching a header once per line inside a `ForAll` re-fired an update-triggered logger
  per patch: one submit wrote thirteen change rows.

## 13. Permission gating in canvas

A canvas gate controls what the APP offers. Anyone with the table privilege can still write through
Excel, the Web API or a model-driven app, and system administrators bypass app gates the same way -
the boundary is security roles and column security (`dataverse.md`). Keep the gate as UI, say so in
the permission audit's output, and keep save handlers re-checking the lock or permission rather than
relying on `DisplayMode`.

- **`&&` binds tighter than `||`.** Appending `&& !gblTrimmed` to `gblIsAdmin || (matrix)` parses as
  `gblIsAdmin || ((matrix) && !gblTrimmed)`, so the admins - exactly who the switch was for - sailed
  through. It compiled clean and passed every audit. Parenthesise every mixed gate:
  `(gblIsAdmin || matrix) && !(gblIsAdmin && gblTrimmed)`.
- **Compute role and scope flags once, in `OnStart`, as independent booleans** (team scope, all
  scope, admin), not one rank, so one person can hold several. Screens that each decided "my team /
  all / admin" drifted apart. Gate names a permission audit recognises must change in the same
  commit (`audits.md`).
- **"Owns any record" is not "owns this record".** A session-wide `gblIsOwner = CountRows(colMine) >
  0` in global gates made a role matrix inert for its whole target population.
- **Decide empty-table semantics deliberately.** In one permission matrix the view gate read
  `<> "No"` (missing row = allowed) and edit/create read `= "Yes"` (missing = denied); seeding
  view-yes/edit-no made an admin grid visible without changing access. A new boolean right defaults to
  No on existing rows - which can remove access that used to come with Edit.
- **A new permission element inherits from its parent until it is named:**
  `If(!IsBlank(LookUp(colPerms, Element = "Budgets")), <own rule>, <parent answer>)` is correct before
  and after the new choice member lands, so schema and canvas can ship on different days. A
  default-allow alternative would silently undo a restriction in the gap.
- **A user missing from the roster resolves to a blank role** - in one app "sees everything, edits
  nothing". Decide what an unrostered user gets and show them an explanatory panel.
- **Settings that gate their own editor need a lockout guard.** The setting listing who may open the
  admin console is the one place a typo locks every admin out of the screen that fixes it: refuse a
  save that would exclude the person making it, and keep the old source as a fallback until a new
  one is proven in the published app. A shared display preference must exempt the admin console for
  the same reason, and never feed a write gate.
- **A lock model needs an order of evaluation.** One that worked: disabled when there is no edit
  right (including via ownership); else when the item is period-sensitive and the period is CLOSED
  (an exception does not override a closed period - reopen it instead); else an exception opens it,
  otherwise an admin lock or an inactive-object lock disables it. Bulk-save loops must SKIP closed
  periods so the lock is real, not cosmetic. When adding a surface, copy an existing cell's gate
  verbatim.
- **Lock and security tables with no role grant fail open.** A lock check that "fails open for users
  without read" silently allows exactly those users; grant read on every lock table.
- **`Visible` for "not for you", `DisplayMode` for "not right now".** Hide what a role never has; use
  `DisplayMode.Disabled` for read-only inputs - `DisplayMode.View` renders an input as plain text, so
  a locked field cannot be told from a label (one sweep switched 136 gates and found 39 ungated
  inputs). Hiding Save does not make a field read-only, and a hidden tab is not a permission guard.
- **Never gate with a password in a canvas app.** Anything in the app definition is readable by
  every co-author; use identity-based gates.
- **A permission matrix as a four-level ladder** (Hidden / Viewable / Editable / Create new), stored
  as three booleans and mapped in one place, also collapses contradictory combinations.
- **Testing restrictions without a second account** proves canvas gates only, never Dataverse roles
  (`browser-verification.md`).

## 14. Errors and diagnostics users can see

- **Set `App.OnError` from the first build.** The player's own banner ("Invalid operation:
  division by zero") names no control. `Set(gblToast, "Something went wrong in " &
  FirstError.Source & "." & FirstError.Observed & ": " & FirstError.Message)` turns it into a
  located error a tester can screenshot - and Monitor may be unavailable (it was greyed out in Studio
  while an authoring session was held).
- **The failure reaches the screen.** Wrap reads that feed gates with a sentinel
  (`power-fx-and-pa-yaml.md`, section 1) and render the flag: degraded is acceptable, haunted is not.
- **A negative-membership test is also true when the list failed to load.**
  `CountRows(Filter(colOpen, Code = ThisItem.Code)) = 0` was meant to mean "closed item" and waived a
  required field; one morning the collection failed to load for everyone and the rule was waived
  everywhere. Require evidence that the list loaded.
- **Show an identity diagnostic for sessions you cannot see.** A user lacked admin buttons while
  everything checked from outside their session was correct (roster row, roles, sign-in address,
  cached manifest, impersonated reads). A small line, shown only to someone with a qualifying row who
  was not recognised, printing what `OnStart` found - plus the build stamp shown to everyone - turns
  that into a screenshot. Ask them to confirm the app URL (not a legacy app with a similar name).
- **Make the app say what it will do.** A submitted record went to a different approver than the
  one the screen used for edit rights, for 10 of 17 people; a line under Submit naming the recipient
  would have exposed it on day one. A person picker shows the email beside the name when names
  repeat.
- **Intermittent screens with every control disabled and a generic message** came, in one
  environment, from a read in `OnVisible` failing against half-stale metadata, leaving the reason
  variable unset (`manifest-caches.md`). The workaround read the related row from its own table by id
  instead of through the navigation property.

## 15. UX and data honesty

- **When a number's scope changes, relabel it.** Scoping a total to active items or to one scenario
  changed headline figures (one went from $51.3M to $18.8M). Change the caption with the scope
  ("Approved (active)", "Forecast portfolio"): a number that silently changes meaning is worse than
  one that reads lower and says why. Two numbers on one screen answering different questions is
  worse than either alone.
- **Scope every total over a fact table to one value of each additive dimension.** A "Forecast" KPI
  and three breakdowns summed every scenario at once (Budget + Pipeline + Baseline + Forecast on the
  same lines), overstating several-fold. Add a scope selector or a fixed filter, and say the scope in
  the caption.
- **A rollup by a classification shows what it could not classify.** A computed figure summed lines
  by their spend class and silently left out the 18 of 171 lines that had none. Any total grouped by
  a classification shows the remainder beside it ("18 lines unclassified, $X not counted") on the
  screen that computes it, so a data gap is a visible number and not a quietly smaller total.
- **An input that does not save must not look editable.** Period cells were editable inputs whose
  edits went only to an in-memory collection and were silently discarded; users cannot tell that from
  a broken save. Until write-back exists, render them read-only.
- **A disabled control must say why.** A Deny button disabled until a reason was typed - in a box far
  from the per-row button - was reported broken twice. Keep it enabled and, pressed without the
  prerequisite, say exactly what to do; or show a hint naming the reason ("(admin only)", who manages
  the record). Never leave a greyed button standing in for an unbuilt feature.
- **No silent defaults that file data.** A picker preset to one region filed every untouched row
  there. Start empty and require a choice; give nullable choices a Clear.
- **Deny-lists, not allow-lists, for eligibility.** A picker built from an allow-list of four
  statuses dropped projects moved to On Hold, Scoping or Ready For Approval while people still booked
  to them. Exclude the terminal states, so a new status cannot make things vanish, and show the loaded
  count so "something is missing" becomes a number. When data cannot say (a blank type), take the
  lenient path.
- **A picker of "available" rows goes silently empty when the flags are wrong.** List a computed
  window around today, mark unavailable entries "(closed)", and decide editability by the rule in the
  form, so a data fault shows as an explanation.
- **Labels the app matches on must be unique; bind by key.** Two reference rows deliberately shared
  a name; the editor re-found by label and took the first. Bind pickers and defaults by id, make
  active display names unique (including case- and space-only variants), and audit live data for any
  value the app matches as a literal string (`LookUp(colCategories, Name = "Walk-in")`): it must
  exist exactly once and be active. Classify rows by a typed column, not a display name.
- **Rename sweeps must classify every occurrence.** User-facing renames hit stored element values,
  data keys built from labels (`gblFY & " | Actuals"`), choice members, data-source names, accessible
  labels and dropdown values compared downstream. Enumerate by control type and classify each hit; a
  "done" rename missed a screen-reader label and three strings, and an "all 9 converted" note was
  twelve. Search case-insensitively. Then prove the old text is gone from the shipped app, not only
  that the new text is present.
- **Configuration, wording and year drivers are data.** Put thresholds, windows (a literal
  `Today() + 21` became a setting), feature flags, report URLs, recipient lists and dialog wording in
  settings and message tables read in `OnStart`, so changes need no reship. A missing row reads as
  the safe default (a feature switch reads as off); a blank value can be meaningful (hide the report
  button while its URL is blank). Gate every surface of a feature (tab, form, badge, flow) on the
  same flag and prove the flip both ways. Keep geometry and colour out of message rows - name a few
  sizes and take colour from the message type's design token. Settings that gate the UI are not a
  security boundary.
- **Multi-year apps share one selected-year variable.** A hard-coded year literal in `OnStart`
  (`Filter(app_Periods, Year = "<literal>")`) makes every screen single-year and blocks forward
  planning. Load a rolling window of years, keep the list of years as data, and bind every year
  selector on every screen to one global (`gblSelectedYear`) so no two screens disagree about which
  year is shown.
- **Dates**: `d mmm yyyy` for people; `yyyy-mm-dd` inside record names, because maker-portal views
  sort a primary name as text.
- **Empty totals show 0, not nothing** (`power-fx-and-pa-yaml.md`, section 8), and a data-empty
  feature is not a broken one - publish what is empty before a test round (`browser-verification.md`).
- **Offer an action only in the state that allows it.** A Lend button stayed active on an asset
  already on loan and refused after the click. Show the state on the row ("On loan to ... until
  ..."), and replace the action with the reason, or disable it with the reason printed beside it -
  never an active button that only says no once pressed.
- **A save must show that it is saving.** A first save that took 36 seconds showed only a greyed
  button; testers pressed it again. Set a `varSaving` flag around the write, show "Saving..." (or a
  spinner) and disable the button while it holds, and clear it in every branch.
- **Rows open their detail when tapped.** A gallery row that does nothing on tap, with a small arrow
  as the only target, reads as broken at phone width. Put `OnSelect` on the row template.
- **Nothing for the developer reaches the user.** No visible build stamps, test diagnostics, record
  ids or placeholder dates ("2001-12-31" as an empty value). Keep the build stamp on an admin-only
  label (`references/canvas-shipping.md`, "The build stamp"), blank dates as blank, and remove diagnostic
  panels before the final ship.
- **Remove the leftover blank screen** that app creation leaves (`Screen1`) once your own screens
  exist, and set `App.StartScreen`.
- **A pending request reserves the item.** A measured build kept an asset "Available" while a loan
  request for it waited for approval, so a second person could request the same asset and two
  approvals went out. Treat a pending (requested, awaiting approval) record like an active one in
  the eligibility rule: the item shows "Requested by <name> on <date>", the request action is
  replaced by that reason, and the save handler checks again server-side (a `LookUp` for an open or
  pending record on the item, immediately before the `Patch`) because two people can have the screen
  open at once. Walk it: request, then request the same item again as a second step, and confirm in
  Dataverse that one record exists.
- **A typed date gets a format message, not "required".** The date picker accepts typing; a
  measured build rejected a typed date it could not parse with "Due date is required", which tells
  the person the field is empty when they can see it is not. Distinguish blank from unreadable
  (`IsBlank(dpDue.SelectedDate)` with the text box non-empty means "not a date"), say which format
  is expected ("Use the calendar, or type 31/12/2026"), and keep the typed text in the box.
- **Every rule here is walk-tested, not assumed.** Each bullet in this section that gates an action
  has a refusal or `twice` scenario in the acceptance contract (`browser-verification.md` section
  18); a rule only read in the source is unproven in the published app.

## 16. Lists: filter, search, group, sort

**Ask about every list before building it, or apply the default and say so.** For each gallery,
list or menu: which columns does a person scan it by, does it need a search, how should it sort, and
is the data categorised (grouped under headers)? Six rows need none of it; sixty rows with no
filter is a scroll hunt, and the request to add one arrives after go-live. The intake question is
in `project-setup.md` section 3.

When you apply the default, end your reply with the choices you made and an explicit invitation to
change them ("I added filters on Category and Status, a name search and a due-date sort - tell me
if this list should filter, group or sort differently"). A default the maker never hears about is a
decision taken for them.

**The default when nobody says otherwise:**

- a filter for every **choice or lookup column a person would scan by** (category, status, team,
  owner) - a dropdown that starts empty, where empty means "All";
- a **search** box on the name (or the record's human key);
- a **sort** that matches the job (due date for work, name for reference data), stated in the header;
- **section headers** when the data is categorised and the list is reference data an administrator
  browses (catalogue items by category, settings by area);
- a count of rows shown ("24 of 31") so a filter cannot silently hide things.

`check-canvas-format.mjs` warns (`list-without-filter`, advisory, never an error) on a gallery over
a table whose Items reads no input control, no variable and no `Search`/`GroupBy`. It cannot judge
whether the narrowing offered is the right one (a "show retired" toggle counts), so the intake
question still decides.

**Filter dropdown, empty means All** (classic controls; a choice column `Category` on table
`Items`):

```yaml
- drpCategory:
    Control: Classic/DropDown
    Properties:
      Items: =Choices('Items'.Category)
      AllowEmptySelection: =true
      Default: =Blank()
- txtFind:
    Control: Classic/TextInput
    Properties:
      HintText: ="Search by name"
      DelayOutput: =true
- galItems:
    Control: Gallery
    Variant: Vertical
    Properties:
      Items: |-
        =SortByColumns(
            Filter('Items',
                IsBlank(drpCategory.Selected) || Category = drpCategory.Selected.Value,
                IsBlank(txtFind.Text) || StartsWith(Name, txtFind.Text)),
            "app_name", SortOrder.Ascending)
```

Delegation (Dataverse): equality on a choice or lookup, `StartsWith` on text and `SortByColumns`
delegate; `IsBlank(control)` is evaluated once on the client and is safe. `in`, `Search` on large
tables in some connectors, `Len` and `Lower` around a column do not - keep them out of the filter
(`power-fx-and-pa-yaml.md`, delegation). A dropdown that must offer a literal "All" entry instead of
an empty selection needs a table of text values, e.g.
`Ungroup(Table({v: ["All"]}, {v: ForAll(Choices('Items'.Category), Text(Value))}), v)`, and the
filter then compares `Text(Category)`, which does not delegate - prefer empty-means-All.

**Grouped list with section headers, delegation-friendly**: an outer flexible-height gallery over
the categories, an inner gallery per category. Each inner query is delegable; `GroupBy` is not and
works only on what is already loaded.

```yaml
- galGroups:
    Control: Gallery
    Variant: VariableHeight
    Properties:
      Items: =Filter(Choices('Items'.Category), IsBlank(drpCategory.Selected) || Value = drpCategory.Selected.Value)
    Children:
      - lblGroup:
          Control: Label
          Properties:
            Text: =Text(ThisItem.Value)
            FontWeight: =FontWeight.Semibold
      - galInGroup:
          Control: Gallery
          Properties:
            Items: =Filter('Items', Category = ThisItem.Value, IsBlank(txtFind.Text) || StartsWith(Name, txtFind.Text))
            Height: =Self.TemplateHeight * CountRows(Self.AllItems)
```

`Variant: VariableHeight` (flexible height) is the name to confirm in your tenant's source (see
`canvas-layout.md`, "Long text"). For a small, fully loaded list a single gallery over
`SortByColumns(...)` with a header label shown when the category differs from the previous row is
lighter.

**Confirmed in a real build (compile 0 errors, published, 2026-10-02):** a single gallery over a
collection built with `Clear(col); ForAll(categories, With({g: Filter(...)}, If(CountRows(g) > 0,
Collect(col, {header row}); Collect(col, ForAll(g, {item row})))))`, each row carrying an `H`
(header) flag, renders category headers with their items; the build re-runs on every filter change.
Not delegable, so use it for reference data of a few hundred rows. A classic dropdown whose `Items`
is a collection of records with a `Value` column, and whose `Default` is one of those records (a
literal "All categories" first), also compiled and ran.

**Remember the filter.** Keep the selection in a variable or the control's state when the user opens
a record and comes back; a list that forgets its filter after every visit is filtered once and then
abandoned.

## 17. Communications: last sent, history and resend

When the app's flows send messages (see `power-automate.md` section 16 for the flow side), the app
shows three things, all read from the communication log table, never from the flows' run history:

- **Last sent** beside each item that sends something: the newest log row for that item -
  `First(SortByColumns(Filter(CommLog, Task = ThisItem.Task), "app_sentat", SortOrder.Descending)).'Sent At'`,
  shown as `d mmm yyyy h:mm` with the status ("Redirected (test)", "Failed") when it is not Sent.
- **History**: a gallery of log rows. Administrators see all rows with filters (kind, status, date,
  recipient search); a record's owner sees the rows for that record on its own page. Columns:
  kind, subject, channel, intended recipient, actual recipient, sent at, status, resend flag,
  attachments.
- **Resend**: a per-row button, shown only for kinds the resend flow handles and only when the row
  is not already Resend Requested. It writes one status; the flow does the rest:

```yaml
- btnResend:
    Control: Classic/Button
    Properties:
      Text: ="Resend"
      Visible: =ThisItem.Kind in [Kind.'Guide Step', Kind.'Task Dispatch'] && ThisItem.Status <> Status.'Resend Requested'
      OnSelect: |-
        =Patch(CommLog, ThisItem, {Status: Status.'Resend Requested', 'Resend Requested By': Lower(User().Email)});
        Notify("Resend requested. The message is sent again within a minute.", NotificationType.Success)
```

Show the outcome, not just the request: the original row turns Resent (or Skipped, with the reason)
and a new row appears for the new send - refresh the history after a short delay or on return to the
screen. Grant the roles that may resend Write on the log table; everyone else Read.

## 18. Template guide and live preview for administrators

Wherever administrators write text a flow fills in (message bodies, document templates), the app
must teach the template format on the same screen:

- **The token list, from data**: read the placeholder list from the one settings row the flow also
  reads (`ParseJSON(LookUp(Settings, Key = "TemplatePlaceholders").Value)`), and show each token, its
  meaning and the value used when it is blank. A hard-coded list in the app drifts from the flow.
  Confirmed shape (compile and publish, 2026-10-02): `IfError(ForAll(Table(ParseJSON(...)) As r,
  {Token: Text(r.Value.token), Meaning: Text(r.Value.meaning), IfBlank: Text(r.Value.ifBlank)}),
  <fallback table>)` - the fallback keeps the guide usable when the setting is missing or malformed.
- **The rules**, in plain words: tokens are written `{Name}`, case-sensitive; an unknown token is left
  exactly as typed (so a typo is visible in the preview); a blank value becomes the stated
  replacement; which formatting is allowed (for HTML templates: paragraphs, bold, italic, lists,
  links, tables - no scripts or external styles, which mail clients strip).
- **A worked example**: a short template and what it renders to.
- **A live preview**: pick a real record (a test one by default) and render the template in the app
  with the **same substitution rules as the flow** - one `Substitute` per token from the same list.
  Flag tokens left unreplaced. The preview is where a typo is found, not the recipient's inbox.
- **An insert-token control** (a dropdown of tokens that appends `{Token}` at the end of the text)
  so administrators do not type them.

The administrator guide's template chapter and this panel say the same thing
(`documentation-set.md`).
