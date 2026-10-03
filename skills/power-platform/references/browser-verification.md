# Driving the maker portal and the published app with Playwright

## Contents

1. Why this is the standard, not a fallback
2. Two ways to drive: the Playwright MCP tools and the bundled driver
3. Sign-in and the persistent profile
4. Finding the app: it is in an iframe
5. Snapshot vs screenshot, and the console
6. Rules for exercising a feature
7. Designing a scenario that can fail
8. Writes, gates and negative tests
9. Input mechanics: text, dropdowns, rows
10. Stale player, the build stamp, and Preview vs published
11. Driving Studio: open, save, publish, close
12. Adding or refreshing a data source through the browser
13. Measuring what the source cannot state
14. Diagnosing without Monitor: the OData trace and the Monitor export
15. Writing a scenario
16. Screenshots for documentation
17. What browser verification does not prove

---

## 1. Why this is the standard, not a fallback

Several things in Power Apps have no API: opening a Studio edit session, adding or refreshing a data
source, capturing a Monitor trace, and running the app to find out whether a feature works. They
used to be filed as "needs a person at the keyboard". Every one is browser work, and a browser can
be driven. Once that happened, the human step disappeared from all of them - and, more
importantly, **"it compiled" stopped being the last word on whether a feature exists.**

**A canvas app has no test framework. The published app is the test harness**, and the browser is
the only way to reach it. Audits and compiles read the source; only this reads the product.

## 2. Two ways to drive

**The Playwright MCP server** (`browser_navigate`, `browser_snapshot`, `browser_click`,
`browser_type`, `browser_evaluate`, `browser_take_screenshot`, `browser_network_requests`, ...)
is best for looking: an investigation, a one-off check, finding a selector. It shares a browser
across calls, so you can drive step by step and read the accessibility tree as you go.

**The bundled driver** `scripts/canvas-browser.mjs` (Playwright library, Node) is best for
anything that should be **repeatable**: post-ship verification, regression scenarios, a dead-click
sweep across every screen, holding Studio open across separate processes. Scenarios are JSON, so
they are reviewable, diffable and re-runnable.

```
npm i -D playwright                          # once per repo; uses the installed Chrome
npx playwright install chromium              # only if neither Chrome nor Edge is installed; then --channel chromium
node canvas-browser.mjs login                # headed, sign in once (MFA included)
node canvas-browser.mjs check                # is the saved profile still signed in
node canvas-browser.mjs play --fresh         # open the PUBLISHED app on a cleared cache, capture, report console
node canvas-browser.mjs walk scenarios/approve-request.json --trace
node canvas-browser.mjs studio               # open Studio in edit mode and hold it
node canvas-browser.mjs save | publish | close-studio
```

The driver reads the app's identity from `scripts/canvas-app.json` (or `--config`), so no id is
written into the script.

**When the MCP tools are missing.** An MCP server that misses the session's startup window shows
"Connected" in `claude mcp list` while its tools are absent from the session - the tool registry
is built **once, at session start**, so a late server is gone for that whole session. The usual
cause for the Playwright server is a cold `npx`: `npx @playwright/mcp@latest` re-resolves against
the package registry whenever npx's cache entry has expired, measured at 43.8 s cold and 26.5 s on a
second run against a 30 s connect budget (slower behind a TLS-inspecting proxy); a pinned version
started in 4.7 s, 2.3 s warm. Fixes, in order:

- Set `MCP_TIMEOUT=120000` in **user-level** settings (`~/.claude/settings.json`, `env` block) -
  the cause is the machine, so every project needs it.
- Pin the server version instead of `@latest`.
- Recover the current session with `/mcp` (reconnect); failing that, relaunch with
  `claude --continue` to keep the conversation.
- Keep a library-based driver that does not depend on MCP startup at all. Verification must never
  be blocked because a tool server was slow to start.

One project built its library driver as a **long-lived command server**: a headed persistent-context
process exposing `goto`, `snapshot`, `screenshot`, `click`, `fill`, `press`, `eval`, `frames`,
`tabs`, `netstart`/`netget` over a localhost port. It keeps Studio alive between commands, falls
back to the last live tab when one closes, and records `$batch` request and response bodies. The
bundled driver gets the same persistence from `studio` plus CDP reattachment (section 11).

**Parallel agents sharing one browser drive whichever tab is current.** A background agent's bare
`navigate` landed on a Studio tab mid-publish and raised a `beforeunload` prompt; the main session's
next keystrokes went to the other agent's tab. Give each agent its own tab, address tabs by a held
page handle or by URL (never by index, which shifts as tabs open), and re-select before every
action. Brief a background agent on this when it is spawned, not after the first collision.

## 3. Sign-in and the persistent profile

Use a **persistent browser profile** so the tenant sign-in (with MFA) happens once and is reused.
That profile holds live session cookies: keep it **outside the repo** (the driver defaults to
`~/.canvas-browser-profile`) and never commit it. Detect a login page wearing the app's URL
(`login.microsoftonline.com`, an `input[name="loginfmt"]`) and fail with "run login" rather than
asserting against a sign-in form.

- Use the real installed Chrome (`channel: 'chrome'`), `--disable-blink-features=AutomationControlled`
  and `ignoreDefaultArgs: ['--enable-automation']`; some tenant policies treat bundled Chromium or an
  obviously automated browser differently.
- **Try headless first.** On a domain-joined Windows machine, the driver signed in headlessly on its
  first run through Windows SSO, with no interactive MFA (environment-specific). Run
  `check --headless` before asking a person to sign in. The mechanism, observed again on an
  Entra-joined device: the device holds a primary refresh token and the browser hands it to the
  sign-in page - Edge by default, Chrome when the `CloudAPAuthEnabled` policy is set - so even a
  brand-new profile is signed in (`first-run.md` section 6).
- **One profile, one Chrome.** `launchPersistentContext` fails with "Opening in existing browser
  session ... profile is already in use" while another Chrome holds the profile. The usual holder is
  the driver's own `studio` process: releasing the edit lock does not end that process. The bundled
  `close-studio` now quits the held browser after the lock is released (`--keep-browser` to opt
  out). In one case the profile stayed unclaimable with no holder found; deleting `SingletonLock`,
  `SingletonCookie` and `SingletonSocket` did not help. Recreate the profile with `login` (or point
  `--profile` at a new directory) rather than deleting files inside it, and report a check that
  could not run as **unverified** - never as inferred from source.
- **Dismiss Studio's first-run surfaces once.** "Welcome to Power Apps Studio", "Did you know?" and
  the read-only teaching bubble that sits over Override all silently intercept command-bar clicks
  until dismissed. Tick "don't show again" in the persistent profile; the driver clicks "Got it"
  when it finds one.

## 4. Finding the app: it is in an iframe

The top-level player page is only Microsoft's chrome (app launcher, share, account). The app
renders inside an iframe - in some tenants a **cross-origin** one (`runtime-app.powerplatform.com`).
A page-level snapshot describes the toolbar and nothing about your app; every `page.getByText` that
worked yesterday times out.

- Find the frame in `page.frames()` that contains canvas controls
  (`div[data-control-name]`), and locate inside it.
- For a cross-origin frame, click through `page.mouse` using the frame locator's bounding box;
  `frame.evaluate(() => document.body.innerText)` reads a whole screen.
- Studio is the same: the editor runs in an `authoring.*.powerapps.com` frame inside
  `make.powerapps.com`. There may be **two** authoring frames (one a prefetch with no DOM); choose
  the frame that actually **contains** the control you need, not the one whose URL looks right.
  Both frames had `/embed/` in their path in one tenant, so a URL-based exclusion removed the real
  editor.
- **Do not wait for `networkidle`.** The player holds long-poll connections open, so it never
  fires. Wait for a control you expect.

## 5. Snapshot vs screenshot, and the console

The **accessibility snapshot** is the instrument: it names every control, its text and whether it
is enabled. The **screenshot** is the photograph: geometry and appearance. Take both; neither
substitutes for the other - a tab body painted over by a later card passed the snapshot (the
controls existed) and only the screenshot showed a blank panel.

- **A screenshot does not prove the screen finished loading.** One showed a blank modal and every
  control disabled; a snapshot seconds later showed no modal and everything enabled. Wait for a
  control you expect, then read. Never conclude from one frame.
- **"On screen" is three questions**: in the DOM, visible by CSS, and inside the viewport with a
  real box. A canvas app renders every control into the DOM whether or not it is inside the canvas;
  a card at Y=770 on a 768-tall screen was "present" to a count-based check and invisible to every
  human.
- **Read the identifiers in generated selectors.** They carry logical names the UI hides. A portal
  picker once offered two entries with the same label and subtitle; only the logical name in the
  selector showed one belonged to another team's table. When labels collide, never choose by label
  or position - confirm the identifier, then rename one of the objects.
- **A modal scrim cannot be found by size.** The scrim is exactly as large as the screen, so "the
  biggest element" is ambiguous, and paint order is not DOM order. Ask `elementFromPoint` at each
  control's centre; anything under an open scrim is covered on purpose. To **prove** a scrim blocks
  what is behind it, click a control behind it: Playwright's actionability error
  ("`<element>` subtree intercepts pointer events") is the evidence.
- **When a check misreports, dump the raw DOM boxes before changing the check.** One overlap check
  flagged rows the gallery had already scrolled away and missed a modal's scrim; printing the boxes
  first meant the fix rested on what the DOM said, not on a guess.
- **Read the words on every screen.** Two notices still described an older app ("being built" over a
  working feature). Stale static text only looks wrong in the running app; include it in every
  walkthrough.
- **Filter console noise into three buckets**: app errors (count against the verdict), player noise
  (`unload is not allowed`, React unmounted-component warnings, an optional 404) and environment
  noise (`ERR_CERT_*` from a TLS-inspecting proxy, network changes). Report the last separately;
  reporting it as an app fault trains everyone to ignore the console. Some errors look like noise
  and are not: a `RangeError: Maximum call stack size exceeded` was the only evidence of a filtered
  list that came back empty (a modern ComboBox's `Selected` read inside a `Filter` over a
  collection), and OData errors on load naming a retired table reflected real orphaned
  relationships.

## 6. Rules for exercising a feature

1. **Exercise it end to end, as the role that would use it.** A feature is not done because it
   compiled and audited. One approval feature passed every audit and compile while being
   impossible to perform - nothing could move a request to Approved. The standard of proof is the
   loop closing: the request appeared in the approver's queue, Deny stayed disabled until a reason
   was typed, Approve wrote the decision and who made it, and the requester then saw the result.
2. **An admin session proves nothing about a restriction.** The owner passes every gate. Proving a
   gate closes needs a non-admin account; without one, report the restriction as **unverified**.
   For data access, Web API impersonation (`MSCRMCallerID`) answers "can this user read this
   table" without their credentials (`dataverse.md`). Section 8 covers what can be done without a
   second account.
3. **Verify the effect where it lands.** Query the table; do not trust the screen that wrote it.
4. **Every write you make is production data.** Make the change, confirm it in the database, put it
   back, and write down what was touched. Effective-dated tables are worse: a careless correction
   rewrites what past records were worth. Section 8.
5. **Test the empty case.** Point the screen at a user with no rows, or a filter with no results.
   The populated case is the one that gets tested and the one that works.
6. **Cold-load the start screen** (new tab) and read it before touching anything; Studio Preview and
   a warm session hide `OnStart` races.
7. **If a click reports OK and nothing happens, suspect the locator before the app.** See section 9.
8. **Marker presence proves a control exists, not that it works.** A Refresh button that called
   `Select()` on a label with no `OnSelect` shipped and was "verified live" by marker; the queue
   never rebuilt. Perform the task.

## 7. Designing a scenario that can fail

A scenario that would pass whether or not the feature works is worse than none: it is recorded as
evidence. Design each one so the broken version gives a different answer.

- **Perform the control case too.** Test the neighbouring case that should be unaffected: a
  a month-end discount was verified on the last day of the month (10%) and on the next ordinary
  day (0%); a role-scoped list on someone who should see a row and someone who should not. One positive
  case cannot tell a working rule from one that always fires.
- **Choose a fixture on which old and new code disagree.** When a queue moved from one column to
  another, the test row named a different person in each, so its appearance in the new person's
  queue proved the code had moved. Prefer the hardest real case, so the changed path actually runs,
  and confirm any failure sentinel stayed dormant.
- **A search test must target a record that is not row 1.** If the expected row is already first,
  the assertion passes whether or not the filter worked. Pair an `expect` for the searched item with
  an `absent` for an item that would show if the filter did nothing, then repeat searching by a
  different field. Likewise a two-row screen cannot distinguish a broken filter from a working one:
  pick a case whose result an independent Dataverse query predicts, including the rows that must be
  ABSENT.
- **Make never-populated branches exist before calling them working.** Two report sections had never
  had a row, because all live data fell in one bucket. Insert throwaway rows that move counts into
  every section, read the result, then delete them.
- **Seed data must exercise every visual state.** Only 8 of 26 records had child data, so most cards
  read zero and testers filed bugs; demo capacity left every role under capacity, so the
  over-capacity red state never rendered; synthetic emails made every tester resolve to the admin
  persona. Seed deterministically, give every record data, tune values so each state shows, and use
  real identities where routing depends on them.
- **Mark test data, and make it removable by one command.** Tag fixtures (a `[TEST]` prefix or a
  flag), keep them in your own tables (never a shared master), and keep one cleanup command that
  deletes only marked rows. Its faults showed only in use: it missed two tables the seed wrote (not
  reachable by cascade), and its dry-run preview printed "leaving -1". Check the cleanup's table
  coverage against the seed. Seed the awkward cases tidy data hides (two rate rows covering one week,
  an approver who is not the team lead). Never invent a pay rate or a person in a table other apps
  read.
- **A data-empty feature is not a broken feature - prove which.** A grid of zeros was proved to be
  absent data by switching to another measure in the same session and matching the home tile; a tag
  filter returning nothing was correct because the junction table had 0 rows. Before a test round,
  publish a data-completeness note (null vs zero, features that will correctly return nothing) so
  testers do not file empty tables as bugs.
- **Know the data locks before scripting an edit.** The first scripted cell edit timed out on a
  closed period - correct behaviour. Check the lock or calendar state and target the first editable
  cell.
- **Concurrency features need two tabs as two users.** Conflict refusal, "being edited by" banners
  and timer refresh were verified with two tabs on one fixture; the "other user" was simulated
  through the Web API (a different editor id, or a 20-minute-old marker as the control). Record the
  measured delays (a banner appeared 42 s later; a server delete cleared a note 13 s later).
  **Keep the tab under test in front**: browsers throttle timers in background tabs, so a timer test
  in a background tab appears to fail.
- **Reconcile reporting screens against an independent query, to the displayed precision.** Compare
  every number with a Web API or FetchXML aggregate for the same filter, row by row, to the decimal
  shown; check internal consistency (the by-week total equals the by-activity total), and state the
  scopes that could not be exercised.
- **List the input types each feature needs, and check the driver has a verb for each.** Twenty
  scenarios existed and none could change a dropdown, so no test had ever driven a status
  transition - the path where a cancellation changes portfolio totals. Add the verb rather than
  skipping the test.
- **Test the row ceiling with today's data.** To prove a fix for 2,000-row truncation, lower the
  app's data row limit to 150 in an **unsaved** Studio session (or restore it before any publish):
  the failure and the fix both show now, instead of when volume arrives. One fix matched the
  database at both 150 and 2,000.

## 8. Writes, gates and negative tests

- **Change-then-revert pairs.** Write a value through the UI, check the effect out of band in
  Dataverse, then revert it through the UI and check the table is back at its baseline exactly ("0
  rows carrying a value"; to the cent for money). The revert exercises the decrement path, and
  landing on the baseline proves a hand-computed delta is symmetric - the only proof available for a
  rollup table with no key column to filter on. Record the pair in the commit.
- **Declare writes in the scenario.** A scenario that saves sets `"writes": true` and names its
  `"restore"` (the revert scenario, or the steps). The bundled driver's `lint` rejects a writing
  scenario with no restore, and `walk` refuses it without `--allow-writes`. Read-only scenarios -
  navigation, expect/absent, the geometry sweeps - run freely after every ship.
- **Confirm the write in Dataverse on every run, not when someone remembers.** A writing scenario
  carries `confirm` checks (`entitySet`, an OData `filter` that finds exactly the rows it touched,
  `expect` values or `count`, or `absent` for a refusal). After the steps, `walk` reads the rows back
  over the Web API with a token from the app config's `dataverseTokenCommand` and fails the verdict
  unless every check holds and every matched row's `modifiedon` is after the walk started - so a row
  left from an earlier run cannot pass. No token, no URL or no network is CANNOT CONFIRM, never a
  pass. `lint` refuses a scenario that declares `"writes": true` without a check that finds the
  written row. The restore scenario confirms the baseline the same way. Observed on the first real
  run: the screen's "Saved" step failed while the confirmation proved the row was written - the
  banner was outside the app frame (next bullet), not a failed save.
- **`Notify()` banners are drawn by the player, outside the app's frame.** An `expect` that searched
  only the app frame reported "not in the DOM at all" for a success message plainly on screen. The
  bundled driver now searches the player's other frames when the app frame has no match.
- **Fire every guard on purpose and confirm nothing was written.** For each refusal a form
  implements, trigger it in the published app, record the message, and confirm the target row's
  `modifiedon` and any totals are unchanged. Run it on real data in the problem shape, not only a
  fixture. Report a guard the data can never exercise as "live but never observed refusing".
- **A negative test whose gate turns out to be open writes a real row.** Treat every negative test as
  a potential write: declare it as one, park what watches the table, and have the restore ready.
- **A no-change Save proves a write path.** Record `modifiedon` and the lookup GUIDs, press Save
  without changing anything, and confirm `modifiedon` moved while the GUIDs are byte-identical: the
  handler ran and re-resolved the right rows.
- **Park the watching flow for a single hands-on test too.** Before one manual test on real data,
  switch off the flow that would notify someone, run the attempt, switch it back on, and confirm
  nothing unintended was written. If performing a branch would message a real person and cannot be
  parked, record that branch as unproven.
- **Restrictions without a second account.** Script your own in-app admin flag off (or deactivate
  your row in the app's admin roster), give yourself the roster and view-only rows a target user
  would have, perform each restriction in the published player, and restore. This proves canvas
  gates (`Visible`, `DisplayMode`, admin-only screens) **only** - a System Administrator still reads
  every table, so Dataverse privileges still need impersonation or a real non-admin. Write the undo
  before the change.
- **When the agent may not write.** A production-write safety gate may refuse the temporary state a
  restriction test needs (removing the only admin, writing another person's record, a submit that
  would email a manager). Do not route around it: hand the user the single command with what it
  changes and how it is undone, and report the restriction as unverified until it ran.

## 9. Input mechanics

- **Typing a value is not entering it.** A TextInput (and NumberInput) publishes `.Value` on
  **blur**. A driven `fill()` sets the DOM; the app may not hear it until focus leaves. A save then
  writes the OLD value and the screen shows no change - indistinguishable from a broken save.
  **`fill()` then press `Tab`**, and confirm the app agrees (a dependent total or count updating is
  the cheapest proof). Do not use click, select-all, delete and `pressSequentially()`: the box
  shows the text while `.Value` stays blank.
- On a **modern** TextInput the `Tab` is the whole thing: a button gated on
  `Len(Trim(Box.Value)) > 0` stays disabled through `fill()` and enables on blur. Read "disabled"
  as "not committed yet", not "broken guard".
- **`fill()` into a box with content may append rather than replace.** Close and reopen the panel
  for a clean box.
- **A DropDown is a `<select>` with no accessible name, and labels repeat across dropdowns.**
  Address by index, use `selectOption` (it fires `change`, which binds to `OnChange`), and log the
  before/after so the transcript says which field moved.
- **A synthetic click may not open a Classic DropDown's flyout.** A blank-looking picker was left as
  "unverified", not called a defect, because a scripted click would not open it; it later displayed
  normally - a render-timing artifact of the driven session (observed once). Record such cases so
  nobody re-investigates.
- **Click the control, not its caption.** A Button's caption is also a text node; `getByText` can
  hit a spot that is not the hit surface. Prefer role `button`, then the
  `div[data-control-name]` containing the text, then raw text.
- **Choosing the option a ComboBox already holds can leave its list open**, and the open list
  swallows the next click (a row's Open button did nothing, then timed out). Press `Escape` after
  choosing, or check the list closed, before clicking anything else on the screen.
- **`nth` is 0-based, and a gallery keeps every row in the DOM.** After a search narrows a gallery
  to one row, `nth: 1` resolves to a row that exists, is not painted, and swallows the click. After
  a filter, address the row as `nth: 0`.
- **Grid cells often share one accessible name** (every cell reporting "lock"); address by index
  within the frame, and blur to commit.

## 10. Stale player, the build stamp, and Preview vs published

- The player serves a **cached build** and may show a small *"You're using an old version of this
  app"* banner - **late**, seconds after load. Re-check before every assertion; when it appears,
  click its own Refresh, wait for the frame again, and let `OnStart` rerun.
- **Reload with a cache-busting query string** (`...&cb=<timestamp>`) rather than a plain reload, then
  press the banner's own Refresh if it still appears. The new build can also raise a fresh consent or
  sign-in prompt for any connector or embedded report it adds - answer it before asserting.
- **The banner does not always appear, and the cache is in IndexedDB.** The player keeps the app
  package in an IndexedDB database named `PowerApps`, and the persistent profile keeps it across
  browser restarts. Disabling the network cache (CDP `Network.setCacheDisabled`) does not touch it;
  unregistering the service worker and clearing Cache Storage did not force the new build when
  tried; deleting the IndexedDB databases did, with no banner ever shown. Run with the driver's
  `--fresh`, or by hand in the player's frames:

```js
for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
for (const k of await caches.keys()) await caches.delete(k);
for (const d of await indexedDB.databases()) indexedDB.deleteDatabase(d.name);   // includes "PowerApps"
// then reload and allow ~50 s for the app to load from the server
```

  Clearing storage re-triggers the connection consent prompt ("This app will be able to: ...").
  Click Allow, or the app loads half-initialised (the driver accepts it and says so).
- **Publish propagation is slow and variable** - measured from 4 to more than 10 minutes, with a
  success toast and nothing written in between (`canvas-shipping.md`, "The player serves the previous
  build"). **A negative result inside the first ten-plus minutes proves nothing.**
- **The decisive check is the build stamp**: the ship writes a unique id into the packed app; an
  admin-only label renders it; the scenario `expect`s it (top-level `"build"`). Then "the browser is
  on the build I just shipped" is a fact, not a hope. Elapsed time is not evidence; only the stamp
  is. **Reload and repeat before debugging a formula.**
- **A browser session can stick to one back-end node.** Retries kept failing in one session while a
  fresh session succeeded, and one user was always broken while another was always fine; per-session
  schema divergence was the leading explanation (mechanism unverified). Before concluding, retry in a
  fresh browser context.

**Preview and the player answer different questions.** Studio Preview (F5) runs the **saved** app
against live data and live choice metadata, with no CDN - so it cannot give a stale-build false
negative. Use it for "is my code right?" and the player for "what do users get?".

- **Preview shows runtime error banners the published player swallows.** "The requested operation is
  invalid." appeared only in Preview and turned a week-old mystery into a ten-minute diagnosis. Run a
  blank or empty screen in Preview before theorising.
- **Preview cannot see a publish that never landed** (check the publish time, section 11), and
  because it reads live metadata it can **hide** a manifest-cache fault the published app has
  (`manifest-caches.md`). Two "inert" picker filters worked in Preview while the player caught up
  later. Confirm the ship in the player.

## 11. Driving Studio: open, save, publish, close

- **Open in edit mode** as the app owner:
  `https://make.powerapps.com/e/<envId>/canvas/?action=edit&app-id=/providers/Microsoft.PowerApps/apps/<appId>`.
  Studio is slow (allow ~3 minutes) and not usable headless. Wait for the window title to read
  `(Editing)`. `(Read-only)` means an edit lock is stranded (Studio says "This app is read-only
  because you already have editing control elsewhere") - a compile will not persist from there.
  `canvas-shipping.md` covers what releases it.
- **Hold it across processes.** The compile runs in a different process from the browser. Launch
  with a remote-debugging port and reattach over CDP for save, publish and close, rather than
  launching a second browser that knows nothing about the lock.
- **Never navigate or reload** a Studio session holding a push. The push blanks the screen; that is
  the push arriving. If a push leaves Studio blank for minutes (shell present, zero menu items), the
  blank tab cannot save and a reload discards the push: while the push session is still held, open a
  **second tab on the same edit URL** - it joins the held session and renders the pushed document,
  and a Save there landed. Then leave through Back, reopen fresh and confirm.
- **Use real clicks for every Studio command.** A scripted `element.click()` through `evaluate()` on
  Save or Publish returned success, even opened and closed the Publish dialog, and nothing was saved
  or published across three attempts; the identical sequence with Playwright's own click (a trusted
  event after actionability checks) worked first time. Keyboard Ctrl+S works only when the editor
  iframe has focus - a person who has just clicked in the editor - so automation must click Save.
- **Assert focus before typing a formula.** A click at a fixed position meant for the formula bar
  landed on the canvas in a larger window; Ctrl+A then selected all 30 controls on the screen and
  the typed text went nowhere (it could as easily have gone into a control). Click the formula
  editor's `.view-lines` element, then check that `textarea[aria-label="Power fx formula edit field."]`
  is `document.activeElement` before any keystroke, and read the property name and value back after.
- **Locate toolbar buttons by the `aria-label` attribute.** `getByRole('button', {name: 'Publish'})`
  did not match `<button aria-label="Publish (Ctrl+Shift+P)">` (the label carries the shortcut);
  `button[aria-label^="Publish"]` did. The same for Save.
- **Save, then prove the save.** Click `button[aria-label^="Save"]` in the authoring frame, wait
  20-30 s, then open the Save flyout and read **`Saved: <time>`** - it must be the time you clicked.
  The window title, a toast and Preview are not proof. A co-authoring push changes the **session**,
  not Studio's edit buffer, so Studio can decide there is nothing to save: Save does nothing, shows
  nothing, and Preview still shows the change (it lives in the session); a reload then loses it.
  Measured: load, push, Save - saved; load, Preview, push, Save - lost, twice. So **never leave
  Studio in Preview when a push lands**, and before saving, select the changed control and read the
  property back in the formula bar (a Save 30 s after a genuine hold saved the pre-push state; the
  read-back also caught a scripted edit that landed on the wrong control). "Save with version notes"
  greyed out is a second tell that Studio thinks it is clean, but proves nothing alone. The driver's
  `save` reads the stamp before and after and exits non-zero when it did not move.
- **A pushed change can be checked against what Save will write.** `sync_canvas` after a compile
  reads the session that was just pushed to, so it is not independent. Reattach over CDP and read a
  control's rendered box from the designer or tree view in the authoring frame (`[data-testid]`,
  `[title]`, `[aria-label]` plus `getBoundingClientRect`): that is Studio's client model, which is
  what Save persists.
- **Publish** = `button[aria-label^="Publish"]` in the same frame, then the confirm button
  ("Publish this version"). Publish ships whatever was saved when it started.
  - **Publish can be inert in a tab that carried a push.** With real clicks, the dialog opened, the
    confirm was clicked, and nothing published - three times - although the Save had landed. After
    a page reload it published first time. Working order: push, real-click Save, prove the save,
    release the held session, **reload** the Studio tab (accept the `beforeunload` prompt), Publish.
    Safe only because the save already persisted the push; never reorder. (`publish --reload-first`.)
  - **The "Publish successful" toast is not evidence.** It stays pinned showing a PREVIOUS publish's
    timestamp and read as success through three publishes that never landed. For a solution-aware
    app, poll the app's Dataverse row: `canvasapps?$filter=displayname eq '<App>'&$select=lastpublishtime`
    must move past your click. That row moves on Publish, not on Save (measured; an earlier note
    assumed otherwise), so it proves a publish, never a save. The same row settles "is the tracker
    behind the environment".
- **Studio settings are saved-but-not-published too.** A raised data row limit or an added data
  source is invisible to the player and to `pac canvas download` until published. After any Studio
  change, Publish, then confirm from a fresh download.
- **Close through Back.** If the app is in preview, exit preview first (Back does not exist
  there). A "Leave the app?" DOM modal appears in the editor frame, and behind it a native
  `beforeunload` dialog - register a `page.on('dialog')` handler **before** clicking or the click
  hangs. Close Studio **before** any solution import. Releasing the edit lock does not release the
  browser profile (section 3); the driver's `close-studio` quits the held browser afterwards.

## 12. Adding or refreshing a data source through the browser

Same kind of drive: Data pane, Add data, search the table, confirm the **logical name** in the
selector (section 5), then save and publish. What goes wrong:

- **Picking another team's table by label.** An app acquired a sibling app's table, probably by
  accident in Add data. In a shared environment, check every bound source against the app's own
  prefix plus the declared shared layer.
- **The `_1` suffix.** When the name is taken, Studio appends `_1`, so a re-added source can silently
  get a new name and break every screen bound to the old one. Read the name back before pushing.
- **The authoring session does not see it yet.** A new source still reads "isn't recognized" in an
  open co-authoring session until the app is saved and published in Studio **and** the authoring
  session reconnects. A probe compile naming the table is the cheap test.
- **Do not trust the Data pane's error badges after an import.** Ten-plus sources showed "delete and
  re-add"; asking the authoring server for each schema returned full columns for all 36. Probe
  first and re-add only what the probe shows broken - one unnecessary remove/re-add cost a version
  restore.
- **Renames need a full tab close.** After renaming a column or a global choice's labels, a page
  refresh was not enough; formulas naming the member bound only after the browser tab was closed and
  reopened (this also discards any held push).
- **Data-pane Refresh** usually does not refresh the cached column list (in one case it did). Never
  trust it; verify by downloading the published app (`manifest-caches.md`).

## 13. Measuring what the source cannot state

- **Clipped text**: for each leaf text element, a box whose overflow is not `visible`, not a
  scroll container, inside the viewport, and hiding at least one whole line
  (`scrollHeight - clientHeight > lineHeight`) or horizontal overflow (`scrollWidth >
  clientWidth`). Labels' line boxes are always a few px taller; compare hidden lines, not pixels.
- **Dead clicks**: for each focusable control, `document.elementFromPoint(centre)`; anything other
  than the control or its descendant means a user cannot press it. Report what covers it. Modern
  inputs paint over galleries regardless of declaration order (`canvas-layout.md` section 4).
- **Scroll**: does the screen scroll at all? In absolute layout a control below the app height is
  unreachable unless the screen scrolls.
- **Font metrics**: measure rendered width per character from single-line strings, by font size and
  weight, and feed the result back into any static geometry audit. State the unit: the driver
  reports px per char per CSS px, and the equivalent per unit of canvas `Size` (points, x 4/3).

All four are scenario verbs in the bundled driver (`clipcheck`, `deadclick`, `scroll`,
`measurefont`).

## 14. Diagnosing without Monitor: the OData trace and the Monitor export

Monitor (Advanced tools) is greyed out while the app has **live updates** (co-authoring) enabled:
*"Monitoring is not available for this app while live updates is enabled."* Two routes remain.

**The OData trace** - often better: drive the published app and read the network.

- Every Dataverse read goes out as `POST .../api/data/v9.0/$batch`. Each response part carries
  `@odata.context` (the entity set) and `@odata.count`. A capture across one button press tells you
  which tables were queried and how many rows came back.
- **A table missing from the trace entirely** means the query was never issued - a dead source or
  an earlier throw - not a query that returned nothing. That distinction has ended a two-day hunt.
- **A Dataverse failure arrives inside an HTTP 200.** The outer `$batch` status is 200 even when an
  inner call failed; the inner part carries the 4xx/5xx and the error message, and only the
  **request** body says which query it was. Keep both bodies. The driver's `--trace` records inner
  failures with their request; with the MCP tools, `browser_network_requests` then
  `browser_network_request` for each body.

**The Monitor export.** If Monitor is greyed out in Studio, publish, then open Monitor from the
app's details page in the maker portal (environment-dependent; the maker portal's newer Monitor view
was metrics only in one tenant). Capture: play, reproduce, Export. The export
(`PowerAppsTraceEvents.json`) has `Messages[]` with a `category` (`Network`, `Delegation`, ...) and
`logLevel` 4 for errors. The decisive split is **"did a request go out" vs "the formula failed
before any request"**:

- 401/403 on Network events: privileges.
- Every Network event 200/204 while errors are `AppMagic.Data.AppDataSourceError` ("your data source
  is not configured correctly"): those sources never resolved metadata and no query was attempted.
  That rules out connectivity, permissions, data and formulas, and points at the solution not
  shipping those tables (one incident: all 13 shipped tables worked, all 18 unshipped failed).
- No errors at all: it is not the app.

Two incidents were each solved from a trace in minutes after hours of theories. **Ask for the trace
first.** When a control errors and no request leaves the browser, Studio's App checker **Runtime**
tab names the failing property (`Control.Items`) and the Data pane badges that source - check those,
then the network log, then the formula.

## 15. Writing a scenario

```json
{
  "name": "deny-request",
  "description": "Approver denies a submitted request; Deny needs a reason; decision is written.",
  "build": "Build 3f9c2ab",
  "writes": true,
  "restore": "run reopen-request.json, then confirm app_request REQ-0042 is Submitted again",
  "steps": [
    { "click": "Approvals", "settle": 5000, "capture": "01-queue" },
    { "expect": "REQ-0042" },
    { "absent": "REQ-0041" },
    { "click": "Open", "nth": 0 },
    { "absent": "Deny reason required" },
    { "type": "Not enough detail", "into": "Reason" },
    { "click": "Deny", "settle": 6000, "capture": "02-after-deny" },
    { "expect": "Denied" },
    { "deadclick": "approvals" },
    { "clipcheck": "approvals" }
  ]
}
```

Then **verify in the database** that the row moved, and **run the restore**. Keep scenarios in the
repo (`scripts/browser/scenarios/`), name them by the task they prove, keep write/revert pairs
adjacent, and run the read-only ones after every ship. A scenario vocabulary grows around what has
been tested so far - when a new kind of interaction appears (the first dropdown, the first grid
cell), add the verb rather than skipping the test.

## 16. Screenshots for documentation

User guides built from captures of the published app stay true when the app changes (recapture and
re-run, not rewrite), and writing them works as an audit - one guide pass found seven live defects
and a stale date nothing else read.

- **Capture at a fixed size** (one project used 1500x1000) from the **published** app, and record the
  build stamp with the shot list.
- **Capture as the target role.** An admin session shows admin-only controls and banners; label them,
  crop them, or recapture as a non-admin. Decide who sees what from the control's `Visible`
  expression, not from what an admin account shows.
- **Never create live data to make a screenshot look better.** Capture the empty state and describe
  the populated one.
- **Trim the player to the app.** Detect and crop the near-black command bar and the dark-grey
  letterbox by scanning a column clear of centred dialogs for low-saturation dark pixels, then trim
  trailing blank pale rows; fall back to the full frame if detection leaves less than ~200 px. A
  band-cut helper removes a role-only banner from the middle of a screen. Write to a new directory;
  never overwrite the originals.
- **Keep captures out of git.** They carry real colleagues' names.

## 17. What browser verification does not prove

| Check | Proves | Does NOT prove |
|---|---|---|
| the screen rendered | controls exist and formulas bound | that the numbers are current (a `CountRows` in `OnVisible` may have run mid-load) |
| you performed the task | the path works **for you** | that it works for anyone else (section 6, rule 2) |
| a screenshot | what the screen looked like at that instant | that the screen had finished loading |
| the player showed the change | this browser ran some build containing it | which build, unless the stamp was read |
| Studio Preview showed the change | the saved app's code is right against live metadata | that it was published, or that the published manifest can see it |
| a "Publish successful" toast | nothing | that this publish landed (read `lastpublishtime`) |
| a negative result minutes after publish | nothing yet | that the fix fails (stamp, then repeat) |

Report results in those terms: what was performed, as whom, on which build, what the database
showed, what was restored, and what remains unverified.
