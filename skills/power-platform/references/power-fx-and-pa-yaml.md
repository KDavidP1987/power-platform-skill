# Power Fx and .pa.yaml: traps that compile clean and fail in the app

## Contents

1. Silent failure: errors abandon the rest of a formula
2. App.OnStart, named formulas and the start screen
3. Collections and globals
4. Types: choices, Yes/No, disambiguated names
5. Lookups and relationships in formulas and queries
6. Delegation and the data row limit
7. Reading large tables: chunking, scoping and proving it
8. Function behaviour that surprises
9. Performance: formulas that re-run on every render
10. Identity: who is signed in
11. .pa.yaml syntax that breaks the whole compile
12. Reading compile output

Control-specific behaviour (TextInput, ComboBox, CheckBox, DropDown, Gallery, Timer, inputs that
fire on render, Default/Reset) and screen design patterns (edit screens, saving, concurrency,
permission gates, read models, data honesty) are in `canvas-controls-and-patterns.md`.

Where a control's property set is in doubt, **copy an existing working control from the same app**
rather than trusting the general Power Apps documentation or memory, or ask the authoring server
(`describe_control`, section 12). Modern (Fluent) controls and classic controls take different
properties, and the docs often describe the other set.

---

## 1. Silent failure: an error abandons the rest of the formula

This is the most expensive Power Fx behaviour there is, and it underlies most "the button does
nothing" reports.

**A Dataverse read that fails returns an ERROR, not blank.** Assign it to a global and the global
holds the error; `Coalesce(...)` does not launder it. When a behaviour formula later compares
against that global, Power Fx abandons **the entire `If()`**, and every statement after it is
skipped: no dialog, no notification, no write, no banner, nothing logged. The investigation always
starts in the wrong place - on the button, which is fine.

**Tell:** the guard chain sets a message variable in every branch, and the user sees no message at
all. The chain is not reaching its branches. Look at the values the **conditions** read.

**Rule: a value that feeds a guard chain must never be able to hold an error. Wrap the read where
it is set, with a sentinel and a safe fallback:**

```
Set(gblCreditUsed, IfError(Coalesce(Sum(Filter(Orders, ...), Amount), 0), -1));
Set(gblCreditReadFailed, gblCreditUsed < 0);
Set(gblCreditUsed, Max(gblCreditUsed, 0));
```

- **A sentinel**, so the failure is still known. `IfError(..., 0)` works and then lies - the screen
  cannot tell "none" from "could not read".
- **A fallback in the safe direction.** Ask which way the degraded value fails before choosing it;
  the wrong default turns a silent no-op into a silent wrong number.
- **The reason reaches the screen.** A flag the UI renders is the difference between degraded and
  haunted.

**Where to look first when a control does nothing:** trace every global its conditions read back to
the statement that sets it, and ask whether that read can fail **for this user**. Missing table
privilege is the most common reason, and your admin account will never show it
(`dataverse.md`, security roles).

**`Value("abc")` raises; it does not return blank.** A guard written as `IsBlank(Value(x))` never
speaks - the platform's own banner appears first. In `DisplayMode`, an errored expression does not
resolve to `Disabled`, so a mistyped amount can leave Save live. Coerce once, up front:
`IfError(Value(x), -1)` makes an unparseable value fail the same range test a negative one does.

**`IfError(Patch(...), Notify(...))` does not bind.** `IfError` needs branches of matching type;
`Patch` returns a record and `Notify` a boolean. Write the error check as:

```
If(IsError(Patch(Orders, rec, {Status: 'Status (Orders)'.Submitted})),
   Notify("Not saved - " & gblLastError, NotificationType.Error))
```

A project hook can block the `IfError(Patch(` shape at write time.

**An errored render property draws nothing.** A button whose `Text` ran a non-delegable
`LookUp(..., IsBlank(col))` rendered with no caption - no error, just an empty button (observed once;
low contrast was a rival explanation). Compute such values once into a variable and bind to that.

**Studio Preview shows runtime error text the published player swallows.** "The requested operation
is invalid." appeared only in Preview and turned a week-old mystery into a ten-minute diagnosis. Run
the failing screen in Preview, against the same data, before theorising.

## 2. App.OnStart, named formulas and the start screen

- **`App.OnStart` is one expression chain.** A bind error anywhere means none of it runs; a runtime
  throw abandons everything after it. Every global stays blank and the app behaves as if the user
  does not exist. A formula error in an `OnSelect` costs one control; the same error in `OnStart`
  costs the application.
- **Write `OnStart` in dependency order**: identity and roles first, then enum lookups, then seed
  collections and anything else that can fail. It will not prevent a failure; it stops an unrelated
  line making the app unusable rather than merely degraded.
- **The start screen's `OnVisible` does not wait for `OnStart`** (non-blocking OnStart). A control
  property reading a global is reactive and re-renders later, so nothing looks wrong. A **`Set()`
  in that OnVisible** evaluates once, with whatever globals hold at that instant. `8 >= Blank()` is
  **true** (Blank coerces to 0), so a first-load computation can confidently announce the wrong
  thing - correct after navigating away and back, correct in Studio Preview (OnStart long done).
  Rules: a start-screen `Set()` may read only what it looks up itself; move anything depending on
  OnStart globals into OnStart after its last input, and let OnVisible recompute under a guard
  (`If(!IsBlank(gblX), Set(...))`). The test for any snapshot: *would this be wrong if every global
  were Blank?* Only a **cold load of the published player** shows it.
- **Headline numbers belong in bindings, not variables.** A `CountRows` in `OnVisible` can evaluate
  while the source is still loading and never re-evaluate: one Home screen read 0 pending while
  another screen read 4 from the identical query.
- **`App.StartScreen` cannot see `OnStart` variables.** Any gate in it must read tables directly.
  For deep links, choose the screen there and resolve the record defensively:

  ```
  StartScreen: =If(!IsBlank(Param("id")), OrderDetailScreen, HomeScreen)
  ```

  Resolve the record in `OnStart` only when the parameter exists (so a failed lookup cannot take
  down an ordinary start), and again in the target's `OnVisible` if it is still blank. `Param()` is
  read once at start; build email links as the app URL plus `?id=<key>`. A gate panel that flashes
  during start can be held back with `Coalesce(gblIsAllowed, true)` for its `Visible`.
- **`Navigate()` is refused inside `OnVisible`.** Route from a behaviour property instead.
- **Named formulas (`Formulas:` on `App`) are partly supported.** In some schema versions the
  property is rejected outright. Where it is accepted, constants and user-defined functions worked
  in one app (a font, a palette, `MoneyShort(x)`, `VarianceText(fc, bud)`), while table formulas
  that `Sort` or `ForAll` over a Dataverse source were rejected ("Sort has invalid arguments") and
  cascaded about 980 errors. App Checker recommends converting read-only `OnStart` collections to
  named formulas; in that app the advice could not be followed - revert cleanly and record it as
  won't-do. Keep reference loads as `ClearCollect` in `OnStart`, and never define the same dataset
  both ways (one inherited app did, roughly doubling start-up work).
- **Hard-coded drivers rot.** A literal `CurrentFY = 2024` was two years stale in a production app,
  and `Filter(Periods, 'Fiscal Year' = "FY26")` in `OnStart` made every screen single-year. Read such
  values from a settings table at start (`canvas-controls-and-patterns.md`, section 15).

## 3. Collections and globals

- **A global that is only ever read is an unrecognised name.** Power Fx infers a global's existence
  and type from `Set()` calls. `Set()` it once in `OnStart` with a real value of the right type -
  not `Blank()`, which has no type to infer.
- **One collection name, one shape, one writer.** `ClearCollect` into the same collection from two
  places with different field names (`Email` vs `Mail`) compiles clean - the schema is the union of
  both - and which fields hold anything depends on which ran last. In one app this blanked a column
  on screen **and** disabled a duplicate-person guard that filtered on the missing field. If two
  screens need different projections, give them different names. Rebuilds hide: one sweep found the
  same collection rebuilt in two to four places, so search for every `Collect`/`ClearCollect` of a
  name before changing its shape, and make runtime `Collect`s emit the same shape as the load.
- **Filter at the source, not a collection you just built - and test with an EMPTY source.** The
  failure is narrower than "an empty collection has no schema". Measured in a published app: text,
  number and GUID fields read fine off an empty collection; what threw was a **Dataverse Yes/No
  carried straight off a source row** and then tested, because a Yes/No is a per-table option set
  with nothing to resolve against when there are no rows. Booleans computed in the projection
  survive. The throw abandons everything after it:

  ```
  ClearCollect(colThings, ForAll(Filter(Source, Owner.Person = gblMyId) As d, {..., Revoked: d.Revoked}));
  ClearCollect(colLive, Filter(colThings, Revoked <> true));   // throws when colThings is empty
  ```

  Write one typed query: `ClearCollect(colLive, ForAll(Filter(Source, Owner.Person = gblMyId, Revoked <> true) As d, {...}))`.
  One of three real instances meant that creating the FIRST record of a kind always failed silently.
  An audit for this shape should flag only the demonstrated signature (a boolean test on a column
  carried off a source row, with no `IsEmpty`/`CountRows` guard *before* the read); a broad sweep
  flagged 43 sites and was permanently red. When several different filters all return nothing,
  suspect the prefix: filters that disagree are a filter bug; filters that agree on "nothing"
  usually never ran.
- **A collection that failed to type poisons every consumer.** One mismatched field in an
  `OnStart` projection produced 186 errors across eight untouched screens
  ("'TotalApproved' isn't recognized"). Read and fix the `OnStart` errors first, re-compile, then
  read the rest.
- **`AddColumns` widens the record type, and `Set()` carries it into a global.**
  `Set(gblRec, ThisItem)` from a gallery whose `Items` used `AddColumns` put the phantom columns into
  the global; a `Patch` of that global on another screen then failed to compile ("The specified
  column 'x' does not exist" - 12 errors on a screen nobody had opened). An `AddColumns` record is not
  a data-source record and `Patch` rejects it, including when it is patched into a lookup.
  Re-resolve the pristine row by key (`LookUp(Orders, Order = ThisItem.Order)`) before assigning,
  patching or navigating. `AddColumns` remains the low-churn way to hoist a lookup field for display
  (every original column survives, so gallery children need no edits) - just never hand that record
  to `Patch`.
- **A record variable is a snapshot.** A global set when a record was opened does not see rows or
  values written later, which looks exactly like a lost save. First thing in the screen's
  `OnVisible`: `If(!IsBlank(gblRec), Set(gblRec, LookUp(Orders, Order = gblRec.Order)))`. A global
  holding the pre-`Patch` record stays stale even after `Refresh()`; re-read it after the write.
- **`Set()` cannot be called inside `ForAll`.** Use `With({...}, ...)` for intermediate values.
- **You cannot `ForAll` over a table while modifying it.** Materialise into a collection first.
- **A collection cannot reference itself mid-`Collect`.** To append a total or remainder row,
  `Set()` the aggregate first, then `Collect` the row.
- **There is no empty-table literal.** `Clear()` then a conditional `Collect()`.
- **`Parent`, `Self`, `ThisItem`, `ThisRecord` are reserved.** A record field named `Parent` makes
  the parser read the keyword; one such field produced 110 errors across eleven controls. Read the
  first diagnostic: *"the formula contains 'Parent' where 'Ident' is expected"*.

## 4. Types: choices, Yes/No, disambiguated names

- **A choice column's type is scoped to its option set - including Yes/No.** Dataverse gives every
  Two Options column its own local option set, and Power Fx types it by that set. Comparing it to a
  boolean works (`Record.'Is Active' = true` compiles and reads correctly); the trap is carrying the
  column's **value** into another table's column of the same name, which fails: *"Expecting a
  OptionSetValue (Is Active (Projects)) value, but of a different schema"* or *"Incompatible
  type"*. **Read it as a boolean at the projection**: `IsActive: (p.'Is Active' =
  'Is Active (Projects)'.Yes)`. Writing a real boolean into a Two Options column is fine.
  - `Coalesce(Record.YesNo, false)` still has the table-scoped type, so `UpdateContext` and a
    boolean variable reject it; `If(Record.YesNo, true, false)` produces a real boolean.
  - Two different option sets are different types even with identical labels; a lookup to the
    same table assigns straight across. For a picklist whose members differ, coerce with `& ""`
    and `Switch`, or use one global choice for a shared meaning.
  - The error names the control and property only - with a fifteen-field record, bisect the fields.
    A **missing or stale column** names the column; a **type mismatch** names only the control. A
    day went to blaming a recently extended source whose cached schema was correct.
- **A Yes/No column added to a table with rows reads NULL on those rows, not its default.** The
  default applies only to rows created afterwards; measured on three shared tables (2,282, 24 and 1
  rows, all null). `= true` empties every picker (it dropped the only existing administrator from an
  admin list); `= false` drops the old rows too. Write `<> false` when "not explicitly excluded" is
  meant - OData `ne false` returns the nulls and still delegates. Measure with `$count` for eq true /
  eq false / eq null. Backfilling instead moves `modifiedon` on every row and wakes every update flow
  on the table (`power-automate.md`).
- **A Dataverse write of `""` stores null.** A seeded empty string came back blank, so
  `("|" & x & "|") in gblSetting` silently never matched until wrapped as
  `Coalesce(gblSetting, "")`.
- **Inside a `Filter`, a choice's name binds to the COLUMN, not the option set.** Hoist enum values
  into `OnStart` (no row scope). `& ""` coercion works but breaks delegation.
- **A global choice's members are named through the option set's display name**
  (`'Approval Status'.Draft`), not the per-table form. If another bound table has a column with that
  display name, the reference becomes ambiguous - give a new global option set a distinctive display
  name ("Discount Applies To", not "Applies To").
- **A Dataverse choice has no `.Value` text accessor.** Coerce to its label with `& ""` (store
  `choice & ""` in a collection to keep a Text column). The `.Value` you see in examples belongs to a
  control: a ComboBox whose `Items` is `Choices(...)` yields records, so a `Patch` needs
  `Combo.Selected.Value` - the opposite of reading the field off a row.
- **Member reference vs text comparison fail in opposite directions.** `Status = 'Status
  (Orders)'.Closed` breaks LOUDLY at compile when the label is renamed; `(Status & "") = "Closed"`
  breaks SILENTLY at run time and matches nothing. Use the member reference for anything that locks
  or permits (a tab reload after a rename is cheaper than a lock that stops locking); text is
  acceptable where a mismatch is visible and harmless. Keep a list of every string-matched label and
  check it before renaming a member. A text comparison against a member that does not exist yet
  compiles and never matches - which can be used deliberately to stage a gate before the member is
  added.
- **A choice compared to text inside `Choices()` is a WARNING, not an error.**
  `Filter(Choices(Orders.Status), Value <> "Closed")` warns "Incompatible types for comparison ...
  OptionSetValue, Text" and filters nothing; a push reported "0 errors" and would have shipped it. The
  `in` operator coerces where `<>` does not; the member reference type-checks.
- **Power Apps disambiguates duplicate display names by appending the logical name.** When two
  columns on a table share a display name, formulas must use `'Order Name (app_name)'`; a custom
  `Status` column pushes the built-in one to `'Status (statecode)'` and plain `Status` silently
  binds the custom column, while the option set stays `'Status (Orders)'`. A lookup's displayed name
  can need the same treatment: `p.'Business Unit'.'Business Unit (app_name)'`. Tools that match
  formulas by display name must accept the suffix and match on the logical half (`audits.md`) - one
  audit reported seven phantom columns without it. Avoid the collision in schema (`dataverse.md`);
  the disambiguated form is the escape hatch when you inherit one.
- **Multi-select choice columns are a poor fit for canvas filtering** - neither delegable nor
  pleasant to filter. For "which of N areas does this person administer", N nullable Yes/No columns
  were additive and filterable; a junction table is the extensible alternative.
- **`Search()` takes column identifiers, not strings**: `Search(T, txt, 'Project Name')`. Strings
  fail with "Expected identifier name".
- **`AddColumns`, `GroupBy` and `ShowColumns` take bare identifiers** in current Power Fx:
  `GroupBy(t, Col, grp)`, not `GroupBy(t, "Col", "grp")`. Much published documentation shows the
  quoted form. `Distinct(...)` returns a column named `Value`, not `Result`, in at least one build;
  `GroupBy` keeps the real column name and reads more cleanly.
- **Sort order is an enum**: `Sort(t, col, SortOrder.Descending)`; a bare `Descending` fails.

## 5. Lookups and relationships in formulas and queries

- **A lookup read off a row is a PARTIAL record: key and primary name only.** `ThisItem.Customer`,
  `gblRec.Customer`, `Table(gblRec.Customer)` and a lookup carried in a collection row all carry the
  key and the primary name and nothing else. A second display column renders blank; a picker's
  `DefaultSelectedItems` fed from it shows blank columns the moment the picker gains a second field
  (and a GUID when the primary name is an autonumber code); passing it to another screen opens with
  blank fields and empty tabs. Re-resolve the full row by key before display or navigation:
  `LookUp(Customers, Customer = ThisItem.Customer.Customer)`, or flatten the fields you need into the
  collection.
- **A lookup cannot be compared to a record** (*"Incompatible types for comparison: Record,
  Record"*). Re-hydrating the variable from the source produces the identical error - it is a
  language limitation, not variable pollution. Compare keys: `Customer.Customer = gblSavedKey` - also
  delegable. You likewise cannot `SortByColumns` on a lookup; sort on a persisted scalar.
- **A `Patch` result exposes no relationship navigation**: `patchResult.'Order Lines'` fails "The
  specified column is not accessible in this context". Read related rows separately.
- **Lookup traversal inside a server-side predicate compiles clean and fails at run time.**
  `Filter(Lines, 'Order'.'Order Number' = x)`, a correlated subquery (a `Filter` nested in another
  referencing the outer row) and `IsBlank(column)` inside a `Filter`/`LookUp`/`CountRows` over a
  Dataverse source all compiled, passed App Checker, and failed at run time in two apps - a network
  error, an empty gallery or a blank label, with nothing shown to the user. Another app's audit
  treated the same shapes as answering silently from the first row-limit rows. Either way it is a
  defect, not a warning to tolerate. Fixes: compare the lookup's key instead of a field behind it;
  hoist into a collection (`AddColumns` the traversal, then filter); or denormalise a delegable
  column onto the row (section 6). After finding one, grep all of `Src`: an unquoted single-word
  field (`'Cost Center'.Code`) evades a regex that requires both sides quoted.
- **Traversal that is NOT a delegation fault.** A traversal off a variable (`gblRec.'Cost
  Center'.Name` inside a server-side `Filter`) is evaluated once on the client and is legitimate;
  so is one over the alias in `ForAll(Source As r, Filter(..., r.Lookup.Field ...))`. Rewriting
  these "to fix delegation" broke the compile once. Audits need an allowlist for them.
- **Dataverse rejects a `$filter` with more than one nested lookup.** ORing across two different
  lookups (`Recipient.Person = me || Author.Person = me`) or walking three hops
  (`Line.Order.Owner.Person`) failed at run time with "$filter clauses with more than 1 nested table
  lookup not supported" - a red banner and zero rows; the compile does not catch it. Split into
  single-hop queries and union them, de-duplicating on the primary key, or filter broadly on a
  denormalised key and narrow in memory.
- **`A = me || (IsBlank(A) && B = me)` over lookups is not delegable** (four delegation warnings on
  an otherwise clean compile). For a queue that must scale, store the resolved value at write time
  (always populate the "decider" column, falling back to the default person and saying so on
  screen) so the filter is a single equality.
- **Narrow, then finish in memory.** Delegate the selective predicate (this person, this period)
  and apply the awkward test (an open-ended `Effective To`, "blank means everyone") to a result that
  cannot reach the row limit.
- **Never traverse a one-to-many relationship off a VARIABLE.** `Set(gblRec, ThisItem)` then
  `gblRec.'Order Lines'` compiled and returned nothing in the published player; Preview showed "The
  requested operation is invalid."; `Filter(Lines, Order = gblRec)` failed to compile; re-hydrating
  the variable and refreshing the source changed nothing. Tell: the gallery is empty **and** its
  empty-state label is hidden too. An earlier fix in the same app, `Filter(gblParent.'Order Lines',
  ...)`, appeared to work but traded an error for staleness - navigation off a captured record returns
  rows as of the capture, so a newly added line did not appear. Durable fix: a stored key column on
  the child, filtered server-side, or a collection narrowed client-side.
- **A polymorphic Owner needs `AsType`**: filtering by owner needs the Users source and
  `AsType(Owner, [@Users])`; direct dot access fails. Note `'Owning User'` is whoever owns the row -
  for seeded data, whoever created it - not the business owner column the app maintains.

## 6. Delegation and the data row limit - it applies to Dataverse too

Measured on a live app with a 2,282-row table and the row limit at 2,000:

```
ClearCollect(col, Vendors)                       -> 2000   truncated
ClearCollect(col, Filter(Vendors, <delegable>))  -> 2000   truncated anyway
CountIf(Vendors, true)                           -> 2282   delegated, no rows pulled
```

Two mechanisms get conflated:

- **Delegation**: can the query run server-side. Dataverse delegates much more than SharePoint,
  which is why people conclude the limit is a SharePoint problem.
- **The data row limit**: how many rows the app will materialise from one query. It applies to
  every tabular connector. It **defaults to 500** (Settings > General > Data row limit) and
  **2,000 is the maximum** - a ceiling, not a tuning knob. Raising it to 2,000 only moves where a
  non-delegable query silently truncates.

**Read the app's actual limit before doing delegation arithmetic.** It is
`DefaultConnectedDataSourceMaxGetRowsCount` in the downloaded app's `Properties.json`, and anyone can
change it in Studio. The "500" in Studio's delegation warning text is generic boilerplate: one team
announced that a bulk copy had processed only 500 of 1,236 rows and had to retract it the next day
(the app was at 2,000; the fix stood anyway). A Studio change to the limit is saved-but-unpublished
like any other Studio change until you publish.

**A non-delegable query does not throw; it answers from a prefix.** The result looks complete. A
`LookUp` that feeds a save and misses because its row sits past the limit makes the save **create a
duplicate**.

**A delegable query is safe only when the RESULT fits.** Design rules:

1. **Bind controls to the source, not a collection.** A gallery over a delegable Dataverse source
   pages as the user scrolls and has no ceiling. When you are asked to add a filter to a gallery
   that currently reads a collection built in `OnVisible` (`ClearCollect(col, Filter(Table, ...))`),
   **move the whole query into the gallery's `Items`** -
   `Filter(Table, Status = ..., IsBlank(txt.Value) || StartsWith('Vendor Name', txt.Value))` -
   rather than layering the new filter on the collection. The collection was already a truncation
   risk; filtering it makes the new feature inherit the bug. Totals then come from a delegable
   aggregate or a server-side rollup, not from `Sum(collection)`.
2. **A collection is a cache with a hard cap. Size every one against its growth** - "what is this
   at 10x?" One looked healthy at 68% of the cap. When `CountRows(col)` equals the limit, show it
   (turn the count line amber: "List truncated at 2,000") rather than letting it pass as complete.
3. **Denormalize to make a filter delegable.** Lookup traversal (`Line.Project.'Project Number'`)
   does not delegate (section 5); a plain text column on the row does. Highest-leverage fix, and
   cheap - but every write path, including importers and model-driven forms, must then maintain the
   copy (`audits.md`, denormalized columns). For a multi-value membership test, a pipe-delimited
   rollup on the parent (`"|A|B|"`, tested with `("|" & x & "|") in Col`) replaced a non-delegable
   correlated subquery in one app; recompute it after bulk edits.
4. **Never compare a choice column to a variable in a delegable filter** - it needs `& ""`, which
   breaks delegation. Denormalize a rank or text copy.
5. **`SortByColumns` only delegates on a real column.** Anything computed in a projection must be
   persisted before a directly bound gallery can sort on it. `First(Sort(T, 'Modified On',
   SortOrder.Descending))` delegated in one app where `Max` over a date column was treated as
   non-delegable (unverified).
6. **Aggregates: trust the warning on YOUR expression.** Microsoft documents `Sum`, `Min`, `Max` and
   `Average` as delegable for Dataverse, and one project reconciled delegated `Sum` totals to the
   cent against the Web API; another got a non-delegation warning on its `Sum` expression and could
   only total a scoped set. `CountIf(T, true)` delegates. The compile/Studio delegation warning for
   the exact expression you wrote is authoritative; when it appears, pre-aggregate server-side or sum
   a collection whose size you control (section 7).
7. **`CountRows(Source)` may return a cached count** (Studio says so). `CountIf(Source, true)` gives
   a live, delegated count.
8. **`Lower()` in a predicate is not delegable and is unnecessary** - Dataverse string comparison
   is already case-insensitive.
9. **`StartsWith`'s second argument must be a literal or a simple value to delegate** - not an
   expression built inside the predicate (section 7).
10. **Read the delegation warnings.** Studio's underline and the compile output name the exact
    clause. They are authoritative and free - and their **disappearance** is the best evidence a
    fix delegates: moving a filter onto a stored key column took the warning count from 61 to 60.
    With two rows of test data a broken filter and a working one look identical.

## 7. Reading large tables: chunking, scoping and proving it

- **A collection is not subject to the row limit; each query that fills it is.** To materialise
  more than the limit, `Collect` several queries that each return a few rows. Chunk on a key whose
  chunk size does not grow: one fiscal period, one parent record, or ten batches on the first digit
  of an always-set autonumber code (`StartsWith('Order Code', "ORD-0")` ... `"ORD-9"`, about 1,000
  rows each until the sequence passes 9999).
- **Build chunk keys outside the predicate.**
  `Filter(T, Code = gblFY & "-" & Text(m.Value, "00"))` compiles with 0 errors and only a warning
  ("'Concat' cannot be evaluated remotely"), so the "chunked" read runs client-side over the first
  2,000 rows. Precompute the keys:

  ```
  ForAll(
      ForAll(Sequence(12) As n, {k: gblFY & "-" & Text(n.Value, "00")}) As m,
      Collect(colFacts, Filter(Facts, Code = m.k))
  )
  ```

- **The real fix for a non-delegable total is summing a collection whose size you control**, or a
  server-side rollup - not raising the row limit.
- **Measure the data's distribution before choosing a scoping key.** "Scope reads by fiscal year"
  removed nothing in one app because every row was in one year; only per-record scoping survived
  (52 rows against about 110,000). Model each candidate scope against the limit at today's,
  planned-active and full-migration sizes; even one row per parent can exceed it at full scale.
  Count rows per key with `GET <set>?$count=true&$top=1`.
- **The limit is per non-delegable query, not per table.** One unscoped read on a 900-row table is a
  worse defect than a scoped read on 90,000 rows, because it truncates silently once the table
  grows. Archiving for performance usually buys nothing and costs referential integrity; status-
  scoped reads (only Submitted, only Returned) are self-limiting. Enforce with an audit that fails
  any unscoped read of a large transactional table, in every behaviour property - one whole-table
  `ClearCollect` hid in a button's `OnSelect` (`audits.md`).
- **Prove truncation fixes by lowering the limit.** In an UNSAVED Studio session set the data row
  limit to 150 so today's data exceeds it: old code read about 1.5M against a true 13.0M, and the
  fixed code matched at both 150 and 2,000. Restore the setting before any save or publish.
- **In reference panels, print the count actually loaded**; matching it to the server's OData count
  proves the app is not dropping rows.
- **When detail outgrows the limit**, keep detail scoped to one parent and have portfolio screens
  read pre-aggregated rollup tables (`canvas-controls-and-patterns.md`, section 11).

## 8. Function behaviour that surprises

- **`Select()` queues the target's `OnSelect`; it neither runs first nor waits.**
  `Select(Check); If(gblClash, ...)` tests `gblClash` before `Check` runs - every time, not as a
  race. A hidden "loader" button is fine when nothing after the `Select` depends on its result;
  anything whose result gates the next statement must be written inline. **`Select()` on a control
  with no `OnSelect` is a silent no-op** - a Refresh button that selected a nav label (which by
  convention had none) never rebuilt anything, and shipped "verified" by marker.
- **`Refresh()` of a source the control does not read does nothing visible.** A gallery bound to a
  collection is unaffected by `Refresh('Orders')`; rebuild what the control actually binds.
- **`Switch()` and `If()` take their result type from the first branch** and coerce the rest:
  `Switch(tab, "a", CountRows(x), "b", Text(total, "0.0"))` is a number, so "264.0" prints as "264".
  When any branch is text, wrap every branch in `Text()`.
- **`Sum()` of nothing is Blank, and Blank renders as nothing.** `Sum` over an empty filter (or the
  `.AllItems` of an empty gallery) returns Blank, not 0; `CountRows` returns 0. `Text(Blank(),
  "$#,##0")` is the empty string, so tiles showed a heading with no number beside tiles reading "0",
  sentences read "Order total    items", and users could not tell where to click. A guard written
  `x = 0` does not catch Blank, so a percentage divided by it threw; a Blank persisted to a header
  total recorded "unknown" rather than zero. Wrap every displayed, persisted or dividing aggregate:
  `Coalesce(Sum(...), 0)`, and sweep every total when you find one.
- **The same holds for a variable that has not been set yet.** `If(gblTotal = 0, 0, done / gblTotal)`
  divided by Blank in Studio before any record was opened, and Studio showed "Invalid operation:
  division by zero" on the first compile. Guard with `Coalesce(gblTotal, 0) = 0`.
- **Search with `in`, not `StartsWith`, when people type a surname.** `StartsWith('Person Name', x)`
  cannot find "Lee" in "Ada Lee". On Dataverse `x in 'Person Name'` (substring) delegates - measured:
  the compile's warning count did not change. Keep `StartsWith` for emails and codes.
- **`Text(x, "0.##")` keeps a dangling separator.** `Text(40, "[$-en-US]0.##")` renders "40." (as
  Excel does). It compiled, passed every audit and shipped twice in one app (eighteen sites, then
  seven). Use a fixed format (`"0.00"`) or bare `Text(x)`.
- **`%` in a Power Fx format string does not multiply by 100.** `Text(0.64, "0.0%")` prints "0.6%".
  Scale it yourself: `Text(x * 100, "[$-en-US]0.0") & "%"`.
- **Sectioned format masks leak into the UI.** `Text(v, "+$#,##0;-$#,##0")` showed users
  `+$16;-$7,598` in one app (the project read it as locale-dependent; unverified). A small
  user-defined function that renders sign, currency and percent explicitly, applied at every
  variance display, was clearer.
- **An `As` alias scopes only the table argument it is attached to.** In
  `Sum(Filter(colPeriods As pp, pp.Year = x), pp.Amount)` the alias is unrecognised in the `Sum`
  argument, because `Sum` re-scopes to its own row - write `ThisRecord.Amount` or the bare column. It
  compiles as an unrecognised name, so it reads like a missing column. Likewise the alias for a
  `ForAll` goes on the `ForAll`'s table (`ForAll(Filter(T, ...) As r, Patch(...r...))`), and a bare
  `ThisRecord` inside `ForAll` did not resolve in the authoring compiler - use `As`.
- **Inner scopes shadow `ThisItem`.** Inside `AddColumns` on a nested gallery's source, `ThisItem`
  is the inner row. Capture the outer row first:
  `Items: =With({ln:ThisItem}, AddColumns(colPeriods, LineId, ln.Id))`, then read
  `ThisItem.LineId` in the inner cell. (No space after the colon in `{ln:ThisItem}` - section 11.)
- **`UpdateContext` nested in `With()` has not committed when the next statement runs.**
  `With({fp: LookUp(...)}, UpdateContext({locAmt: fp.Amount})); Reset(txtAmt)` reset the box against
  the PREVIOUS value. Write the context update and the reset as plain sequential statements.
- **`Navigate()` needs a literal screen.** It cannot take a variable; a data-driven list of
  destinations drives a `Switch` of literal `Navigate` calls.
- **Blank compares confidently.** `>=`, `<=` and `<>` against `Blank()` all return an answer.
- **A comparison against a value that does not exist is always true and nothing flags it.**
  `gblMetric <> "Variance"` never fired because the picker offered "Variance vs Budget"; the red/green
  styling it gated had never worked. Only performing the task finds a formula that is merely wrong.
- **`Download()` of a `data:` URI does nothing** - browsers block it, with no file and no error. To
  export, send the text to a flow (email it as an attachment, or create a file and return a link),
  then `Launch()` the https URL.
- **Calling a flow from the app**: Power Apps strips spaces from the flow's name and a hyphen forces
  quoting; parameters arrive positionally (`text`, `text_1`, `text_2`, in the order the inputs were
  added to the trigger) - read the flow's contract rather than assuming. A formula naming a flow the
  app has not added fails the whole compile; add the flow in Studio, save and publish first, like a
  new data source. A flow created under My flows cannot be added to a solution-aware app
  (`power-automate.md`).
- **Diagnosing a dead source:** `If(CountRows(Source) = 0, "A", "B")` in a label - blank means the
  expression faulted (source), not that the table is empty.

## 9. Performance: formulas that re-run on every render

- **A per-cell `LookUp` inside a `Filter` is O(rows x lookups) on every render.** Report cells
  computed as `Sum(Filter(colPeriods As pp, ... && !IsBlank(LookUp(colLines, Id = pp.LineId &&
  <attrs>))), pp.Amount)` re-ran the join per cell, per row, per render: 73 sites, 34 on one
  dashboard, re-firing on every dropdown change - multi-second click lag and a frozen dropdown. App
  Checker never flags it. Fix: project the parent's attributes onto each child row once in
  `OnStart`, so every total is one flat `Filter`, and make every runtime writer that adds to the
  collection emit the enriched shape.
- **A totals row outside a gallery cannot use `ThisItem`.** Precompute the per-row amount into a
  collection column so every cell, row or total, is a plain `Sum`.
- **Use `Gallery.AllItemsCount`, not `CountRows(Gallery.AllItems)`.** The latter forces the gallery
  to materialise every item for a count label or an empty-state `Visible` (App Checker rule
  `CountRowsGalleryAllItems`).
- **Batch creates as `Collect(Source, ForAll(...))`** rather than `Patch` inside `ForAll` (App
  Checker `ForAllWithMutation`). It cannot always be batched: when child rows must reference the id
  of a parent created in the same pass, the parents must exist first; one project accepted per-row
  writes for a low-frequency admin action.
- **One load pattern per dataset.** An inherited app pasted the same 40-line `ClearCollect` on four
  buttons and also loaded it in `OnStart`; give each dataset one loader that every caller uses.
- **`ScreenHasManyControls`** fires above about 300 controls on one screen - a hint to split.

## 10. Identity: who is signed in

- **`User()` exposes `Email`, `FullName` and `Image`**; canvas identity in these projects was
  matched by `User().Email` against a person table. A person row whose email differs from the
  sign-in address (a formal name, a missing or changed address) opens the app as an unknown user -
  show such a user the address the app tried to match. Keep the email column clean.
- **`User().EntraObjectId`** exists in current Power Fx and is more robust than email (it does not
  change when an address changes or is recycled). It is an option to evaluate, not verified in the
  projects behind this skill; check your version before building on it.
- **The signed-in `systemuserid` is not directly available.** A lookup from a person table to
  `systemuser` still pays off server-side (row sharing, `GrantAccess`, flows, row security); keep
  email as the fallback for people without accounts, refuse two person rows pointing at one user,
  and give the lookup RemoveLink on delete (`dataverse.md`).
- **Diagnose a session you cannot see** with a small line, shown only to a person who has a
  qualifying row but was not recognised, printing what `OnStart` found - and show the build stamp to
  everyone (`canvas-controls-and-patterns.md`, section 14).

## 11. .pa.yaml syntax that breaks the whole compile

The compile is all-or-nothing across every file: one bad character fails the app, and the error
rarely points at the responsible line. The bundled hook catches the first four at write time.

- **A colon followed by a space inside a single-line value** breaks the YAML scanner even inside
  a quoted string: `Text: ="Total: " & x` fails. Build it as `"Total:" & " " & x`, or use a block
  scalar. The confusing part: `{locOpen: true}` is fine inside `OnSelect: |` and a parse error
  inside `OnSelect: =`. Error text: *"While scanning a plain scalar value, found invalid mapping"*.
  Record literals are the usual victim - write `{locOpen:true}` without the space, or put any
  formula containing a record in a block scalar. A house rule of " - " instead of ": " in UI
  strings avoids the trap in captions.
- **A `#` preceded by a space in a single-line value starts a YAML comment** - `"Order #"` lost
  the rest of the formula; one app renamed it "Order No".
- **No YAML comments.** The service round-trips these files and drops them; put reasoning in the
  commit message or the decisions log. (A tooling note: a comment line indented shallower than a
  block scalar legitimately ends the block, so an indentation checker must skip comment lines
  rather than read them as broken continuations.)
- **`Tooltip` on a modern Button** - a hard bind error (`canvas-controls-and-patterns.md`,
  section 1).
- **The ~50 file ceiling** - see `canvas-shipping.md`.
- **A base64 data-URI image costs file size.** `Image: ="data:image/png;base64,..."` works, but a
  logo added roughly 49 KB to every `.pa.yaml` that carried it - pressure on file-size limits, and
  copying it per screen pushes toward the file ceiling. Put it in one place (a named formula) at
  most; the alternatives are a one-time media upload in Studio or images packed into the app's
  Assets folder (both unverified in these projects).
- **A continuation line indented less than its block scalar ends the block.** YAML then reads the
  rest of your formula as mapping keys, and reports `found invalid mapping` **where it gave up** -
  one case was thirty lines below the line that broke. Search upward from the reported line for a
  line shallower than its block. When scripting edits, derive indentation from the neighbouring
  line; never write a literal indent.
- **`Children:` is a sibling of `Properties:`, not nested in it.** Nesting it broke five blocks in
  one pass.
- **Block scalars come as `|`, `|-`, `|+`, `>`...** House style varies. Any tool that recognises
  formulas must match `[|>][-+]?`, or it will parse nothing in a codebase that uses `|-`.
- **Gallery variants are `Vertical` and `Horizontal`.** The early-preview `galleryVertical` fails
  with `PA2109 Unknown variant` and stops Studio opening the app at all - and a packed copy still
  embedding it is what Studio validates on open.
- **Dotted enum names must be single-quoted**: `'TextCanvas.Weight'.Bold`,
  `'ButtonCanvas.Appearance'.Subtle`, `'TextInputCanvas.TriggerOutput'.Keypress`.
- **Control names must be unique across the WHOLE app, and a duplicate is not a compile error.**
  YAML accepts it and it behaves unpredictably at run time; one collision came from a
  `ComboBoxDataField` child. Prefix every control with its screen (`ordGrid`, `detSave`) and audit
  uniqueness app-wide, including nested children. Name every control for what it is - an app full of
  `Container14_16` cannot be maintained.
- **A screen may not share a name with a data source.** `Navigate(Orders)` resolved to the table,
  with "the specified property is not accessible in this context". Suffix screens (`OrdersScreen`).
- **Check the app's modern-controls flag before writing Fluent control names.** With "Modern
  controls and themes" off (`fluentv9controls: false` in the downloaded app's settings), no modern
  control name binds. Turn it on before the first screen: on a blank app it is free; after ten
  screens it means a re-style. Several app settings take effect only after save, close and reopen.
- **Changing a control's type under the same name** silently keeps the old control
  (`canvas-controls-and-patterns.md`, section 9).

## 12. Reading compile output

- **Read the first line.** `No active coauthoring canvas designer session detected` means the
  result is meaningless (`canvas-shipping.md`, section 8).
- **Read the first diagnostic, not the loudest.** Everything after a failed `OnStart` or a failed
  record literal is consequence.
- **A wall of `'X' isn't recognized`** almost always means the session, not the source.
- **FAILED is printed for warnings too.** Count `: error` lines; anchor on `Files validated: N`.
- **Zero errors is not a clean compile.** Type mismatches inside `Filter` (section 4) and
  non-delegable clauses are warnings. Read every warning on the lines you changed.
- **Bisect.** When an error names only "control and property", comment out half the fields and
  compile again. One compile per half is cheaper than reasoning. Write down each hypothesis the
  evidence eliminated - in one hunt a blank grid, a `Record, Record` compile error and "invalid
  operation" in Preview had one cause, and three plausible suspects (a sort on a lookup, a stale
  snapshot, a polluted variable) were each disproved before it was found.
- **Settle property names with the authoring server, not one push per guess.** `describe_control`
  lists every input and output property with its enum values, from the same source the compiler
  reads - that is how `TriggerOutput` was found, and how `DatePicker`/`ComboBoxDataField` (not
  `DatePickerCanvas`/`ComboBoxField`) were confirmed.
- **Prove an unproven property on ONE control before adding it to many.** Adding a property not
  proven valid on a control type to 108 controls at once is how a whole navigation layer stops
  binding.
