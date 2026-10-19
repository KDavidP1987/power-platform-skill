# Feedback to the skill

When this skill misleads you or leaves you without an answer, the fix belongs in the skill, so the next
person does not pay for it again. This page says when to offer feedback, what goes in it, and what never
does.

## Contents

1. When to offer it
2. What goes in, and what never does
3. How to file it
4. Projects that keep their own lessons log

## 1. When to offer it

Offer feedback once per distinct problem, at a natural pause (after the cause is known, or at the
hand-back), when any of these happened:

- A rule, script or snippet in the skill was wrong, and you measured that it was wrong.
- A bundled check passed something it should have caught, or failed something that was fine.
- The skill had no answer for a situation that cost real time, and you found the answer.
- A procedure worked well enough that the skill should say it.

Do not offer it for the person's own design choices, for failures the skill already describes, or before
the cause is known. "Something went wrong" is not feedback; the mechanism is.

## 2. What goes in, and what never does

Feedback describes **the skill's behaviour, not the person's work**.

| Include | Never include |
|---|---|
| The skill version (`metadata.version` in SKILL.md, or `.claude/hooks/harness.json`) | What the person is building, its purpose, its business domain or its screens |
| The reference section, script or check involved | Names of people, companies, tenants, environments, sites or workspaces |
| What the skill said or did, what happened instead, and what you expected | URLs, ids, GUIDs, email addresses, connection strings, tokens |
| How you know: what you measured (a read-back, a download, the published app, an API response) | Data rows, file contents, screenshots of the person's app or data |
| The smallest reproduction, using generic names (`app_`, `core_`, an orders and vendors example) | Error text that carries any of the above - redact it first |
| A proposed fix, if you have one | Anything the person asked to keep private |

Rewrite the evidence in generic terms before showing it. "A gallery over a 3,000-row table stopped at
2,000" is enough; the table's real name adds nothing to the fix.

## 3. How to file it

1. **Draft it and show it to the person.** Say in one line why it is worth filing. Filing is their
   choice; never file on your own.
2. Use the repository's issue forms:
   - **Something in the skill is wrong** (`defect`): version, what happened and what you expected, how you know.
   - **A lesson for the skill** (`lesson`): the lesson in one or two sentences, the evidence, where it belongs.
3. **If they agree** and the GitHub CLI is signed in, create it:

   ```
   gh issue create --repo KDavidP1987/power-platform-skill --label defect \
     --title "<one line: the mechanism, not the project>" --body-file <draft.md>
   ```

   Otherwise give them the new-issue link with the draft to paste:
   `https://github.com/KDavidP1987/power-platform-skill/issues/new/choose`.
4. If they decline, drop it. Do not raise the same item again in the session.

## 4. Projects that keep their own lessons log

Some teams keep a local lessons log that a maintainer folds into the skill. When the project has one (its
CLAUDE.md or standards say so), write the lesson there as soon as the cause is known, with the evidence, and
keep working. Offer a public issue only for what the person wants shared, still anonymised as above.
