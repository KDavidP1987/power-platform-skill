# Roadmap to 1.0

The skill is in public beta. Each release below is defined by what it must prove, not by a date,
except 0.6.0, which is the next release. The [changelog](CHANGELOG.md) records what each release
actually shipped.

## 0.6.0 (next)

- **A fresh evaluation against 0.5.x** (done 2026-10-02, on 0.5.1): ten tasks, two runs per
  configuration, 133/148 checks with the skill against 98/148 without. The tasks, inputs and harness
  are in [`evals/`](evals/). It found four checks that fail with the skill, listed under 0.7.x.
- **The documentation kit's first real run** on a real app (role guides, a manager guide, an
  administrator guide and the developer and platform guide), and the fixes that run turns up.

## 0.7.x and 0.8.x: confirm what is still assumed

- **Fix what the 0.5.1 evaluation found:** the verification script must confirm the write in
  Dataverse on every run, not behind an option; a `.pa.yaml` edit must move a gallery off a
  whole-table collection and say that `Sum` over the source and filters on a lookup's related column
  do not delegate (both passed on 0.1.0); notes should invite changes to defaulted list filters; and
  `check-canvas-format.mjs` must resolve `Gallery.Selected.Column` against `--schema`, as it does
  `ThisItem.Column`.
- **Harder loop and recipient tests.** The unaided model already catches an explicit two-flow cycle
  and caps recipients when told to, so those tests guard against regression without measuring the
  skill. Replace them with a cycle through three flows among several, and a recipient leak in an
  existing flow that nobody points out.
- **Calibrate the long-text estimate** (`check-canvas-format.mjs`, 0.56 em per character) against
  rendered output, with Power Fx `measurefont` or screenshots of the published player, and publish
  the measured range per font.
- **Confirm the snippets still marked "confirm in your tenant"**, or rewrite them:
  - the flexible-height gallery's `Variant: VariableHeight` name;
  - the key Studio writes for Named Formulas in `App.pa.yaml`;
  - the empty-means-All classic dropdown (`AllowEmptySelection: =true`, `Default: =Blank()`);
  - whether a Tooltip shows on hover inside a gallery row in the published player;
  - clearing a single-select ComboBox, across control versions.
- **Run `canvas-browser.mjs`'s untried paths against a real tenant**: `--fresh`, the save proof,
  `publish --reload-first`, `--channel`, and `doctor`'s Studio half.
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
