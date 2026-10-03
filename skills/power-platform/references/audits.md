# Audits you can trust

A Power Platform project accumulates source audits because the platform tells you so little: a
geometry check, a permission-gate check, a write-path check, a flow linter, a solution-dependency
check. Each is cheap and each catches real defects. Each can also lie in a way that looks exactly
like good news. This file is about the second part.

## Contents

1. Prove the check can fail
2. A floor, a vocabulary guard, and visible skips
3. Parse what the app really writes
4. An audit must know when its own inputs are stale
5. The runner: exit codes, and a third state that is not a pass
6. A fallback must announce itself
7. Read the right copy: repo, live, or both
8. The loudest line counts only what breaks; exceptions are named
9. Audits that enforce the bug
10. Porting an audit carries its assumptions
11. Audits worth having in a canvas project
12. Audits on live rows and on the environment
13. When an audit is wrong most of the time, fix or delete it
14. Reusable tool designs

## 1. Prove the check can fail

Every audit must be shown going **red** on a deliberately broken input before it is trusted green.
A permission audit once reported "every write is behind a permission guard" while analysing
**zero** writes - its parser had stopped matching and nothing said so. Keep the known-bad fixture
in the repo and run it in CI (`--selftest`).

Three details decide whether the self-test proves anything:

- **Test the whole path, not just the detector.** The runner must turn red too (audit, then the
  runner's verdict). A geometry audit that signalled an overlap only through its exit code was
  never seen by a runner that counted printed markers (section 5).
- **Restore the whole pre-fix state.** Moving one control back after a layout fix did not
  reproduce the bug, because the fix had also moved its neighbours. A mutation test that
  reintroduces half the fault proves nothing.
- **Seed with the incident that created the check.** A file-wide "is there a `CountRows()` guard"
  test let a dangerous read hide behind a guard 22 lines below it; reintroducing the original
  incident's exact shape showed no finding. Negative-test every audit with its founding incident.

And the reverse discipline: **every time a person finds a defect, ask which check should have
caught it**, extend that check, and prove it red on the exact fault. An overlap audit that had
passed text spilling out of its boxes was upgraded this way and then found all seven reported
overlaps plus sixteen nobody had reported.

**Re-run the audit after the obvious fix.** After scoping the obvious whole-table read, a second
collection built behind two lookup traversals still pulled the whole table; only the re-run found
it.

## 2. A floor, a vocabulary guard, and visible skips

```
!! SELF-CHECK FAILED - this audit found only 0 write surfaces (floor 12).
   It is not reporting a clean app; it is reporting that it cannot read the app.
```

Three lines of code. Without it, the failure mode is an audit quietly reporting success forever,
which is strictly worse than not having it - you would at least know you had not checked.

Two ways audits have read the wrong thing and passed confidently:

- **A bare `|` does not match `|-`.** A project whose formulas use `OnSelect: |-` gave a gate audit
  zero write surfaces to parse. Match block scalars as `[|>][-+]?`.
- **Schema name vs logical name casing.** Comparing `app_Role` to `app_role` literally made a
  dependency audit report every table both missing and orphaned. **When "missing" and "orphaned"
  are both near-total, the lists are failing to meet, not disagreeing.** Case-fold.

**A floor counts only what the audit understands.** After a floor was added to a permission audit,
a new `SubmitForm`, a `Collect` into a data source, or a `Relate`/`Unrelate` would have left the
count healthy and the new write unchecked. Add a **vocabulary guard**: any write verb outside the
recognised set is itself a finding. Prove it by injecting each unrecognised verb into a **copy** of
the source - the real source being clean is also exactly what a broken guard looks like.

**Skipped items are findings about the audit.** A geometry audit that could not resolve
`gblGutter`-style layout globals skipped 353 of 367 controls; another skipped 450 controls sized
against `Parent.Width`. Both printed the skip count, but the runner showed only finding counts, so
nobody saw it. Reading numeric globals from `App.OnStart` cut the skips to 14 and surfaced 8 real
overlaps at once. Print coverage ("read 353 of 367 controls") every run, surface it through the
runner, and give coverage its own floor. Report counts even when clean: "0 dead targets across 41
screens" is evidence; silence is not.

**A zero-row read is a broken query, not a clean bill.** Any audit over live rows must treat zero
rows from a table known to be populated as a failure to read. An API helper that paged on a
`value` array returned an empty set for a single metadata entity and the check passed; make such
helpers raise on an empty result.

## 3. Parse what the app really writes

Parsers that are quote-aware but not comment-aware break on ordinary prose: a comma inside a `//`
comment split a `Patch` record into nonsense arguments; an apostrophe in a comment ("doesn't",
"the project's number") flips quote state for the **rest of the file**. Findings past the first
commented record become unreliable in a way that looks exactly like real findings. Strip comments
before parsing source.

Rules every `.pa.yaml` parser in the project has had to learn:

- **Strip double-quoted string literals before looking for names.** Display text "Vendors" is not
  a reference to the `Vendors` table. Strip `'quoted names'` before the bare-identifier pass, too:
  `'App Admins'` made a bare `Admins` look bound.
- **Search the whole text, not only function arguments.** An "unused data source" detector - whose
  output drives retirement decisions - missed `Items: =Users`, which sits in no function call, and
  nearly retired a live source.
- **Derive exclusion sets from source, never from a hand list.** `As` aliases, `With({...})` record
  names, control names (`X.SelectedItems`), table-returning functions nested in a first argument,
  and named formulas that return a table are not data sources. Without these exclusions one section
  produced 16 false findings.
- **Match bare single-word source and field names.** A whole-table-read check that required quotes
  could not see `ForAll(People As p, ...)`, the one table already over the row limit; a traversal
  check requiring `'X'.'Y'` missed `'Cost Center'.Code`.
- **Disambiguated names carry the logical name.** Power Apps writes `'Display (logical_name)'` when
  two columns share a display name, and option sets as `'Status (Orders)'`. Match on the logical
  half in parentheses - matching on the display half resolved writes to the read-only key, and a
  parser that knew only plain display names reported 7 phantom columns. An option-set reference
  `'Status (Orders)'.Active` has the same shape as a lookup traversal; the `" (<table>)"` suffix is
  the discriminator.
- **Resolve data-source names by longest match.** Studio names a second source of the same display
  name `Vendors_1`, a strict superstring of the first; a substring match picks the wrong one.
- **Visit nested children.** Consuming a control's whole block (including `Children:`) silently
  skipped every control in a gallery template - where row buttons live. Scan to the next control
  header at any indent.
- **Group controls by parent, not indent depth.** Two galleries' templates sit at the same depth in
  different coordinate spaces; grouping by depth produced 57 phantom overlaps.
- **Read multi-line plain scalars and block-scalar `Visible`.** Reading only line one let a
  163-character sentence pass a fit check; a `Visible: |` read as missing put two mutually
  exclusive controls in the "always visible" group.
- **Scope a guard positionally.** "Is there a guard" means "before the read", not "anywhere in the
  file" (section 1).
- **Read the app's settings, do not assume them.** Take the row limit from
  `DefaultConnectedDataSourceMaxGetRowsCount` in `Properties.json`, the design surface from
  `DocumentLayoutWidth`/`Height`, and the entry screen from `App.StartScreen` (the first screen when
  none is declared - otherwise the start screen is reported as an orphan).

## 4. An audit must know when its own inputs are stale

Many audits read a **cached snapshot** of the environment, not the environment: the `.msapr` copy,
a connected-data-sources record, a table-metadata dump, a solution export. Each is correct when
taken and stale the moment Studio or Dataverse changes. A stale input produces a finding
**indistinguishable from the real fault** - five "findings" in one day were stale caches, two of
them a data source removed hours earlier.

**A warning comment in the file is not a check.** It asks the reader to doubt the file at the exact
moment the file says something alarming. Make it mechanical:

- each cached input compares its timestamp with the **last ship** to the environment;
- an audit reading a stale input exits with a **distinct code** - not "found something", not
  "clean", not "could not run" - and the runner shows a **third state** beside OK and SKIPPED,
  counting its findings as **unverified**;
- findings are still printed in full: relabelled, never hidden; staleness outranks findings, so
  the whole result is labelled stale, not just the lines that look suspicious;
- the stale report names the **refresh command** (the old warnings went unheeded because acting on
  one meant finding out how);
- **a stale audit is not a pass**, any more than a skipped one.

**The rule that is easy to get backwards: only a SHIP makes an input stale, never a repo edit.**
Editing the repo does not move the environment. Author a required column and do not import it, and
the table-metadata dump is a perfectly current picture of live - so "this save targets a column
live does not have" is a **true** finding, the exact one the audit exists to give. Treating the edit
as staleness suppresses it. Guard this with a self-test, because the intuitive wrong version is the
one a future change drifts toward.

What counts as a ship: a **shippable** artifact being built (the import zip, which exists for no
other reason), or the import script stamping a record of a successful import - written by the
deploying script, not by a person who has to remember, and only after the script has checked the
import's exit code (one script stamped a failed import as a ship). Nothing local can observe an
import, so a built artifact stands in for an imported one; the check nags slightly early, which is
the safe direction. Keep it offline and fast - a freshness check that needs the network gets
skipped as often as the refresh it nags about.

Three refinements, each learned from a false alarm or a missed one:

- **A direct metadata write to live is a ship too.** A migration script that reorders a choice or
  clears a required level moves the environment with no build at all; re-capture the schema
  snapshots after every live metadata write (have the migration script stamp it).
- **A routine verification pack is not a ship.** If packing is how you prove the source still
  builds, counting that zip marks every snapshot stale on every run. Only the import artifact or the
  import record counts. State the remaining gap (hand imports that bypass the script) rather than
  widening the evidence.
- **Allow a grace window for the same run.** A snapshot taken seconds before the artifact it is
  compared with (export, then build, in one script) is not stale.

Refreshing the inputs has its own traps:

- refresh everything in one command, in order: download the **published** app after the import
  (not the pre-import download the ship script made), re-export the solution, re-dump metadata;
- parse the refreshed data-source list with the **audit's own parser**, so the two cannot disagree;
- **refuse to stamp a file you could not re-read** - a fresh date on a stale file silences the guard;
- overwrite cached files in place under the names the audits read;
- do not require Studio to be open (an import ends the session the probes depend on).

Two honest-reporting rules. A dump taken **before a field was added to the dump format** must make
the audit exit "refresh needed", never compare the absent field as "matches". And when a "stale"
input turns out to be content-identical to live, say so - "stale by time, identical by content" is
not drift caught.

## 5. The runner: exit codes, and a third state that is not a pass

Run every audit from one runner (`audit-all`) that prints OK / FINDINGS / STALE / SKIPPED per audit
and treats anything but OK as not-a-pass. A contract that has held up:

| Exit | Meaning | Runner shows |
|---|---|---|
| 0 | clean | OK |
| 1 | findings | FINDINGS (count) |
| 2 | could not run (no network, no input, unknown argument) | SKIPPED - not a pass |
| 3 | ran on stale inputs | STALE - findings counted as unverified |

Runner rules, each paid for once:

- **Honour the exit code.** A runner that counted only lines beginning `!!` printed "ok,
  findings: 0" while a geometry audit exited 1 on a real overlap. Any non-zero exit is at least one
  finding.
- **A pipe reports the last command's exit.** `node check.mjs ... | tail -6; echo $?` printed 0
  over ten findings: the 0 was `tail`'s. Capture the audit's own code (`node check.mjs ... > out.txt;
  echo $?`, or `set -o pipefail`) and count the finding lines from the file.
- **Check the special codes before the generic rule.** Test 2 and 3 first, or SKIPPED and STALE
  become phantom findings.
- **Banner lines are not findings.** A run of `!` characters used as a heading inflated counts;
  noise teaches people to ignore the suite. Do not give a freshness banner the finding prefix.
- **Only a path argument can be a missing prerequisite.** A runner that tested every argument for
  being a missing file reported SKIPPED for any audit called with a flag (`--check`); a passing
  check was never run. Test the runner with each audit's real arguments.
- **Surface skip counts and coverage**, not only finding counts (section 2).
- **Order audits cheapest-and-most-catastrophic first**, so the line that matters is at the top.

## 6. A fallback must announce itself

An empty `catch {}` turns a tooling bug into a silent wrong answer. A mis-escaped regex threw, the
catch swallowed it, and a metadata script reported its 500-row fallback as if it had read the app's
real limit. Every fallback prints that it fell back and the **direction** of its error ("row limit
unreadable, assuming 500 - findings are OVER-reported").

The same family:

- a removal script printed a success line after nine consecutive HTTP 400s - exit non-zero when any
  operation fails, and print the server's message;
- an existence probe wrapped in try/catch read every throttle and timeout as "does not exist";
- a live-data audit that cannot reach the environment exits SKIPPED, never "no findings";
- a repair step that finds nothing to repair must distinguish "already correct" from "could not
  locate the thing to check" - raise on the second.

## 7. Read the right copy: repo, live, or both

Many checks can be answered from the repo or from the environment, and they answer **different
questions**.

- **Ask both "is live right" and "is the repo right".** A check comparing the app's bound sources
  against the live export passed three times while the repo's canvas `meta.xml` lagged - and the
  repo copy is what the next plain import ships. One of those drifts was missing the table that
  decides who is an administrator. Add a section that compares against the repo copy always.
- **Each section states which copy it read.** After security roles were removed from the live
  solution, one section had moved to the live export while another still listed the repo's role
  files from a pre-removal sync, and kept reporting "ships 4 roles". Half a fix reads exactly like
  no fix. The repo is authoritative for source; the environment is authoritative for every
  reference manifest.
- **Never hard-code the list an audit compares against.** A fixed list of 31 data sources against
  an app with 35 produced "missing" findings indistinguishable from the real fault. Keep such lists
  as data, print their verification date every run, and put them under the freshness guard.
- **Compare the published app with the repo semantically, not as text.** After a ship, download the
  published app (`pac canvas download`), unpack it, and compare it with `Src` as YAML: flatten each
  screen to `(control, property) -> formula`, normalise whitespace, and compare the formulas for
  properties present on **both** sides, plus the two sets of control names. Studio drops properties
  set to their defaults and re-serialises the rest, so a text diff reports hundreds of differences
  that mean nothing; the semantic compare of a clean ship reports zero, and anything else it reports
  is a real difference to explain.
- **Compare the control order too.** Declaration order is z-order, and the property compare cannot
  see it. A ship where every property matched published a card on top of its gallery: the push had
  inserted new controls before existing ones, and Studio's sync kept its own order for the controls
  it already had. Per container, list the children present on both sides in repo order and in
  published order; any difference is a draw-order bug (the earlier-in-repo control now draws on top).
  The page looks empty while the DOM holds the gallery's text, so a text-reading browser check
  passes too - look at a screenshot.
- **Check the published app before anything irreversible.** A column-retirement gate must search
  the app users are running (downloaded fresh), not the repo, which already said what *will* ship.

## 8. The loudest line counts only what breaks; exceptions are named

An audit printed "DO NOT IMPORT. 10 data sources would break" directly under a section reading
"none missing": the ten were tables owned by a shared solution and sanctioned virtual tables,
missing by design. An alarm that is wrong on its face trains people to ignore the honest ones.
Exclude by-design cases from the headline **and** the exit code, and list them as information.

**Encode accepted exceptions as a named allowlist, with a reason and a date.** When an access gap
is accepted (another team's role reading restricted data), list each accepted principal in the
audit, so the **next** principal to gain that access fails instead of passing silently. Name
decided exceptions as decided rather than flagging them forever. Never exempt by prefix when the
same prefix also covers a table that must never be bound.

**Key allowlist entries on a distinctive substring, never a line number.** A (file, line) entry
expired when ten lines were inserted above it and re-reported a long-accepted site as new. A
substring survives unrelated edits and stops matching only when the construct itself changes,
which is the behaviour you want. Mutation-test that removing an entry re-reports the site.

## 9. Audits that enforce the bug

An audit is code written from a belief. When the belief is wrong, the audit defends the defect.

- **An audit that shares the migration's assumption inherits its bug.** A migration read a source
  system's status code as 0 = Inactive; it was the reverse. The audit written to check it made the
  same assumption and reported 86 of 86 in agreement while six people were wrong. Derive expected
  values independently of the code being checked, and treat 100% agreement on a first run as a
  reason to check the selection.
- **Delete an audit whose premise is disproved.** During a multi-day hunt, an audit written to
  enforce a theory (later disproved) kept flagging correct code. A confident wrong rule in an audit
  is worse than no audit; delete it in the change that disproves the theory.
- **Narrow a check to the demonstrated signature.** A sweep for "reading a field off an empty
  collection" flagged 43 sites, a permanently red audit. The published app showed only one type
  actually threw (a Dataverse Yes/No carried off a source row); narrowed to that, three real
  instances remained. A broad rule that is mostly wrong gets ignored along with its real hits.
- **The audit's recognised-names list drifts from the app.** Renaming or consolidating role flags
  made a permission audit report correctly gated writes as ungated, three separate times. Derive the
  list from the app, or self-test that every gate defined in `App.OnStart` is known to the audit.
  Identity flags ("is known", "is a contractor") are not permission gates.
- **Do not apply a platform checker's advice literally.** The accessibility checker recommended
  `TabIndex >= 0` on about 900 static labels and rectangles (1,829 findings); obeying it would put
  every caption in the tab order. The real defect was 12 label cells with `OnSelect` that were the
  only keyboard route into a grid. App Checker also analyses whatever build the authoring service
  holds, which can lag the repo by a session, and returns clean with no session at all - that is
  "inconclusive", not "clean".
- **A docstring is a claim too.** A ported audit stated these faults "fail at run time with a
  network error"; in fact they answer silently from a prefix of the data - false in the dangerous
  direction. Keep stated mechanisms honest and mark unproven ones as such.

## 10. Porting an audit carries its assumptions

Copying an audit suite to a sibling project is cheap and valuable, and every one of these came
along with it in one port:

- a hard-coded absolute path that audited the **other** repo;
- a hard-coded `Src/` folder that made a flat-layout app read as an empty, "clean" app;
- the other project's banner name and decision numbers, inviting someone to read a sibling's result
  as their own;
- the other project's permission-variable names (7 false "ungated" findings) and table list;
- an inherited pixels-per-character constant that was wrong 19 times in 20;
- two checks that flagged this project's intended design as faults.

Both real defects found in that port (the `|` vs `|-` miss and the casing mismatch in section 2)
were latent in the **originals**, correct there only by luck - house style happened to use bare
`|`, schema names happened to be lower case. After porting: re-derive every constant and list from
the new app, recalibrate without weakening, run the floor and a known-bad fixture against the **new**
codebase, and push the fixes back upstream as commits in the source repo, not as a note.

## 11. Audits worth having in a canvas project

| Audit | What it asks | Notes |
|---|---|---|
| data connections | every whole-table read, ranked against a **live** row count | the same construct is a finding on a big table and silence on a small one; scan every behaviour property, not just `OnStart` |
| scale | what breaks at the **planned** size, not today's | see the method below |
| permission gates | every write surface is behind a role check | needs a floor and a vocabulary guard; admin testing cannot prove it |
| write paths | every `Patch` targets columns live has; denormalized copies are set on every create and refreshed on every source change | decided from live metadata, offline |
| role coverage | every bound table is granted by some role reaching that screen, including tables the app only writes (a change log) | source plus solution `Entity.xml` |
| solution deps / dbrefs | the solution ships the tables, **and** the player will initialise each source | two different questions (`manifest-caches.md`) |
| schema drift | live vs **solution source**, type-aware (lookups matter, scalar casing does not) | print case-only drift with codepoints - it is invisible in every error message |
| geometry | overlaps across `Visible` conditions, gallery children vs row bounds, off-canvas edges, dead click spots | a floor; the browser is the authority (`canvas-layout.md`) |
| navigation | dead `Navigate` targets, orphan screens, app-wide duplicate control names, nav bar drift | see below |
| `.pa.yaml` traps | colon-space, comments, Tooltip on Button, file ceiling, block-scalar indentation | run at write time by the hook too |
| flows | `lint-flows.mjs` set, plus cross-flow cycles, entity set names, repo vs live on/off state | `power-automate.md` |
| accessibility | interactive controls with no accessible name; actions only a mouse can reach | derived from source, not from the platform checker; see below |
| picker bindings | every ComboBox `FieldName` exists on the table its `Items` binds; no partial default records | see below |

Details that made several of these worth running:

- **Write paths.** Feed the audit live `RequiredLevel`, `IsValidForCreate`, `IsValidForUpdate` and
  `AttributeType`, and flag three runtime-only failures: a create that omits an
  `ApplicationRequired` column (throws for every user, only on that add path); a write to a column
  renamed or dropped live (compiles against the snapshot until the source is refreshed); a write to
  a read-only or calculated column. Recognise creates in dual-purpose editors -
  `Patch(ds, If(gblNew, Defaults(ds), gblRec), {...})` - not only a literal `Defaults(ds)` second
  argument, which found zero creates on tables that plainly had them. Importers, migrations and
  admin forms are write paths too.
- **Permission gates.** Only variables expressing what a user may *do* are gates. Resolve screens
  gated "at the door" as a fixed point: assume every non-entry screen gated, then demote any screen
  reachable from an ungated control on an ungated screen (a single-hop check reported 19 false
  positives through ungated Back buttons). A two-step confirm is gated when whatever sets its flag
  is gated. A hidden tab is not a gate. Writes open by design (commenting) go on a named allowlist
  with a reason. State in the output that a canvas gate is UX, not a security boundary.
- **Scale.** Classify each table as record-grained (rows track the number of top-level records) or
  reference data; project record-grained tables by live rows-per-record to the planned active set
  and the planned full set; report OVER or UNDER the row limit per collection site; exclude sources
  bound directly to a control. Say the ratio comes from a small sample. Prove the ranking flips with
  a doctored low row limit.
- **Navigation.** For a nav bar hand-copied into every screen, compare each screen against the
  canonical nav **per destination, by majority**. A whole-set mode on a 5/5/1 split crowned the
  minority and told someone to delete the correct item from five screens. Dead-target and orphan
  checks still pass while a bar silently loses an item.
- **Columns nobody writes or nobody reads.** For each custom column, does any `.pa.yaml`, flow or
  script write it, and does any read it - plus its live non-null count. One typed classification
  column was null on all 3,113 rows because no path wrote it; a "period closed" flag was written by
  an admin screen and read by no formula, so closing a period changed nothing.
- **One fact in two places needs an audit in the same change.** The recurring outage shape was one
  fact stored twice with nothing comparing the copies: the data-source list in `DataSources.json`
  and `<DatabaseReferences>`; two deployable zips with an import script defaulting to one; flow
  on/off state in the repo and in the environment. Each was caught by a person, one after damage.
  When a change creates a second copy, build the comparison in that change.
- **Generated registers.** A hand-maintained flow table in the dependency register listed six
  invented flows while eleven real ones ran. Generate such tables from the definitions and run the
  generator with `--check` in the suite (proved by hand-editing one trigger). Keep live on/off state
  out of generated docs - it changes without a commit.
- **Literal-string matches.** Any row the app finds by literal text (`LookUp(colX, Label = "Time
  Off")`) must exist exactly once and be active; fail if it is renamed, retired or duplicated,
  including case- and space-only duplicates.
- **Accessibility.** Flag only two things: (A) an interactive control with neither an
  `AccessibleLabel` nor a literal `Text`, and (B) an `OnSelect` on a Label, Rectangle or HtmlText -
  not in the tab order, so mouse-only; fix B with `TabIndex: =0` plus a visible
  `FocusedBorderThickness` on that control alone. Exempt full-screen dismiss scrims (sized off
  `Parent`, `OnSelect` only closes the dialog): they duplicate the Close button, and a tab stop there
  is a dead stop in front of every dialog. Do not add an `AccessibleLabel` to a control whose literal
  `Text` already names it - screen readers announce the name twice. A scripted fix-up derives a
  missing label from `Text`, then the placeholder, then the control name split into words
  (`btnSubmitOrder` -> "Submit order"). These rules took one app from 1,829 checker findings to 12
  real ones (section 9).
- **Picker bindings.** Repointing a picker is covered by grepping `FieldName`; automate it. Each
  `ComboBoxDataField.FieldName` must exist on the picker's bound table, and a `DefaultSelectedItems`
  fed a partial record (only some columns) is a finding - user-visible once a second display column
  exists, latent until then. Resolve the bound table as the **first argument of the outermost table
  function** in `Items` - in `Sort(Filter(app_Vendors, ...), 'Vendor Name')` it is `app_Vendors`,
  never the sort column - with a longest-name tie-break when one source name prefixes another
  (`app_Order` vs `app_OrderLine`).

## 12. Audits on live rows and on the environment

Some invariants live in data or in the environment, where no source audit can see them.

- **Live-data audits**: overlapping effective-dated windows (compare pairwise - a back-dated row can
  overlap a non-adjacent closed window), more than one current row per grain (get the grain right:
  per person on one table, per person **and** type on another), records with no resolvable approver,
  self-approval, a classification that disagrees between two copies. Watch for grouping on a `None`
  key: orphans all shared it, so unrelated departed people's windows were compared and reported as
  overlaps.
- **Role resolution.** When in-app roles are derived from rows (manager = someone has you as
  leader), you cannot sign in as each role. Recompute the `App.OnStart` logic for every active
  person from the same rows and check: unrecognisable people, records that route to nobody,
  self-approval, inactive approvers, and **reachability** - routing, the nav item and the home tile
  were gated by three separately maintained flags, so a person could receive items with the screen
  that reaches them hidden.
- **Security, from the environment.** Source cannot see the security boundary. Ask: every role
  holding any privilege on a sensitive table, and every enabled human holding it, against an
  approved list kept in the audit; the app's roles have not drifted above Basic on user-owned
  tables; any Global read of a transactional table; the app's own admin list vs who Dataverse treats
  as admin (where they disagree, one is wrong). Filter platform principals by the role's
  `ismanaged` flag, not a name list (52 of one first run's 61 findings were Microsoft service
  principals). `Depth` comes back as a string. A decision written in one project's log does not
  constrain another project's role on a shared table - only an audit of the environment does
  (`shared-environments.md`).
- **Ask the data, not the code.** In one app, four consecutive defects were tables modelled but
  never populated, or seeded but never read; none could fail a build, a test or a screenshot. An
  audit counting rows, rows with an author, and readers per table found them.
- **Snapshot and diff around every import that touches shared schema**, and mutation-test the
  differ first (plant a changed column, a removed column, an entity facet change).

## 13. When an audit is wrong most of the time, fix or delete it

An audit that is wrong nineteen times in twenty gets ignored, and it takes the honest checks beside
it down with it. Measure its precision against the running product (`canvas-layout.md` has one
such measurement), tune it for the cases that actually get flagged, and state its limits in its
output. Hooks especially: **flag only what is known to break, never style** - a hook that fires on
style gets disabled, and then it is not there when it matters.

## 14. Reusable tool designs

Tools worth rebuilding in a Power Platform repo, beyond the ones bundled with this skill. Each is
small; the design is what matters.

- **Live table-metadata dump.** Downloads the *published* app, reads the source-name to
  logical-name map from its own `DataSources.json` (Studio's `_1` suffixes and irregular plurals
  make a hand map wrong), then dumps per column: display, logical and schema name, type, required
  level, creatable, updatable, plus a `$count` row count and the app's row limit. Downloading every
  run means its source list can never be older than the run; the audits consuming its JSON stay
  offline.
- **Freshness module.** A table of cached inputs (what each is a snapshot of, how to refresh it), a
  `last_ship()` read from build and import artifacts only, a `guard(*names)` that prints a banner
  and returns the stale exit code, and a `--selftest` locking in the easy-to-break rules (no ship
  means nothing is stale; a repo edit is not a ship; a same-run snapshot is fresh).
- **Ship pipeline with manifest reconcilers.** Download live by id, unpack with `--layout
  SourceCode`, copy the live `.msapr`, reconcile option sets / entity set names / lookup navigation
  names, copy `Src`, stamp the build, enforce the file ceiling, pack, assert reference count and
  `LoadFromYaml`; export the solution, strip roles, repair the player's data-source list, then
  re-run every reconciler in `--check` mode against the **finished** zip (`manifest-caches.md`).
- **Reconciler contract.** Each manifest reconciler takes a `.msapr` or `.msapp`, accepts either
  path separator, asks live metadata through one read-only helper, never blanks what it cannot
  verify, prints every change, rewrites the archive preserving every other entry, reads it back,
  and has `--dry-run` and `--check` (exit 1 on drift) so the ship can assert on the artifact.
- **Column-cache gate.** For each bound table, live display names against the manifest's frozen
  column list; block only when a missing column is referenced by a formula; print the Studio cure.
  Detect, do not forge.
- **Direct stdio client for the canvas authoring server.** Prints the tool contract the server
  actually advertises, sends those argument names, skips JSON-RPC notifications while waiting for a
  response, prints the compile result **before** any hold and gates on a parsed error count, holds
  a session released by a sentinel file, and always kills the server's process tree on exit
  (`canvas-shipping.md`, `tooling-and-auth.md`).
- **Studio client-model probe.** About 40 lines of Node: `connectOverCDP` to a held Studio, find the
  `authoring.*` frames, read named controls' rendered boxes from the designer. Answers "did the push
  reach what Save will write?", which a session sync cannot.
- **Data-source schema probe and App Checker grouper.** With Studio open, ask the authoring server
  for every source's schema (zero columns = broken; an empty list = no session, not N failures) and
  for App Checker errors grouped by severity, message and control - the shape of a failure rather
  than hundreds of copies.
- **Monitor trace analyser.** Splits a Monitor export into requests that went out (and their status)
  and failures that never reached the network, recognises the unresolved-data-source signature, and
  names the next command (4xx/5xx: privileges audit; all 200 plus errors: unresolved sources).
- **Schema-divergence probe.** Asks the environment the same metadata question N times (does a
  retired table resolve; does each lookup `$expand`, with navigation names read from live metadata,
  never hard-coded) and prints a per-probe string like `E-E--E-E` with a verdict, plain enough to
  paste into a support case. Include a control lookup that never misbehaves.
- **Bulk-write safety check.** `--table --rows --op`: reads live flow definitions from
  `workflow.clientdata`, lists the ON flows that would fire and the send steps inside each, prints
  "N rows x M sends = up to K messages" with exact park and restore commands, labels the figure an
  upper bound, and exits SKIPPED when it cannot read the environment.
- **Flow park/restore helpers.** `park(names)` records each flow's state and turns off only those
  that were on; `restore(state)` turns back on only those, then re-reads and refuses if anything
  differs. Every migration that writes to a watched table calls them.
- **Flow policy transformers.** Idempotent rewriters over the flow JSON, each with `--check` and a
  matching audit, that apply a cross-cutting rule to every send step (recipient cap, shared-mailbox
  sender, non-production banner). A policy enforced by script plus audit, not by remembering
  (`power-automate.md`).
- **Flow activation script.** Requires an explicit name filter (a broad default would have switched
  on roster-wide scheduled mailers), supports `-WhatIf` and `-Off`, prints the server's full refusal
  text (activation is the only template compile) and re-reads every state.
- **Two-gate column retirement.** Gate 1 searches the published app recursively, scoped per table,
  and throws on zero files read; gate 2 runs `RetrieveDependenciesForDelete` and names the forms in
  the way. Dry run by default.
- **Dry-run-by-default repair scripts.** Without `-Apply`, print what would change; with it, write
  only rows that are missing or wrong, so a second run is a no-op (249 rows, then 0). Data that
  breaks a rule but belongs to users is reported on every run, never deleted.
- **Role builder.** The privilege matrix as code (depth per table, Append/AppendTo derived from live
  relationships), applied with `ReplacePrivilegesRole` so roles converge, with `-Report` and
  `-WhatIf`; roles built in the environment, never shipped.
- **Entity cloner from a spec.** Clones a known-good imported `Entity.xml`, rebuilds attributes from
  per-type templates lifted from live ones, regenerates form and view GUIDs, refuses `<lookup>name`
  clashes, and prints the relationship and root-component lines it deliberately does not guess.
- **Directory matcher.** Fills blank emails from `systemuser` in tiers (exact, first+last, primary
  account, known variants, departed-only for disabled accounts, ambiguous = never written), refuses
  two people mapped to one account, and keeps a self-test of the cases it once got wrong.
- **Effective-access overlay.** An admin picks a person and sees their role, admin status, record
  stakes and a per-element view/edit/create grid computed with the same rules the app enforces -
  role testing without a second account, for app-level gates only.
- **Empty-gallery verdict.** Checks the filter key's distribution, rows meeting the visibility rule,
  and the join key against the parent, then prints one verdict: no data / broken join / problem
  elsewhere.
- **Scripted canvas edits that assert.** Bulk `.pa.yaml` edits (an accessibility pass, wrapping
  controls' `Visible` in a gate, a generated period matrix) assert each anchor's occurrence count and
  block-scoped target before substituting, assert what they must not match, preserve line endings,
  and detect their own prior run. A regex `\w*Clear:` once matched "Clear advanced" before "Clear
  filters", and a long lookahead found a different control's label and skipped 14 of 48 insertions.
- **Pre-load review workbook.** Snapshot live read-only, audit the incoming data, and write one
  review workbook with issue ids, in-workbook hyperlinks to each row, original values beside
  corrections, a load yes/no column and a reconciliation tab to the cent; the loader reads the
  reviewed copy (`model-driven-and-docs.md`).
- **Playwright command server.** One long-lived headed persistent-context process exposing actions
  over a localhost port (goto, snapshot, click, fill, eval, frames, tabs, network capture with
  bodies), so Studio stays alive between commands and `$batch` request and response bodies are kept
  - the only way to read a failure inside an HTTP 200.
- **Weekly raw-material gatherer.** Prints the week's commits across repos, dated changelog
  sections and tracker items closed; deliberately writes no prose (`model-driven-and-docs.md`).
