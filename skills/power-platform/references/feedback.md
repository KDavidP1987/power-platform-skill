# Feedback to the skill

When this skill misleads you or leaves you without an answer, the fix belongs in the skill, so the next
person does not pay for it again. This page says when to give feedback, how the person decides whether
you file it yourself, what goes in it, and what never does. `scripts/feedback.mjs` does the mechanical
part: it adds the technical details, refuses anything that looks like the person's data, avoids
duplicates and files the issue.

## Contents

1. When to give it
2. Manual or automatic: the person's choice
3. What goes in, and what never does
4. How to file it
5. What is enforced, and what is not
6. Projects that keep their own lessons log

## 1. When to give it

Once per distinct problem, at a natural pause (after the cause is known, or at the hand-back), when any
of these happened:

- A rule, script or snippet in the skill was wrong, and you measured that it was wrong.
- A bundled check passed something it should have caught, or failed something that was fine.
- A bundled script failed in a way its message did not explain (its name and exit code go in).
- The skill had no answer for a situation that cost real time, and you found the answer.
- A procedure worked well enough that the skill should say it.

Not for the person's own design choices, for failures the skill already describes, or before the cause
is known. "Something went wrong" is not feedback; the mechanism is.

## 2. Manual or automatic: the person's choice

The person picks one mode, once; it is kept in `~/.power-platform-skill-feedback.json` for every
project on the machine (`POWER_PLATFORM_SKILL_FEEDBACK=ask|auto|off` overrides it, for example in CI).

| Mode | What you do |
|---|---|
| `ask` (the default) | Draft it, show the person the draft with one line on why it is worth filing, and file only on a yes to that draft (`file --yes`). If they decline, drop it for the session. |
| `auto` | File it yourself once the draft is clean, then tell the person in one line with the link. At most 3 automatic issues a day; a matching issue gets your evidence as a comment, not a second issue. Issues filed this way carry the `agent-filed` label. |
| `off` | Never offer it. File only an issue the person asks for themselves (`file --yes`). |

Ask about the mode at most once, with the other setup decisions (`first-run.md`), never mid-task:
"When the skill itself gets something wrong, should I file a GitHub issue about it automatically,
ask you first each time, or never?" Record the answer: `node scripts/feedback.mjs mode auto` (or
`ask`, `off`). With no person present and no mode set, the mode is `ask`, so nothing is filed: write
the draft and list it in the hand-back.

## 3. What goes in, and what never does

Feedback describes **the skill's behaviour, not the person's work**.

| Include | Never include |
|---|---|
| The technical details `draft` adds: skill version, install kind, OS, Node, Python and pac versions | What the person is building, its purpose, its business domain or its screens |
| The reference section, script or check involved (`--area`), a script's name and exit code (`--script`, `--exit`) | Names of people, companies, tenants, environments, apps, solutions, sites or workspaces |
| What the skill said or did, what happened instead, and what you expected | URLs, host names, ids, GUIDs, email addresses, connection strings, tokens, user folders |
| How you know: what you measured (a read-back, a download, the published app, an API response) | Data rows, file contents, screenshots of the person's app or data, the project's own schema names |
| The smallest reproduction, using generic names (`app_`, `core_`, an orders and vendors example) | Error text that carries any of the above - rewrite it first |
| A proposed fix, if you have one | Anything the person asked to keep private |

Rewrite the evidence in generic terms. "A gallery over a 3,000-row table stopped at 2,000" is enough;
the table's real name adds nothing to the fix. Use placeholders for hosts: `<org>.crm.dynamics.com`.

## 4. How to file it

```
node scripts/feedback.mjs template defect > .ship-work/feedback/body.md     # or: template lesson
# fill in each section, in generic terms
node scripts/feedback.mjs draft --kind defect --title "<the mechanism, not the project>" \
  --body-file .ship-work/feedback/body.md --area "canvas-shipping.md 4" [--script canvas-browser.mjs --exit 4]
node scripts/feedback.mjs file .ship-work/feedback/<id>.md [--yes]
```

- `draft` checks the required sections, appends the technical details, runs the privacy check and
  writes the draft. Exit 5 lists each finding by line and type (the value is masked): rewrite those
  lines and draft again. There is no override flag.
- `file` checks again (the draft may have been edited), applies the mode, looks for an issue with the
  same title (exit 6 prints it: add your evidence with `comment <number> <draft>`), and files it with
  the GitHub CLI. Without a signed-in `gh`, it prints a new-issue link with the draft filled in for
  the person to open (exit 3).
- Kinds map to the repository's labels: `defect` (something in the skill is wrong) and `lesson`
  (something the skill does not say yet).

The check reads the project's own names from its config (`scripts/canvas-app.json`, `tables.json`,
`Solution.xml`'s publisher prefix, `.claude/hooks/harness.json`), this machine's user and host names
and the git identity. It cannot know a name that is written nowhere: list such terms in
`"feedbackPrivateTerms"` in `scripts/canvas-app.json`, or one per line in a `.feedback-private` file in
the project or any folder above it (`prefix: abc` marks every `abc_` name as private).

## 5. What is enforced, and what is not

- **Enforced by the plugin, in every folder:** an issue or comment on the skill's repository written any
  other way (`gh issue create`, `gh issue comment`, `gh api .../issues`, a GitHub MCP issue tool) is
  denied, so the privacy check always runs. `"pluginGate": false` does not switch this off.
- **Enforced by `feedback.mjs`:** the privacy check, the mode, the daily limit and the duplicate check.
- **Not enforceable, so yours:** whether something is worth filing, and the generic rewrite. The check
  is a net, not a guarantee: a description of the person's business in plain words passes it. Read the
  draft as the person would before filing, in `auto` mode most of all.

Without the plugin (a copied skill folder), nothing denies a raw `gh` call: use `feedback.mjs` anyway.

## 6. Projects that keep their own lessons log

Some teams keep a local lessons log that a maintainer folds into the skill. When the project has one (its
CLAUDE.md or standards say so), write the lesson there as soon as the cause is known, with the evidence,
and keep working. File a public issue only for what the person wants shared, still through
`feedback.mjs`; in `auto` mode such a project's log is the default, not the public issue.
