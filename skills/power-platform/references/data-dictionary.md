# Data dictionaries for Dataverse apps

A data dictionary answers "what does this column hold, what values can it take, who sets it, and who
reads it" for every table an app owns, in a form a report builder, an auditor or the next developer
can search without opening the maker portal. `scripts/datadict.py` builds it from the unpacked
solution in the repo, checks it against the live environment (read-only), names the Fabric dataflows
that read each table, and evaluates a dictionary later. Column lineage through a medallion is
`data-lineage-docs.md`; this page documents the tables at the source.

## Contents

1. When to make one
2. Build it, step by step
3. What it reads, and what it cannot
4. The curated notes
5. Evaluate a dictionary
6. Evaluate a data dictionary the tool did not make
7. Sharing it

## 1. When to make one

- Before reports are built on the app's tables, or when a medallion starts reading them: report
  builders need each column's meaning, unit and allowed values, and choices by label, not number.
- At go-live, as chapter 4 of the developer and platform guide (`documentation-set.md`).
- Before an access review: the dictionary names every sensitive column, the access decision behind
  it, and the dataflows that copy it out of Dataverse.
- When a table's meaning is argued about: a curated meaning with the decision id ends the argument.

One dictionary per solution, regenerated after every schema change; not a spreadsheet kept by hand.

## 2. Build it, step by step

1. **The solution in git.** `pac solution clone` or `unpack` so `Entities/<table>/Entity.xml` and
   `Other/Relationships/` are in the repo (`dataverse.md`).
2. **Offline first.** `python scripts/datadict.py doc --solution solution --out
   docs/data-dictionary/<app>`. Read the summary line and the gaps: a choice with no options (a
   global choice outside the solution), a lookup with no relationship, a table with no description.
3. **The notes skeleton.** `datadict.py notes --solution solution --out
   docs/data-dictionary/<app>-notes.md` writes one section per table with every column, its display
   name and type, and an empty Meaning. Run it again with `--notes` on the same file after a schema
   change: it keeps every meaning already written and adds the new columns.
4. **Write the meanings** (section 4) from the design documents, the scripts that write each column
   and the app formulas that set it. A large app splits cleanly by domain across several people or
   agents; each fills its own tables, and the sections are joined.
5. **Live.** Add `--env https://<org>.crm.dynamics.com` (a signed-in `az`, Az PowerShell or
   `--token-cmd`): each table's columns are compared with the repo both ways, and row counts come
   from Dataverse's snapshot count. Add `--dataflows <medallion>/fabric/dataflows` so each table
   names the Fabric dataflows that read it.
6. **Look at it.** Open the HTML at desktop and phone width, light and dark; try the filter box on a
   column name and on a choice label; check the sensitive flags are the ones you expect and no others.
7. **Evaluate** (section 5), then commit the `.html`, `.md`, `.csv`, `.json` and the notes together,
   with a README in `docs/data-dictionary/` holding the exact regenerate command.
8. **Keep it current.** Regenerate after any solution change; `evaluate` fails a dictionary whose
   tables changed since it was made. Never edit the generated files.

Measured on a production project-management app: 58 tables, 996 columns (822 app columns, 68
choices, 142 lookups), every lookup resolved, live columns matching the repo, 36 tables read by
the medallion. Its solution carried a description on every table and on none of its 822 columns:
the meanings were drafted by six agents in parallel, one per domain, from the design documents,
the scripts and the app formulas, with the ones resting only on a display name listed in the
About section for the owner to confirm. `evaluate` then caught a sensitive-pattern hit the notes
did not cover (an interest rate on a capital request, marked not sensitive), and passed 9 of 10.

## 3. What it reads, and what it cannot

From each `Entity.xml`: the table's display and plural names, description, entity set, ownership,
primary name column, alternate keys and audit; for each column the display name, type with length or
precision, required level, description, choices with values and labels (status reasons with their
state, default value), column security, audit and formula or rollup. From the relationships: each
lookup's target and what deleting the target does to the row (clears the link, deletes it, is
blocked), and the tables that point at each table.

Listed per table: the app's own columns, the primary key, Status and Status reason. The standard
columns every table carries (created, modified, owner, version) are listed once. A currency column's
base-currency copy is a flag on the column, not a row.

Not read: business rules, plug-ins, flows and formulas that set a column (the meaning says who sets
it), and tables outside the solution (a lookup to one shows its logical name). Global choices are
read from `Other/OptionSets`; one defined in another solution is a gap until that solution is
unpacked too.

Sensitive columns: whole-word rate, salary, wage, pay, compensation, bonus, ssn, birth date and
personal contact details on the display name, and every column with column security. Finance figures
such as Amount are not flagged by default: in a finance app they are the point of the app, not
personal data. `--sensitive REGEX` replaces the pattern, and the notes can mark any column sensitive
or not (section 4).

## 4. The curated notes

Text before the first table heading is the About section; a `## <table logical name>` section adds
to that table; a `| Column | Meaning |` table inside it gives the column meanings, by logical or
display name. Extra columns in that table (the skeleton's Display name and Type) are ignored, except
an optional `Sensitive` column (yes or no) that overrides the pattern.

| Part | What it holds |
|---|---|
| Purpose | What the app is for and what it replaced |
| Owner | The owning team and repo |
| Consumers | The apps, portals, dataflows and reports that read the tables |
| Sensitive data | Each sensitive table or column, why, and the access decision that governs it |
| How to read it | Units and conventions that apply everywhere (currency, fiscal periods, US and international) |
| Per table | Grain (one row per what), who writes it, decision ids |
| Per column | One sentence: what the value is, its unit or grain, who sets it, the decision behind it |

A numbered series (Month 1 to Month 100) takes one wildcard row: `| app_month* | Spend in that month
of the timeline. |`. A lookup named after its target table needs no meaning: the target is the
meaning. Keep names of people out of it: roles and teams age better, and the dictionary travels.

The right long-term home for a column's meaning is the column's own description in Dataverse, where
the maker portal, Power BI and Copilot see it. `evaluate` warns when most meanings live only in the
dictionary; copying the curated meanings into the solution's descriptions is a schema change and
goes through the normal release.

## 5. Evaluate a dictionary

```
python scripts/datadict.py evaluate --doc docs/data-dictionary/<app> --solution solution [--min-coverage 0.8]
```

| Check | FAIL when | WARN when |
|---|---|---|
| tables described | a table has no description and no curated section | |
| column meanings | fewer than `--min-coverage` of the columns have one | any column has none |
| choices labelled | a choice has no options, or an option has no label | |
| lookups resolved | a lookup has no target in the relationships | |
| freshness | a table or relationship file changed since the dictionary was made (hashes in the JSON) | |
| age | | older than `--max-age-days` |
| drift | a table's live columns differ from the repo | generated without `--env` |
| curated notes | missing, or no purpose or owner in the About section | |
| sensitive columns | a flagged or secured column is not covered by the About section's sensitive-data part (by column or table name) | |
| meanings in Dataverse | | fewer than half the app columns carry a Dataverse description |

Exit 0 no FAIL, 1 a FAIL, 2 cannot run. Run it before relying on a dictionary, in CI after a schema
change, and before a release review; a failing dictionary is regenerated, not edited.

## 6. Evaluate a data dictionary the tool did not make

A spreadsheet dictionary, a wiki page or a catalogue export is judged on the same questions; any "no"
in the first four makes it unfit to rely on:

1. **Complete?** Every table the app owns, every app column; count them against the solution.
2. **Built from the schema?** Types, lengths and choices taken from the solution, not retyped.
   Compare three choice columns' labels and values against `Entity.xml`.
3. **Current?** Dated, with the solution version it describes, and newer than the last schema change.
4. **Meanings, not restated names?** "Project Number: the project number" is not a meaning; unit,
   grain and who sets the value are.
5. **Allowed values by label**, with the default and what deleting a related row does.
6. **Sensitive columns named** with the access decision, and the places the data is copied to.
7. **Consumers named**: apps, portals, dataflows, reports.

Where a hand-made dictionary exists, generate one and compare: each disagreement is a stale entry or
a schema change nobody recorded. Carry its good meanings into the notes so they survive the next
regeneration.

## 7. Sharing it

The dictionary names sensitive columns and internal systems, never values (row counts are the only
figures, and they are approximate). Check it against the data's access decisions before it leaves
the audience that can already see the schema, and publish it privately first.
