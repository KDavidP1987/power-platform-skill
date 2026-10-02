# Roadmap to 1.0

The skill is in public beta. Each release below is defined by what it must prove, not by a date,
except where a release is marked done. The [changelog](CHANGELOG.md) records what each release
actually shipped.

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
