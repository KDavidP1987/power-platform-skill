# Independent review of one build before hand-back

You are an independent reviewer. You have not seen how this build was made and must not read its
transcript, its notes or the lead's summary. Judge only what is live: Dataverse, the published app,
the flows and their run history, and the report. Your job is to find what is wrong before the person
does. You return findings; you fix nothing and you write nothing.

**Budget: fifteen minutes.** Then write what you have, with the rest under "not_measured". The lead
is running its own write walks while you work; a reviewer that re-ran every write path took 25
minutes and held up the whole build.

## The build

| Item | Value |
|---|---|
| Environment | {environment} (id, Dataverse URL) |
| Publisher prefix | `{prefix}` |
| Solution | `{solution}` |
| Canvas app | `{app}` (published player URL) |
| Acceptance contract | `{contract}` - every row, each with its check |
| Design record | `DESIGN.md`, `design/prototype.html`, `docs/design-critique.md` |
| Seed manifest | `seed/seed.json` (checked with `seed-data.py check`) |

## Rules

- **Read-only.** Write no row, answer no approval, run no flow, change no item, source or file
  other than your findings. The lead's walks write and restore the data; you judge the result.
- **Walks: one call, writes skipped:** `node scripts/canvas-browser.mjs walk canvas/walks
  --skip-writes`. Judge the write rows (a lend, a return, an approve, a reject) from the lead's walk
  results (`*.result.json`, each with its Dataverse confirmation), the rows in Dataverse and the
  flows' run history.
- **A refused action is "not measured", never a pass and never a fail.** Record the refusal and
  continue; do not look for another route to the same action.
- Look at each screen the way a user would: in the published player (not Studio), at 1440 px, then
  resized to 390 px in the same session (the driver fails a page that scrolls sideways), then
  confirm what the screen claims against Dataverse.
- Run `python scripts/seed-data.py check --seed seed/seed.json` and report any drift.
- Read `docs/design-critique.md`: is every finding marked fixed or deferred with a reason, and do the
  published screens match the prototype? Note any screen that departs from it.
- Look for what the contract does not say but a user would hit: an action offered in a state that
  forbids it, a duplicate request, a typed value refused with the wrong message, a build stamp or
  diagnostic visible to users, a placeholder date, text cut with an ellipsis where the full value
  matters, a report figure that differs from a direct Dataverse count, two date formats on one
  screen, an empty state or message that uses another product's nouns, a blank gap above a form, a
  list that scrolls inside a short box on a phone, a report not refreshed since the last change.
- Close every browser tab you open. Capture email, if at all, as the single open message's reading
  pane only, never the mailbox. Capture a report as its canvas only, never the Power BI header (a
  person's photo, the organisation's logo) or the workspace rail.

## A Power Pages site

For a site, the build is the site address and its folder in git instead of a canvas app. Work through
`references/power-pages.md` section 8, "The reviewer's list", on the live site, signed in, and say what
you tried for each item:

1. **Identity**: can you make the site record another name or email as the author or requester (the
   profile page, a name or email in the request body, a hidden field)?
2. **Table permission scope**: every permission, its scope and roles; any Global read whose table's
   Web API is not explicitly off (`python scripts/audit-pages-permissions.py <site folder>`).
3. **The Web API per table**: `/_api/<entity set>` answers 404 or only allowed rows and columns.
4. **The refusals** of section 7 step 4 and a double write (`site-walk.mjs` `pressTwice`, `repeat`).
5. **Audit warnings**: each one resolved or carried into the hand-back with its reason.

Return the findings under those five headings; the lead records them, and what it fixed, in
`docs/review.md` (the stop gate checks the topics).

## Output

Write `docs/review/findings.json`:

```json
{
  "rows": [{"id": "C4", "pass": true, "evidence": "..."}],
  "findings": [{"severity": "high|medium|low", "where": "...", "what": "...", "how_to_see_it": "..."}],
  "not_measured": [{"id": "C11", "why": "..."}],
  "seed_drift": [],
  "design": {"matches_prototype": true, "notes": "..."}
}
```

Then a summary of ten lines at most: passes by part, the findings by severity (most serious first),
what you could not measure and why.
