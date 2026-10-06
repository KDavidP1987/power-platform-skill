# Roadmap to 1.0

The skill is in public beta. Each release below is defined by what it must prove, not by a date,
except where a release is marked done. The [changelog](CHANGELOG.md) records what each release
actually shipped.

## Backlog to 1.0

What still stands between the current release and the [1.0 criteria](#10-the-criteria), in the order
it will be worked. This table is the single source: `node scripts/sync-backlog.mjs` copies it into the
README and the documentation front page, and CI fails when they differ. Update it in every release.

<!-- backlog:start -->
| # | Item | Why it matters | Status |
|---|---|---|---|
| 1 | Power Pages: a site walk driver with sign-in, refusal and `/_api` proofs, and a reference covering row visibility, "my records", Private sign-in, deploy and teardown | The thinnest area: written from one real site, and nothing could walk a site or prove a refusal on one | First measured build (0.21): 30 of 30 blind checks, design 23 of 25, 85 minutes, no person needed. 0.22 adds Dataverse confirmation, captures and freshness waits to the walker, and the build's lessons (go-live decisions, identity for people who are not Dataverse users, the 15-minute cache window, feedback patterns). Second measured build (0.22): 30 of 30, design 23 of 25, 96 minutes (30 lost waiting on the site's sign-in consent), no person needed; it used the bundled walker for all 65 checks. 0.23 accepts the site's own consent when nobody is present, adds spill and covered-field checks to the walker, and stops asking a build with no seed to re-seed. Third measured build (0.23.1): 30 of 30, design 23 of 25, 90 minutes, no person needed. 0.24 turns what blind reviews kept finding into checks (current-page marker, focus contrast, double writes, unfilled columns, unguarded Global read), holds a site's hand-back for a critique of 30/40 and a five-topic security review, settles identity first with the administrator's steps, and ships in one call. 0.25 scopes every rule to the surface it serves (`rules-and-scope.md`): the 30/40 floor is for sites only, and the flow lint gates every import; 0.25.1 reads server logic in the permissions audit. Microsoft's plugin arm is next |
| 2 | Speed and cost against Microsoft's plugins | The last four canvas builds beat them on quality but not on time or cost | 0.21: data-source check on `create`, a design-helper time box, no single-issue publishes after the fix batch; to be measured |
| 3 | A self-test in CI for every script, and a floor that refuses to pass when nothing was examined | A 1.0 criterion; four scripts had none | Done in 0.21 |
| 4 | Teardown order for Fabric: Dataflows before their lakehouse | Dataflows can refuse deletion once their destination is gone | Done in 0.21 |
| 5 | Stabilise (0.9): one interface table, the compatibility file, upgrade notes | Users need options, exit codes and finding codes that stop moving | Interface table and compatibility file drafted in 0.21; freeze at 0.9 |
| 6 | Re-run the graded evaluation on the current version: ten or more task types (adding Power Pages, model-driven and SharePoint), three runs each, the held-out triggering set | A 1.0 criterion; the last graded run was 0.7.1 (217/222 with the skill, 136/222 without) and much has changed since | Open |
| 7 | Publish the 0.7.x results and the measured builds on the evaluation page | The page still shows the 0.5.1 run | Open |
| 8 | A model-driven app with a responsive canvas companion, built and verified in a tenant | Clears most of the snippets still marked "confirm in your tenant" | Open |
| 9 | SharePoint as a data source: delegation, the 5,000-item threshold, staying on a standard licence | Common in real tenants; written down nowhere yet | Open |
| 10 | Approvals in Teams and Outlook, and the one-Approvals-connection-per-person limit | Every approval flow meets it | Open |
| 11 | Two independent real builds in different tenants | A 1.0 criterion; every build so far ran in one tenant | Open: needs a second tenant |
<!-- backlog:end -->

## 0.6.0 (done 2026-10-02)

- **A fresh evaluation against 0.5.x** (done 2026-10-02, on 0.5.1): ten tasks, two runs per
  configuration, 133/148 checks with the skill against 98/148 without. The tasks, inputs and harness
  are in [`evals/`](evals/). It found four checks that fail with the skill; three are fixed below, the fourth is under 0.7.x.
- **The documentation kit's first real run** on a real app (role guides, a manager guide, an
  administrator guide and the developer and platform guide), and the fixes that run turns up
  (done: path resolution, pagination, figure and build inventory, Word or LibreOffice finishing,
  page rendering).
- **Three of the four evaluation findings fixed** (done): a gallery or picker on a whole-table
  collection moves to a source query (core rule 10); the notes treat each aggregate and each lookup
  filter as its own delegation point; defaulted list filters end with an invitation to change them;
  `check-canvas-format.mjs` resolves `Gallery.Selected.Column` against `--schema`.

## 0.7.0 (done 2026-10-02)

- **The last 0.5.1 evaluation finding** (done): a writing scenario must carry `confirm` checks, and
  `walk` reads the rows back over the Web API after the steps on every run, failing unless they hold
  the expected values and changed during the run. Proved against a real tenant: a setting changed in
  the published app, confirmed, restored and confirmed.
- **Harder loop and recipient tests** (done): task 5 is now a cycle through three flows among five,
  every trigger filtered and every flow guarded, with a drifting date that defeats a "skip unchanged
  values" fix; task 6 asks for a new flow in a set where an existing flow's failure path emails a real
  person, and nobody says so.
- **Static overlap check** (done): `check-canvas-overlap.mjs` and its hook, from a defect class that
  recurred across real builds (a control placed over another that shows only under some condition).
- **`canvas-browser.mjs` on a real tenant** (partly done): `--fresh`, `check --headless`, `walk`
  with writes and `confirm` ran against a real tenant and two driver bugs were fixed. `--channel`,
  `publish --reload-first`, the save proof and `doctor`'s Studio half are still untried.

## 0.7.x and 0.8.x: confirm what is still assumed

- **Re-run the full evaluation** (done in 0.7.1): three runs per configuration on the 0.7.0 task
  set, 216/222 with the skill and 136/222 without; it found the agent skipping the canvas checks
  when hooks are not installed, fixed in 0.7.1 (217/222). Still to do: publish the 0.7.x results
  on the evaluation page, which shows 0.5.1.
- **Use the skill on a new app from nothing** (started in 0.7.1): a work tracker with a Dataverse
  app, a SharePoint-only viewer and three mirror flows. The flows found two `lint-flows` false
  positives (fixed). Feed what the canvas build finds back here.
- **A SharePoint data-source reference** (found by that build's standard-licence viewer): which
  functions delegate to a SharePoint list and which do not (the default substring search and
  `CountIf` advice are Dataverse-only); a row count and distinct-value filter options without a
  delegable count or `Distinct`; the 5,000-item view threshold and which columns to index; field
  types (person, Yes/No, ID, Created, the 255-character single-line limit); a text-fit schema from
  list metadata; and what keeps an app on the standard licence (no premium connector, no flow call,
  the multiplexing caveat for a mirror of premium data). Confirm each in a tenant before it ships.
- **Small reference gaps from the same build**: whether `Errors(source)` is filled after an
  `IsError(Patch(...))` test; a comment box whose Post button enables while typing (Keypress)
  against the blur default; `check-canvas-format` finding the project's schema by itself on the CLI.
- **From the same build's Dataverse app** (confirm at its first compile, then write down):
  - whether a modal's scrim and card cover MODERN inputs declared before them, or the inputs paint
    through as they do over a gallery - if they paint through, the overlap checker's modal exemption
    must not apply to modern inputs;
  - quoting an apostrophe inside a quoted identifier (`'Won''t Do'`), and which form a custom
    `Status` column binds as (`Status` or `'Status (prefix_status)'`) - section 4 and a working
    app disagree;
  - clearing a lookup in `Patch` (`Blank()` against an `If` with no else);
  - a text-fit schema built offline from a table manifest, for an app whose tables do not exist yet;
  - when a collection behind a people picker is acceptable under core rule 10;
  - patterns for a fixed-height card whose title wraps to two lines, and a new-record form whose
    inputs start hidden.
- **Found shipping that app's fixes to an existing app** (write into `canvas-shipping.md` and the
  Dataverse reference):
  - a bare lookup-free field in a `ForAll` record (`{Id: s.Sprint, L: s.Name}`) was left out of the
    Dataverse `$select`, so every row arrived with a blank label and a picker looked empty; the same
    field inside an expression (`s.Name & ...`) was selected. Seen in the player's `$batch` response.
    A check could flag a bare `x.Field` value in a collected record, and the guidance could say to
    read the batch response before theorising (an `<>` filter was blamed first, wrongly);
  - `pac canvas download` returns the PUBLISHED version, not the last save: a save cannot be
    verified by download, only a publish can;
  - a push into a co-authoring session left Save disabled (Studio saw no change), so Ctrl+S saved
    nothing. What worked, three times: push with a Studio tab ALREADY open on the app; that tab goes
    white (do not reload it); open a NEW tab on the edit URL, which shows the push; confirm a changed
    property there, make a real edit and revert it with a second edit (Undo does not count, and Undo
    was unavailable), Save, Publish, then download. A push made with no Studio tab open did not reach
    a tab opened afterwards. Fold this into `canvas-shipping.md` section 4;
  - the formula bar edits whichever property is showing, not the one last picked in the property
    list; read the property name before typing;
  - the player caches the previous build: after publishing, a reload can still show "You're using
    an old version"; select Refresh before verifying.
- **`check-canvas-format` missed a literal label that clipped** (a two-line hint at height 24):
  confirm the wrap estimate is applied to literal `Text`, not only to bound text.
- **Calibrate the long-text estimate** (`check-canvas-format.mjs`, 0.56 em per character) against
  rendered output, with Power Fx `measurefont` or screenshots of the published player, and publish
  the measured range per font.
- **Confirm the snippets still marked "confirm in your tenant"**, or rewrite them:
  - the flexible-height gallery's `Variant: VariableHeight` name;
  - the key Studio writes for Named Formulas in `App.pa.yaml`;
  - the empty-means-All classic dropdown (`AllowEmptySelection: =true`, `Default: =Blank()`);
  - whether a Tooltip shows on hover inside a gallery row in the published player;
  - clearing a single-select ComboBox, across control versions.
- **Run `canvas-browser.mjs`'s remaining untried paths against a real tenant**: the save proof,
  `publish --reload-first`, `--channel`, and `doctor`'s Studio half.
- **`walk` waits for the app to be ready before step 1**: on a real tenant a first `click` failed
  once with "nothing clickable matched" and passed on the re-run. Wait for a named control (or the
  build stamp) rather than a fixed settle.
- **Run the long-text and list checks over more apps**, and turn any recurring false positive into a
  rule or an exclusion with a self-test case.

- **Reporting** (started 0.7.x, `references/reporting.md`): confirm the Power BI section against the
  first medallion build that follows it (dataflow shapes, the Direct Lake model deployment by API),
  and add a check that flags `If(cond, Table(), ForAll(...))` in a `ClearCollect`.
- **A separate Power BI and Fabric skill** (later): reports (PBIR), semantic models (TMDL), DAX,
  dataflows and lakehouses, deployment pipelines, custom visuals (`pbiviz`), usable on its own;
  this skill's reporting reference then points to it.

## 0.11.x and 0.12: more kinds of app

- **Power Pages** (started in 0.11.0 from one real site): fill the contact's name through an explicitly
  configured Entra provider (the built-in one ignored claims mapping, even after a restart); cover basic forms and lists against the Liquid-plus-Web-API pattern, file uploads, an
  external identity provider, and anonymous pages; a scenario format for `canvas-browser.mjs walk`
  (or a sibling) that drives a site and proves the refusals.
- **A responsive canvas app** (one app for desktop, tablet and phone): containers and breakpoints,
  measured at each form factor, with the overlap and format checks extended to every breakpoint.
- **Approvals in Teams and Outlook** from cloud flows, with the recipient pin kept.

## Gaps found against Microsoft's official skills (evaluated 2026-10-03, closed in 0.15.0)

Microsoft publishes eight plugins in `microsoft/power-platform-skills`. They generate; this skill
ships and verifies in a real tenant. Their canvas skill ends at a clean compile ("Runtime
evaluation: NOT RUN"). The comparison found eight gaps here; 0.15.0 closes each as follows, and what
is still documentation rather than measurement is listed so it can be confirmed:

- **Work alongside their plugins** (done): `SKILL.md` "Alongside Microsoft's official plugins", the
  README limits.
- **Requirements to verification** (done): the acceptance contract, `contract-to-walk.mjs`,
  `browser-verification.md` section 18. Measured offline on a real change-request stage machine (12
  scenarios; six writing moves found never pressed twice). Still to do: run generated walks against
  a tenant, and add a combo-box step to the walk vocabulary.
- **Responsive layout with containers** (done as guidance): `canvas-layout.md` section 9. Computed
  geometry is measured; the auto-layout skeleton and its traps are from documentation and marked
  to confirm. Still to do: compile and publish the skeleton in a tenant, and teach the overlap and
  format checks to see inside auto-layout.
- **Accessibility and contrast checks** (done): `check-canvas-format.mjs` `no-accessible-name`
  (note), `low-contrast` and `literal-text-overflow` (block), measured on a nine-screen app. Still
  to do: compare with the authoring server's `get_accessibility_errors` on the same app.
- **Power Pages security** (done): `power-pages.md` section 8 and `audit-pages-permissions.py`,
  measured on a real site's source and live headers. The firewall and the studio scan are from
  documentation (a trial site cannot use the firewall).
- **Flow run diagnosis** (done): `power-automate.md` section 18 and `flow-runs.py`, measured on a
  real failed run. Resubmit and cancel are from documentation.
- **Model-driven apps** (done as guidance): `model-driven-and-docs.md` section 8. Browser
  verification of a model-driven app and the pairing with Microsoft's app builder are marked to
  confirm.
- **Install and update** (done): README updating, issue templates, the harness's version record and
  the pre-flight's once-a-day update notice (measured against the real release feed).
- **Also from this round:** `setup-harness.mjs` installs the hooks and tools into a project;
  `first-run.md` section 13 removes repeated sign-ins (each identity measured silent).

## Next: a measured baseline against Microsoft's canvas plugin

Once the gaps above are closed, build the same app twice and compare. Plan:

- **The app:** one realistic brief with a Dataverse table or two, a list, a detail and edit screen,
  a status change with a refusal, and a phone layout - small enough to finish in a day each way.
- **Arm A:** Microsoft's `canvas-apps` plugin alone (its planner and screen builders), then its
  documented hand-off to the person for save and publish.
- **Arm B:** this skill with its harness (contract, generator or hand-written screens, hooks, push,
  save, publish, walk).
- **Same model, same environment, a fresh blank app each, a fresh session each, the same brief.**
- **Measure:** wall-clock time to a published app; agent tokens (input, output, cache); tool calls;
  compile errors met and fixed; person interventions (sign-ins, clicks, questions); defects found
  afterwards by one independent walk of the acceptance contract against each published app
  (requirements met, refusals that hold, rows confirmed in Dataverse); accessibility and contrast
  findings; layout defects at 1440 and 390 px; rework needed to make each one correct.
- **Report:** a table per metric with both arms, what each arm left unproven, and the raw logs in
  `evals/baseline-ms/`.

## 0.9: stabilise

- Freeze the script interfaces: options, exit codes (0 clean, 1 findings, 2 nothing examined) and
  finding codes, documented in one table.
- Publish a compatibility matrix: the `pac` CLI, Playwright, Node and Python versions, and the Studio
  and player behaviour each script was last verified against (`assets/tested-versions.json`).
- Write upgrade notes from 0.x to 1.0 for every renamed option or finding code.

## 1.0: the criteria

1.0 ships when all of these hold, measured rather than asserted:

- **Evaluation:** the skill passes at least 90% of graded checks across at least ten realistic
  tasks, at least 20 points above the same model without it, and no task scores lower with the skill
  than without; each configuration runs at least three times; triggering stays correct on the
  held-out set with no false triggers. (0.5.1: 90% and 24 points over two runs, with two tasks tied.
  The gap was 30 points or more on 0.1.0's four tasks, but the unaided model already passes 81% of the
  newer tasks' checks, so a fixed 30 would reward picking tasks it fails rather than a better skill.)
- **Every bundled script** has a `--selftest` with known-bad and fixed fixtures, run in CI, and a
  floor that refuses to report a pass when it examined nothing.
- **No copy-paste pattern** in the references depends on an unconfirmed snippet.
- **Two independent real builds** (different apps, ideally different tenants) have used the method
  end to end: schema, flows, canvas, ship, verification in the published app, and the documentation
  set.
- **CI is green** on the release commit, and the version check agrees everywhere.
