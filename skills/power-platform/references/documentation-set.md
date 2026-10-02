# The documentation set: four guides for a finished app

## Contents

1. When to offer it
2. The four guides and who they are for
3. Chapter skeletons
4. Writing rules
5. Screenshots by role
6. Building, rendering and checking
7. Definition of done

The method behind generating guides from the running product (why, and how the screenshots are
trimmed) is in `model-driven-and-docs.md` sections 3 and 4. This file is the standard set and its
structure. The kit is `assets/doc-kit/`: `doc_kit.py` (formatting, trim, inventory),
`build_guides_example.py` (the four skeletons, words only), `shots.example.json` (the shot list).

---

## 1. When to offer it

**Offer the set once the app works** - after the first end-to-end task has been performed in the
published app as each role, and before go-live. Say what it is in one line ("a user guide per role,
a manager guide, an administrator guide and a developer and platform guide, generated from the app
itself"), and let the developer pick which ones. Offer it again at each major release: the guides
are rebuilt from scripts, so an update is a re-run plus the changed chapters, not a rewrite.

Do not write them earlier. A guide written before the app settles describes an app that no longer
exists by go-live.

## 2. The four guides and who they are for

| Guide | Reader | Style | Built from |
|---|---|---|---|
| **User** (one per user role if their tasks differ) | Someone who has never seen the app | Standard operating procedure: one chapter per task, numbered steps, a figure per screen, "what happens next" | The published app as that role; the control labels in `.pa.yaml` |
| **Manager** | People who approve, assign or oversee | Tasks plus oversight: the team view, decisions, follow-up, messages they receive | The published app as a manager; flow definitions for what they are sent |
| **Administrator** | People who configure the app from inside it | Reference plus procedures: each admin screen tab by tab, reference data, templates, settings, resend and history, routine tasks, limits | The admin screens' source, the settings rows, the template placeholder list |
| **Developer and platform** | The next developer, and the platform administrator | Exhaustive handover: everything needed to run, change, release and hand over | The repository, the solution, the live environment read on a stated date |

Chapters that two guides share (opening the app, who sees what, messages, glossary) are written
once and called from both (section 4).

## 3. Chapter skeletons

`build_guides_example.py` holds each skeleton as runnable code. In outline:

**User guide**: opening the app; one chapter per task, named as a verb ("Raise a request"); statuses
and what they mean; messages the app sends and how to get one resent; glossary; getting help.

**Manager guide**: opening the app; the team's work at a glance; approving, rejecting and
reassigning; following up (overdue, blocked, history); messages; what each role can see; glossary;
getting help.

**Administrator guide**: how the app decides who is an administrator; what each role can see; the
administration screens tab by tab; reference data, lists and settings (each setting's meaning,
values and the safe value); writing message and document templates (placeholders, meaning and value
when blank, syntax, allowed formatting, a worked example, the in-app preview); communications
history and resend; routine tasks; known limitations; glossary.

**Developer and platform guide**:

1. About this guide (scope, the commit and live-read date it describes, how to regenerate it)
2. The environment and the solution (name, type, URL, solution, publisher, prefix, neighbours)
3. Architecture (app, tables, flows, connectors, external systems, a diagram)
4. Dataverse tables (purpose, key columns, choices with their values, relationships, delete
   behaviour, expected growth)
5. Security roles and data access (each role's privilege matrix, how it is applied outside the
   solution, how it was proved by impersonation)
6. Giving someone access (licence, role, app share, team membership, in order)
7. Sharing and licensing (per role; premium connectors; capacity)
8. Connections and connection references (each reference, its connector, whose connection, the
   deployment settings file)
9. Cloud flows (each flow: trigger table, message, filtering attributes and condition; what it
   writes and sends; the loop analysis from `lint-flows.mjs --verbose`; the safety switches)
10. Theme and design elements (the `theme.json` tokens, fonts, icons, imagery, layout grid, the
    text-fit rule, accessibility)
11. What happens when the app opens (`App.OnStart` or Named Formulas, collections, role resolution)
12. The main screens in detail (data sources, filters, galleries, write handlers, gates)
13. A record from start to finish (each status, who moves it, which flow fires, what is sent)
14. Changing and releasing the app (branching, build, artifact checks, import, publish, build
    stamp, rollback)
15. Running it day to day (flow failures, resend, data growth, scheduled jobs and their switches)
16. Rules and traps (each with the incident behind it)
17. The repository (folder map, scripts and what each proves, audits, hooks)
18. Known gaps for the next developer

## 4. Writing rules

- **Every statement is read from the source or the live environment**, never from memory or intent.
  Button names, tab names and messages are the controls' own text, quoted exactly. Who sees what
  comes from each control's `Visible` and `DisplayMode` and the live roles, not from what an admin
  account happens to show. Settings and their values are read from the live rows on a stated date.
- **No logical names in the user, manager or administrator guides** (no `app_status`, no entity set
  names). The developer guide uses them, next to the display names.
- **Shared chapters are written once**, as functions taking the document and the chapter number,
  and called from every guide that needs them. Two copies of "how resend works" will disagree within
  a release.
- **The cover carries the version, the issue date and the build stamp** the screenshots were taken
  on. A guide that cannot be matched to a build cannot be trusted.
- **The guide's words match the in-app help.** An in-app template guide or glossary and the
  administrator guide say the same thing; when one changes, change both in the same commit.
- **Describe the populated state honestly.** Never create production data to make a screenshot look
  full; capture with test data, or capture the empty state and describe the full one.
- Plain, instructional tone; the organisation's own theme colours on the page (`doc_kit.load_theme`
  reads the app's `theme.json`).

## 5. Screenshots by role

1. **Capture in the published app**, never Studio, after refreshing past any cached build and
   recording the build stamp (`browser-verification.md`).
2. **One pass per role**: sign in as a test user holding only that role, or use the app's own
   impersonation if it has one. An administrator's captures show admin-only controls; a user guide
   illustrated with them promises buttons the reader does not have.
3. **Test data only.** Create clearly fictitious records (marked as test, removed afterwards) so
   every capture is populated and shows no real person. Even so, keep captures out of git: test
   names often turn out to be real, and real ones leak in from shared reference tables.
4. **A fixed window size** (1500x1000 worked) so figures are consistent.
5. **File names**: `<screen>-<role>[-<state>].png`, lower case, listed in `shots.json` with the
   screen and role each one shows.
6. **Trim** with `python doc_kit.py trim out/shots out/shots-trimmed` (removes the player bar,
   letterbox and blank tail; never edits in place). Remove a role-only banner from the middle of a
   capture with `cut_band`.
7. **Inventory**: `python doc_kit.py inventory shots.json` fails on a missing file and on any
   (screen, role) a guide requires without a shot. An empty list is a failure, not a pass.

## 6. Building, rendering and checking

- Copy `build_guides_example.py` into `scripts/build-guides.py`; keep `doc_kit.py` beside it.
- `python scripts/build-guides.py --draft` while captures are pending (a missing figure becomes a
  visible "capture needed" box); the final build stops on any missing figure.
- Output to `out/` (git-ignored) as `.docx`; update fields and render the PDF through Word
  (`model-driven-and-docs.md` section 4), then render the PDF pages to images and **read every page**
  for stranded headings, figures alone on a page and tables split badly.
- Commit the scripts and `shots.json`; never the output.

## 7. Definition of done

- The developer chose which guides; each chosen guide builds without `--draft`.
- `doc_kit.py inventory` passes; every figure was captured on the build named on the cover.
- Button names checked against source; no logical names outside the developer guide.
- Every page of every PDF read; screens still needing recapture listed in the state file.
- The developer guide's flow chapter carries the current `lint-flows.mjs --verbose` edge list, and
  its table chapter the current choice values read from metadata.
