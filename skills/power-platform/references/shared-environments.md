# Several apps sharing one environment

When more than one app lives in a Dataverse environment and shares reference tables - a fiscal
calendar, a cost taxonomy, a people roster, a vendor master - a change made for one app can break
another with no error anywhere. An unmanaged import overwrites what it carries; a canvas app binds
columns by display name and fails at run time, not build time; a flow reading a shared column breaks
on its next scheduled morning. The shared layer needs an owner, a registry, a change protocol and a
written record of every change. This file is that protocol and the traps that made each part of it
necessary.

## Contents

1. The shape: one owner, one prefix per app
2. Shipping shared tables from exactly one solution
3. The shared-table registry
4. The change protocol and the sync log
5. Downstream analytics readers are consumers
6. Who may write shared reference data
7. An admin roster table is not a security boundary
8. Do not build a writer to a shared column until it is agreed
9. Changing shared data safely
10. Migrating an app onto shared tables
11. Coordination hooks and the status board

## 1. The shape: one owner, one prefix per app

- **One publisher prefix per app; each app changes only its own tables.** Shared reference data
  lives in a separate **shared reference solution** with its own prefix (say `core_`), owned by a
  coordination repo that also holds the registry, the sync log and the status board.
- **Write down who is system of record for what.** One table: each app, its prefix, what it owns,
  what it consumes. Rules that held: no app modifies another app's tables; cross-app data moves only
  through the shared tables or dataflows; the shared solution holds reference data only, never an
  app's transactional tables; data one app owns that another needs (order totals, for a finance app) lands
  in a read-only landing table.
- **Union requirements into an additive superset before building shared tables.** Before the shared
  tables existed, each consuming app wrote a requirements note per table (columns, keys, gaps) and
  the owner produced a review pack: a table summary, a cross-app relevance matrix (consumes / retires
  a duplicate / seeds / additive), a column dictionary with per-app usage, and numbered open
  questions. Where apps differ, take the superset (for a status choice, the union of every app's
  values). Keep app-specific concepts (a planning "focal year", business units at a different grain)
  app-local and say so explicitly, so nobody builds them shared. Ask "which grain?" before a second
  taxonomy of the same thing appears (country vs continental region).

## 2. Shipping shared tables from exactly one solution

Solution membership decides what an import **writes**, not what an app can **read**. That
distinction is the whole of this section.

- **A consumer solution that carries shared tables reverts them.** A sibling app's solution included
  nine shared tables as components. Importing it for an unrelated change republished its stale copy
  over the owner's, silently reverting columns another app had added - no error, and the other app
  failed later on a column that existed yesterday. Shared tables ship from the owner's solution only.
  Audit every solution for tables it ships but does not own.
- **But a canvas app's solution must reference the shared tables it binds.** A canvas app imported in
  a solution that does not list a table it binds comes up with that data source unresolved
  (`manifest-caches.md`). The fix that worked: add each shared table to the consumer solution with
  `AddSolutionComponent` and `DoNotIncludeSubcomponents = true` - a reference without the schema -
  and remove any full copies (`RemoveSolutionComponent` unlinks; it never deletes the table or its
  data). The Web API shape of `RemoveSolutionComponent` is unusual; see `dataverse.md`.
- **Create a shared column in the owner's solution, never the consumer's.** When a consuming app's
  migration adds a column to a shared table, it passes the shared solution's unique name
  (`MSCRM.SolutionUniqueName`) so the column lands there. One project's provisioning script had its
  own solution name hard-coded and had to make it a parameter.
- **Ship no security role from any app's solution.** A role component in one app's solution resets
  the live role on that app's import. In one environment the live role had been extended with Read on
  the shared tables after the repo copy was taken: the import would have removed 64 privileges,
  invisible to a System Administrator. Stripping roles at build time protected only that script's
  builds; a hand export still carried them. Remove role components from the solution outright and
  let the environment be authoritative for security (the trade: with several target environments,
  roles are then created in each).
- **Snapshot and diff the shared schema around every import that touches it.** Full metadata of
  every shared table - entity facets, each column's type, required level, create and update
  validity - one flat string per column so any facet change shows, captured before the change, after
  it, and after the import: 0 differences expected. Prove the differ first by planting a changed
  column, a removed column and an entity change. Make it re-runnable by anyone before an import.
- **Import order: the shared solution first.** When app solutions take lookups into the shared
  solution, the shared one must be imported (its tables created) before any dependent import, or the
  dependent one fails on missing dependencies. Encode the order in the deploy scripts ("next: run the
  dependent deploy"), not in someone's head.
- **Check an app's bound sources against its own prefix plus the declared shared layer.** One app
  picked up a sibling app's table, most likely by accident in Add data (the picker hides tables the
  app already binds, so a search can surface another app's table of the same name).

## 3. The shared-table registry

One document listing every shared table, column and choice, and for each: the owning solution, the
apps (and flows, and reports) that read it, which apps write it, the screens where it is user-facing,
and the delete behaviour of every inbound lookup.

- **Display names and value formats are part of the contract.** Canvas formulas name columns by
  display name, so renaming a shared column's display name - or changing the text format of a value
  another app parses (`Left(MonthName, 3)`) - breaks the consuming app at run time. Record it as a
  dependency whenever another app reads a shared column on a user-facing screen.
- **Inbound lookups are delete obstacles.** A `Restrict` lookup into a shared table stops every app
  in the environment deleting those rows. Count inbound `Restrict` links before planning any delete
  of a shared row; deactivate rather than delete. Each new consumer and each new inbound lookup is a
  registry entry, because it adds a reader and an obstacle.
- **A new nullable column has a meaning that later apps will reuse.** Document it narrowly, so a
  third app adopts it only if it means the same thing (section 6).

## 4. The change protocol and the sync log

Before changing anything shared:

1. Check its dependents in the registry.
2. Prefer additive changes (a new nullable column needs no migration anywhere).
3. Coordinate first if anything is breaking; announce it before applying.
4. Make the change; update the registry.
5. Append a **sync log** entry naming every affected app, including those needing no action.

A sync log that only records schema changes misses half of what breaks people. Entry kinds that
proved useful:

| Kind | When | Must say |
|---|---|---|
| CHANGE | schema altered | what, why, Affects per app |
| DATA | values changed on shared rows | counts, what was deliberately not written |
| DEPENDENCY | a new app, flow or report now reads an existing shared column - nothing changed | what reads it and how; a future change now breaks someone |
| PLANNED | announced before applying, when a row replacement could orphan another app's lookups | what will happen, when, how to object |
| FINDING / INCIDENT | a platform trap every app on the environment is exposed to | "check now" steps per app |
| CORRECTION | an earlier entry was wrong | what was wrong, what to undo |

```
## CHANGE - core_person: added core_systemuser (lookup to systemuser)
Why: server-side sharing and flows need the account, not the email.
Shape: nullable; RemoveLink on delete; NoCascade on assign/share.
Affects: app A - no action. App B - none until it adopts it.
         Analytics copy - new column appears on next refresh.
Not done: no backfill yet (see next DATA entry).
```

A **dependency notice** is the entry people skip, and it is the one that would have helped: a
scheduled digest flow read two person columns through a FetchXML chained `link-entity` (person to
leader, a self-reference); retyping either column in another project would have broken the flow on
a Monday morning with nothing at build time to warn anyone. Log a DEPENDENCY entry whenever a flow,
app or report starts reading a shared column.

Port fixes to sibling repos as commits there, not as log action items (`project-setup.md`).

## 5. Downstream analytics readers are consumers

A data platform that copies every table through the Dataverse TDS endpoint (`SELECT *`, full
reload) is a consumer like any app, and goes in the registry:

- adding a table or column is picked up on the next refresh;
- renaming or removing a column breaks every refined layer built on it;
- **restricted data copied there gains a second access boundary** - workspace membership - which
  must be held to the same standard as the Dataverse role that protects the source;
- a shared analytics workspace used by other teams: touch only items carrying your own name prefix,
  and generate your dataflows from a manifest deployed by REST so the set you own is explicit;
- reporting dataflows running on one person's connection are a single point of failure - record the
  owner, and move them to a service account.

## 6. Who may write shared reference data

Decide it explicitly and write the condition down. Two options were considered in one environment:

- **Admin-writable only**: a roster of reference-data admins with a write role; everyone else gets a
  read-only role included in every app's role set.
- **Full cross-app write**: accepted there only because one team administered every app, with the
  condition recorded - "revisit if administration splits across teams; consider column security or
  an approval path".

Whichever you choose, **screens that edit shared rows show an in-UI warning naming the consuming
apps** on destructive or propagating edits, because the admin in front of the screen will not know
which app reads which column.

Rules for apps that read shared data:

- **Narrow locally, never edit the shared definition.** When one app wants fewer values of a shared
  choice, it filters its own pickers and derives defaults from its own flag, rather than editing an
  option set another app relies on.
- **Narrowing what an app's UI offers still changes data.** If an app's status picker offers "Open"
  but not "Future", its users write "Open" over rows another app distinguishes. Log it.
- **Add an app-specific flag rather than reuse a shared lifecycle flag.** An app that needed to hide
  reference rows from its own pickers added a nullable "relevant to this app" column instead of
  reusing the shared `active` flag other apps read for lifecycle.
- **When two shared columns encode one fact** (a status and a closed flag), write both together from
  every control that changes either, so they cannot disagree.

## 7. An admin roster table is not a security boundary

A shared admin-roster table says who the admins are - a readable source of truth. What **enforces**
it is a security role, ideally granted through an Entra security group mapped to the role by a group
team. Keep the two in step: add an admin to both, or automate the reconciliation and audit it.

The failure on the other side: an app gated its admin console on an app-setting string holding one
address, so three people given the admin security role still saw no console - the roster, the role
and the app's idea of "admin" were three lists. Audit them against each other; where they disagree,
one is wrong.

App-side gating decides what the app *offers*; any user holding the table privilege can still write
through Excel, the Web API or a model-driven app. In a shared environment there is a further twist:
**a role in a neighbouring app can grant access to your data.** One live security audit found that a
sibling app's role gave a new joiner read on sensitive rows here the day they were added. Audit roles
from every app sharing the environment, and encode accepted exceptions as a named allowlist so the
next principal fails (`audits.md`). A decision written in one project's log does not constrain
another project's role - only a check does.

## 8. Do not build a writer to a shared column until it is agreed

One app deliberately did not build "close a fiscal period", because closing writes a shared flag
another app's financial logic reads - closing one period moved a large projection in testing. It
stated the dependency on screen instead and asked the owner to decide, noting that the apps might
need different dates (entry cutoff vs finance close) and that an app-owned switch might be enough.
That is the pattern: a writer to a shared column that others compute from needs the owner's
agreement first; until then, show the dependency rather than build around it.

A reference calendar that apps can edit has the same hazard: editing one period's end without the
next one's start leaves a gap or overlap for every consumer. Generate such calendars
deterministically with asserted invariants (contiguous, aligned to the week start) and guard every
write path, not just warn.

## 9. Changing shared data safely

- **A backfill on a shared table is a bulk write on every consumer's table.** It moves `modifiedon`
  on every row it touches and can wake every update flow any app has on that table. Write only rows
  that are actually wrong, and run the bulk-write check (`power-automate.md`) across all apps' flows.
- **A new Yes/No column on a shared table reads NULL on existing rows** - measured three times on
  shared tables (2,282, 24 and 1 rows, all NULL). Every consumer filtering `= true` empties; tell
  consumers to filter `<> false` in the same log entry that announces the column.
- **Seeds and backfills update the seed file too**, so a from-scratch rebuild reproduces live; the
  table manifest gains every column added live. One drift was caught when two columns another app
  added live were missing from the manifest - anything reconciling against the manifest rather than
  the environment was reconciling against a fiction. After fixing a manifest, re-run the idempotent
  creator and confirm it is a no-op.
- **Mark test data, and never put it in the shared master.** Seed fixtures in your own tables, mark
  every row ("SEEDED TEST DATA - safe to delete"), and have the removal script delete only marked
  rows and print how many unmarked rows it left. Do not add or delete fake people or rates in a table
  other apps read - reuse existing fixture rows. Clear test data before any consolidation migration,
  or the consolidated table inherits invented values.
- **Natural keys are contracts.** Never rename or reformat a shared table's natural key after
  seeding: every consumer's backfill matches on it.

## 10. Migrating an app onto shared tables

Publisher prefixes and schema names are immutable and a lookup's target cannot be changed in place,
so "rename the app's table onto the shared one" is impossible. At the coordination level the
migration that worked was:

1. **One table at a time**, lowest risk first and the most-referenced (the calendar) last.
2. **Announce it** (PLANNED entry) and note which apps' lookups each step could orphan.
3. **Reconcile rows on the source system's key** and keep an id crosswalk. Never crosswalk on names:
   a vendor master de-duplicated by name left 41 source numbers resolving to nothing, and a
   names-only comparison reported 43 "missing" vendors where matching on number found one real gap.
4. **Add a new lookup beside each old one**, backfill through the crosswalk, repoint the app's data
   sources, grant every app role Read on the shared table.
5. **Audit agreement row by row** - every row resolves to the same key through old and new lookup.
   Row counts prove nothing.
6. **Keep the old table and lookups as the rollback path** until a test round passes; retire last.
7. **After retiring a table, check every app for relationship husks** - retired tables have left
   relationships still pointing at them, which broke inserts in a sibling app with every audit green
   (`dataverse.md`).

The data mechanics - crosswalks, backfills, matching people, loads and their reconciliation - are in
`data-migration.md`.

## 11. Coordination hooks and the status board

Each app repo surfaces the coordination layer at the moments it matters:

- **SessionStart**: print the newest few sync-log headings and the status-board rows, as JSON
  `hookSpecificOutput.additionalContext`.
- **PostToolUse guard**: when an edit's path or text references the shared prefix, remind the
  session of the protocol; stay silent when the edit is inside the coordination repo itself.
- **Stop**: fire only if the project tree changed; decide "touched shared" from **added** diff lines
  plus untracked files, not from files that merely mention the prefix; skip a reminder whose hub file
  is already modified; emit a non-blocking `systemMessage`.

Implementation details that kept them cheap across repos: resolve the hub from the hook file's own
location (`import.meta.url`), never from the current directory; reference the hooks from each app's
settings through `$CLAUDE_PROJECT_DIR/../<hub>/...` so nothing is copied; exit 0 silently on any
error or a missing hub.

**Status board**: one row per app - repo, current focus in one line, deploy state relative to the
shared environment, last updated - with detail kept in the app's own notes, updated at session end.
Enforce the one-line rule: in practice rows grew into paragraphs and two went stale for weeks.
