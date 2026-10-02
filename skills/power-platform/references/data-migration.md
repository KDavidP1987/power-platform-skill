# Migrations, loads and backfills on live Dataverse data

A migration that edits live data is a claim about what the data will look like afterwards. Every
write here is production data unless proven otherwise. Schema design is in `dataverse.md`; the Web
API mechanics (paging, names, retries, PowerShell traps) are in `dataverse-web-api.md`; what fires
when you write is in `power-automate.md`, section 8.

## Contents

1. The rules for any write
2. Profile the source before planning
3. Keys: crosswalk on source keys, never names
4. Moving an app onto a different table: the parallel lookup
5. Loading from spreadsheets
6. Backfills on watched tables
7. Destructive runs, test data and clean-up
8. Read models and rebuild scripts
9. Cutting over

---

## 1. The rules for any write

- **Dry-run first, always**, printing the actual rows it would touch, not just a count. Make dry run
  the default and require `-Apply`. Dry runs must model rows that earlier steps of the same run would
  create - one reported 18 phantom creates.
- **Fill blanks freely; never silently overwrite a value that disagrees.** Report disagreements for a
  person to decide. If an overwrite rule is needed, make it narrow and stated ("replace only where the
  current value points at a deactivated row"); "latest wins" is not a rule. For messy clean-ups, work
  in two phases: apply only unambiguous fixes, and send heuristic ones to a review CSV with an
  `apply = Y/N` column.
- **Do not invent values.** Where the data cannot say, leave the field blank (show "Not set") and
  report it. A backfilled proxy - a start date taken from another event - carries a note on every row
  saying where it came from; seeded-but-unconfirmed reference data says UNCONFIRMED wherever it is
  shown. A guessed value that looks measured is worse than a blank, because nothing downstream can
  tell them apart. Check that no history exists anywhere before estimating.
- **Write only rows that are wrong.** A backfill that rewrites every row moves `modifiedon` for every
  consumer of a shared table and can wake every flow on it. A second run should be a no-op (one repair
  wrote 249 rows, then 0).
- **Validate the whole input before writing anything** - allowed values, lengths read from live
  metadata, uniqueness of identity keys (no email on two people, none colliding with an existing row).
  A half-loaded master looks finished.
- **Read it back after writing.** A 204 means accepted, not correct. Re-query and print the count.
  **The verification filter must be at least as wide as the writer's**: a loader that verified with a
  narrower date filter than it wrote reported "368 of 370" and a phantom shortfall. Derive both from
  one predicate, and say which "active" you mean - a custom Active flag and `statecode` disagreed on 68
  of 158 rows.
- **Idempotent, so a partial failure is resumed by running it again** - but idempotence is only as good
  as its snapshot. A loader whose "already exists" check ran once at the start left three copies of one
  person after a part-way failure. Pre-flight must abort on duplicates and name them.
- **On a shared table, deactivate rather than delete.** A flag is reversible, survives referential
  constraints, and does not destroy an answer another app relies on. Check references first.
- **Data that breaks a rule but belongs to users is reported, never deleted** by a script - for
  example forecast lines left on completed records.
- **Key every upsert on a unique code, never a display name** (section 3).
- **Seeds are a starting position, not an interface.** Once an admin console edits a table, make its
  loader insert-missing-only and report differences, with an explicit `-Overwrite` for rebuilding an
  environment; an upserting seed silently reverted console edits. Never replay a whole settings seed
  over live: one still carried both notification channels **on** and would have re-enabled mail for
  everyone - seed the safe value and audit seed files with the live-settings rules. Conversely, when a
  backfill changes a shared table, update the seed file (and the schema manifest) in the same change,
  so a from-scratch rebuild reproduces live.

## 2. Profile the source before planning

What "migrate the history" means is a measurement, not an assumption.

- **Count before planning**: parents, children, childless parents, active vs inactive, distinct
  values per column. About 17,200 legacy "headers" turned out, by bucketing `createdon` per minute, to
  be empty shells a machine created in two minutes; the real history was under 3,000 self-contained
  lines - a question that had stood open for two years. Migrate what the measurement says is real, and
  keep strays rather than silently dropping them.
- **Look for junk rows a previous import made.** A CSV import had turned "NA" and "0" cells into active
  person rows that appeared in every picker; deactivate them after checking references.
- **Find packed meanings before mapping a column.** A source column held a year **and** a disposition
  in one value ("F21 - In Plan") on half its rows, and the target was a lookup to a year table.
  Migrating first would have silently dropped the disposition on 1,054 rows. Ordering is the whole
  risk: add the missing column, then migrate.
- **Measure cardinality before choosing lookup vs junction.** 41% of records carried a group value for
  more than one year; a single lookup would have kept one. Prefer the grained shape (parent x period x
  value) when the source is multi-valued. Likewise, count matches per key before switching on any
  "exactly one match" rule - one would have left most snapshots blank and mailed support on every run.
- **Read a source system's codes from labels, not intuition.** A SharePoint `Status` choice coded 0 =
  Active, 1 = Inactive; a migration read it the other way round, and its audit - sharing the same
  assumption - compared against the old rows and reported 86 of 86 in agreement while six people were
  wrong. Derive mappings from labelled rows (`FormattedValue`), spot-check individuals whose answer you
  already know, and treat **100% agreement on a first run as a reason to check the selection**. An
  audit must derive its expected values independently of the code it checks.
- **Measure what users actually fill in.** An empty list named after a process is not proof the
  process is unused - the "pipeline" lived in most rows of a differently named list. For workbooks,
  diff each live file's cells against the blank template: a value counts as hand-entered only if it is
  not a formula and differs from the template. Some sheets were never filled (0 of 7), so the tables
  designed for them were dropped.
- **Free text to a managed reference list:** profile distinct values and counts, propose canonical
  values and merges, leave junk blank rather than guessing, ship the admin screen so the business
  finishes the mapping, and keep the free-text column as a maintained mirror. A canonical set carries
  an `is_active` flag for retired values plus a crosswalk from every legacy spelling, loaded as seed
  data so the migration cleans as it loads.
- **Do not classify rows by a display-name string; write the typed column.** A report separated walk-in
  sales from orders by excluding the category literally named "Walk-in". The typed choice built for this was
  null on all 3,113 rows because no write path set it, and renaming the row would silently count walk-ins
  as orders. Have the app write the typed column, then backfill it (section 6), asking a person about any
  value without a clean mapping.
- **Rich text from a SharePoint list can be HTML-encoded twice.** Multi-line rich text arrives
  entity-encoded, and on some rows encoded again (`&amp;lt;div&amp;gt;`). Strip-then-decode left
  literal `<div>` on screen and would have made 38 of 708 rows worse; decode, decode again, then
  strip left zero rows with markup. Decode `&amp;` last within each round so it cannot manufacture a
  new entity. Dry-run any text clean-up over **all** rows and count improved / unchanged / worse
  before applying, and state the cost: without a smarter replace, a literal `<` in prose ("<30
  words") is lost.

## 3. Keys: crosswalk on source keys, never names

- **Crosswalk on the source system's key.** A name comparison reported 43 "missing" vendors where
  matching on vendor number found 0-1. A reference load de-duplicated by **name** kept one row per
  name; 31 names occur several times under different numbers, so 41 numbers resolved to nothing -
  harmless for a picker, but data later keyed by number arrives as unattributed amounts, not as an
  error. Load one row per business key with the name as a non-unique label, count source rows against
  loaded rows, and explain every gap.
- **Never rename or reformat a natural key after seeding** - every consumer's backfill matches on it.
- **Never match with `contains()`.** A `contains(name,'X')` filter overwrote the wrong record during a
  live migration; the verification pass caught it.
- **Upserting on a name makes renames impossible.** A loader keyed on (name + classification) cannot
  rename: change the name in the CSV and it creates a second pair of rows and orphans every record
  pointing at the originals. Rename in the environment first, then edit the seed. Use composite keys
  where two genuinely different rows share a label, and natural keys that survive reality.
- **Matching people:** match on a stable id, then email, then a name **only when exactly one row bears
  it**. Keying on one id alone nearly duplicated a person whose row had an email but no id.
  - Network ids are not stable: 56 people held more than one and 30 ids recurred across different
    people. Make the person row the identity and let the id travel on a dated assignment or alias
    table.
  - Names are not unique: twelve names in one roster belonged to two different people each.
  - Duplicates hide in format variants ("Surname, Forename - Dept (nnnn)" vs "Forename Surname");
    an identical-name check misses them.
  - Duplicate guards must include inactive rows.
  - Refuse a write that would land one directory account on two people.
  - Prefix matching and nicknames: `dataverse-web-api.md`, section 14.
- **"Missing" from a shared table is unproven.** An exact-name match reported six vendors absent; five
  were present under legal names the source spelt short. Acting on it would have created five
  near-duplicates in a table other apps read. Build a mapping instead.

## 4. Moving an app onto a different table: the parallel lookup

Publisher prefixes, schema names and a lookup's target are immutable (`dataverse.md`, section 4), so
"rename onto the shared table" is impossible. The sequence that worked, one table at a time,
lowest-risk first and the most-referenced (the calendar) last:

1. **Reconcile rows on a natural key** and keep an id crosswalk.
2. **Add a new lookup beside each old one**, with a suffixed display name ("Vendor (shared)") so the
   two do not collide while both exist - logical **and** display names must both be new.
3. **Backfill through the crosswalk** (code first, then name only when unique).
4. **Refresh the data source in Studio**, then repoint every formula **and** every
   `ComboBoxDataField.FieldName` (a raw string with no bind check - `manifest-caches.md`). Repoint
   wholesale; a repoint is done only when nothing references the old name.
5. **Grant every app role Read on the new table** (`security-and-access.md`).
6. **Audit agreement row by row** (below).
7. **Keep the old table and lookups as the rollback path** until a test round passes, then retire
   (`dataverse.md`, section 9). If a half-migration would make the UI contradict itself, revert it
   wholesale.

**Audit agreement, not coverage.** "Backfilled N rows" and "non-blank" are not evidence. Check:

- rows with the old lookup set and the new one blank;
- where both are set, that they resolve to the **same natural key** (0 disagreeing);
- denormalized string vs lookup disagreement - the highest consequence, because screens filter on the
  string while joining by the lookup;
- gaps in the crosswalk, and orphans;
- the behavioural impact of the new source of truth (which totals move, per year).

A pass like this also surfaces pre-existing faults - one found a column that was null on every row.

## 5. Loading from spreadsheets

**Audit the source against live first.** Match every key; compare key formats (short vs long
numbers); check the source's own arithmetic (total = sum of days); choose the app's derivation and
report the discrepancies rather than loading them.

Traps measured in real workbooks:

- About 15,000 phantom columns in a small sheet; text in numeric cells ("off board", formula
  fragments); merged subtotal rows interleaved with detail; two coexisting code schemes. Validate the
  header layout before reading - a `(field, column, expected header prefix)` map makes the loader
  refuse a shifted sheet.
- **Check the extract's dates against its save date.** A workbook cut on a Monday held the next
  week's pre-filled copies: 31 of 57 rows byte-identical to the previous week.
- Macro-enabled workbooks may refuse automation; parse the `.xlsm` XML directly, handling
  self-closing `<c/>` cells (a parser that did not attributed every value to the previous cell). Excel
  holds an exclusive lock on an open workbook: copy it and read the copy.
- **Parse CSV with a real RFC 4180 parser**, never by splitting lines on commas: quoted fields carry
  commas and newlines. When an export has duplicate column names, address columns by position - a
  reader that keys rows by header name keeps only one of the duplicates and silently drops the other.
- Keep source workbooks, extracts and generated CSVs **out of git** - they carry names and money.

**Before a production load, produce a review workbook**: an issues tab with ids, "question for" and a
severity (Decision / Follow-up / Fix at source / Cleaned / Info), hyperlinks between each issue and its
row, the original "(workbook)" columns kept beside the corrected ones plus a Load? Yes/No column, a pale
tint on the exact cell, and a reconciliation tab against control totals to the cent. The loader reads
the reviewed copy, then: dry run, trial load, read-back reconciliation.

**Load each row in exactly the shape the app writes**, leaving blank what the app leaves blank, so a
loaded record behaves like a typed one.

**Check reference coverage.** Legacy weeks loaded before the calendar table covered them would have
been invisible to every screen filtering by week; make the importer refuse until the reference rows
exist.

**Reconcile three ways** - file, headers, lines - to the source's precision (one load matched to 0.1
hour). Splitting a total across periods leaves rounding drift (up to a few dollars per line): put each
line's remainder on one row so the parts add back to the cent, and re-audit. When loading explicit
autonumber values, move the autonumber seed above them, or the next row the app creates collides.

## 6. Backfills on watched tables

**Ask what watches the table before any bulk write** - a correct, loop-guarded trigger flow fires once
per row (`power-automate.md`, section 8). Beyond senders:

- **Put the interlock inside the migration.** The script reads the live on/off state of the flows that
  watch the table and **aborts** unless they are off, printing the exact off/on commands - not a
  warning to skim.
- **Change-log flows matter too.** An unguarded logger would have written hundreds of "Total now
  5,000" rows recording changes that did not happen.
- **Deletes are bulk writes.** During a test-data purge, a delete-triggered logging flow wrote a blank
  "Deleted" row per record, which then needed cleaning.
- **Park and restore by name.** A `park(names)` helper records each flow's current state, turns off
  only those that were on, and re-reads; `restore(state)` turns back on only those that were on and
  refuses if the re-read differs.
- **Denormalized copies have writers you forget** - importers, migrations, admin forms, the
  model-driven app (`dataverse.md`, section 10). Repair with a fill-blanks backfill and make it
  re-runnable as a drift detector.
- **A stored label column** ("number - name" for a large picker) goes stale silently after any bulk
  load that changes its parts: re-run its backfill as part of the load.

## 7. Destructive runs, test data and clean-up

**A purge, in order:**

1. Export every row of every affected table to timestamped JSON **outside git** (it holds personal
   data). That file is the undo. Refuse to delete until export counts equal live counts.
2. Park the flows that would write a row per delete.
3. Delete parents first (children cascade), then dependants.
4. Re-read every table and require 0.
5. Restore each parked flow to exactly the state it was found in, and re-read.

**Before deleting a table**, print its row count and every known reference - including Power BI
datasets and flows outside the repo - and delete only on explicit sign-off. In the app, disable
Delete on a reference row while it is in use, show the count, and offer Deactivate.

**Test data:**

- **Mark it** (a `[TEST]` prefix, a notes marker, a recognisable email pattern for synthetic people),
  and keep **one** removal command that deletes only marked rows and prints how many unmarked rows it
  leaves, so the count is checked, not assumed. Its faults show only in use: one missed two tables the
  seed wrote (not reachable by cascade) and its preview printed "leaving -1". Check its table coverage
  against the seed.
- **Seed the awkward cases on purpose**: two rate rows with a boundary mid-week, an approver who
  differs from the leader. A test where the only candidate is the right one proves nothing.
- **Never in tables other apps read.** Do not add or delete fake rows in a shared table - reuse
  existing fixtures - and never invent pay or people in tables other apps read. Deactivate fixtures
  rather than deleting them, after checking none is still referenced. Clear test data before any
  consolidation migration, or the consolidated table inherits invented values.

## 8. Read models and rebuild scripts

When detail outgrows a canvas app's row limit, portfolio screens read **pre-aggregated rollup tables**
and detail loads per parent.

- **Measure the distribution before choosing a scope key.** The recommended fix "scope reads by fiscal
  year" removed nothing: every row was in one year. Only per-record scoping survived (52 rows against
  about 110,000). Count rows per candidate key against live data, and model each candidate at today's,
  planned-active and full-migration sizes - even one row per parent can exceed the cap at full scale.
- **A rollup carries every dimension any consumer groups by** (read all consumers first), and the
  filter it is read with must itself be delegable - ride status and active flags onto the rollup row.
  A rollup with no record key (period x scenario) stays small but cannot be filtered by record
  attributes, so scope it at build time and add or subtract a record's amounts by hand when its status
  changes.
- **Keep it current three ways**: the app's save path applies the delta to the matching rollup row
  (and mirrors it into the in-memory collection); an **idempotent server-side rebuild script follows
  `@odata.nextLink`** - one page reintroduces the truncation it exists to remove; and the rebuild
  checks each read model's size against the row limit.
- **Do not hard-code flags in the maintenance.** A save path that wrote `IsActive: true` would have
  pulled finished records into totals on any edit.
- **Reconcile to the cent**, and prove the delta logic by performing an edit and its revert in the
  app: landing back exactly on the baseline proves the hand-computed delta is symmetric.
- **Archiving for performance usually buys nothing.** The 2,000 limit is per non-delegable query, not
  per table: one unscoped read of a 900-row table is a worse defect than a scoped read of 90,000.
  Archive tables cost referential integrity, change-log links, report unions and prior-year
  corrections. Prefer status-scoped reads (self-limiting), an audit that fails any unscoped read of a
  large transactional table, and Dataverse long-term retention for unbounded logs.

## 9. Cutting over

**Never run two apps on one database as a "parallel run".** A replacement app in the same environment
as the old one is not isolated: people enter data in the wrong one and neither total is right. Cut over
at a reporting-period boundary; decide in advance whether the old app goes read-only or is retired,
and who tells users. Empty the new period of test data first (backup taken, senders parked) so it
starts clean, and publish a data-completeness note so features that are correct but empty are not
reported as broken.
