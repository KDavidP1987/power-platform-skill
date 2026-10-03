# First run: connecting an agent to a Power Platform environment

Everything else in this skill assumes the agent can already reach the environment: read and write
Dataverse, pack and import, open Studio, drive the published app. This file is the order to set
that up in, from a machine with nothing on it, and the smoke test that proves it before the first
real change. Do it once per machine and once per environment; most of it never has to be repeated.

The detail behind each step lives elsewhere (`tooling-and-auth.md` for pac, tokens and MCP servers,
`project-setup.md` for the repository, `browser-verification.md` for the browser). This file is the
sequence and the checks.

## Contents

1. What the person needs before the agent can do anything
2. The machine
3. The project folder and the agent's permissions
4. pac
5. A Web API token that renews itself
6. A browser that signs in by itself
7. Studio and the canvas authoring server
8. Optional MCP servers
9. The app config file
10. What the agent will hand back to the person
11. The smoke test
12. Why it gets quieter: what removed each manual step

## 1. What the person needs before the agent can do anything

The agent acts as the person signed in. It can never hold more rights than that person, so find out
what they hold first, and write it in the project's state file.

| Need | For | Usually held by a maker? |
|---|---|---|
| A work account in the tenant, licensed for Power Apps (premium if the app uses Dataverse) | everything | yes |
| **Environment Maker** in the target environment | creating apps and flows | yes, in a developer or sandbox environment |
| **System Customizer** (or System Administrator) in the environment | tables, columns, solutions, reading full metadata, importing | often only in a developer environment |
| Ownership of the canvas app, or co-owner | editing it in Studio, sharing it | the person who created it |
| Tenant consent for a first-party client id (Azure CLI's), or an app registration | device-code tokens for the Web API | depends on tenant policy |
| Power Platform admin | Dataverse MCP preview switch, environment settings, tenant consent | rarely |

**Prefer a developer or sandbox environment.** In a Production-type environment the agent's safety
layer refuses imports, role changes and connection creation (section 10), so every ship needs the
person at the keyboard. A developer environment removes most of that friction.

**An environment with a delegated admin set is a hint the person is not a tenant admin.** Plan
around the admin-only items rather than discovering them mid-build.

## 2. The machine

| Tool | Why | Check |
|---|---|---|
| git | the repo is the source of truth | `git --version` |
| Node.js 18+ (20+ preferred) | `canvas-browser.mjs`, `lint-flows.mjs`, the canvas checks, the hooks | `node --version` |
| Python 3.10+ | `ship-canvas.py`, `check-drift.py`, `inspect-artifact.py` | `python --version` |
| .NET SDK (8+; 10 for the canvas authoring server) | `pac` as a .NET tool | `dotnet --version` |
| `pac` (Power Platform CLI) | pack, import, canvas download | `dotnet tool install --global Microsoft.PowerApps.CLI.Tool`, then `pac` |
| Chrome or Edge | the browser the driver uses (no separate download) | installed |
| Azure CLI (optional) | one more token route | `az --version` |

On Windows keep project paths short: the evaluation harness and some tools fail past 260
characters, and a synced documents folder adds length (`tooling-and-auth.md` section 5).

## 3. The project folder and the agent's permissions

1. **Open the project folder itself** in Claude Code, not a parent: project hooks and `CLAUDE.md`
   load only from the opened folder.
2. **Install the skill** (plugin, or `.claude/skills/power-platform/`).
3. **Wire the hooks** from `assets/settings.snippet.json` into `.claude/settings.json`: the
   pre-flight at session start, the `.pa.yaml` compile-killer check, the text-fit and overlap checks
   on every write, and the end-of-turn audit.
4. **Offer version control on GitHub** if the folder is not already a repository with a remote:
   explain what it is and why it matters, and help choose a personal or an organisation account
   (`project-setup.md` section 12). Set the commit identity in the repository before the first
   commit.
5. **Allow the read-only commands** the agent runs constantly (`pac org who`, `git status`, the
   bundled checkers), so each one is not a permission prompt. Do not allow imports or role
   changes by rule: those should stay a deliberate step.

## 4. pac

```sh
pac auth create --environment https://<org>.crm.dynamics.com   # browser sign-in, once
pac org who                                                     # names the environment and you
```

One universal profile, then `pac org select --environment <url>` per repo. Every script that
writes prints `pac org who` first, so the target is on screen before anything happens.

## 5. A Web API token that renews itself

Scripts that read and write Dataverse (provisioning, seeding, role scripts, and the browser driver's
**Dataverse confirmation** after a walk) need a bearer token for `https://<org>.crm.dynamics.com`.
Pick one route and make it a command that prints the token:

- **Azure CLI:** `az login` once, then
  `az account get-access-token --resource https://<org>.crm.dynamics.com --query accessToken -o tsv`.
- **A device-code helper with a cached, rotating refresh token** (`tooling-and-auth.md` section 2):
  one sign-in, then silent for as long as tenant policy allows (about 90 days in one tenant), shared
  by every repo that targets the same org. Wrap it in a two-line script that prints the token.

Prove it: `GET https://<org>.crm.dynamics.com/api/data/v9.2/WhoAmI` returns your user id. Then put
the command in the app config as `dataverseTokenCommand` (section 9). The token cache lives in the
user profile, never in the repo; treat it as a credential. The agent should use the token only
through that command and never print it.

**Once the token command works, the agent creates tables itself.** It writes the schema as a
manifest and runs `scripts/deploy-tables.py --plan` with `--token-cmd`, shows the person the plan,
then applies it and reads every table, column and option back (`dataverse.md`, section 16). That
needs **System Customizer or System Administrator** in the environment (section 1), for the plan as
well as the apply, because a plain user token cannot read all metadata. Without it the tool stops at
the first refused request with exit 2, never a partial pass. Security roles stay a step the person
runs (section 10).

## 6. A browser that signs in by itself

The published app is the test harness, so the browser has to reach it without a person typing a
password. Install the driver's one dependency in the repo (it changes `package.json`, so ask):

```sh
npm i -D playwright          # drives the Chrome or Edge already installed
node scripts/canvas-browser.mjs check --headless
```

`check` opens the maker portal with the driver's profile (in the home folder, outside the repo) and
says SIGNED IN or NOT SIGNED IN. What happens next depends on the machine:

- **A managed Windows device joined to Entra ID** usually signs in with no prompt at all: the
  device holds a primary refresh token, and the browser passes it to Microsoft's sign-in page. Edge
  does this by default; Chrome does it when the organisation sets the `CloudAPAuthEnabled` policy
  (check `chrome://policy`). Then even a brand-new profile is signed in, headless included.
  Observed: a fresh profile reported SIGNED IN on its first headless run.
- **Anything else** (a personal machine, a non-joined device, a tenant that requires MFA on every
  new browser): run `node scripts/canvas-browser.mjs login` once. It opens a visible browser; the
  person signs in, MFA included, and the profile keeps the session. Later runs are silent until the
  session expires.

Then run `node scripts/canvas-browser.mjs doctor` to prove every UI anchor the driver relies on
still resolves in a live Studio and player. The profile holds live session cookies: keep it out of
every repo and every sync folder.

For interactive looking, the Playwright MCP server (`claude mcp add playwright -- npx
@playwright/mcp@<pinned version>`) gives the agent browser tools directly; set `MCP_TIMEOUT` in the
user settings, because a cold `npx` start can miss the session's connect window
(`tooling-and-auth.md` section 4). Use the bundled driver for anything that must be repeatable.

## 7. Studio and the canvas authoring server

Formulas are only validated against real data sources by a **live Studio edit session**. The
co-authoring (canvas authoring) MCP server compiles and syncs against that session:

1. Open Studio in edit mode as the app's owner: `node scripts/canvas-browser.mjs studio` (holds it
   open) and confirm the window title reads `(Editing)`, not `(Read-only)`.
2. Connect the authoring server, compile, and read the first line of the result: "no active
   coauthoring session" means it validated against nothing.
3. Leave through the editor's Back button (`close-studio`), never by killing the tab, or the edit
   lock is stranded.

The server needs the .NET 10 SDK and authenticates as the person; details and its traps are in
`authoring-sessions.md`.

## 8. Optional MCP servers

| Server | Gives | Setup cost |
|---|---|---|
| Playwright | browser tools for looking around | none beyond Node; pin the version |
| Dataverse (`@microsoft/dataverse`) | tables and rows as tools | may need the environment's MCP preview switch and tenant consent - admin actions |
| GitHub (hosted) | issues and pull requests | a minimal fine-grained personal access token in a header; push history with git, not through it |

None is required: every bundled script works without them.

## 9. The app config file

`scripts/canvas-app.json` names the app and the environment for every bundled tool; nothing about a
specific app is written into the scripts. Start from `assets/canvas-app.example.json`:

```json
{
  "environmentId": "<environment GUID>",
  "environmentUrl": "https://<org>.crm.dynamics.com",
  "appId": "<canvas app GUID>",
  "appName": "Orders",
  "solutionUniqueName": "Orders",
  "canvasSrc": "canvas/orders/Src",
  "dataverseTokenCommand": "az account get-access-token --resource https://<org>.crm.dynamics.com --query accessToken -o tsv"
}
```

The ids are not secrets, but the file is per environment: keep one per target, or override with
`--config`.

## 10. What the agent will hand back to the person

Some actions the agent's safety layer refuses on every attempt, correctly: creating a connection,
creating or assigning a security role, importing into a Production-type environment, and anything
that would reuse the person's browser session as a credential for another purpose. Plan for them
from the start (`tooling-and-auth.md` section 6):

1. The agent writes an **idempotent script with a dry run** (`-WhatIf`, `-Report`), runs the dry
   run, and shows what it would change.
2. It hands over **one command** to run in the session (`! powershell -File ...`), with what it
   unblocks and how the result will be verified.
3. It verifies the effect against live itself afterwards.

Granting app access is the same shape: one script that assigns the roles, updates any in-app
administrator list, and shares the app with no invitation email, then reads all three back.

## 11. The smoke test

Run all of it before the first change. Every line must pass; a line that cannot run is not a pass.

| Check | Expected |
|---|---|
| `pac org who` | the intended environment and user |
| the token command, then `WhoAmI` | a user id (never print the token itself) |
| `node scripts/canvas-browser.mjs check --headless` | SIGNED IN |
| `node scripts/canvas-browser.mjs doctor --player-only` | exit 0 |
| `node scripts/lint-flows.mjs --selftest`, `check-canvas-format.mjs --selftest`, `check-canvas-overlap.mjs --selftest`, `canvas-browser.mjs --selftest` | selftest ok |
| a read-only scenario with a `confirm` check, through `canvas-browser.mjs walk` | VERDICT: PASS with DATAVERSE CONFIRMED |

The last line is the whole method in one run: the published app performs a task in a real browser,
and the effect is read back from Dataverse by an independent route.

## 12. Why it gets quieter: what removed each manual step

Early sessions in one build needed the person for almost every verification: signing in, opening
Studio, clicking through the app, checking the table. Each of those steps went away for a specific
reason, and each reason is a setup step above:

| Manual step that disappeared | What removed it |
|---|---|
| Signing in for every script | a cached refresh token that rotates on each use (section 5) |
| Signing in to the browser | device single sign-on on a managed machine, or one saved profile (section 6) |
| "Please open Studio and compile" | the driver holding Studio open and the authoring server compiling against it (section 7) |
| "Please click through the app and tell me what happens" | scenarios walked in the published app, with overlap, clipping and dead-click sweeps (section 6) |
| "Please check the row was saved" | the walk's Dataverse confirmation, which also proves the row changed during this run |
| Reviewing each `.pa.yaml` write for compile-killers, clipped text and overlapping controls | the PostToolUse hooks (section 3) |
| Remembering what is live and what is held | the state file the pre-flight hook prints at session start |

What does not go away, by design: the steps in section 10. They stay one deliberate command each.
