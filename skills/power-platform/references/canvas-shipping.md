# Shipping a canvas change, and proving it landed

## Contents

1. Where the app lives, and what to settle on day one
2. The ship loop, and what each step proves
3. Path A: solution import (unattended)
4. Path B: co-authoring push (fast, more moving parts)
5. Proving a save and a publish
6. A solution import ships every component - and removes none
7. Verifying: which half runs, which build the browser has
8. Rolling back: version restore and broken-import recovery
9. Hard limits: the screen-file ceiling and archive paths

Studio sessions, the edit lock and the authoring MCP server have their own reference:
`authoring-sessions.md`.

---

## 1. Where the app lives, and what to settle on day one

- **Canvas UI is `.pa.yaml` in git**, under `canvas/<app>/Src/`. The repo is the source; the
  designer validates and edits data sources.
- **The `.msapr` (and `References/` inside a `.msapp`) is the app's data-source manifest.** The
  repo copy goes stale quickly. Never pack the repo's copy - build on a freshly downloaded live
  one (`pac canvas download`). Packing a stale manifest silently drops data sources: one project
  measured 206 references in its repo copy against 231 live, and the import de-wired 25 sources
  with no error. A refreshed `.msapr` that was never repacked into the `.msapp` is just as stale:
  one build re-added five sources a person had just removed in Studio. The artifact is only as
  current as its last pack.
- **Data sources can only be added in Studio.** `.pa.yaml` cannot declare one and no CLI adds one.
  Studio is a web page, so this is browser work (see `browser-verification.md`), not "needs a
  person". A data source is a **snapshot of the table** taken when it was added - see
  `manifest-caches.md` for everything that follows from that.
- Keep the app's identity in **one** config file (for example `scripts/canvas-app.json` with
  `environmentId`, `appId`, `appName`, `solutionUniqueName`) and have every tool read it. Two tools
  pointed at different apps is a failure nobody notices until a ship goes to the wrong one.
- **Pass the app id, never a name, to `pac canvas download --name`.** With the logical name pac answered
  "No canvas apps in the selected environment", which reads as if the app had been deleted; a
  display name can resolve to the wrong app when names repeat. And the id in the downloaded
  app's `Properties.json` (`Properties.Id`) is a **document id**, not the app id - passing it
  downloads nothing with an error that does not say why. Record both in the identity config and
  label which is which.

### Is the app solution-aware? Find out before planning a ship path

Query the Dataverse `canvasapps` table for the app. **An app created outside a solution has no
row there at all**, so it cannot be a solution component. Consequences: Path A is unavailable; the
app does not travel with the solution to another environment (a managed zip ships the tables
without the application); and the `canvasapps` row you would use to confirm a publish (section 5)
does not exist. Moving a live app into a solution changes how it is managed - an owner decision,
cheapest at project start.

The reverse trap: on a solution-aware app (`almMode: Solution` in the package), **importing an
app package is a silent no-op**. Apps > Import of an exported package - even with
`suggestedCreationType: Update`, even after bumping `appVersion` - reported success twice and
changed nothing. For a solution-aware app the only import path is a solution import. (Side use
seen in one project, unverified elsewhere: Studio's "Import .msapp" then Play is a quick render
and `OnStart` smoke test of a built `.msapp`.)

### Creating a new canvas app: Studio, inside the solution, settings first

pac and `.pa.yaml` can edit and ship an app but cannot create one.

1. Create the app in Studio with the form factor the layout assumes (for example tablet 1366x768).
2. Save it **into the solution** (Solutions > your solution > New > App), not as a loose app.
3. Record its app id in the identity config.
4. Turn on **modern controls** (Settings > Updates, "Modern controls and themes"; sometimes under
   Preview). When off, the manifest reads `fluentv9controls: false` and every modern control name
   fails to bind. Turning it on changes default properties: free on a blank app, a re-style after
   ten screens.
5. Turn on **co-authoring** (Settings > Updates > Preview > Collaborative editing). Until it is
   on, the authoring server's `connect` fails with "Coauthoring is not enabled for this app", and
   no Power Fx is ever compiled. It is not visible in the package, so no script can check it -
   re-check it after toggling other settings, which is when it tends to get lost.

Several app settings take effect only after **Save, close and reopen**. Studio settings are also
"saved but not published" like everything else: a raised data row limit and newly added sources
were invisible to the player and to `pac canvas download` until a Publish.

### Legacy packages

`pac canvas unpack` refuses old structure versions ("MSAppStructureVersion 2.0 is below the
minimum supported version 2.4.0"). The file is not corrupt. To bring such an app into git, open
and re-save it in a current Studio first. To read it only as a specification, unzip the `.msapp`
and read the JSON directly - one project recovered an exact filter rule that way.

## 2. The ship loop, and what each step proves

Run in order. Each answers a question none of the others can.

| Step | The only question it answers |
|---|---|
| audit suite | is the source structurally sane, **and is every saved input it reads current** |
| compile with Studio open | do the formulas bind against the REAL data sources |
| build the artifact | does the package contain the change, built on the LIVE manifest |
| import | did the components land |
| verify the marker | is the change in the half of the app that actually RUNS |
| check the build stamp | is the browser running that package yet |
| perform the task | does the feature work, for the role that will use it |
| refresh the audit inputs | will the next audit be about the app that now exists |

The two most often skipped are the build-stamp check and the refresh. Skip the first and a hands-on
result means nothing; skip the second and tomorrow's audit describes an app that no longer exists -
and passes while doing so.

**Always compile, and know that it is the only compile.** The import path does not check formulas,
and there is no offline validator any more: `pac canvas validate` answers "no longer supported", and
in at least one CLI version `pac canvas pack` itself refused with "must be validated first by
opening the app for edit within Power Apps Studio". A live Studio session is therefore the only
formula validation. If the edit lock is stranded (`authoring-sessions.md`), no canvas change can
be verified - stop shipping canvas rather than ship unverified.

**Order the day.** After a 30-minute held push was silently voided by an import, one project
adopted: do all schema work and imports first and verify them; then compile and push; then let
nothing touch the environment between push and save. Four distinct push failures in one day each
looked like a repeat of the previous one - assuming a repeat sent the diagnosis the wrong way
twice. Read each failure fresh.

## 3. Path A: solution import (preferred for unattended work)

Build the `.msapp` from repo `Src` on top of the **live** manifest, swap it into a solution
exported from the **environment**, assert on the finished artifact, import. No save, no timing.

The non-negotiables, each a post-mortem:

- **Build on the live `.msapr`**, never the repo's. Refuse to emit an artifact whose data-source
  count is lower than the live app's.
- **Build the solution from the environment** (`pac solution export`), not from `solution/src`.
  The repo's component list and canvas metadata lag (one project: 18 tables in repo source, 35
  live), and a stale list leaves data sources unresolved or dead on import (see
  `manifest-caches.md`, "the list exists twice").
- **Every table the app binds must be in the solution** (section 6). Gate the build on it.
- **Strip security roles** from the zip. A solution carrying roles resets live access control.
- **Stamp the build** (below). Make the ship **refuse** if the placeholder is missing.
- **Refuse unless the packed app loads from yaml.** After `pac canvas pack --layout SourceCode`,
  read `packed.json` -> `LoadConfiguration.LoadFromYaml` from the fresh `.msapp`; if it is not
  true, the stale `Controls/*.json` wins and the change is invisible. Unpack the live baseline with
  the same `--layout SourceCode` so the pack directory has the same shape.
- **Assert on the finished artifact.** A pack can report success and omit exactly the change you
  queued. Use `scripts/inspect-artifact.py <zip> --expect <marker,...>`.

Extra refusals worth having on the finished canvas-ship zip:

- the entity root-component count (`RootComponent type="1"`) is unchanged between the exported
  solution and the rewritten one - so a canvas ship can never alter schema;
- exactly one canvas app (`type="300"`) is present;
- no `<Role` element survives in `customizations.xml`, and no `RootComponent type="20"`;
- the stamp placeholder is gone and the markers are present.

When rewriting `customizations.xml` or `*.meta.xml` inside the zip, read with `utf-8-sig` and
write the BOM back if the original had one. (One project's newer script wrote without the BOM and
still imported - treat it as safe practice, not a proven requirement.)

Sketch of a ship script's stages:

```
pac canvas download --name <appId> --environment <env>   -> live.msapp (baseline manifest)
pac solution export --name <solution>                    -> live-export.zip
build .msapp: live References/ + repo Src/ + stamp      -> app.msapp
reconcile manifest caches (choices, entity sets, dbrefs) -> see manifest-caches.md
swap app.msapp into live-export.zip, drop Role components -> import-me.zip
inspect-artifact.py import-me.zip --expect <markers> --min-datasources <live count>
pac solution export --name <solution> --managed false    -> rollback point (section 8)
pac solution import --path import-me.zip --publish-changes
```

(`--name` takes the app id here, not a name - section 1.)

**The live baseline is the PUBLISHED app.** The manifest the build starts from - including each
data source's cached column list - is the published version's, not the last save. After a schema
change, refresh the changed data sources in Studio, save **and publish**, then build. Measured on
one build: four tables refreshed and saved but not published; the build refused with eleven
"column exists live but not in the app's cached column list" findings; after a publish of the same
refreshed (otherwise unchanged) app, the rebuild had 0 drift. `ship-canvas.py` prints that remedy
when it refuses on this finding. Do not pass `--accept-drift` for it: the player cannot bind a
column its cache lacks.

**The exported solution carries everything in it, flows included.** The build swaps the app into a
solution exported from the environment at build time, and the import applies every component in
it (section 6) - so a package built BEFORE a flow deployment re-imports the old flows over the new
ones. Order the release: deploy flows first, then build and import the canvas package. Delete any
package built earlier rather than import it later.

### The build stamp

Write a unique id into the PACKED copy of `App.pa.yaml` only - never the repo copy, which would
churn - and render it on an admin-only label:

```
Set(gblBuild, "unshipped");      // placeholder in the repo
Set(gblBuild, "2026-01-15 14:02Z a1b2c3d+");   // what the ship writes
```

- Use `<UTC time> <short sha>`, plus a `+` when `git status --porcelain` is non-empty, so a build
  from uncommitted source can never be mistaken for the commit it claims.
- **Every** packer that can produce an importable zip must stamp - including the plain packer.
  Before one project's plain packer stamped, its artifact shipped the literal placeholder and the
  live app read "Build unshipped", which cost a cycle.
- The push path can be stamped too (section 4).
- A stamp that silently stops updating is worse than none: refuse to ship when the placeholder is
  not found.

### Build-script hygiene

- **pac is a native executable: in PowerShell its failure does not throw**, even under
  `$ErrorActionPreference = 'Stop'`. A pack script printed "Built" and left the previous zip in
  `out/` to be imported; an import script stamped a "last successful import" record after a failed
  import - a worse lie than no stamp. After every pac call:
  `if ($LASTEXITCODE -ne 0) { throw "pac failed: $LASTEXITCODE" }`.
- **Check the artifact path before calling pac.** Given a path that does not exist, `pac solution
  import` prints about 30 lines of usage text that read like a malformed command. A broken default
  path survived about twenty ships because every documented caller passed one explicitly. Test the
  path, list what is in `out/` with timestamps, and stop.
- **Do not commit the `.msapp`; regenerate it on every pack.** It changes on every ship; a
  committed copy lags and ships an old app with nothing to say so. Gitignore `CanvasApps/*.msapp`,
  commit only stable sidecars, and rebuild from `Src/` + `.msapr`.
- **Never write build products into `solution/src`.** Copy it to a staging folder and inject the
  fresh `.msapp` there, or the next `git add -A` commits it.
- **A staging copy must start empty, or refuse.** On a cloud-synced folder on Windows,
  `rmtree(ignore_errors=True)` failed on read-only files, was swallowed, and resurfaced as a bare
  `FileExistsError` from the copy. Clear the read-only bit in an error handler, retry, then refuse
  if the tree still exists. Never "fix" it with `copytree(..., dirs_exist_ok=True)`: a screen
  deleted from the repo survives in the stale copy and gets shipped (and can push the app over the
  file ceiling). Making the stamp the default is what surfaced this - an opt-in path stays
  untested.
- **A managed zip cannot be packed from unmanaged-unpacked source.** `pac solution pack
  --packagetype Managed` over an Unmanaged unpack fails "Solution package type did not match
  requested type". Export the managed build from the environment (`pac solution export --managed
  true`). Unpacking with `--packagetype Both` should let one tree produce either (general pac
  behaviour, not exercised in these projects).
- **Bump the solution version on every delivery.** A build from an environment export carries the
  live version forward, so a good and a broken build are indistinguishable by version.
- **A pack that only proves the solution builds is not a ship.** If it counts as one, every
  verification run marks every audit input stale.

### Canvas apps in an unpacked solution tree

The canvas twin of the "unexpected children" skip in `dataverse.md`:

- `<CanvasApps />` in `Customizations.xml` must be **childless**.
- Each app needs `CanvasApps/<name>.meta.xml` beside its `.msapp`.
- Declare the app (root component type 300) in `Solution.xml` without its files and pack prints
  "Following root components are not defined in customizations" - and **exits 0** with a zip that
  declares an app it does not contain.

Assert declared against present per component type after every pack (the checks are in
`dataverse.md` section 2; `inspect-artifact.py` runs them). In one project this
guard fired twice during the work that introduced it.

## 4. Path B: co-authoring push (fast, more moving parts)

`compile_canvas` pushes into the live Studio session; Studio must then **save** it and **publish**
it. One project retired this path after measuring Save as a no-op (the app record unmoved for 225
minutes), then re-adopted it days later when the same instrument showed saves and publishes
landing and a fresh download carried every marker. The cause of the change was never established
(the floating server version is the likeliest suspect). Both paths are legitimate; this one is
faster per change and has more failure points, each listed here. Amend a decision with the
re-measurement in place rather than deleting it, and re-measure a retired path when its
preconditions change.

### The order that works

1. Open Studio in edit mode in a driven browser (`canvas-browser.mjs studio`) and wait for the
   title to read `(Editing)`. **Leave it in the editor, not in Preview.**
2. `connect`, then `compile_canvas` - pushing a stamped scratch copy (below). Read line 1 and the
   error count (`authoring-sessions.md`, section 2). Keep the session held.
3. Prove the push reached Studio's client: select a changed control and read the property back in
   the formula bar, or see the new control in the tree.
4. Click Save (a real click, section 5). Open the Save flyout and read `Saved: <time>`.
5. Release the held session. **Reload the Studio tab** (accept the `beforeunload` prompt), then
   Publish. Safe only because step 4 already persisted the push - never reorder.
6. Confirm the publish from the `canvasapps` record, then the player and its build stamp.

### Failure points, each of which reports success

- **Studio closed during the push is always invalid.** One project tried "hold mode": push with
  Studio closed, keep the client alive so Studio attaches later. Measured: Studio never joins the
  agent's solo session; the compile produced 4,068 errors because data sources resolve only from a
  live designer session; and **saving afterwards persisted the OLD document over the push**.
- **The push blanks Studio's screen. That is usually the push arriving.** Save still works while
  white. But in one case the shell stayed empty (root present, zero menu items, five minutes) and
  could not save. **Fix: while the push session is still held, open a SECOND tab on the same edit
  URL.** It joins that session and renders the pushed document; a real-click Save there landed.
  Then Back, reopen fresh, confirm. This removes the reload catch-22.
- **A reload discards the push** - it joins a new session that does not contain it. The screen
  looks broken, the instinct is to refresh, and the work is gone. One exception: after a session
  expiry Studio can silently re-attach to a new session on its own (white screen, nobody reloaded,
  save did not land). That is the one case where reloading is right: reload once, say so, push
  again. When the session dies on token expiry (a 401), the new session loads the **last saved**
  app - everything pushed but unsaved is gone. Restore your scratch working copy from git before
  each edit, never from a `sync_canvas` of the server, which may be stale.
- **A push that lands while Studio is in Preview is never saved.** A push changes the SESSION, not
  Studio's edit buffer, so Studio can decide there is nothing to save: Save does nothing, no toast,
  and Preview still shows the change because it lives in the session - "drive it and see" passes.
  Measured: load -> push -> Save saved; load -> Preview -> push -> Save was lost, twice. A disabled
  "Save with version notes" is a secondary tell (greyed alone proves nothing).
- **"Session held" is not "Studio has applied the push".** A Save about 30 s after a genuine hold
  saved the PRE-push state, Publish shipped it, and only the post-publish marker check caught it.
  The step-3 read-back takes fifteen seconds; it also caught a scripted edit that had landed on the
  wrong control.
- **The push targets whichever session the client joined.** After a data-source refresh or a
  publish reloads Studio, Studio joins a NEW session while the agent keeps pushing into the old
  one: 0 errors, a "successful" push into a room nobody is in, and a saved app with a clean cut at
  the last pre-reload change. **Re-connect after any reload, data-source change or publish.**
  Observed again on a later build: four data sources refreshed, then compile and hold reported
  "PUSHED CLEAN" twice, while Studio's tree view still lacked both new screens and every new
  control; the save that followed saved the old app. Step 3 (read a marker control in the tree)
  is what caught it. When a change needs a data-source refresh, prefer Path A: refresh, save and
  publish in Studio, then ship by import.
- **Never import a solution while a push is held.** An import republishes every customisation and
  kills the session holding the push.
- **The hold has a timer, and expiry discards the push.** A 60-minute default expired while waiting
  on a person. Make the cap configurable and generous.
- **Publish can be inert in a tab that carried a push.** With real clicks, Publish failed three
  times (dialog opened, confirm clicked, `lastpublishtime` unmoved) although the Save had landed; it
  published first try after a page reload. Hence step 5.
- **The push does not reorder controls Studio already has.** New controls inserted before existing
  ones, and an existing card and gallery that moved, published in a different order from the repo,
  with the card drawn over the gallery. Append new controls after the existing ones; when existing
  controls must change order, rename them so the push creates them fresh in repo order; then run the
  order check in `audits.md` section 7 on the downloaded app.
- **The compile does not report what it pushed.** It answers "do these formulas bind". One round
  touched three screens, reported `PASSED, 29 files`, and two of the three never reached the
  server. `sync_canvas` into a scratch directory (never into `Src`) and compare **semantic
  markers**, not bytes or line counts: the server re-serialises (sorts properties, drops `X`/`Y = 0`
  defaults), so files legitimately differ by 10-20 lines. `sync_canvas` reads the session, not
  Studio's client model; a stronger check reattaches to the held Studio over CDP and reads the
  changed control's rendered box or tree entry from the `authoring.*.powerapps.com` frame
  (`[data-testid]`, `[aria-label]` plus `getBoundingClientRect`) - that is what Save will write.

### Stamping the push path

The authoring server accepts a `directoryPath` outside the app directory, so compile a stamped
**scratch copy** (never the repo) and suffix the stamp `(push)`. The scratch directory must be
removed fully first (section 3, staging rule). Write the "last push" record only after a
successful push. If the authoring tools cannot write into a cloud-synced long path (observed with
one sync client), build in a local temp directory, compile from there, and copy back.

## 5. Proving a save and a publish

| Question | The only evidence that answers it |
|---|---|
| did the push land? | `sync_canvas` right after the compile (or the CDP read-back) |
| did the save land? | the Save flyout's `Saved: <time>`, then a **fresh** Studio session + `sync_canvas`, or a fresh download after publish |
| did the publish land? | the `canvasapps` row's `lastpublishtime` moved |
| is it live in the browser? | the player, refreshed, with the build stamp read |

- **Never the window title, never a toast.** The in-app "Publish successful, <time>" toast stayed
  pinned showing a PREVIOUS publish's timestamp through three attempts that never landed - actively
  confirming a lie.
- **Read `canvasapps` for the publish.** `canvasapps?$filter=displayname eq '<app>'&$select=
  lastpublishtime,lastmodifiedtime,appversion`. In one measurement none of these moved on Save -
  only on Publish - so the row proves a publish, not a save (an earlier note assumed Save moves
  `lastmodifiedtime`; possibly version-dependent). The same row settles "is the tracker behind the
  environment": a state file said "saved, not published" two and a half hours after the app had
  been published.
- **Use trusted input events for every Studio command.** A keyboard Ctrl+S works only if the
  editor iframe has focus - a person clicking in the editor first. Automation lands on the outer
  shell, where Ctrl+S is the browser's save-page shortcut, suppressed, and nothing throws. A
  scripted DOM `element.click()` (via evaluate) on Save or Publish also silently no-ops - it even
  opened and closed the Publish dialog, with `lastpublishtime` unmoved across three attempts. The
  identical sequence with real Playwright mouse clicks worked first time. Click
  `button[aria-label^="Save"]` (or `#commandBar_save`) inside the authoring frame, wait 20-30 s,
  then the Publish button and "Publish this version" (`canvas-browser.mjs save` / `publish`).
- **Save and Publish are separate, and Publish does not wait.** Publishing too soon after a save
  ships the version current when it started - and says "Publish successful".
- **First-run modals swallow clicks.** "Welcome to Power Apps Studio", "Did you know?" and the
  read-only teaching bubble intercept every command-bar click until dismissed; tick "don't show
  again" once in the persistent profile.

If a fresh session shows the change saved but the player disagrees, **publish again** before
looking for any other explanation.

## 6. A solution import ships EVERY component - and removes none

There is no schema-only import. A zip carries every component it declares, so importing a
one-column change also reships the canvas app in the same solution - and whatever built that zip
decided which version of the app went live.

Projects tend to keep two build paths that produce different apps:

- a **plain packer** (`pac solution pack` over `solution/src`), and
- a **ship script** that downloads the live app, builds on it, stamps it, and refuses lossy output.

Import the plain packer's output for a schema change and you silently replace a validated, stamped
app with an unvalidated, unstamped one - and if the repo's canvas metadata has drifted, de-wire
live sources (in one case including the table that decides who is an admin). **Rule: if the zip
contains a canvas app, build it with the ship script.** Use the plain packer to prove the solution
packs - not to deploy. For small schema changes (a choice member, a required level), prefer a
targeted, idempotent Web API metadata call mirrored into the unpacked solution XML. A
force-overwrite import also replaces saved-but-unpublished work in the live app and resets
connections.

After **any** import, re-read the published app and compare its data-source count with the
previous one before believing it is fine.

### Every bound table must be in the solution

In one incident an import left 18 of 31 sources unresolved. The trace showed `AppDataSourceError`
"Your data source is not configured correctly" (`_errorKind: 15`) with **no request issued** for
those tables; `App.OnStart` then died at the admin lookup and the admin gate collapsed for everyone.
The discriminator was exact: every table the solution shipped worked, every table it did not ship
failed. The component list was months stale, and the reference-count, marker and root-component
checks all passed because none asked "does the solution contain the tables the app binds". The
mechanism was recorded as a correlation, not proven.

So gate the **pack and the ship** on "every table the app binds is in the solution's entity list"
(offline, about a second), with an explicit skip switch for a deliberate partial build. A
canvas-only solution with zero tables, considered as a way to stop app updates touching schema,
would have left every source unresolved. For tables another solution owns, add them as a
**reference** - `AddSolutionComponent` with `DoNotIncludeSubcomponents = true` - so your import
resolves them without republishing their schema (see `dataverse.md`; a sibling project that
removed shared tables from its list saw no breakage, so the effect may depend on how the app was
bound - keep the gate).

### What an import does and does not do

- **An unmanaged import is additive: it adds and overwrites, it never removes.** A component
  dropped from source stays live; option values deleted live come back if the solution XML still
  holds them; a canvas app survives an import from a repo that no longer declares it; importing an
  older zip produces no error at all. Removal is a separate, explicit operation (see
  `dataverse.md`).
- **An import reports success for the wrong artifact just as loudly.** With a schema zip and a
  canvas zip in one output folder, an import script that defaults to one will, run bare, import a
  stale pack: "Solution Imported successfully", exit 0, live app walked backwards. Make the default
  **refuse** when the other artifact is newer and none was named, printing both timestamps. A wrong
  import also blocks the corrective one ("Cannot start another [Import] because there is a previous
  [Import] running") for several minutes. **Read the build stamp after every import, never the
  exit code.**
- **The client can time out or hang after the server succeeded.** Twice in one project: `pac
  solution import` timed out at 30 minutes and the wrapper printed "import failed; nothing was
  imported" while the server job had finished in about five minutes with 0 failures (only the
  publish was missing); and once it never returned and was killed at 25 minutes while the server
  had finished in about three. Read the **`importjobs`** table (progress, completion time) before
  believing an exit code or a wrapper's summary; run `pac solution publish` if the import landed
  unpublished; write any ship stamp from the job's completion time.
- **Print `pac org who` before every import.** The environment is part of the artifact.
- **Shared solution first.** When several apps' solutions take lookups into a shared reference
  solution, import the shared one first, or the dependent import fails on missing dependencies.
  Encode the order in the deploy scripts, not in someone's head.
- **Close Studio before importing** (an import kills any held push), and expect Studio's Data pane
  to show red badges afterwards that may be a client cache (`manifest-caches.md`).
- Imports also re-apply flow on/off state and can revert hand-applied metadata - see
  `power-automate.md` and `dataverse.md`.

Deploying without pipeline or tenant rights: a maker with System Customizer on the target can still
build the zip in git and self-import it (or hand the zip to IT for higher environments).

## 7. Verifying: which half runs, which build the browser has

- **An app carries its screens twice**: `Controls/*.json` (compiled) and `Src/*.pa.yaml` (source).
  `Header.json`/`packed.json` -> `LoadConfiguration.LoadFromYaml` decides which wins:

  | Shipped by | LoadFromYaml | Authoritative | The other half |
  |---|---|---|---|
  | Studio save/publish | false | `Controls/*.json` | `Src/` may lag |
  | Solution import of a yaml-built msapp | **true** | **`Src/*.pa.yaml`** | **`Controls/` is stale** |

  A correct import has been reported as a failure because the check grepped `Controls/` on an app
  that had just been told to load from yaml. `inspect-artifact.py` reads the flag first and
  searches the half that runs, and should print whether the other half agrees so a disagreement is
  visible.
- **Choose a marker that exists only because of the change.** "Upcoming Renewals" was chosen for a
  new button but was already a screen title, and returned PRESENT against a build without the
  change; "covered by" also occurred in an unrelated accessibility label and reported seven screens
  behind when one was. Confirm the marker is absent from the previous build before shipping.
- **Assert absences too** (`--absent`): the old wording a change removes. After a sweeping text
  change two notices switched by a different variable survived every presence check. A removed
  feature still present in the running half is as much a failed ship as a missing one.
- **A build-stamp detector must accept both quoting forms.** When `LoadFromYaml` is false the
  running half is `Controls/*.json`, where the formula is JSON-escaped (`Set(gblBuild, \"...\")`);
  a bare-quote regex printed NOT STAMPED beside a stamped build. A detector that always says "no
  stamp" trains people to ignore it.
- **Marker presence proves a control exists, not that it works.** A Refresh button shipped and was
  "verified live" by marker while it `Select()`ed a label with no `OnSelect`. The last step is
  performing the task (`browser-verification.md`).
- **After any Studio surgery, re-ship from git and check `LoadFromYaml`.** Publishing from Studio
  writes the app back in `Controls/*.json` form: `LoadFromYaml` flips to false, the build stamp
  vanishes, and if the Studio session predated recent imports, the live app silently loses that
  work. Treat the live app as untrusted until you have re-shipped and confirmed `LoadFromYaml:
  true` and a current stamp.

### The player serves the previous build for minutes - sometimes more than ten

Offline checks read the environment; the browser reads its cache. The tell is the app behaving
exactly as before with no error - same button, same success toast, nothing written. Measurements
from three projects:

- a build stamp absent 4 minutes after an import, present at 6;
- the previous build still running 7 minutes after release; a test at 12 minutes, judged "long
  enough", still lag;
- with full storage cleared, the old build at 2 minutes and the new one at about 9; on a later
  publish about 10 minutes was still not enough.

Three "the fix does not work" results in one day were all the old build. **Elapsed time is not
evidence; only the stamp is.** Reload and repeat before looking for a bug in your formula.

How to force the new build (the package lives in IndexedDB, not the HTTP cache), the consent prompt
that clearing storage re-triggers, and when to use Studio Preview instead of the player are in
`browser-verification.md` section 10.

## 8. Rolling back: version restore and broken-import recovery

- **Take a rollback point before every import**: `pac solution export --name <sol> --managed false
  --path backup-<time>.zip`. When the solution lists tables another team owns, snapshot their
  metadata before and after and diff (`dataverse.md`).
- **A version restore updates the DRAFT only.** After Apps > Details > Versions > Restore, a
  download returned content byte-identical to the broken build; the restored version reached users
  only after Publish. Restore, Publish, then verify - and then re-ship from git and check
  `LoadFromYaml`, as after any Studio surgery.
- **A held authoring session blocks restore** (`authoring-sessions.md`, section 1): kill the
  server processes and stop connecting first.
- **Recovering from a broken import:** restore the last good version, Publish, `pac canvas
  download` it, and adopt its `References/DataSources.json` / `.msapr` as the new baseline manifest
  - in one recovery the good copy had every source and the repo copy did not.
- **Diagnose a post-deploy break in this order**, which one project learned by reaching for the
  first step last, twice (a trace answered a day-long outage in ten minutes):
  1. A Monitor trace (if live updates allow; otherwise publish, then open Monitor from the app's
     details page) or an OData trace (`browser-verification.md`). 401/403 means privileges; all
     200 with formulas still erroring means sources never resolved; no errors means it is not the
     app.
  2. Check the solution ships every bound table (section 6).
  3. Read what is live from a fresh download.
  4. Roll back with Restore + Publish.

Keep a "what NOT to do" list built from your actual wrong turns. One project's: asserting a stale
cache without checking it; verifying in the same session that made the change; removing healthy
data sources because the Data pane said so; trusting the FAILED banner as an error count.

## 9. Hard limits: the screen-file ceiling and archive paths

### About 50 `.pa.yaml` files per app

Over the cap the authoring service refuses the compile. Compiling a subset **mirrors** rather than
merges, evicting the excluded screens from the session, so publishing ships an app with screens
missing and dead `Navigate` targets. The bundled `.pa.yaml` hook warns as you approach it.

- **Validating while over the cap (stopgap):** copy 50 files to a temp folder, compile there,
  filter the known `Navigate` errors aimed at the excluded screen, and ship by **solution import,
  never by push** (a push would evict). Then fold a screen.
- **Fold a screen into a full-screen overlay on another screen** - an admin or config page is
  ideal; a navigation audit's orphaned screens are free slots. The procedure:
  1. Pick the host screen that navigates to it; check for app-wide control-name collisions
     (control names must be unique across the whole app).
  2. Move the controls verbatim, keeping absolute X/Y, over a full-screen backdrop declared first.
  3. Gate every top-level moved control on a context flag (`Visible: =locShowSettings`); gallery
     children inherit.
  4. Entry is `UpdateContext({locShowSettings: true})`; the old Back becomes Close.
  5. **An overlay has no `OnVisible`**: move that logic into the opening button's `OnSelect` (check
     for duplicated `OnChange` logic), and make sure any in-overlay recompute already exists.
  6. Delete the screen file and confirm no `Navigate(<Screen>` remains.

  An overlay shares its host screen's state: navigating away and back re-runs the host's
  `OnVisible`, and context variables persist per screen (reset overlay flags in `OnVisible`). That
  same property is why an overlay is the right shape when unsaved staged rows live on the screen.

### Reading `.msapp` / `.msapr` entries: match either path separator

Producers differ - some store `References/DataSources.json`, others `References\DataSources.json`;
an unpacked `.msapr` can also nest it as `msapp/References/...`. Python's `zipfile` normalises;
.NET's `System.IO.Compression` does not, so a PowerShell filter on `/` silently stops matching and
reads as a corrupt archive. Normalise with `($_.FullName -replace '\\','/')` before matching. Close
a read handle before rewriting the same path on Windows (otherwise intermittent "Errno 22 Invalid
argument").
