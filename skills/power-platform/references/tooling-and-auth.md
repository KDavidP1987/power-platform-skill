# Tooling and authentication

The tools around Power Platform - pac, Web API tokens, the TDS endpoint, MCP servers, Windows
PowerShell, a synced documents folder, and Claude Code itself - each have failure modes that look
like a platform fault or, worse, like success. This file collects them.

## Contents

1. pac: profiles, environment selection, and exit codes
2. Dataverse Web API tokens
3. The TDS (SQL) endpoint
4. MCP servers
5. Windows, OneDrive and PowerShell traps
6. Working with Claude Code on Power Platform

## 1. pac: profiles, environment selection, and exit codes

- **One universal profile, then select per repo.** `pac auth create` once, then
  `pac org select --environment <url>` in each repo, and `pac org who` before anything that writes.
  Have the import script print `pac org who` as its first line, so the target environment is on
  screen before the import starts.
- **pac is a native executable: its failure does not trip `$ErrorActionPreference = 'Stop'`.** In
  PowerShell a failing `pac` sets a non-zero `$LASTEXITCODE` and carries on. One pack script printed
  "Built" over a failed pack and left the previous zip in `out/` to be imported; one import script
  wrote a "last successful import" stamp after a failed import. After **every** native call:

  ```powershell
  pac solution pack --zipfile $zip --folder solution/src --packagetype Unmanaged
  if ($LASTEXITCODE -ne 0) { throw "pac solution pack failed ($LASTEXITCODE)" }
  ```

- **A missing file reads like a malformed command.** Given a path that does not exist,
  `pac solution import` prints its full usage text. A broken default path survived about twenty
  ships because every caller passed one explicitly. `Test-Path` first, list what is actually in
  `out/` with timestamps, and stop.
- **The client can misreport a server-side result.** Twice `pac solution import` timed out or hung
  (30 minutes; killed at 25) while the server job had finished in three to five minutes with zero
  failures - only the publish was missing. Read the `importjobs` table (progress, completion time)
  before believing the client's exit or a wrapper's "nothing was imported"; run `pac solution
  publish` if the import landed unpublished; stamp the ship from the job's completion time.
- **pac has no flow commands, and `pac canvas validate` is retired.** Flow definitions are authored
  in source (`power-automate.md`); the only canvas formula validator is a live Studio session.
- **`pac canvas download --name` takes the app id GUID**, not the logical or display name
  (`project-setup.md`).
- **In CI**, the generic installer action did not reliably put `pac` on PATH; the pack-solution
  wrapper action did.

## 2. Dataverse Web API tokens

Two routes, in the order scripts should try them: an `-AccessToken` parameter, else
`az account get-access-token --resource https://<org>.crm.dynamics.com` (Azure CLI), else a
device-code helper. Keep every token cache outside the repo and treat it as a credential.

**A device-code helper with a rotating refresh token** gives one sign-in that covers every repo
targeting the same org, with no module installs:

1. POST to `https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode` with a
   first-party public client id (the Azure CLI's is the usual choice) and scope
   `https://<org>.crm.dynamics.com/.default offline_access`. Without `offline_access` there is no
   refresh token.
2. Show the user code; poll the token endpoint at the returned `interval`. Continue on
   `authorization_pending`; on `slow_down`, add 5 seconds to the interval. The device code expires in
   about 15 minutes.
3. Cache **only the refresh token**, in the user profile.
4. On each later call, redeem it with `grant_type=refresh_token` and **save the rotated refresh token
   that comes back** - the old one is not guaranteed to keep working.
5. On any refresh failure, fall back to a fresh device code. Offer `-Reset` to force a new sign-in.

```powershell
$body = @{ client_id = $clientId; grant_type = 'refresh_token'
           refresh_token = $cached; scope = "$org/.default offline_access" }
$t = Invoke-RestMethod -Method Post -Uri $tokenUrl -Body $body
Set-Content -Path $cachePath -Value $t.refresh_token   # rotate
```

- **Fetch a fresh access token before each long step.** Access tokens last about an hour; a long
  seed load or migration that obtains one token at the start fails part-way, half-written.
- **Refresh-token lifetime is tenant policy** - about 90 days of silent access in one tenant. Plan
  the re-sign-in rather than discovering it.
- **If the public client is not consented in the tenant**, register a public-client app with the
  Dataverse `user_impersonation` permission and pass its client id.
- **Schema reads need at least System Customizer** in the environment; a plain user token can read
  data but not all metadata.

**Az PowerShell without WAM.** `Connect-AzAccount` through the Web Account Manager broker fails in
a non-interactive or embedded console with a "window handle" error. Turn the broker off once, then
sign in:

```powershell
Update-AzConfig -EnableLoginByWam $false
Connect-AzAccount -Tenant <tenant>
(Get-AzAccessToken -ResourceUrl "https://<org>.crm.dynamics.com").Token
```

Az.Accounts then supplies tokens for Dataverse, Fabric and Power BI REST calls on a machine without
the Azure CLI. (Recent Az.Accounts versions return `Token` as a `SecureString`; convert it before
putting it in a header.)

## 3. The TDS (SQL) endpoint

The Dataverse TDS endpoint (`<org>.crm.dynamics.com`, port **5558**) accepts a SqlClient connection
authenticated with an Entra access token:

```powershell
$cn = New-Object System.Data.SqlClient.SqlConnection(
        "Server=<org>.crm.dynamics.com,5558;Encrypt=True")
$cn.AccessToken = $token
$cn.Open()
$cmd = $cn.CreateCommand(); $cmd.CommandText = "SELECT COUNT(*) FROM app_request"
$cmd.ExecuteScalar()
```

It gives exact `COUNT(*)` per table - useful for reconciling a downstream copy without paging the
Web API. It is read-only and must be enabled for the environment. For a single table the Web API is
cheaper still: `GET <entityset>?$count=true&$top=1` returns `@odata.count` in one small request.
An analytics pipeline that copies tables through this endpoint is a consumer of your schema
(`shared-environments.md`).

## 4. MCP servers

**The tool registry is built once, at session start.** A server that misses the connect window never
attaches for that session, even though `claude mcp list` may report it connected. Measured:
`npx @playwright/mcp@latest` took 43.8 s cold and 26.5 s on a second run against a 30 s budget,
because `@latest` makes npx re-resolve against the registry whenever its cache lapses (slower again
behind a TLS-inspecting proxy); a pinned version started in 4.7 s, and 2.3 s warm. Fixes:

- set `MCP_TIMEOUT` (for example `120000`) in **user-level** settings (`~/.claude/settings.json`,
  `env`), because the cause is the machine, not the project;
- pin server versions rather than `@latest`;
- recover in-session with `/mcp`, else relaunch with `claude --continue` to keep the context;
- keep a library-based driver (`scripts/canvas-browser.mjs`) that does not depend on MCP startup.

**Dataverse MCP server.** Configured as a stdio server running
`npx -y @microsoft/dataverse mcp https://<org>.crm.dynamics.com`; the first tool call opens a browser
sign-in, and a "tools fetch failed" from a non-interactive health check before that is expected. It
may need two admin actions a maker cannot do: enabling the environment's Model Context Protocol
(preview) setting, and tenant consent for the Dataverse CLI client application. Find out whether you
are a tenant admin before planning around it (an environment with a delegated admin user set is a
hint you are not). Package name and switches are as of the time of writing; it is a preview feature.

**GitHub hosted MCP.** The hosted endpoint rejected OAuth ("does not support dynamic client
registration") and worked with a personal access token in an `Authorization: Bearer` header. Use a
minimal fine-grained token, never paste it into a chat, and rotate one that was pasted. Use it for
issues and pull requests, **not for pushing history**: an initial upload through its file API
created remote commits (an auto-init plus API commits) sharing no history with the local repo, so
the next `git push` was rejected. Push with git from the start; to repair, see `project-setup.md`.

**The canvas authoring MCP server authenticates as you.** Every session it opens looks like your
own, so an orphaned server process holds the app's edit lock and blocks version restore while you
truthfully have the app open nowhere. On Windows, a server launched through a shell (`shell=True`)
leaves the real process running when the client terminates the shell: kill the process tree
(`taskkill /F /T /PID <pid>`), sweep stray server processes at start and exit, and release sessions
in a `finally`. A direct stdio client must skip JSON-RPC notifications (`tools/list_changed`) while
waiting for a response id, and send the argument names the server **advertises** - in one observed
state `connect` wanted snake_case while the compile and sync tools wanted camelCase. The rest of the
authoring-server behaviour is in `canvas-shipping.md`.

## 5. Windows, OneDrive and PowerShell traps

None of these is a Power Platform fault; each broke a Power Platform script in a way that looked like
one.

**OneDrive-synced repos**

- **Sync locks.** `shutil.rmtree` of an unpack or staging folder fails part-way (WinError 5) on files
  the sync client holds. Clear the read-only bit in an error handler, retry with a short sleep, then
  **refuse** if the tree still exists. Never `rmtree(ignore_errors=True)` followed by a copy - the
  swallowed failure resurfaces as a bare `FileExistsError` - and never `copytree(dirs_exist_ok=True)`
  into a stale folder: a deleted screen survives in it and gets shipped.
- **Close a read handle before writing the same path** (`with` blocks), or Windows intermittently
  raises "Errno 22 Invalid argument".
- **Long paths.** A plain clone failed with "Filename too long";
  `git -c core.longpaths=true clone --depth 1 --filter=blob:none --sparse <repo>` plus a
  sparse-checkout of what you need worked. The canvas authoring tools could not write into a synced
  long path at all: build and compile in a local temp directory, then copy into the repo.
- **Excel holds an exclusive lock** on an open workbook: it blocks Python but not `Copy-Item`, so
  copy first and read the copy.

**Path separators.** Zip producers differ: some store `References/DataSources.json`, others
`References\DataSources.json`. Python's `zipfile` normalises; .NET's `System.IO.Compression` does
not. Normalise with `($_.FullName -replace '\\','/')` before matching (`canvas-shipping.md`).

**Encodings**

- **cp1252 consoles.** Printing a tool result containing check or cross glyphs raised
  `UnicodeEncodeError` **after** the compile had run, losing the result. Start Python tools with
  `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`.
- **`subprocess.run(..., text=True)` decodes with the console code page** and throws on the first
  non-Latin-1 byte in a metadata label. Capture bytes and decode UTF-8.
- **Windows PowerShell 5.1 corrupts non-ASCII in `Invoke-RestMethod` POST bodies.** A middle dot and
  an en-dash in seed text were mangled, which broke name-based idempotency and created a duplicate
  row. ASCII-normalise seed text, or send an explicit UTF-8 byte body:
  `-Body ([Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8'`.
- **Solution XML has a UTF-8 BOM.** Read `solution.xml` and `customizations.xml` with `utf-8-sig`
  and write the BOM back when rewriting (one project's BOM-less rewrite also imported; treat it as
  safe practice, not a proven requirement).

**Windows PowerShell 5.1** (often the only shell - `pwsh` may not exist, so every documented `pwsh`
command must also work as `powershell -File`):

| Trap | Consequence | Fix |
|---|---|---|
| native exit codes do not throw | success printed over a failed `pac` | check `$LASTEXITCODE` after every call |
| unordered hashtable in `ConvertTo-Json` | `@odata.type` emitted after the properties it types; bare `0x80040216` | `[ordered]@{ ... }` for every metadata body |
| one-element array returned from a function | unrolled; `.Count` empty; a destructive preview printed "leaving -1" | `@( ... )` at the assignment |
| empty `HashSet` returned from a function | arrives as `$null`; `-contains` misbehaves | return a plain array |
| `$row[$col]` on an `Import-Csv` row | silently yields nothing (0 rows created) | `$row.$col` |
| `$pid` as a variable name | read-only automatic variable; throws at use | pick another name |
| variable names are case-insensitive | `$appendix` and `$APPENDIX` are the same variable | never rely on case |
| `Invoke-WebRequest` non-interactively | null reference, sometimes after the POST succeeded | `-UseBasicParsing` |
| error body in a `catch` | the response stream is already consumed; reading it returns "" | `($_.ErrorDetails.Message \| ConvertFrom-Json).error.message` |
| TLS defaults | older hosts negotiate below TLS 1.2 | `[Net.ServicePointManager]::SecurityProtocol = 'Tls12'` |
| `[string[]]` parameter via `powershell -File` | "a,b" arrives as one string | two parameters, or split explicitly |
| `$PSScriptRoot` in `param()` defaults | empty in some hosts | resolve inside the script body |

A dot-source guard - `if ($MyInvocation.InvocationName -eq '.') { return }` after the function
definitions - lets one script be both a runnable provisioner and a helper library. In Python,
tools named like `canvas-mcp.py` cannot be imported by name: load them with
`importlib.util.spec_from_file_location`, so there is one token helper or client, not drifting
copies.

## 6. Working with Claude Code on Power Platform

**Open the project folder, and anchor hooks on `$CLAUDE_PROJECT_DIR`.** Project hooks and
`CLAUDE.md` load only from the opened folder, and a hook registered with a relative path silently
stops running once the session works from a subfolder (`project-setup.md`).

**The safety layer refuses some production actions. Do not route around it.** Observed refusals,
all reasonable: rewriting production security roles, assigning roles, granting record access
(`GrantAccess`) or editing a flow to add a sharing step; production metadata writes and data
migrations; deleting a schema column; the Studio Publish click; writing to another real person's
record to test a rule; triggering a submit that would email a real manager; removing the only
admin's access to test as a non-admin. The pattern that kept work moving:

1. Make the change an **idempotent, dry-run-first script** - never prose instructions.
2. Hand the person **one command** to run in the session (so the output comes back), for example
   `! powershell -File scripts/migrate/014-build-roles.ps1 -Apply`, with: why it is safe to re-run
   (idempotent, checks live drift first, exactly what it adds or removes), what it unblocks, and the
   **verification with its expected result** ("the security audit's section E goes from 2 findings
   to 0").
3. **Verify against live yourself** afterwards - by impersonation (`MSCRMCallerID`) for anything
   about access - not from the script's own report.
4. Keep pending user actions as a numbered list in the state file, and record the feature as
   **shipped but unproven** until the verification is done. On an irreversible call, stop with the
   options and a recommendation.

**The automation boundary, by category.** Three kinds of action were refused on every attempt in
one build, and each was finished by the person running one prepared command:

| Refused | Why the guard refuses it | What to prepare |
|---|---|---|
| Creating a connection (Approvals, Word Online, any connector) | it persists a credential | Prefer **reusing an existing connection** (below); otherwise the person creates it in the maker portal and you bind it |
| Creating or changing a security role, assigning one | it grants permissions | an idempotent role script with `-Report` (prints the matrix, writes nothing) and a live subset verification |
| `pac solution import` into a Production-type environment | it is a production deploy | a deploy script that exports a rollback first, gates the import on the checks (lint, recipient audit, marker inspection), and reads back what landed |

Validate each one read-only first (`-Report`, `-WhatIf`, a dry run of the gate on the actual package)
and hand over ONE command. Never look for a second route to the same effect; the refusal is the
answer for that action.

**Reuse existing connections instead of creating them.** List the connections the person already
has: `GET https://api.powerapps.com/providers/Microsoft.PowerApps/apis/<connector>/connections?api-version=2016-11-01&$filter=environment eq '<env id>'`
with an Az token for `https://service.powerapps.com/`. Put each connection's `name` (the id) into the
deployment-settings file (`ConnectionReferences[].ConnectionId`) and import with
`pac solution import --settings-file <file>`: the solution's connection references bind to them and
nothing is created. Check the connection's `statuses` is Connected before binding, and read the
binding back from `connectionreferences` after the import.

Expect the schema half and the canvas half of a change to ship on different days when the person
runs one of them. **Design staged changes to be correct in both states**: a new permission element
whose rule inherits its parent's answer until the new choice member exists is safe before and after
the schema lands, where a default-allow would have silently undone a restriction in the gap.

**Loops.** When each iteration needs a live designer session (the co-authoring server and an open
Studio), a cloud cron job cannot do the work; an in-session loop on a short self-scheduled cadence
can. Each iteration restores the scratch copy from git (never from a server sync, which may be
stale), edits, compiles against the live session, and commits; saving and publishing still need the
person or the browser driver. Recurring loop jobs in the harness expire after about seven days. An
autonomous loop acts on whatever the queue says, so a stale "next" list makes it redo shipped work -
verify each queued item against live before acting (`project-setup.md`).

**Continuity.** Sessions end mid-ship. Before closing: commit with the shipped/unshipped boundary
stated, update the state file (what is live by build stamp, what is held, what waits on a person),
and update the umbrella backlog if several repos are in play. The next session's pre-flight hook
prints the top of the state file; make sure what it prints is true.
