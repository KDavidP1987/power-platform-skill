# Power Automate cloud flows in a solution

## Contents

1. What a solution flow definition looks like
2. Dataverse triggers: settings that fail silently
3. Trigger loops: the update payload is the whole row
4. Loops between flows, and bookkeeping writes
5. Activation is the only compile
6. Five defects that are only rejected at activation
7. Dates, nulls and `if()`: defects that fail at run time, or never
8. An import applies the repo's on/off state
9. Who a flow runs as: connections, restricted reads, sharing
10. Notifications: hidden failures and safety switches
11. Testing a sending or scheduled flow without mailing anyone
12. Bulk writes are mail-merges
13. Aggregates and joins: use FetchXML
14. Run history is a table
15. A checklist for every flow

Lint definitions with `scripts/lint-flows.mjs <solution/src/Workflows>` - it checks most of what
follows statically. Add `--entity-sets sets.json` to verify every entity set name and
`--date-only cols.json` to flag date-only columns used as instants.

---

## 1. What a solution flow definition looks like

In an unpacked solution, each flow is `Workflows/<Name>-<GUID>.json` plus a `.json.data.xml`.
The JSON's `properties` holds:

```json
{
  "properties": {
    "connectionReferences": {
      "shared_commondataserviceforapps": {
        "runtimeSource": "embedded",
        "connection": { "connectionReferenceLogicalName": "app_sharedcommondataserviceforapps_x1y2z" },
        "api": { "name": "shared_commondataserviceforapps" }
      }
    },
    "definition": {
      "$schema": "...", "contentVersion": "1.0.0.0",
      "parameters": { "$connections": {...}, "$authentication": {...} },
      "triggers": {
        "When_a_request_is_updated": {
          "type": "OpenApiConnectionWebhook",
          "inputs": {
            "parameters": {
              "subscriptionRequest/message": 3,
              "subscriptionRequest/entityname": "app_request",
              "subscriptionRequest/scope": 4
            },
            "host": { "apiId": "/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps",
                      "connectionName": "shared_commondataserviceforapps",
                      "operationId": "SubscribeWebhookTrigger" },
            "authentication": "@parameters('$authentication')"
          }
        }
      },
      "actions": { ... }
    }
  }
}
```

Note the asymmetry: the trigger names the table by **logical name** (`app_request`); Dataverse
actions (`ListRecords`, `GetItem`, `UpdateRecord`, `CreateRecord`) name it by **entity set name**
(`app_requests`), and write columns as `item/<column>` parameters. Remember the three GUID copies
(`dataverse.md`, section 7) and that connection references bind at import (section 6 there).

**Packaging details** that are easiest learned from an export, not guessed:

- `<Category>5</Category>` in the sidecar is what makes it a modern cloud flow; `Solution.xml`
  lists it as `<RootComponent type="29" id="{guid}" behavior="0" />`. The file name strips spaces
  and punctuation from the flow name and carries an upper-case GUID.
- A working solution carried a connection reference declared only in `Customizations.xml`, with no
  root component of its own (observed in one project; confirm against your own export).
- **`pac` has no flow commands**, and in one check the Power Platform management MCP server's tool
  list had none either (tool lists change by version). There is no CLI path to create a flow. Learn
  the shape by exporting an existing solution read-only, then author definitions in source. A
  third-party flow tool that deploys straight to the environment bypasses the solution - treat it
  as live editing.
- **The deployed definition is readable**: `GET workflows?$select=name,statecode,clientdata&$filter=category eq 5`
  returns each cloud flow's full definition as a JSON string in `clientdata`. Parse
  `properties.definition.triggers` for `subscriptionRequest/entityname`, `/message` and
  `/filteringattributes`, and walk actions for send operation ids. That answers "what fires if I
  write to this table, and which of those send" without the portal, and lets you compare the live
  definition with git before trusting either.
- **A flow a canvas app calls must live in the solution.** A flow created under *My flows* cannot be
  added to a solution-aware app; create it from Solutions > your solution > New > Automation.
- **Power Apps (V2) trigger inputs are positional.** The app passes arguments in the order the
  inputs were added, and the internal names are `text`, `text_1`, `text_2` - read the flow's
  contract, do not assume names. Power Apps strips spaces from the flow's name, and a hyphen forces
  quoting. Email attachment content from the app must be `base64(...)`. A formula naming a flow the
  app has not added fails the app's whole compile (`canvas-shipping.md`).
- **A flow created over the Dataverse API still needs a person**: it arrives unbound, and its
  connection must be authorised by an interactive sign-in.
- **When flows are deferred, build the app side of the seam now.** Create the staging tables and
  columns the flow will need and an in-app version of its action (for example, writing the
  change-log row on save), and write one contract per flow: trigger, scope, inputs, output columns,
  required privileges, loop guard (section 3) and build order. The flow then only extends the seam
  to writes made outside the app, and can be built later without reshaping the app. Treat the
  contract's assumptions - the loop guard especially - as hypotheses until a real run proves them.
- **Keep one root action.** When inserting settings readers at the top of a flow (mode, allowlist,
  mailbox), chain them one after another before whatever used to start the flow. Two root actions
  with `runAfter: {}` are legal but make "what starts this flow" ambiguous for every later tool,
  including the next script that inserts a step.
- In the modern designer the trigger's advanced parameters hide behind **Show all**, and *Update a
  row* refuses to save until environment, table and row id are all filled.

## 2. Dataverse triggers: settings that fail silently

These let a flow register, activate and report **On** while doing nothing or the wrong thing. The
only place either of the first two is explained is the Flow checker pane in the designer - a click
path, not an API - so assert on them in source.

**`runtimeSource` must be `"embedded"` for anything not called by a Power App.** `"invoker"` means
*run as whoever triggered this*, and needs the caller to hand over a token in an
`X-MS-APIM-Tokens` header. A Power Apps (V2) trigger does that. **A Dataverse webhook does not, and
a Recurrence has no caller at all**, so every run dies in the trigger after a few milliseconds:

```
InvokerConnectionOverrideFailed. Failed to parse invoker connections from trigger '...' outputs.
Could not find property 'headers.X-MS-APIM-Tokens' in the trigger outputs.
```

Invoker also defeats the point of connection references: the flow is meant to run as one service
identity, which is what lets it write data the triggering user cannot. One project shipped invoker
in nine flows - and its flow audit **asserted invoker was required**, so the defect passed every
audit for nine days. An audit that enforces the bug is worse than none.

**The SDK message codes are 1 = Create, 2 = Delete, 3 = Update** (and 4 = Create or Update, 5 =
Create or Delete, 6 = Update or Delete, 7 = all). Not 1/2/3 = Create/Update/Delete, which is the
natural guess. A wrong code registers, activates, and listens to the wrong event: an edit wrote a
"deleted" audit row against a row that still existed, and a real delete fired the update flows,
which then failed retrieving the row that had just gone. A "fix" that changed 3 to 2 "to move Delete
to Update" did the opposite. **Prove it from a run**: the trigger payload carries
`"SdkMessage":"Create"|"Update"|"Delete"` in plain text. Scope (`subscriptionRequest/scope`) is
1 = user, 2 = business unit, 3 = parent-child BU, 4 = organisation. Old notes written before the
codes were understood will say otherwise; trust the run payload.

**An update payload carries only what changed for the attributes you read** - anything else reads
null, and `@{null}` interpolates to `""`, which fails conversion on a date or lookup. **Retrieve the
row (`GetItem`) and read fields from that.** A delete payload carries little more than the id, so a
delete handler must tolerate every field being absent and should write the record id into its own
text so the entry can be correlated later.

- **Do not design on prior values from the trigger.** A design that reads "old and new value" from
  `triggerOutputs()` assumes pre-images the Dataverse connector's update payload was never shown to
  carry in these projects - unverified. If you need the before-value, keep it yourself (a
  status-before column the writer fills, or a log row).
- **Filtering attributes exist only for the Update message.** Do not demand them on Create or
  Delete triggers (an audit that does generates noise).
- **Choice labels may be missing.** One project's flows did not receive
  `@OData.Community.Display.V1.FormattedValue` for choice columns, so a status read "unknown";
  another read labels from trigger outputs as `body/<column>@OData.Community.Display.V1.FormattedValue`.
  Scope not characterised: open a real run's outputs before building messages on annotations, and
  map integers to labels in the flow when they are absent.

## 3. Trigger loops: the update payload is the whole row

**A flow triggered on a table that writes back to the same table retriggers on its own write.**
That is a runaway loop against production data, billed per run.

The trap that actually cost money: believing the payload is a diff, and writing

```
trigger: app_request updated (no filtering attributes)
  IF status = Submitted            <- never written by this flow
     notify approver
     UPDATE app_request SET locked = true     <- self-write
```

reasoning that the self-write cannot re-enter because `status` will be absent from its payload. It
will not be absent. The row is fetched whole, the condition is true again, and the flow runs
forever. Measured once: **1,203 runs in 45 minutes** across four flows from five real user actions,
and about **500 emails to one person**. The project's own flow audit had been requiring the broken
shape.

**The rule: a flow that writes back to its own trigger table must guard on an attribute its own
write-back changes.** The second pass then reads the new value, the condition is false, and it
stops - one wasted run, no loop.

| Flow writes | Guard on |
|---|---|
| `locked = true` | `locked <> true` |
| `snapshotrate = <n>` | `snapshotrate is blank` |
| `processedon = utcNow()` | `processedon is blank` |

A guard of "the modifying user is not the flow's service account" is a common proposal; treat it as
a hypothesis until a run proves it, and keep the value-based guard regardless - it does not depend
on which identity wrote.

And prefer **not writing back at all**: check whether the app already made the same write in the
same user action. A duplicate write whose only effect is to arm a loop should be deleted.

**Use both layers: filtering attributes to cut the run count, the sentinel to guarantee
termination.** `filteringattributes` (Select columns) is Microsoft's recommended way to stop a flow
running on irrelevant edits, and it saves billed runs - use it, and never write a column that
appears in the filter. But do not make it the **only** loop protection: it is a registration-time
setting you cannot see working from source, and in one project two update triggers carrying
filters were found subscribed to nothing for eleven days (observed once; treat as "verify, do not
assume"). So after deploying a filtered trigger, **prove it registered**: every subscribed
Dataverse trigger has a row in `callbackregistration` (`GET callbackregistrations?$select=name,entityname,message`)
- count rows against activated Dataverse-triggered flows, which is how the eleven-day gap was found
(3 rows where 7 were expected) and the repair proved - and perform a qualifying edit and confirm a
run appears in run history. Keep the sentinel guard in the flow regardless.

**Check it mechanically**: intersect the attributes a flow guards on with the columns it writes to
its own trigger table, and fail when that intersection is **empty**. (Note the direction - a check
asserting the opposite passes every looping flow.)

## 4. Loops between flows, and bookkeeping writes

- **Loops between flows are invisible to a per-flow guard.** Flow A fires on X and writes Y; flow B
  fires on Y and writes X; each passes "does not write its own trigger table". Build one graph of
  every flow's trigger table and written tables, and fail on any cycle. List every `Foreach` with
  what it walks (a query result fixed before the loop, never something the body grows), and treat
  every `Until` as a finding unless somebody can say why it terminates.
- **A bookkeeping column on a watched table is a change, as far as every flow is concerned.** An
  "editing by / editing since" marker written when someone opens a record fires every update flow
  on every open - change-log rows, and "your record was changed" emails when an admin merely
  looked. With filtering attributes unavailable: give the bookkeeping write a tell (stamp
  `EditingSince = Now()` on set and clear; blank both inside every business write) and add one
  clause to each flow's existing gate: skip when `modifiedon` is within a few seconds of
  `EditingSince`. Make it **fail open** (a larger skew behaves as before the column existed).
- **The trigger fetches the row when the run starts, not as it was at the event.** A marker written
  one second after a Submit made the Submit look like a marker write, and the submission flow
  skipped it. Never write bookkeeping within the window of a business write - defer it (a Timer
  tick later).
- **A flow's "did the app already do this?" lookahead can race the app.** A logger ran about one
  second before the app wrote its own log row, so every submission got two rows. Add a `Wait`
  before the lookahead sized to the app's **whole** chain (patch header, rewrite lines, write log),
  and put cheap exits **before** the wait so runs that should stop still stop in under a second.
- **Every app write is a trigger event, including the ones inside a loop.** A canvas save that
  patched the header once per line inside a `ForAll` re-fired an update-triggered change logger per
  patch: one submit wrote thirteen change rows. Patch the header once, after the lines.
- **A log derived from the current state cannot say what happened.** A logging flow wrote its
  action from the row's *current* status, so every edit of an approved record also logged
  "Approved" - and a later flow that took "the latest Approved row" as the approval moment had its
  clock reset by every edit. The source read correctly and every audit passed; only expanding the
  condition of a real run showed it. Log a **transition** (record status-before and status-after;
  a row counts as an approval only when status-before is not null and differs), and log "Edited"
  when the status did not move.
- **Backfilling a new column is a bulk write to a watched table.** It churns `modifiedon` on every
  row and fires every update flow on the table (section 12). On a shared table, prefer reading a
  blank as the default (`<> false`) over a backfill.
- **A flow-written change log sees every writer; an app-written one sees only the app.** Maker
  portal edits, scripts, imports and other clients leave no trace in a log the canvas app writes. If
  the log must be complete, it belongs in a Dataverse-triggered flow (or native auditing) - with the
  loop and bookkeeping rules above. Keep owner, actor and "on behalf of" as separate columns.

## 5. Activation is the only compile

Turning a flow on runs a **server-side template compile**. Nothing else does: `pac solution pack`,
`pac solution import`, and any source audit accept a definition the runtime rejects:

```
InvalidTemplate: The inputs of template action 'X' cannot reference action 'Y'.
Action 'Y' must either be in 'runAfter' path or within a scope action on the
'runAfter' path of action 'X', or be a Trigger.
```

So "it imported" means nothing until the flow turns on. And **a flow shipped deliberately off** -
scheduled, destructive, or held for go-live, all normal - never reaches that gate: the defect
surfaces the morning it is first needed. Turn every flow on once after import, even if it then goes
straight back off until go-live.

- **Activate over the Web API and read the refusal.** `PATCH workflows(<id>)` with
  `{"statecode":1,"statuscode":2}` turns a flow on (the compile happens here);
  `{"statecode":0,"statuscode":1}` turns it off. On refusal print `ErrorDetails.Message` in full -
  it names the expression it could not parse. Activation calls sometimes hit a gateway timeout and
  had succeeded anyway, or succeeded on retry: **re-read `statecode`** rather than trusting the
  call's result.
- **An action may only read what it can see**: the transitive `runAfter` closure within its scope,
  anything nested inside those actions, and whatever the enclosing scope inherited. The classic
  trap: a condition whose expression reads an action nested inside that same condition - circular,
  can never run.
- **Assert visibility in source.** Resolve each action's visible set (handling If/else, Switch
  cases and default, Foreach, Until, Scope) and report any `outputs()`, `body()`, `actions()`,
  `result()` reference outside it. About 60 lines, no network. `lint-flows.mjs` does this.
- **Open Flow checker before switching on for real.** A switched-off flow's only warning there is
  "This flow is off", so it is worth reading only after the activation pass.

## 6. Five defects that are only rejected at activation

Each of these packs, imports and passes a source audit that does not look for it.

1. **An apostrophe inside a single-quoted expression literal.** The only escape is doubling the
   quote, so ordinary English ends the literal early:

   ```
   @{if(empty(x), 'Nothing is waiting in the team's queue.', join(y, ''))}
                                                 ^ the literal ends here
   ```

   Activation says *"the string interpolation segment starting at position '4480' is not
   terminated"*. **Reword** rather than doubling (`''` in prose gets "fixed" by the next person).
   Do not detect it by checking whether the whole string ends inside a quote - a later apostrophe
   flips the state back. The reliable signal: hitting the next `@{` while still looking for this
   segment's `}`, since interpolation cannot nest.
2. **A property NAME that starts with `@`.** The runtime evaluates a leading `@` in JSON keys, not
   only in values. A `GrantAccess` (or other `PerformBoundAction` / `PerformUnboundAction`) body
   needs a key `"@odata.type"`, and written that way it fails activation:

   ```
   TemplateValidationError: Unable to parse template language expression 'odata.type':
   expected token 'LeftParenthesis' and actual 'Dot'.
   ```

   Write `"@@odata.type"`; the runtime renders it back to a single `@`. Keys that merely contain
   `@` (`item/app_Owner@odata.bind`) are fine - only a leading single `@` is evaluated.
3. **More than one trigger.** A definition built from connector (`OpenApiConnection*`) operations
   may declare exactly one trigger. One with three packed and imported, then was refused: *"the
   workflow containing Open Api Connection operations do not support multiple triggers"*. Split it
   into one flow per trigger.
4. **A guessed entity set name.** Dataverse pluralises irregularly; a wrong set packs, imports,
   activates, and fails at **run** time with *"Resource not found for the segment"*. Read it from
   metadata (`EntityDefinitions(LogicalName='x')?$select=EntitySetName`) or from the solution's
   `Entity.xml`, and audit every `entityName` in every flow against that list. Found once in a
   lookup action upstream of every send in a scheduled reminder - the whole reminder would have
   failed on its first real morning. (Strictly a run-time failure, listed here because it hides in
   exactly the same place.)
5. **An action reading another action not on its `runAfter` path** (section 5).

## 7. Dates, nulls and `if()`: defects that fail at run time, or never

These pass activation. Some fail every run; the worst succeed and do the wrong thing.

- **A date-only stamp is midnight.** A flow decided "the record changed after approval" by
  comparing `ticks(modifiedon)` with a **date-only** "approved on" column plus five minutes. A
  date-only value reads as midnight, so the test was true from the instant of approval, and every
  approval emailed its owner a false "your record was changed". Date-only columns also reject a time
  part on write, and a column's behaviour can go from User Local to Date Only but **never back**, so
  the column could not be fixed. Rules:
  - Create **event** stamps (approved, submitted, processed) as User Local date-time and read the
    behaviour back from metadata. Calendar facts (a period start, a closure day) are correctly date-only.
  - Never put a date-only column inside `ticks()`, `addMinutes()`/`addHours()`, or a comparison with
    `utcNow()`, `modifiedon` or `createdon`. `lint-flows.mjs --date-only cols.json` flags it.
  - If the stamp is already date-only, take the moment from somewhere that has one - the platform
    `createdon` of the log row that recorded the transition (section 4).
- **`@{null}` is an empty string, and an empty string is not a date.** An optional date or lookup
  read from a sparse payload, interpolated into a parameter, fails the action with
  `OpenApiOperationParameterTypeConversionFailed`. Read from a retrieved row and `coalesce` optional
  values. One project's 103 failing runs all had this signature (section 14).
- **`if()` may evaluate both branches.** `if(empty(enddate), 'open-ended', formatDateTime(enddate,
  'yyyy-MM-dd'))` still runs `formatDateTime(null)` and fails - on every row without an end date,
  which is the ordinary case. Guard inside the branch (`formatDateTime(coalesce(enddate, '1900-01-01'), ...)`)
  or compute in a separate Compose behind a condition, and **test with a fixture that has neither
  optional date**.

## 8. An import applies the repo's on/off state

Each flow's `.json.data.xml` sidecar carries `<StateCode>` and `<StatusCode>`, and an import applies
**those**, not whatever is live. The common advice "import flows deactivated" is right for a flow's
**first** import, when its connection references are not yet bound. For a flow that is already
running it is a trap:

- One audit found five flows **Draft in the repo and running in production**; the next import would
  have switched off every record-triggered notification and reported success.
- Separately, an import of eight changed flows printed *"The original workflow definition has been
  deactivated and replaced"* and *"Solution Imported successfully"* - and one of the eight did not
  come back on. Nothing named it.

- **Keep the repo's state in step with live.** Whenever a flow is switched on or off in the
  environment, edit its sidecar in the same change.
- **Diff flow state after every import.** The import script reads each sidecar's declared state,
  queries `workflows?$select=name,statecode&$filter=category eq 5`, and prints every flow not in
  its declared state with the exact command that fixes it. An audit compares repo and live on every
  run: a **state** mismatch is a finding; a **definition** mismatch is a note (normal between a
  change and its import).
- **Activation scripts select by name, and refuse to run bare.** An activation script whose default
  filter matched every app flow would, run bare, have switched on the deliberately-off scheduled
  reminders to the whole roster. Require an explicit name (or make the default match nothing),
  support `-WhatIf` and run it with `-WhatIf` after every import to print what would change, and
  write "never run bare" wherever the command is printed.
- **Park and restore by recorded state.** A helper that parks flows records each named flow's state,
  turns off only those that were on, and re-reads; restore turns back on only those that were on,
  and refuses if the re-read differs from the record. "Turn the flows back on" without that record
  also turns on whatever was deliberately off.
- **Before switching flows on for real**: read each deployed definition back from
  `workflow.clientdata` and confirm it matches git; open Flow checker on each; read about four weeks
  of run history for failures; walk the cross-flow chains (section 4).

## 9. Who a flow runs as: connections, restricted reads, sharing

Every action runs as the **owner of the connection** behind its connection reference. That owner's
privileges are part of the system's security, and their account is part of its availability.

- **Decide connection ownership before building flows.** Under a personal account, flows stop when
  that person's password, licence, MFA or role changes, with no error to users, and every email
  appears to come from them. In one project an integration running on one person's connection
  stopped answering days before go-live, and nobody could add new work items. Use a service
  account, or at least a named owner with a fallback, and list each connection's owner in the
  dependency register.
- **Moving connections off a person**: create each connection under the new account (one
  interactive sign-in), point each connection reference at it, then turn each flow off and on.
  Binding every flow through connection references is what makes this a rebind rather than a
  rebuild.
- **Let the flow's identity read what users must not.** Where a value is sensitive (a pay rate, a
  cost), keep it out of every user role and let a server-side flow resolve it: on approval, the
  flow finds the value effective for the business date (not today), snapshots it onto the record,
  and nobody - employee, approver or delegate - is ever granted the table. **Fail closed**: on zero
  or more than one match it writes nothing and alerts a support mailbox. That rule caught a live
  case where most people had two active rows of different types (the query was missing the type
  filter - see the grain rules in `dataverse.md`). Verify **both halves**: the snapshot lands, *and*
  a non-admin still cannot read the source table from a non-app client (Web API or Excel). Measure
  the match cardinality in live data before enabling an "exactly one" rule, or it alerts on every
  run from day one.
- **Share rows to the people they are addressed to.** With Basic-depth roles a row is readable by its
  owner, not by whoever a lookup on it names - an approver can be emailed about a request they
  cannot open. A flow running as the service identity can call `GrantAccess` for each addressee
  (remember `@@odata.type` in its body, section 6). Do it **outside** any notification branch, so
  switching channels off cannot also remove access, and verify with
  `RetrieveSharedPrincipalsAndAccess` and impersonation rather than by reading the flow. The role
  design and the costs are in `security-and-access.md`.

## 10. Notifications: hidden failures and safety switches

**Failures that leave the run green**

- **Teams running after `Succeeded, Failed, Skipped` on an email hides a failed email.** A failed
  action whose successor accepts `Failed` does not fail the run; history is green and the only
  evidence is a person saying "I got the Teams message but no email". If the channels are
  independent, make them **parallel siblings** off a common predecessor: a failed email then fails
  the run, and Teams still posts. If one is a fallback, say so and add a step that surfaces the
  failure.
- **A send that resolves to nobody succeeds.** A comment flow's first condition was "recipient is
  not empty", but the app filled the recipient only when a specific person was picked; the normal
  path wrote an **audience** (a group). Every audience-routed comment notified nobody, and every run
  Succeeded. Resolve each audience type to an address list in a Compose (named person, a configured
  group list, current delegates; drop the writer), treat an empty list as a finding rather than a
  quiet skip, and test **each UI path** that creates the row. Write down the app-to-flow field
  contract: which fields the app writes, which the flow reads.
- **Skip self-notification**: compare author and recipient with `toLower()` on both sides. Mail
  about one's own action is the fastest way to get a channel muted. So is one email per write when
  one save touches many rows - use a digest (below).

**Sending as a mailbox, not as a person**

`SendEmailV2` (*Send an email (V2)*) sends as the connection owner. `SharedMailboxSendEmailV2`
(*Send an email from a shared mailbox (V2)*), with `emailMessage/MailboxAddress` read from a
settings row at run time, fixes the visible sender without touching connections. It has **no
fallback**: a blank value, a typo, or a missing Send As permission fails every send. That is better
than the old shape failing open as a person, but sequence the switch: grant **Send As** on the
mailbox to the connection's account, *then* change the setting, *then* make one narrowed test send
(section 11). Make the settings editor refuse a blank or `@`-less address. In one tenant the action also accepted
an ordinary user mailbox, which let flows send before the shared mailbox existed - tenant-specific;
mailbox permissions still apply.

**Safety switches**

- **A safety device must fail toward silence, not toward everybody.** A notification cap that
  intersects recipients with an allowlist, with the rule *"if the allowlist is empty, send to real
  recipients"*, makes the safe state depend on a field being full - so a cleared box, a failed
  read, or an unseeded environment addresses the whole organisation. (One project's first version
  was exactly that: blank meant "no cap", so go-live was clearing one row.) **State the dangerous
  mode explicitly and treat everything else as safe**: `if(mode == 'Production', <real recipients>,
  <intersection with allowlist>)`. Nothing opens the doors except the exact word. Same shape for a
  boolean switch: anything that is not literally `false` is ON.
- **Put the cap in a named Compose so run history shows who survived.** Per send: `Cap_<send>` (a
  Compose holding the capped list) and `Allowed_<send>` (an If that skips the send when the list is
  empty). An inline expression in the To field proves nothing afterwards; the Compose output is
  "who this would have emailed", read rather than reasoned about. **Cc is a recipient too** - cap
  it the same way; an audit that checks only To misses it.
- **Do not narrow the real recipient setting "to be safe".** It corrupts the record of the intended
  audience. Narrowing is the allowlist's job.
- **Separate WHO may be reached from WHICH CHANNEL is live**, so communications can be paused
  without losing the record of who they would have gone to. Audit that every person-facing send
  sits inside **both** gates: one flow had seven sends behind neither channel switch while the
  allowlist half of the audit was satisfied. Keep deliberate exceptions (a fault report to support
  that must ignore the channel switch) as a named list, each one a decision.
- **Read switches once, at the top level, immediately before sending** - not inside a
  per-recipient loop (about 316 extra calls a week for two reminders in one project). There is no
  `filter()` function, so read each setting with its own filtered List rows call. Make the settings
  editor and the flow use the identical truth rule. Leave ungated only a message the user cannot
  learn any other way ("your approver has no account").
- **A flow that is ON with its channel OFF still runs**, and shows the suppression in run history.
  A mode cap limits who a run reaches, not whether it runs.
- **Mark every non-production message.** Outside Production, prefix the subject (`DEVELOPMENT TEST
  - `) and open the body with a banner, through one `@{if(<is production>, '', '<text>')}` keyed
  off the **same** mode reader as the cap. A tester on the allowlist can tell a rehearsal from the
  real thing, and go-live needs only the mode change it already requires. Apply it by script across
  every send, and have an audit fail any send without it - a send added in the designer will not
  have it.
- **Seed files are switches too.** A settings seed replayed in full still carried both channel
  switches **on** while live was off; any re-seed would have turned email and Teams on for five live
  trigger flows. Seed the safe value, and audit seed files with the same rules as live settings.
- **Pilot onboarding includes the allowlist.** A test-mode allowlist silently drops new pilot
  users' messages. Widening it while the mode stays non-production and channels stay off raises the
  ceiling without sending anything.
- **Make the irreversible direction cost two presses and the safe direction one.**
- **Audit the rule, not just the mechanism.** "Every send intersects against the allowlist" was
  true of the dangerous version too. Check that the cap keys off the mode, and follow each
  switch-reading expression **by reference** to the row it reads - a match on the reader action's
  name passed a reader repointed at an unrelated setting.

**Scheduled mailers are a different risk class.** A trigger flow mails the people involved in
something a person just did. A scheduled flow mails whatever its query returns, unattended, often
the whole roster. Keep an audit that reads **live** state by default (a source-only run cannot say
"is it on right now"), fails if any scheduled broad sender is on without sign-off, and reports
SKIPPED - not pass - when live state cannot be read.

**Digests: a queue table plus a last-sent watermark**, not "rows modified since". The trigger flow
writes a queue row (recipient, and what changed, at that moment); the scheduled flow covers
last-sent-to-now, groups by recipient, marks rows sent and advances the watermark. A late, retried
or missed run then sends exactly once and skips nothing, failed sends stay visible as data, and the
digest knows who a change was *for* - which a later re-read of `modifiedon` cannot tell, since
ownership may have moved. Keep the cadence (immediate, daily, weekly) in a settings row.

## 11. Testing a sending or scheduled flow without mailing anyone

A flow first switched on at go-live has never run. Prove it first:

**A trigger flow that sends**: narrow the allowlist to yourself, turn the channels on, and make
**the same write the app makes** on a test row. Read the run: one send to you, the others capped
(visible in the `Cap_` Compose). Restore the allowlist and switches, delete the row, and read every
setting back. For a single hands-on test on real data, park the flow that would notify someone,
make the attempt, restore it, and confirm nothing was written (`modifiedon` unchanged).

**A scheduled flow**: (1) switch the channel settings off and narrow recipients to one person;
(2) temporarily pin the flow's date parameter to a past period that has data; (3) activate that
flow alone, run it by hand, and read the run; (4) check each send shows *Skipped,
ActionBranchingConditionNotSatisfied* - proof the switch held; (5) revert the pin as a targeted
edit, not a whole-file checkout; (6) re-import, switch the flow off, confirm with `-WhatIf`;
(7) read back every setting.

Prove any calendar lookup inside it on known dates (a closure day, the day before, the day after) over
the Web API first, and hoist invariant lookups ("is today a closure day") out of `Apply to each` to the
top level with an early terminate - inside a per-person loop it cost two calls per person per run.

## 12. Bulk writes are mail-merges

A trigger flow that is ON, correct, loop-guarded and desirable fires **once per row**. A migration
touching a thousand rows fires it a thousand times; if it sends, that is a thousand emails to real
people - from a script whose description is "write a column onto some old rows".

**Ask what watches the table before any bulk write, every time** - the answer changes whenever a
flow is switched on.

- **Count the messages, do not describe them.** "This may generate notifications" gets skimmed;
  "366 rows x 2 send steps = up to 732 messages to real people" stops somebody. A small script can
  read the live on/off state of every flow (the `workflow` table: `category eq 5`, `statecode`),
  read each definition from `clientdata`, match trigger table and message, and print that
  arithmetic with exact off/on commands. It exits "could not check" (not pass) when it cannot read
  the environment, and says that plug-ins and business rules are not covered.
- **Say that the count is an upper bound** - it counts flows that fire, before each flow's own
  first condition. Read each named flow's guard and work out the true number. In one case the
  qualifying rows were migrated history with no approval date, and the sending flow required one:
  the real figure was zero, not 732. An unqualified alarming number is how a check gets ignored.
- **Senders are not the only cost.** An unguarded change-log flow would have written hundreds of
  "total now 40" audit rows recording changes that did not happen. **Deletes are bulk writes too**:
  during a test-data purge a delete-triggered logger wrote a blank "Deleted" row per record, which
  then needed cleaning.
- **Park the watcher, do not hope - and put the interlock in the migration.** The script reads the
  live state of the flows that watch its table and **aborts** unless they are off, printing the
  exact off/on commands. Switch the specific flows off by name, run the write, restore exactly the
  recorded state (section 8), and verify it both times. A bare "turn the flows on" at the end also
  turns on whatever was deliberately left off.

## 13. Aggregates and joins: use FetchXML

The workflow definition language has no `sum()`, and `filter()` is not a function (Filter array is
an action). The usual `foreach`-accumulate workaround is slow, needs `concurrency: 1` to be
deterministic, and gets worse when nested to join two lists.

The Dataverse **List rows** action has a **Fetch Xml Query** parameter (`fetchXml`), and FetchXML
does aggregates and joins:

```xml
<fetch aggregate="true"><entity name="app_orderline">
  <attribute name="app_amount" aggregate="sum" alias="total" />
  <attribute name="app_order" groupby="true" alias="orderid" />
  <link-entity name="app_product" from="app_productid" to="app_product" alias="prod">
    <filter><condition attribute="app_category" operator="ne" value="Samples" /></filter>
  </link-entity>
</entity></fetch>
```

Chained `link-entity` flattens a two-hop join (an order line, its order, that order's account)
into aliased columns on one row, which `$expand`
cannot do. Two things to know: **an alias with no matching rows is absent** rather than zero, so
`coalesce` every aggregate; and **`if()` may evaluate both branches** (section 7), so keep anything
that can raise outside them (convert with total functions like `string()` inside, apply `float()`
once to the result). **Prove the FetchXML against the Web API first**
(`GET /api/data/v9.2/<set>?fetchXml=<urlencoded>`), so only "does the connector accept it" is left
to verify in the product.

**FetchXML is a dependency nobody sees.** A flow that names columns inside a FetchXML string breaks
at **run** time - on the next scheduled morning - when any of those columns is retyped or its
relationship rebuilt, possibly by another team on a shared table. A flow that finds a row by its
display name ("Walk-in") breaks when the row is renamed. Record each flow's tables, columns and
literal names in the dependency register, and log a dependency notice on a shared table when a flow
**starts** reading one of its columns, even though nothing changed. Generate the register's flow
table from `Workflows/*.json` by script (trigger, reads, writes, channels) with a `--check` mode in
the audit suite; one hand-written table listed six invented flows against eleven real ones. Keep
live on/off state out of it - that changes without a commit.

**A rule that lives in both Power Fx and a flow will drift.** The two languages cannot share a
function. One credit limit ended up in six places (three screens, `App.OnStart`, FetchXML in three
flows), and a flow kept a constant the app had made dynamic: same period, two answers. Have both
read the same tables, have the flow **print its derivation** in the message or a Compose
("standard 5,000 less 1,000 on hold"), keep a register of every copy, and have an audit compare the
option values in the flows' FetchXML with the app's enums.

## 14. Run history is a table

`flowrun` is an ordinary Dataverse table - you do not need the portal:

```
GET /api/data/v9.2/flowruns?$select=name,starttime,status,duration,errorcode,errormessage,_workflow_value
    &$orderby=starttime desc
Prefer: odata.include-annotations="*",odata.maxpagesize=5000
```

- **Read `duration`, not only `status`.** A guarded flow that decides to do nothing and one that
  does the full send both report Succeeded; they are ~200 ms and ~4,700 ms (another project: 552 ms
  guarded, about 3 s with sends). That one column picked the single real send out of 23 runs.
- `_workflow_value@OData.Community.Display.V1.FormattedValue` gives the flow's name, so a per-day,
  per-flow count is one query - which is how a trigger loop is measured after the fact.
- Open a failed run's trigger outputs to read `SdkMessage` and the actual payload before theorising.
  Appending `?v3=false` to a run's URL (`.../flows/<id>/runs/<runid>?v3=false`) opens the classic
  view, which shows every action's inputs and outputs.
- **Expand the conditions of a run that Succeeded.** A logic fault in a green run showed only by
  expanding the condition and seeing *Skipped* where the branch should have run. Open one real run
  per branch of a new guard, and put each arithmetic step in its own Compose so the working is in
  history.
- **Judge a run only against the definition that was live when it started.** Runs that "proved" a
  flow still broken had started 28 minutes before the fix was deployed. Compare run start times with
  the deploy time, and discriminate with a paired experiment - two fixtures differing in one
  attribute - plus duration.
- **"It is a licence problem" needs a run to prove it.** One team believed for eleven days that
  Dataverse triggers were blocked by licensing and planned a purchase. `flowrun` showed 103 runs
  whose trigger had fired and whose action failed with
  `OpenApiOperationParameterTypeConversionFailed` - an empty string for a date (section 7). A
  licence or DLP block returns 403 or suspends the flow; it does not produce a parameter error,
  which means the action was invoked. The earlier "not delivered" diagnosis was really invoker
  runtime and a wrong message code (section 2). Licences are still a real lead-time item - in
  another project correctly built flows never ran until the owner's licence arrived - so request
  them early, but diagnose from run history before buying, and re-measure an old negative finding
  before acting on it.

## 15. A checklist for every flow

- [ ] It lives in the solution; one trigger; one root action.
- [ ] `runtimeSource` is `embedded` unless the trigger is Power Apps (V2).
- [ ] Trigger message code is right (1 Create, 2 Delete, 3 Update), proved from a run payload;
      registration counted in `callbackregistration`.
- [ ] Update handlers re-read the row; delete handlers tolerate missing fields; no design depends on
      prior values from the trigger.
- [ ] Any write to the trigger table is guarded by a value that write changes; no cross-flow cycle;
      logs record transitions, not current state.
- [ ] Every action reference is on its `runAfter` path; no apostrophes in single-quoted literals;
      no property name starting with a single `@`; every `entityName` is a real entity set.
- [ ] No date-only column used as an instant; optional dates `coalesce`d; tested with a fixture
      missing every optional field.
- [ ] Sends are parallel siblings, not chained after `Failed`; recipients resolve to a non-empty
      list; any cap keys off an explicit mode and sits in a named Compose covering To and Cc; every
      send is inside both the recipient gate and a channel switch, and carries the non-production
      banner.
- [ ] Sender is a mailbox with Send As granted, not a person; connection owner is a service
      account or a named owner with a fallback.
- [ ] Imported; connections exist and are bound; turned on once to compile, even if it then goes
      back off until go-live; repo sidecar state matches the live state you intend; state diffed
      after the import.
- [ ] Before any bulk write or purge to a watched table: messages and log rows counted, true figure
      worked out, watchers parked by name and restored to their recorded state.
