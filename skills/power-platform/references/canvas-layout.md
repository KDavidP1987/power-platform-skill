# Absolute layout: the numbers that get guessed wrong

None of these is visible in the source, and each has shipped a defect past a compile, a marker
check and a full audit suite. Measure in the running app; use static checks as a floor.

## Contents

1. Absolute layout, not nested AutoLayout
2. Text width and height (and the unit)
3. Galleries
4. Unclickable controls: z-order and its exception
5. Moving and removing controls
6. Readable, reachable controls
7. What a static geometry audit must do to be worth running

---

## 1. Absolute layout, not nested AutoLayout

Two projects built screens from nested AutoLayout containers (`GroupContainer` with
`FillPortions`, `LayoutWrap`, `LayoutGap`) and got "areas cut off", "text invisible" and grey boxes
in Studio and the player - and the result could not be reasoned about from source. Both rebuilt on
absolute `X`/`Y`/`Width`/`Height` (Rectangles, classic Labels with explicit colours, Buttons) on a
fixed design surface, which fixed the reports and made geometry auditable. One project's write-time
hook now blocks `Variant: AutoLayout`. This is team experience, not a platform guarantee.

- **Define shared column positions once**, as globals set in `App.OnStart` (`gblColName`,
  `gblColQty`), so a grid's header, entry row, gallery template and subtotal cannot drift apart.
  A static audit then has to resolve those globals (section 7).
- **Absolute layout is desktop-only.** A fixed 1366x768 app does not reflow; making it responsive
  is a per-screen rebuild. State the supported size in the in-app help.

## 2. Text width and height (and the unit)

**State the unit before quoting a ratio.** A canvas `Size` is in **points**: Size 11 renders at
about 14.7 CSS px. A "chars per font size" ratio means nothing until you say which of the two it
divides by.

- **Measure the character width; do not assume it.** Measured per CSS px of rendered font size,
  body text ran 0.55 to 0.6 in one app and bold headings approached 0.75. Measured per unit of
  `Size`, another app's layout needed ~8.9 px/char at Size 11 and ~8.1 at Size 10 (about 0.81 x
  Size) - the same order as 0.6 x 14.7 px. A guess of ~6 px/char at Size 11 was about two thirds
  of the measured 8.9. A constant of 0.74 inherited from another project was close to the worst
  case and made a static audit wrong nineteen times in twenty. Font, weight and scaling all move
  the number, so **measure it in your app**: pick a string you can see exactly filling a known
  width in a screenshot of the running app and divide, or let the browser decide
  (`canvas-browser.mjs` `measurefont` prints both units; `clipcheck` reports actual clips).
- **A wrap breaks at word boundaries, so a column must fit the longest WORD**, not the average
  string. Query the real data for the longest value and its longest single word before choosing a
  width. **Separator-joined data is one unbreakable word**: a semicolon-joined address list does not
  wrap - insert a space or line break after each separator before display.
- **Text longer than its box is simply not drawn.** No error, nothing in the compiler, and nothing
  in an overlap audit - the control is exactly where it was told to be. Static approximation, with
  the font size converted to px (`px = Size * 4/3`): characters per line = `Width / (k * px)`,
  lines available = `Height / (1.3 * px)`; flag only where needed lines exceed available lines.
  `k` is an average over a proportional font, so this is a floor, not a guarantee.
- **Descenders clip first; give a single-line label about twice its `Size` in height.** The 1.3
  line-height rule says Size 11 fits in 22 px. In the player, labels 22-24 px tall at Size 11
  clipped - and only the ones containing g, y or p were reported. Height 28 for Size 11 fixed eight
  screens. When one label is reported clipped, check every label of that height and size, and use
  the browser clip check for single-line headers.
- **A Label centres its text vertically by default.** Prose labels then sit mid-box, leaving a gap
  under every title - set `VerticalAlign: =VerticalAlign.Top`. Worse, a centred label that
  overflows **clips both ends**: a 20 px box holding three lines showed only the middle one; four
  lines in a 52 px box bled above and below. Top-align long text and size it for the longest value.
- **Numbers cannot be aligned with spaces.** Padding values with spaces inside one label never lines
  up columns, because the font is proportional - a "1" is narrower than an "8". Use one label per
  numeric column with `Align: =Align.Right`, the header and every value sharing the same `X` and
  `Width`.
- **Make truncation recoverable rather than pretending it away.** When no width fits every value
  (one list had 2,103 names), set `Wrap: =false` so a long value clips on one line instead of
  wrapping into the row below a fixed-height row, and add a `Tooltip` with the full text (Labels
  take `Tooltip`).

## 3. Galleries

- **A vertical gallery draws its scrollbar INSIDE its width**, over the last ~16px of every row,
  once it has more items than fit. A child flush to the right edge looks right with two rows and is
  covered with six (an amount column read `9.` for `9.38`). **Usable row width is `Width - 16`.**
- **The viewport must be a whole number of row pitches.** Pitch is `TemplateSize +
  TemplatePadding`, and **`TemplatePadding` defaults to 5 when unset**: measured in the player, a
  gallery with `TemplateSize: 44` and no padding rendered rows 49 px apart with the first at y=5.
  Power Apps draws the row that does not fit and clips it at the gallery's edge, slicing through its
  text - it reads as a rendering fault, not "scroll for more". In one app all 31 literal-height
  galleries had been sized on `TemplateSize` alone and sliced their last row; in another, 29 of 33
  vertical galleries used `Height: =Parent.Height - N`, which hides the remainder from any static
  check. Make heights a multiple of the pitch, or trim the padding.

```yaml
- galOrders:
    Control: Gallery
    Variant: Vertical
    Properties:
      TemplateSize: =44
      TemplatePadding: =5          # state it: the default is 5, not 0
      Height: =5 * (44 + 5)        # five whole rows
```

- **Gallery header labels sit outside the gallery, in screen coordinates**: header `X` = child `X`
  + gallery `X`. A header placed by eye drifted 16 px from its column.
- **A list can end up with less room than one row** on a crowded tabbed screen (112px for a 156px
  row: no entry was ever fully visible). Layout fix, not arithmetic: put the always-open entry form
  behind a button - reading is the common case - and reuse the screen's existing modal pattern.
- **Row-level clicks.** Gallery-level `OnSelect` did not fire reliably on a row click in the player
  in two apps. Give each row its own button. Observations on transparent buttons disagree: a button
  with `Appearance.Transparent` / a Transparent fill received no clicks in two apps, while another
  used a text-less full-row button declared last in the template successfully, and a text-less
  Subtle-appearance button drawn last over a KPI tile is a deliberate pattern in a fourth. The safe
  default is a visible per-row button ("Open"); if you overlay, give the button a real (even subtle)
  fill, declare it last, and prove it by clicking it in the published app.
- **A gallery keeps every row in the DOM well past its viewport.** Automation that counts DOM hits
  or compares rectangles is fooled; use `elementFromPoint` and viewport bounds.

## 4. Unclickable controls: z-order and its exception

**Declaration order in `.pa.yaml` is z-order.** An interactive control declared **before**
decoration that overlaps it is painted underneath, and the click lands on the decoration - which
has no `OnSelect`, so nothing happens. One app's "Edit" button was 72% covered by two status pills,
centre included: the only route to editing that record had never worked, for anyone, through
seven audits and four rounds of user testing.

- **Declare interactive controls after nearby decoration**, and do not rely on that alone - give
  them geometry that does not overlap, so paint order stops mattering.
- **Ask the browser**: for every focusable control, does `document.elementFromPoint` at its centre
  return that control? (`canvas-browser.mjs` scenario step `{"deadclick": "screen-name"}`.)
- **Labels swallow clicks.** A Label, Rectangle, Image or HtmlViewer declared after an input it
  overlaps is a finding, not a style choice.
- **A whole panel can be covered, and every check says fine.** A tab body declared before the
  screen's content card rendered blank: the geometry audit, the marker check and the accessibility
  snapshot all passed, because the controls existed; only a screenshot showed it. Fixed order per
  screen: background card, tab bodies, overlays last; a help overlay after any panel added later.

**The exception: modern (Fluent/PCF) input controls paint over a gallery whatever the declaration
order.** A search-results gallery could not overlay a form built from modern inputs; the inputs
showed through. Do not design a dropdown-style results list over modern inputs - push the form down
with a hidden spacer whose `Height` equals the list's, added to the `Y` of every control below:

```yaml
- recResultsSpacer:
    Control: Rectangle
    Properties:
      Visible: =false
      Height: =If(Len(txtSearch.Value) >= 2, galResults.Height, 0)
- txtNotes:
    Control: TextInput
    Properties:
      Y: =txtSearch.Y + txtSearch.Height + 8 + recResultsSpacer.Height
```

**A button that clicks only at one edge is covered by something conditional.** A 900x20 empty-state
label, shown only while a setting was blank, lay across two buttons, so they clicked only at their
top edge. A click that works "intermittently" by data or configuration state means a conditional
overlap. Put hints above or below a button row, never across it.

**Gate tab content on `Visible`, not only `DisplayMode`.** Two buttons gated only by `DisplayMode`
were both visible and stacked at identical coordinates on different tabs, so a click could hit the
wrong handler. A control missing its tab condition in `Visible` draws over every other tab.

## 5. Moving and removing controls

- **A layout fix can relocate the collision.** A Clear button moved off one control landed on a
  checkbox and, being later in document order, covered it - unnoticed for two sessions. After any
  move, re-check the new neighbours.
- **Removing a control means recomputing the stack below it.** Removing two fields left a note
  overlapping a dropdown by 8 px. Re-derive the `Y`/`Height` stack of the whole column.
- **The same `Y` on many screens is not the same slot.** A banner placed at one `Y` on seven
  editors landed inside each screen's 72 px header. Check each screen's header height, or reuse an
  existing control's proven slot (merging into an existing banner worked).
- **After a scripted layout edit, diff every coordinate.** A re-layout script kept a "current tile"
  variable it never reset, so every control after the last tile inherited its offset and half a
  screen moved 807 px right, off-canvas. Nothing overlapped, so seven audits, a clean compile and a
  marker check passed; a person found it by looking. Diff `X`/`Y`/`Width`/`Height` of every control
  against the pre-change file, and when a script went wrong, restore the file from git and re-run
  the fixed script rather than hand-patching forward.

## 6. Readable, reachable controls

- **Subtle or white-palette modern buttons on a dark header are unreadable** (grey chips on a navy
  bar). Nav items, tabs and back-links worked as classic Labels with an explicit `Color`, an
  `OnSelect` and `TabIndex: =0` (Labels are not in the tab order otherwise). To add a count badge
  without re-laying out every screen, put it in the label text ("Approvals (3)", capped at "9+").
- **Set an explicit, contrasting `Color` on every Label over a coloured fill.** Implicit colour gave
  grey-on-grey text, and empty tiles drawn light grey with grey text read as "missing data". Make
  an empty state white with a border and dark text.
- **Measure inherited colours for contrast.** A carried-over orange scored 3.32:1 on white and
  failed WCAG AA (4.5:1); a darker token passed at 5.02:1. Let colour reinforce a text label, never
  replace it.
- **A disabled control must say why**, with a hint label beside it. A disabled button with no
  reason, or one enabled only by typing in a box far away, is filed as a bug.

## 7. What a static geometry audit must do to be worth running

- **Compare across `Visible` conditions.** An audit that only compares controls sharing the same
  `Visible` expression missed seven overlaps a user found in an afternoon. An always-visible control
  is in every group. Two groups are compared unless their conditions are **provably exclusive**
  (same local against different literals, `A` vs `!A`, `A || B` vs `!A && !B`); anything not
  provably exclusive is concurrent.
- **Exempt overlays narrowly.** A later control is an overlay only when its `Visible` carries every
  term of the covered control's plus more, or it is driven by a panel local and its group contains
  a full-size backdrop rectangle. A card whose `Visible` is only a role or tab test is body content,
  not an overlay. Whitelist the deliberate text-less button drawn last over a tile. Treat 1-2 px
  touches as rounding.
- **Check every control against the design surface**, not only against each other: read
  `DocumentLayoutWidth`/`DocumentLayoutHeight` from the live app's `Properties.json` and flag any
  screen-level control extending past it ("runs 775 px past the right edge"). A uniform shift
  creates no overlap and only this check sees it. Include the shared header and nav band: a button
  moved into it overlapped nav text unseen.
- **Resolve what the layout is written in, and print what you could not.** Read numeric globals set
  literally in `App.OnStart` (longest name first, so `gblGutterWide` is not read as `gblGutter`),
  and resolve simple arithmetic on `Parent.Width`/`Parent.Height` for direct children of a screen -
  never inside a gallery, where `Parent` is the row. One audit resolved only literals and skipped
  353 of 367 controls; reading the globals cut that to 14 and surfaced 8 real overlaps at once.
  Another skipped 450, including the actual offender. Print the skip count every run and make the
  runner show it, not only the finding count. If the audit cannot resolve a high-risk bar (nav),
  keep that bar at literal coordinates.
- **Visit gallery children, and group by parent.** A parser that consumed a control's whole block
  skipped every control in a gallery template (272 in one app) - where row buttons and dense layouts
  live. Check them against the row bounds: `Width - 16` wide and `TemplateSize` tall. Group controls
  by **parent**, not indent depth: two galleries' templates sit at the same depth in different
  coordinate spaces, and grouping by depth produced 57 phantom overlaps.
- **Parse the YAML the way it is written.** Read multi-line plain scalars to the end (a `Text:
  =If(cond,` whose branches continue below let a 163-character sentence pass the fit check), and
  read block-scalar `Visible: |` (read as missing, it put two mutually exclusive controls in the
  always-visible group).
- **Fit-check formula text with its longest literal.** A `Text` that is an `If()` or concatenation
  still draws real words; its longest double-quoted literal is a lower bound on what is drawn, so
  flagging on it cannot cry wolf. Exclude `Text()` format arguments (`"[$-en-US]0.00"`) and literals
  with no letters, or every date and number cell is flagged.
- **Skip text-free controls in overlap checks.** A card is a Rectangle drawn behind its contents as
  a sibling and overlaps every label on it by design; without this rule one screen reported 40
  false pairs.
- **Compare hidden lines, not raw pixels.** Every label's line box is a few px taller than its box;
  a pixel comparison reports the whole app.
- **Prove the check red against geometry that shipped broken** before trusting it green - and
  restore the WHOLE pre-fix state for that test: moving one control back after the fix also moved
  its neighbours, and the mutation proved nothing.

Measured against a running player the same day, one static audit flagged 20 clipped labels (0 of
13 checked were real) and missed the 1 real clip, because that label's `Text` was a formula. The
browser is the authority; the static audit stops the obvious cases reaching a user.
