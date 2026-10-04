# Setting up a Power Platform repository

## Contents

1. Layout
2. Bootstrapping
3. First session for a new canvas app
4. The harness: hooks and tools, offered at the start
5. Continuity documents
6. Trackers that cannot drift
7. Issue and PR templates, and the dependency register
8. Branches, commits and CI
9. Shipping without pipeline rights, and going live
10. Several apps sharing one environment
11. Keeping the method current
12. Version control on GitHub: offer it at the start

## 1. Layout

```
<project>/
  CLAUDE.md                       project guide: app identity, environments, links to docs
  README.md  CHANGELOG.md  CONTRIBUTING.md
  .claude/
    settings.json                 hook wiring (assets/settings.snippet.json)
    hooks/                        check-pa-yaml.mjs, check-standards.mjs, audit-stop.mjs, preflight.mjs
  canvas/<app>/Src/*.pa.yaml      canvas source (the app)
  solution/src/                   pac solution unpack output (tables, choices, flows, conn refs)
  scripts/
    canvas-app.json               the app's identity, read by every tool (assets/canvas-app.example.json)
    pack.ps1 / import.ps1         plain pack + guarded import (refuses a stale default)
    ship-canvas.(py|ps1)          live-manifest build, reconcile, stamp, assert, import
    audit-all.(py|mjs)            the audit runner (OK / FINDINGS / STALE / SKIPPED)
    dv-query.ps1                  read-only Web API window, resolves entity set names
    entity-specs/*.json           one spec per table, with _why_* keys recording intent
    seed/                         idempotent loaders + CSVs + a README of their conventions
    migrate/NNN-*.ps1             numbered, idempotent, dry-run-by-default migrations
    browser/
      canvas-browser.mjs          (copied from this skill)
      scenarios/*.json            repeatable verifications, named by the task they prove
  docs/
    STATE.md                      current state, next up, pending user actions - read first
    decisions.md                  numbered: what was decided and why
    dependencies.md               components, integrations, who depends on what
    data-model.md  security-roles.md  deployment.md
  out/                            build artifacts, reports, captures (gitignored)
  scratchpad/                     downloads, syncs, captures (gitignored)
```

`.gitignore` must cover `out/`, `scratchpad/`, `node_modules/`, token caches and any browser
profile. Never commit tokens, connection strings, or a browser profile (it holds live session
cookies). Also keep out of git: roster and payroll extracts, source workbooks, pre-purge JSON
backups, and generated documents and reports - screenshots and reports carry colleagues' names.
Record the ignored paths in the document that produces them, so nobody "fixes" the ignore.

Two generated-artifact rules:

- **Do not commit the `.msapp`.** It changes on every ship, a committed copy must be re-synced by
  hand, and a lagging copy ships an old app with nothing to say so. Commit `Src/`, the stable
  sidecars and the `<CanvasApps>` block; the packer rebuilds the `.msapp` every time.
- **Never write build products into `solution/src`.** The packer copies the tree to a staging folder
  and injects the fresh `.msapp` there; a generated file written into source gets committed by the
  next `git add -A`.

**A change that needs schema and UI ships as a numbered script pair.** `migrate/NN-add-x.ps1` writes
the schema (dry-run by default, `-Apply` to write) and prints the manual Studio step that must follow
and why; `migrate/NN-stage-x-ui.py` edits the canvas source and refuses to run until the schema step
has. Every script header states what it creates, why this shape, what it deliberately does not do,
the manual-step order and the impact on any shared schema, and the script closes by printing an
honest count of what it changed. The schema half and the canvas half often ship on different days;
the pair and its header are what let the second half be picked up cold.

`scripts/canvas-app.json` holds everything a tool needs to find the app: environment id, **app
id**, app display name, app logical name, solution id and unique name, and the sign-in hint. Label
the app id clearly - the id in a downloaded app's `Properties.json` is the *document* id, a
different GUID, and `pac canvas download` given it downloads nothing with an error that does not
say why.

## 2. Bootstrapping

Before the first command, offer version control on GitHub (section 12): what it is, why it matters
here, and personal against organisation accounts. A local repository comes first either way.

```
git init -b main
pac auth create --environment <url>          # then: pac org who
pac solution export --name <Solution> --path out/probe.zip
pac solution unpack --zipfile out/probe.zip --folder solution/src --packagetype Unmanaged --allowDelete true
pac canvas download --name <app id GUID> --file-name out/live.msapp
pac canvas unpack --msapp out/live.msapp --sources canvas/<app>     # or extract Src/ from the msapp
npm i -D playwright
node scripts/browser/canvas-browser.mjs login
```

Then offer and install the harness (section 4: `setup-harness.mjs`, plan first), and run each
hook once by hand to see it pass on a clean tree and fail on a seeded fault.

Bootstrap traps:

- **`pac canvas download --name` wants the app id GUID.** Given the logical name it answers "No
  canvas apps in the selected environment", which reads like a deleted app; a display name can
  resolve to the wrong app when names repeat.
- **`pac canvas unpack` refuses old packages** ("MSAppStructureVersion 2.0 is below the minimum
  supported version 2.4.0"). To bring such an app into git, open and re-save it in current Studio.
  To read a legacy app only as a specification, unzip the `.msapp` and read the JSON - it is not
  corrupt.
- **`--allowDelete true` on unpack** when syncing, or components removed live stay in
  `solution/src` forever.
- **A managed zip cannot be packed from an unmanaged unpack** ("Solution package type did not match
  requested type"). Either export the managed build from the environment (`pac solution export
  --managed true`), or unpack with `--packagetype Both` so the tree can produce either (general pac
  behaviour, not exercised in the projects behind this skill).
- **`pac canvas validate` is retired**, and `pac canvas pack` may refuse an app "until validated by
  opening it for edit in Studio". There is no headless compile: a live Studio session is the only
  formula validator, so a stranded edit lock means stop shipping canvas, not ship unverified.

**Measure the environment before planning on beliefs about it.** Notes said legacy tables lived in
another environment; they were in the same one, with production data. Lists slated for migration
were already virtual tables, and a planned table already existed. Inventory live tables, columns and
solutions before proposing schema, snapshot live schema to JSON, and let the measured section of an
assessment supersede sections written from repos and exports.

**State the real ALM direction honestly.** In one project tables were authored in a JSON manifest and
applied to live by script, and `solution/src` held no entity definitions until a sync pulled them
back. Write down "`solution/src` is a mirror of live" rather than claim offline-first, run the sync
after every schema change, and record that the repo cannot yet rebuild the environment.

Source control for neighbouring platforms, when a repo grows a reporting layer: save Power BI as
PBIP (report JSON, model as TMDL - diffable), parameterise connections per stage, and record RLS,
refresh and gateway configuration in the dependency register. For Excel, version the logic (Office
Scripts `.ts`, Power Query `.m`, exported VBA) rather than the binary workbook.

## 3. First session for a new canvas app

**Take the theme before the first screen.** Every organisation, and often every project, has its
own look: a palette (and colours it must not use), fonts, a logo, imagery, icons and symbols with
meaning, a landing page people expect, a tone. Asked for after ten screens, it is a rebuild; asked
for now, it is one file. Ask, and record the answers in `canvas/theme.json`
(`assets/templates/theme.json`) before writing a screen:

| Ask | Record |
|---|---|
| Palette: primary, secondary, accent, the semantic colours (success, warning, error, info), and any colour the brand forbids | role-named tokens with their RGBA and purpose (`clrPrimary`, `clrTextMuted`, `clrError` - never `clrBlue`) |
| Fonts, and the type scale (caption, body, titles, figures) | a font token and the sizes |
| Logo, imagery, illustration style; who owns them and the licence | file names, where they live, the source |
| Iconography and symbolism: icons or marks that carry meaning (safety, status, a programme's emblem), and any to avoid | the icon set and the meanings |
| The landing / home page: what a person must see first, per role | the home screen's sections, in order |
| Tone of labels and messages | one line ("plain, instructional"), plus words to use or avoid |
| Accessibility: contrast target, minimum text size | e.g. WCAG AA 4.5:1, nothing below Size 9 |
| Light, dark, or both; the supported screen size | the mode(s) and the design surface (e.g. 1366x768) |

If nobody can answer yet, record an interim palette and mark the theme **interim** with what is
pending: the app is built on tokens either way, so the brand arrives as a change to one file, not to
every screen. Then define the tokens in `App.pa.yaml` and reference only them from screens
(`references/canvas-layout.md`, section 10); `check-canvas-format.mjs` fails a screen that uses a
literal colour or font. Respect the organisation's own palette and restrictions; the skill prescribes
neither.

**Ask the same way about lists, messages and documents** - three things that are cheap at the
design stage and a rework after go-live:

| Ask | Default when nobody says |
|---|---|
| For each gallery, list or menu: which columns do people scan it by; search; sort; is it categorised? | a filter per choice or lookup column people scan by (empty means All), a name search, a stated sort, section headers for categorised reference data, a row count (`canvas-controls-and-patterns.md` section 16) |
| Does the app send messages? To whom, on what event, by which channel? | every send logged, "last sent" shown per item, a history for administrators and owners, a Resend button (`power-automate.md` section 16) |
| Do records carry documents? Linked, stored, or generated from a template? | offer all three; generated documents from an HTML template with a placeholder list shared by flow and app, and a template guide with a live preview for administrators (`power-automate.md` section 17) |

Record the answers in the spec; `check-canvas-format.mjs` warns on a table gallery that offers no
filter, search or grouping.

pac and `.pa.yaml` can edit and ship an app but cannot create one. Do this once, in Studio, before
the first screen:

1. **Create the app in Studio with the form factor the layout assumes** (for example tablet
   1366x768). Absolute layout does not reflow; state the supported size in the app's guide.
2. **Save it into the solution**, not as a loose app. An app created outside a solution has no row in
   the `canvasapps` table, cannot be a solution component, cannot use the unattended import path,
   does not travel to another environment, and has nowhere to carry a build stamp. Moving it into a
   solution once it is live is an owner decision; decide it at project start. Query `canvasapps`
   before planning a ship path.
3. **Record its id** in `scripts/canvas-app.json`.
4. **Turn on modern controls** (Settings > Updates or Display). The manifest reads
   `fluentv9controls: false` when off, and every modern control name then fails to bind. Turning it
   on changes default properties: free on a blank app, a re-style after ten screens. Check this flag
   in a downloaded `.msapp` before following any guide that prescribes modern controls.
5. **Turn on collaborative editing** (Settings > Updates > Preview) if you will use the co-authoring
   path. `connect` fails with "Coauthoring is not enabled for this app" until it is on **and** the
   app has been saved and reopened. Several settings take effect only after save, close and reopen;
   re-check this one after toggling others. There is no API for it.
6. **Publish**, then confirm from a fresh download. Studio settings (a raised row limit, an added
   data source) are saved-but-unpublished until you do.

## 4. The harness: hooks and tools, offered at the start

The method only stays fast when the checks run themselves. In the builds behind this skill the
same harness was copied into every project by hand - hooks that refused compile-killers at write
time, a client that pushed to Studio and held the session, a token that never prompted, an order
check after every publish, owner scripts for anything destructive - and every project that lacked
a piece paid for it again. **Offer the harness at the start of every project**, say what it adds in
one line per group, and install it when the person agrees:

```sh
node <skill>/scripts/setup-harness.mjs <project>            # plan: every file it would add or merge
node <skill>/scripts/setup-harness.mjs <project> --apply    # install; re-run any time, it is idempotent
```

| Group | Installs | Why it pays |
|---|---|---|
| hooks | the six hooks below into `.claude/hooks/`, wired in `.claude/settings.json` with `$CLAUDE_PROJECT_DIR` | compile-killers, clipped text, overlaps, accessibility and palette are caught on the write that caused them, not at the next ship |
| tools | `canvas-mcp.py`, `ship-canvas.py` (+ `inspect-artifact.py`), `check-published-order.py`, `canvas-browser.mjs`, `contract-to-walk.mjs`, `deploy-tables.py`, `check-drift.py`, `lint-flows.mjs`, `flow-runs.py`, `audit-pages-permissions.py`, `dv-token.ps1` into `scripts/` | the ship, verify and data loop as one command each, with refusals instead of silent passes |
| config | `standards.config.json`, `canvas-app.json`, `selectors.json` (copied once; the project owns them after) | one statement of the app's identity that every tool reads |
| docs | `STATE.md`, `decisions.md`, `dependencies.md`, `acceptance-contract.md`, and the owner cleanup script template | the session-start context and the owner-step pattern |

It never overwrites a file that differs from the skill's copy (it reports it; `--force` replaces
it), never removes anything, merges hook wiring and permissions into an existing
`settings.json`, appends the build folders to `.gitignore`, and records the skill version in
`.claude/hooks/harness.json`. The pre-flight hook compares that version with the latest release at
most once a day and, when a newer one exists, tells the agent to offer the update and re-run the
plan. After installing: fill `scripts/canvas-app.json` (including `login`, section 13 of
`first-run.md`), set the shared prefixes, run each hook once by hand, and restart the session so
Claude Code loads the hooks.

Two patterns the harness supports but cannot install, because they are written per project:

- **Generate screens from code.** For an app of more than a few screens, write the `.pa.yaml` from
  a small generator (Python functions that emit a control with its properties, a layout helper for
  the phone and desktop geometry, one module per screen) and never hand-edit the output. A rename,
  a palette change or a new phone rule is then one edit and one regeneration, and the hooks check
  the generated files exactly as they would hand-written ones. Keep removed controls in the
  generator (hidden) for one push when a co-authoring push would delete them
  (`canvas-shipping.md` section 4).
- **Owner scripts for anything destructive.** The template in `assets/templates/owner-cleanup.ps1`
  lists by default, deletes only with `-Apply`, refuses tables outside the app's own prefix, and
  is handed over as one `!` line (`tooling-and-auth.md` section 6).

### The hooks

| Hook | Event | Does |
|---|---|---|
| `preflight.mjs` | SessionStart | Prints branch and dirty state, unpushed commits, `pac org who`, and the top of `docs/STATE.md`. Never blocks. |
| `check-pa-yaml.mjs` | PostToolUse Write/Edit | On `.pa.yaml` only: colon-space in a single-line Power Fx value, YAML comments, `Tooltip` on a modern Button, file-count ceiling, block-scalar continuation indented shallower than its block. Exit 2 feeds the problem back so it is fixed in the same turn. |
| `check-standards.mjs` | PostToolUse Write/Edit | Optional, configurable output standards (by default: no emoji, no purple/violet accent colours in UI and docs). Turn off or edit `standards.config.json` to taste. |
| `check-canvas-format.mjs --hook` | PostToolUse Write/Edit | On a screen `.pa.yaml`: text with too little contrast and captions that clip (block), inputs and click targets with no accessible name (note), a data-bound label whose text can overflow its box with no remedy, a clamp whose full text is unreachable, scroll inside a gallery row, and literal colours or fonts once the app defines theme tokens (`references/canvas-layout.md`, sections 6, 8 and 10). Blocks only on known lengths: set `textFitSchema` in `standards.config.json`. Copy it from the skill's `scripts/`, not `scripts/hooks/`. |
| `check-canvas-overlap.mjs --hook` | PostToolUse Write/Edit | On a screen `.pa.yaml`: controls drawn over other controls under conditions that can both hold, dead clicks behind decoration, controls outside their gallery row. |
| `shared-guard.mjs` | PostToolUse Write/Edit | When an edit names a table with a shared prefix (`shared.prefixes` in `standards.config.json`), a non-blocking reminder to record the change in the shared registry and sync log (`shared-environments.md`). Silent otherwise. |
| `audit-stop.mjs` | Stop | Repo-wide standards scan, leftover debug markers, file ceiling, and bookkeeping reminders (solution changed without the dependency register or state file; commits today without a changelog entry). Blocks once on findings, never loops. |

Keep hooks **narrow**: only things known to break, never style. Exempt a line with a
`standards-ignore` marker in a comment.

Wiring rules that decide whether a hook runs at all:

- **Anchor every hook command on `$CLAUDE_PROJECT_DIR`.** `node .claude/hooks/x.mjs` resolves
  against the current directory; once a session works from a subfolder (a compile leaves the shell
  in `Src`), the hook silently stops running, which is indistinguishable from a clean result. Use
  `node "$CLAUDE_PROJECT_DIR/.claude/hooks/x.mjs"`.
- **Open the project folder, not its parent.** Project hooks and `CLAUDE.md` load from the folder
  Claude Code was opened in; opening an umbrella folder silently skips every guard.
- **Every hook is runnable by hand** by piping JSON:
  `echo '{"tool_input":{"file_path":"canvas/app/Src/Home.pa.yaml"}}' | node .claude/hooks/check-pa-yaml.mjs`.
- **A SessionStart hook should not shell out to another runtime.** A pre-flight that calls Python
  gets disabled the first time Python is missing. Report the canvas file count against the ceiling
  and the age of cached audit inputs with a crude mtime check in the hook's own language; the
  precise answer is one command away.

Design rules for write-time hooks:

- **Two tiers: BLOCK and NOTE.** Block compile killers and paid-for rules; emit a non-blocking note
  (`additionalContext`) for real but non-fatal issues - YAML comments existed on 177 lines across 27
  files in one app, and a rule that blocks every existing file gets switched off. Prove a hook red on
  a crafted file with one of each fault **and** green on every existing file; the second half
  decides whether it survives.
- **A comment line legitimately ends a block scalar.** Section-banner comments written at control
  indent (`# ---- TAB ----`) end the block just as a key does; treating them as formula
  continuations blocked every edit to a screen that compiled clean. Skip comment lines and keep
  scanning.
- **Graduate the file-ceiling check:** a note from about 25 files, block from 45, refuse over 50, so
  growth is a conversation long before it is a crisis.
- **Stop hooks fire every turn**: keep them non-blocking reminders unless a finding is serious, fire
  only when the project tree changed, and decide "touched X" from added diff lines, not from files
  that merely mention it.

## 5. Continuity documents

Power Platform work spans sessions, people and environments, and the platform keeps almost no
history of why. These files are what make the next session start from a known state:

- **`docs/STATE.md`** - a short, current snapshot: what is live (build stamp), what is in flight,
  what is next, what is waiting on a person (consent for a connection, a non-admin tester). The
  pre-flight hook prints its top lines. Update it before ending a session. When saved and published
  diverge (a push saved but not published), say so in a banner at the top.
- **`docs/decisions.md`** - numbered decisions with the reason. "Why is this a full-screen overlay
  instead of a screen?" should have an answer (the file ceiling). When a later measurement changes a
  decision, amend it in place with the re-measurement rather than deleting it - one ship path was
  retired on a correct measurement and re-adopted days later when the same instrument said otherwise.
- **`docs/dependencies.md`** - every table, flow, connection reference, shared component and
  external integration, and what depends on it. Consult before a change; update with it (section 7).
- **`CHANGELOG.md`** - dated, plain-English entries; it doubles as the raw material for status
  reports.
- **A risks file** when something is known and unresolved ("nothing in the app has been verified
  by a non-admin").
- **A human-steps runbook** in dependency order: every step only a person can do (interactive
  sign-in, connection consent, creating the app, Studio-only settings, licences, decisions), each
  numbered, marked person or agent, saying what it unblocks, ending with a "blocked on right now"
  table. These items carry forward into every report until done.
- **A feedback triage file.** Put all tester feedback in one place, label each diagnosis CONFIRMED
  (checked against live data or source in the same session) or UNVERIFIED, and look for common
  causes first - 24 items once resolved to three root causes, and five findings explained thirteen
  of twenty-two in a demo. Reported "duplicates" were two people sharing a name; "copy is broken" was
  a reused, wrong message. Fix data before testing behaviour that depends on it.
- **A data-completeness note before every test round**: null vs zero and populated counts per
  column, and which features are correct but will show nothing yet, so testers do not file empty
  tables as bugs. A gate nobody has ever exercised is untested by construction - say so.

Update these **in the same change** as the work. The stop hook reminds you. When quoting Power Fx
in a markdown table, escape the pipes (`\|\|`) or move the formula out of the table: an unescaped
`||` splits the row into extra cells and the table renders broken.

**Record what a theory is NOT.** Incidents in these projects followed one pattern: every theory was
plausible and wrong, every measurement decisive and cheap. A stale-cache explanation was asserted
twice and wrong both times. Write eliminated causes into the commit message or the decision with the
measurement that eliminated them, leave a root cause "not proven" with the next instrument named
rather than closing on a guess, and record a correlation as a correlation. When a theory is
disproved, retire it completely: roll back the change it motivated, delete any check written to
enforce it, and rewrite any standard that repeated it.

## 6. Trackers that cannot drift

Trackers drift, and a stale tracker does real damage: one register said twenty-odd items were open
when four were; another listed four items "not started" that were built; an autonomous loop acted on
a stale "next" list and redid shipped work.

- **One line per item, a stable never-reused id**, separate id series for build work and human-only
  work (numbered to match the runbook steps). Owner tags (agent / human / both). Statuses Open / In
  progress / Blocked / Done / Dropped; every Blocked line names its blocker. Closed items record the
  evidence (what was performed, where).
- **The checkbox is the record.** Twice in one day a hand-written "DONE: ..." summary sat above
  checkboxes nobody ticked: 15 items read open when 12 had shipped, and one line naming four
  deliverables (three built) made an unstarted phase read nearly done. A summary may restate the
  checkboxes, never replace them. Split an item that names several deliverables. Keep exactly one
  "resume here" marker.
- **Name one file as the status authority** and reconcile the others against it before any report;
  recompute status from the items at session close. A status line in the project guide that outlives
  its subject is the same defect - correct it in the change that makes it false.
- **Verify queued work against the environment before starting it.** Check the done-log and the live
  app first; make "next" sections pointers into the tracker, not copies of it.
- **The count in a done-note is a claim.** "All 9 converted" was the number converted, not the
  number that existed (12). Enumerate mechanically (every control matching a pattern, read its
  type), not by re-reading a diff.
- **Measure "feature-complete" against the source** with a coverage table: what the design names,
  what is built, what is loaded. One such table showed half a project complete and the other half
  (the half the project was named after) not started, hidden by one stale backlog line.
- **Check the data before building.** An "only mine" default, a role-permission matrix and a tag
  filter were all built correctly and inert, because the ownership columns and roster were nearly
  empty. A live count before building changes what the item is; record the data load that releases
  it. Equally, before dropping designed work as unused, check whether the *function* moved - a list
  named for a process was empty because the process lived in a different list.

When several repos are worked together, keep one umbrella backlog beside the per-project state
files: per project, newest first, the work performed in each session and what remains, with pointers
into the project's own tracker. It is what a new session reads to pick up multi-repo work.

## 7. Issue and PR templates, and the dependency register

Three issue templates have worked across projects:

- **Component**: type, module, proposed logical name, purpose, draft definition, depends-on and
  depended-on-by; acceptance: packs cleanly, spec written, register updated.
- **Change request**: current vs desired behaviour, impact analysis copied from the dependency
  register; acceptance: dependent forms, views, flows, roles and reports verified.
- **Bug report**: steps, expected, actual, environment, affected component, suspected dependencies.

The PR template's checklist: dependency register updated for any table, relationship or flow
change; solution version bumped if this ships to a shared environment; verification performed in
the running product (imported and exercised, not "it packs"). A per-component spec file
(`docs/components/<name>.md`) mirrors its dependencies into the register.

The dependency register (`assets/templates/dependencies.md`) earns its keep through sections that
are easy to omit:

- data sources and connections, with the auth source and the **connection owner** (never the
  values) - a person's connection is a single point of failure;
- automations, with the tables, columns and literal names each reads (a FetchXML `link-entity`
  chain or a flow keyed on a row's display name breaks at run time when another team renames it);
- external integrations: direction, mechanism, owner - including Power BI hand-off links, which
  address a workspace and report by id and break silently when the workspace moves;
- model-driven forms and views, which block column deletes and are a write path that bypasses canvas
  gates (`model-driven-and-docs.md`);
- a change-impact checklist to walk on any shared change: UI that shows or edits it;
  views, queries, filters and measures; automations that read or write it; calculated logic; access
  and permissions; downstream reports and exports.

Generate the parts that can be generated (the flow table, from the flow definitions, with a
`--check` mode in the audit suite) - a hand-written flow table once listed six invented flows while
eleven real ones ran.

## 8. Branches, commits and CI

- **Push early.** A long branch with dozens of commits existed on one machine only. Push at least at
  each session close.
- **Push history with git, not a file API.** An initial upload through a GitHub API or MCP file push
  creates remote commits that share no history with the local repo, so the next `git push` is
  rejected. If it has happened: push the working branch, merge the stale remote root with
  `git merge -s ours --allow-unrelated-histories`, then fast-forward - no force push needed.
  An equally valid recovery: `git reset --soft origin/<branch>` moves the branch pointer onto the
  remote while keeping your working tree; commit the staged difference and push normally. It
  collapses the local commits into one, so use it when that local history need not be kept.
- **Commit messages carry the evidence**: what was performed to verify, which causes were
  eliminated, and the shipped/unshipped boundary when a session ends mid-ship.
- **Scripted bulk edits assert their occurrence counts** before applying, and assert what they must
  not match; restore from git and re-run a broken scripted edit rather than patching forward.
- **Port a cross-project fix as a commit in each sibling repo**, with that repo's own fixture, rather
  than as an action item in a shared log - the log then records what happened, not what someone
  still has to do.
- **Bump the solution version on every delivery.** Building from an environment export carries the
  live version forward, so a good and a broken build become indistinguishable by version.
- **CI packs the solution on every pull request**: cheap proof the unpacked source still builds.
  Fail on pac's silent-skip warnings ("unexpected children", "root components are not defined in
  customizations"). The generic installer action did not reliably put `pac` on PATH ("command not
  found"); the pack-solution wrapper action did. `pac solution check` is the cloud Solution Checker
  step.
- **Environment values**: commit connection reference and environment variable definitions, and
  supply values at import with a settings file from `pac solution create-settings`.

## 9. Shipping without pipeline rights, and going live

A maker who holds System Customizer on the target environment but no pipeline or tenant rights can
still ship: build the zip from git, self-import it (`pac solution import`, or Solutions > Import),
or hand the zip to IT for higher environments. Worth stating early, because it decides the ALM
design for most departmental makers. Bump `<Version>` in `Solution.xml` per release and record it in
the changelog.

**Cut over at a period boundary; never run two apps on one database** as a parallel run
(`data-migration.md` section 9).

Licences are a deployment dependency with lead time - see `model-driven-and-docs.md`.

## 10. Several apps sharing one environment

When more than one app lives in an environment and shares reference tables, the shared layer needs
an owner, a registry, a change protocol and a sync log. That is now its own reference:
`shared-environments.md`.

## 11. Keeping the method current

Write a lesson down where the next person will look. Apply one test to every lesson: **would another
project here hit this?** Yes - the shared standards; no - the project's docs; both - the rule in the
shared standards and the specifics locally, with a link. The absence of that test let two projects
pay for the same canvas traps twice.

- **Put the shared standards folder under git from day one.** One shared framework sat as plain
  synced files for five to seven weeks with no history; nothing could show it had gone stale, and a
  note in it ("canvas is designer-authored") outlived reality. A `.git` written from two machines
  through a file-sync service can corrupt - give it a remote.
- **A project's local copy of a shared standard drifts, then contradicts it.** One forked standard
  predated a "verify in the running product" step added to the shared one, and argued against the
  portfolio on exactly that point. Mark local copies with their source and the rule "if the two
  disagree the shared file wins; if the local one is right, fix the shared one", and re-sync them in
  reviews.
- **Correct a standard in the same change that makes it false**; a standards file is only worth
  reading if it is true.

## 12. Version control on GitHub: offer it at the start

**Offer this once, when a project starts, and let the person choose.** Many Power Platform makers
have never used source control; the platform does not require it. Explain it in plain words, give
the options below, and record the answer in the project's state file. If they decline, keep a local
git repository anyway (`git init` costs nothing, and the hooks and evidence trail rely on it) and
offer the remote again at the next release.

### What to tell them

- **Git** records every change to the project's files - what changed, who changed it, when and
  why - and can bring back any earlier state. **GitHub** keeps that history on a server rather than
  on one laptop, and adds sharing, reviews, issue tracking, release pages and automated checks.
- **Why it matters for Power Platform in particular:**
  - Studio's own version history covers one canvas app, and only in that environment. A flow, a
    table, a role or a setting has no history at all. In git, the whole app has one history.
  - A bad import or a broken formula can be rolled back to a known build, and the difference
    between the two is readable line by line.
  - The agent's work becomes reviewable. Every change it makes is a commit a person can read,
    question or revert, and the commit message carries the evidence of what was verified.
  - If the laptop is lost, the project survives. One team here had dozens of commits that existed
    on a single machine.
  - It is what "the repo is the source of truth" (core rule 1) stands on.

### Which account: personal or the organisation's

| Situation | Use | Notes |
|---|---|---|
| Work for an employer | **The organisation's GitHub** (GitHub Enterprise Cloud, Enterprise Server, or an organisation on github.com) | The work belongs to the employer. Ask who administers it, and request a repository or the right to create one. |
| Enterprise Managed Users (accounts named like `name_company`) | The managed account only | It cannot create public repositories or push outside the enterprise. Sign the CLI in with that account. |
| The organisation uses Azure DevOps Repos or GitLab | That | Everything here applies except the `gh` commands. |
| Personal or learning projects, or a public, anonymised tool | A personal github.com account | Never put an employer's app, data, tenant details or people's names in a public repository. |

Organisation repositories usually sit behind single sign-on: after `gh auth login` the CLI may
need to be authorised for that organisation (the CLI prints the link). Enterprise Server has its own
host name: `gh auth login --hostname github.<company>.com`.

### Setting it up

```text
winget install --id Git.Git -e          # macOS: brew install git gh
winget install --id GitHub.cli -e
gh auth login                           # choose GitHub.com or the Enterprise host; sign in in the browser
git config user.name  "<Name>"          # REPO-LOCAL, before the first commit (see below)
git config user.email "<address the account uses>"
gh repo create <owner>/<name> --private --source . --push
```

- **No administrator rights?** The `winget` package is an installer that needs elevation; on a
  locked-down work machine it fails with "You cancelled the installation" (1602). The CLI also ships
  as a zip: download `gh_<version>_windows_amd64.zip` from the cli/cli releases page, extract it
  under `%LOCALAPPDATA%\Programs\gh`, and add its `bin` folder to the user PATH. No elevation needed.
- **Sign-in from inside an agent session**: `gh auth login --web` prints a one-time code and waits
  for the browser. Run in the foreground through a command prefix, it is moved to the background
  after the time limit and the code is never seen, so the wait times out. Have the agent start it
  as a background command, read the code from its output, and give the person the code and
  https://github.com/login/device.
- **Private by default.** Make a repository public only on purpose, and only after checking it holds
  nothing from the organisation.
- **Never commit secrets** (tokens, client secrets, connection values) or exported rows of real
  data. Environment URLs and ids are acceptable in a private repository and never in a public one.
  The `.gitignore` from the bootstrap excludes `out/`, browser profiles and token caches.
- **Set the commit identity per repository.** A machine's global git identity is usually the work
  address. A personal or public repository then publishes the work address in every commit, and
  removing it later means rewriting history and force-pushing, which is the person's decision. Set
  `user.name` and `user.email` in the repository before the first commit, and check
  `git log -1 --format=%ae` after it.
- **What the agent may do.** Allow by rule `git status`, `git diff`, `git log` and committing.
  Pushing to a private repository can be allowed per project. A force push or a history rewrite is
  always the person's step.

### Versions and releases

Tag each delivery to match the solution version (`git tag v1.4.0`) and keep a `CHANGELOG.md`.
`gh release create v1.4.0 --title 1.4.0 --notes-file <notes>` publishes a release page, and the
built solution zip can be attached to it, so "what is in production" has one answer.
