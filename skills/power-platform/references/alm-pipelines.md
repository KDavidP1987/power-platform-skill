# CI/CD for Power Platform: pac in GitHub Actions and Azure DevOps

The rest of this skill assumes the person shipping is a maker at a keyboard: build the zip from git,
import it, prove it in the running product. This file is for the next step, a pipeline that does
the build and the import under a service principal. The skill's tools then become gates the
pipeline must pass.

**How much of this has been tried.** The projects behind this skill shipped mostly without
pipeline rights (`project-setup.md` section 9). CI that packs the solution on every pull request was
used, and so were the offline gates. A service-principal pipeline that imports into a shared
environment was **not** used, so most of this file restates Microsoft's documentation. Every
statement carries one of these tags:

- **[Documented]** Microsoft documents this behaviour. Re-read the current page before relying on
  flag names; pac and the actions change.
- **[Observed]** this skill's projects saw it happen, outside a service-principal pipeline unless
  the text says otherwise.
- **[Untested here]** the recommended design, never run end to end by this skill. Treat it as a
  hypothesis and prove it once in a non-production environment.

## Contents

1. The shape of a pipeline
2. Service principal authentication
3. Source: export and unpack on a branch
4. Build: pack, then assert on the artifact
5. Solution Checker
6. Managed vs unmanaged, update vs upgrade
7. Deployment settings: connection references and environment variables
8. Flows: import, then activate deliberately
9. GitHub Actions: microsoft/powerplatform-actions
10. Azure DevOps: Power Platform Build Tools
11. Where the skill's tools fit as gates
12. A minimal GitHub workflow
13. What a green pipeline does not prove

## 1. The shape of a pipeline

```
pull request    lint-flows -> check-pa-yaml -> pack (unmanaged) -> inspect-artifact -> [checker]
main / release  pack (managed) -> inspect-artifact -> checker -> drift check -> import to TEST
                -> activate flows by name -> perform the task in TEST (Playwright, by a person or
                a self-hosted runner) -> approval -> import to PROD -> diff flow state
```

- **Dev is unmanaged, everything downstream is managed.** [Documented] That is Microsoft's healthy
  ALM guidance. A team that imports unmanaged everywhere, as this skill's projects did, has to
  live with "imports never remove" (`dataverse.md` section 3).
- **The repo is the source; an export is an input to a commit, never a build.** [Observed] Building
  from an environment export carries the live version and any live-only edits forward, so a good
  build and a broken one become indistinguishable (`project-setup.md` section 8).
- **A pipeline that imports needs a person, or a scheduled run, to perform the task afterwards.**
  [Untested here] No CI step can drive the published app as a real user without that user's
  credentials. Keep that step human, or give it a dedicated test account on a self-hosted runner.

## 2. Service principal authentication

**The pieces** [Documented]:

1. An app registration in Microsoft Entra ID with a client secret or, better, a certificate or a
   federated credential.
2. An **application user** for that app id in each target environment (Power Platform admin
   center > the environment > Settings > Users + permissions > Application users > New app user),
   with a security role. Without the application user the token is valid and every call is denied.
3. pac signed in as that app:

   ```bash
   pac auth create --name ci \
     --applicationId "$PP_APP_ID" --clientSecret "$PP_CLIENT_SECRET" \
     --tenant "$PP_TENANT_ID" --environment "$PP_ENV_URL"
   pac org who   # first line of every job: name the environment on screen
   ```

   Recent pac versions also document `--certificateDiskPath` and `--certificatePassword`, and
   federated (secretless) sign-in from GitHub Actions or Azure DevOps. [Documented, untested here]
   Prefer federation over a stored secret when the pac version on the runner supports it.

- **Which role.** [Documented] Importing solutions needs broad customization privileges. System
  Administrator is the role most guides assign to the application user. A narrower custom role is
  possible, but find out by running an import in a test environment, not from the role editor.
  [Untested here]
- **The application user owns what it imports.** [Documented] Components created by the import,
  including flows, are owned by the service principal. Flows owned by a service principal are
  supported for solution-aware flows. The connections behind them are a separate problem
  (section 8).
- **Keep the application user's roles out of the solution**, for the same reason as every other
  role (`security-and-access.md`). [Observed]
- **Test the native exit code after every pac call**, in bash and in PowerShell. [Observed] A
  failing pac in PowerShell does not trip `$ErrorActionPreference = 'Stop'`, and one pipeline-like
  script printed "Built" over a failed pack (`tooling-and-auth.md` section 1). In bash, use
  `set -euo pipefail`.

## 3. Source: export and unpack on a branch

[Documented] commands:

```bash
pac solution export --name "$SOLUTION" --path out/unmanaged.zip --managed false
pac solution export --name "$SOLUTION" --path out/managed.zip   --managed true
pac solution unpack --zipfile out/unmanaged.zip --folder solution/src --packagetype Both
```

- `--packagetype Both` expects the managed and unmanaged zips side by side, named
  `<name>.zip` and `<name>_managed.zip`. It is what later lets the pipeline pack a **managed**
  solution from source. [Documented]
- **Run the export on a branch and open a pull request; never push an export to main.** [Untested
  here as a pipeline] The diff is the review: an export also carries every change somebody made
  in the maker portal and never told git about. Treat unexpected hunks as findings, not noise.
- **Canvas apps:** this skill keeps canvas source as `.pa.yaml` and builds the app on the live
  manifest (`canvas-shipping.md`). An unpack produces `.msapp` files (or, with
  `--processCanvasApps`, a source tree in an older format). Do not let an automated export
  overwrite the canvas source you edit by hand. [Observed]
- **Flow on/off state comes along.** [Observed] Each flow's `.json.data.xml` records `StateCode`, and
  the next import applies it (`power-automate.md` section 8). An export from an environment where
  someone switched a flow off writes "off" into the repo.

## 4. Build: pack, then assert on the artifact

```bash
pac solution pack --zipfile out/solution.zip         --folder solution/src --packagetype Unmanaged
pac solution pack --zipfile out/solution_managed.zip --folder solution/src --packagetype Managed
```

- **A pack exits 0 while dropping components.** [Observed] Fail the build on pac's silent-skip
  warnings ("unexpected children", "root components are not defined in customizations"). Then open
  the zip with `inspect-artifact.py` and assert that the components and markers are present and
  that no security role is included.
- **Bump `<Version>` in `Solution.xml` on every delivery** and fail the build if it did not move
  since the last tag. [Observed] An import of an equal or lower version cannot be told apart from
  the previous one afterwards.
- **Pack on every pull request** as cheap proof that the unpacked source still builds. [Observed]

## 5. Solution Checker

```bash
pac solution check --path out/solution_managed.zip --outputDirectory out/checker
```

- [Documented] Runs the Power Apps checker service against the zip, which needs the signed-in
  profile, and writes a SARIF report. Rule sets and per-rule level overrides are configurable
  (`--ruleLevelOverride`). The GitHub action and the Azure DevOps task expose the same thing.
- **Decide the gate from the report, not from the exit code.** [Untested here] Parse the SARIF and
  fail on the severities you choose (for example, any High or Critical issue not on a reviewed
  allowlist). Like the pack, a checker step can complete and still have found something.
- **What it does not cover:** Power Fx semantics against your data, flow loops, activation
  rejections and cached canvas metadata. The skill's own gates exist for those (section 11).

## 6. Managed vs unmanaged, update vs upgrade

| | Unmanaged import | Managed import (update) | Managed upgrade |
|---|---|---|---|
| Adds and overwrites components | yes | yes | yes |
| Removes components missing from the new version | **no** | no | **yes** |
| Editable in the target | yes | no (only through layers) | no |
| Typical use | dev | patches | releases that retire something |

[Documented] The upgrade is `pac solution import --stage-and-upgrade`, or `--import-as-holding`
followed by `pac solution upgrade`. The upgrade deletes components (and **their data**, for tables
and columns) that the new version no longer contains. Treat it as a migration. List what will
disappear from the holding solution's diff before applying it, and take a backup.

- **Do not mix the two on one environment.** [Documented] Once a solution is imported managed, an
  unmanaged import of the same solution is blocked, and unmanaged customizations on top of managed
  layers produce the "my change did not apply" class of problem. Decide per environment and write
  the decision down.
- **Unmanaged everywhere?** Then every retirement is an explicit scripted operation
  (`dataverse.md` section 9), because nothing is removed by an import. [Observed]

## 7. Deployment settings: connection references and environment variables

[Documented] Generate the template from the built zip, keep one copy per target environment, and
pass it at import:

```bash
pac solution create-settings --solution-zip out/solution_managed.zip --settings-file deploy/settings.template.json
pac solution import --path out/solution_managed.zip --settings-file deploy/test.settings.json
```

```json
{
  "EnvironmentVariables": [
    { "SchemaName": "app_SupportMailbox", "Value": "" }
  ],
  "ConnectionReferences": [
    { "LogicalName": "app_dataverse", "ConnectionId": "", "ConnectorId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps" }
  ]
}
```

- **Commit the definitions, supply the values.** [Observed] Connection reference and environment
  variable definitions live in the solution, while values come from the settings file (or are set
  once in the target). Do not commit a dev value into the definition's default; it becomes the
  value wherever nothing overrides it.
- **A connection id must belong to a connection that already exists in the target.** [Documented]
  Connections cannot travel in a solution. Each connection is created once per environment, and
  the settings file records its id. [Observed] For most connectors, creating the connection needed
  a person to sign in and consent interactively, and no CLI could do it (`dataverse.md` section 6).
  Plan that as a deployment step with a named owner.
- **Secrets do not belong in the settings file.** Keep connection ids and URLs there; keep secrets
  in Azure Key Vault-backed environment variables or the pipeline's secret store. [Documented: Key
  Vault secret environment variables; untested here]
- **Regenerate the template whenever a reference is added**, and fail the build if the settings
  file for a target is missing a key the template has. [Untested here] A missing value surfaces as
  a flow that will not turn on, or that runs against the wrong mailbox.

## 8. Flows: import, then activate deliberately

[Documented] When a solution is imported with connection references bound (via settings or
already set in the target), its flows can be turned on as part of the import, and
`--activate-plugins` turns on plug-ins and workflows. Flows whose references are not satisfied
stay off.

[Observed] The import applies the on/off state recorded in each flow's sidecar. A flow that is
Draft in the repo and running in production is switched off by the next import, and an import of
eight changed flows once left one of them off without naming it (`power-automate.md` section 8).

So in a pipeline:

1. **First deployment of a flow to an environment: import it off.** Its references are not bound
   yet. Bind them through the settings file, then activate. [Documented pattern]
2. **Activate by name, never in bulk.** [Observed] A bulk "turn every app flow on" switched on
   deliberately-off scheduled reminders to a whole roster. The pipeline step takes an explicit
   list of flows (or reads the sidecars' declared state) and runs a `-WhatIf` pass that prints
   what would change.
3. **Activation is the compile.** [Observed] A flow that imports cleanly can be rejected when it is
   turned on (`power-automate.md` sections 5 and 6). An activation step that ignores the response
   ships a dead flow. Read each flow's `statecode` back after activating, and fail on any flow not
   in its declared state.
4. **Who activates matters.** [Documented] Turning a flow on as the service principal makes the
   service principal its owner, and its connections must be usable by that identity. Connections
   owned by a person are the usual blocker. [Untested here] If activation as the service principal
   fails on connections, activate as a named service account that owns the connections, and record
   that dependency.
5. **Diff flow state after every import**, and print the fix for each mismatch. [Observed]

Activation through the Web API [Documented]:

```bash
TOKEN=$(curl -s -X POST "https://login.microsoftonline.com/$PP_TENANT_ID/oauth2/v2.0/token" \
  -d "client_id=$PP_APP_ID&client_secret=$PP_CLIENT_SECRET&grant_type=client_credentials&scope=$PP_ENV_URL/.default" | jq -r .access_token)
curl -sf -X PATCH "$PP_ENV_URL/api/data/v9.2/workflows($FLOW_ID)" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"statecode":1,"statuscode":2}'
```

## 9. GitHub Actions: microsoft/powerplatform-actions

[Documented] Microsoft publishes `microsoft/powerplatform-actions`, with one action per verb:
`actions-install`, `who-am-i`, `export-solution`, `unpack-solution`, `pack-solution`,
`check-solution`, `import-solution`, `upgrade-solution`, `deploy-package`, environment
create/copy/backup/reset, and others. They take `environment-url`, `app-id`, `client-secret` and
`tenant-id` (or federated credentials in newer versions). Pin a release tag, and read that tag's
`action.yml` for the exact input names.

- **[Observed]** In CI the generic installer action did not reliably put `pac` on `PATH`
  ("command not found"), while the `pack-solution` wrapper action worked. Either use the wrapper
  actions for every step, or install pac yourself as a .NET tool
  (`dotnet tool install --global Microsoft.PowerApps.CLI.Tool`, documented for Linux and macOS
  runners) and call it directly, which is what the sample in section 12 does.
- Use GitHub **environments** with required reviewers on the production job, and keep
  `PP_CLIENT_SECRET` as an environment secret, not a repository secret. [Documented GitHub
  feature]

## 10. Azure DevOps: Power Platform Build Tools

[Documented] The "Power Platform Build Tools" extension provides the same verbs as tasks:
`PowerPlatformToolInstaller@2`, `PowerPlatformWhoAmi@2`, `PowerPlatformExportSolution@2`,
`PowerPlatformUnpackSolution@2`, `PowerPlatformPackSolution@2`, `PowerPlatformChecker@2`,
`PowerPlatformImportSolution@2`, `PowerPlatformSetConnectionVariables@2` and others. Authentication
goes through a service connection of type **Power Platform** (application id, secret, tenant,
environment URL), which you reference as `authenticationType: PowerPlatformSPN` with
`PowerPlatformSPN: <connection name>`.

```yaml
steps:
  - task: PowerPlatformToolInstaller@2
  - task: PowerPlatformPackSolution@2
    inputs:
      SolutionSourceFolder: solution/src
      SolutionOutputFile: $(Build.ArtifactStagingDirectory)/solution_managed.zip
      SolutionType: Managed
  - script: python skills/power-platform/scripts/inspect-artifact.py $(Build.ArtifactStagingDirectory)/solution_managed.zip
    displayName: Assert on the artifact
  - task: PowerPlatformImportSolution@2
    inputs:
      authenticationType: PowerPlatformSPN
      PowerPlatformSPN: pp-test
      SolutionInputFile: $(Build.ArtifactStagingDirectory)/solution_managed.zip
      UseDeploymentSettingsFile: true
      DeploymentSettingsFile: deploy/test.settings.json
```

[Untested here] Input names differ between task major versions. Copy them from the task reference
for the version you pin, not from this sample. Use **environments with approvals** for production
stages.

**Power Platform Pipelines**, the in-product pipelines, are a third option that needs no YAML.
[Documented] They suit makers without DevOps rights, but they deploy what is in the dev
environment, not what is in git. Pair them with the export-on-a-branch step in section 3, or the
repo stops being the source of truth.

## 11. Where the skill's tools fit as gates

Every gate below runs offline or read-only, needs no tenant write, and has a `--selftest` that the
upkeep workflow runs monthly. Run them in this order, cheapest first:

| Gate | Command | Fails the build when | Needs |
|---|---|---|---|
| Flow lint | `node scripts/lint-flows.mjs solution/src/Workflows` | exit 1: self-trigger loop, invoker runtime on a non-app trigger, references outside `runAfter`, single-`@` names, message-code mismatch, cross-flow cycle. Exit 2 means nothing was read and must also fail | nothing |
| Canvas source | `check-pa-yaml.mjs`, run per file (below) | exit 2: a fault that fails the whole-app compile | nothing |
| Artifact | `python scripts/inspect-artifact.py out/solution_managed.zip --expect <markers> --min-datasources <live count>` | exit 1: missing components or markers, security roles present, fewer data sources than live | the built zip |
| Drift | `python scripts/check-drift.py out/solution_managed.zip --offline metadata-dump.json` (or live, read-only, with a token) | the app's cached Dataverse metadata disagrees with the target in a way a formula depends on | a metadata dump, or a read token for the target |
| Checker | `pac solution check` | your severity policy (section 5) | service principal |

The `.pa.yaml` hook reads a Claude Code hook payload on stdin. In CI, feed it one file at a time:

```bash
for f in canvas/*/Src/*.pa.yaml; do
  printf '{"tool_input":{"file_path":"%s"}}' "$f" | node skills/power-platform/scripts/hooks/check-pa-yaml.mjs || exit 1
done
```

What none of these prove: that formulas bind to live data sources (only a live Studio compile
proves that), that a flow activates (only activation does), and that the task works for a real
user (only performing it does). Keep those three as named, human-signed steps in the release
checklist. A pipeline that hides them behind a green tick is the vacuous pass `audits.md` warns
about. [Observed]

## 12. A minimal GitHub workflow

Offline gates on every pull request, and a managed build plus an import to a test environment on
demand. The import job uses a GitHub environment named `test` that holds the secrets and, if you
want one, a required reviewer. [Untested here as a whole. Each command is documented, and the
offline gates are the skill's own.]

```yaml
name: solution

on:
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: "8.0.x" }
      - run: dotnet tool install --global Microsoft.PowerApps.CLI.Tool
      - name: Lint flows
        run: node skills/power-platform/scripts/lint-flows.mjs solution/src/Workflows
      - name: Check canvas source
        shell: bash
        run: |
          shopt -s nullglob
          for f in canvas/*/Src/*.pa.yaml; do
            printf '{"tool_input":{"file_path":"%s"}}' "$f" | node skills/power-platform/scripts/hooks/check-pa-yaml.mjs
          done
      - name: Pack (managed) and fail on silent skips
        shell: bash
        run: |
          set -euo pipefail
          mkdir -p out
          pac solution pack --zipfile out/solution_managed.zip --folder solution/src --packagetype Managed 2>&1 | tee out/pack.log
          if grep -Eiq "unexpected children|root components are not defined" out/pack.log; then exit 1; fi
      - name: Assert on the artifact
        run: python skills/power-platform/scripts/inspect-artifact.py out/solution_managed.zip
      - uses: actions/upload-artifact@v4
        with: { name: solution, path: out/solution_managed.zip }

  import-test:
    if: github.event_name == 'workflow_dispatch'
    needs: gates
    runs-on: ubuntu-latest
    environment: test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: solution, path: out }
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: "8.0.x" }
      - run: dotnet tool install --global Microsoft.PowerApps.CLI.Tool
      - name: Sign in as the service principal
        shell: bash
        env:
          PP_APP_ID: ${{ vars.PP_APP_ID }}
          PP_TENANT_ID: ${{ vars.PP_TENANT_ID }}
          PP_ENV_URL: ${{ vars.PP_ENV_URL }}
          PP_CLIENT_SECRET: ${{ secrets.PP_CLIENT_SECRET }}
        run: |
          set -euo pipefail
          pac auth create --name ci --applicationId "$PP_APP_ID" --clientSecret "$PP_CLIENT_SECRET" \
            --tenant "$PP_TENANT_ID" --environment "$PP_ENV_URL"
          pac org who
      - name: Solution Checker
        run: pac solution check --path out/solution_managed.zip --outputDirectory out/checker
      - name: Import with this environment's settings
        run: pac solution import --path out/solution_managed.zip --settings-file deploy/test.settings.json
      # Next, by name and with a dry run first: activate flows, then diff every flow's state
      # against its sidecar. After that a person performs the task in the test environment.
```

The pack step in this sample builds a managed solution, so `solution/src` must come from an unpack
with `--packagetype Both` (section 3). A team that ships unmanaged replaces `Managed` with
`Unmanaged` and accepts that imports never remove anything.

## 13. What a green pipeline does not prove

- **That the import landed what was built.** [Observed] The client can time out while the server
  finishes, or report success for a job that did not publish. Read the `importjobs` row, and
  download the app and read `LoadFromYaml` for canvas changes (`canvas-shipping.md`).
- **That the published player runs the new build.** [Observed] The player caches. Confirm the build
  stamp in the browser (`browser-verification.md` section 10).
- **That access still works.** [Observed] Roles stay out of the solution, so a new table imported
  by the pipeline is visible to nobody until some role grants it. Prove that by impersonation.
- **That nothing loops.** [Observed] The lint catches self-writes on one flow and cycles across
  flows, but a filtered trigger can register to nothing, and a bookkeeping write can fire every
  update flow. Read run history in the hour after the first real use.
