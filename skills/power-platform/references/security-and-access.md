# Security and access in Dataverse

Who can read and write what, and how to prove it. Everything here shares one property: **a System
Administrator sees none of it fail.** You read every table, every secured column and every row, so a
missing privilege cannot be observed from your own account - the app works for you and fails for every
real user, and no build, compile, audit or App Checker run says so. Packaging is in `dataverse.md`;
the Web API mechanics are in `dataverse-web-api.md`.

## Contents

1. Security roles stay out of the solution
2. Every table the app binds or writes needs a role
3. Prove access by impersonation, and allow for caching
4. Roles as code: `ReplacePrivilegesRole` converges
5. Reading roles back: depth is a string, platform roles are managed
6. Ownership and depth in a single business unit
7. Record sharing: rows invisible to the person they address
8. Column security
9. Restricted data that a process must use
10. App gates are not a boundary
11. SharePoint virtual tables run as the connection owner
12. Onboarding a user: four gates, licence first
13. Changing production access when you cannot (or should not) do it yourself

---

## 1. Security roles stay out of the solution

**A solution carrying security roles resets live access control on import.** One import of four role
components reset them to definitions a month old: 64 missing privileges (the live roles had since
been extended with Read on shared tables), no non-administrator able to open the app, and nothing
visible to the administrator who imported it.

- **Build roles in the target environment** (section 4), test with a non-admin, and keep them out of
  the solution zip.
- **Stripping roles in the ship script protects only builds made by that script.** A hand-taken
  export still carried them. Remove the role components from the solution itself
  (`RemoveSolutionComponent`, `dataverse-web-api.md` section 10); the environment then becomes
  authoritative for security.
- **Verify the removal three ways**: zero `solutioncomponent` rows of type 20 for the solution, zero
  `RootComponent type="20"` in a fresh export's `solution.xml`, zero `<Role>` under `<Roles>` in its
  `customizations.xml` (only `unpack` explodes them into `Roles/*.xml`). Count privileges per role
  before and after.
- **Keep the strip step anyway**: it catches a role re-added through the maker portal.
- The trade: with more than one target environment, roles must then be created in each - which is
  what a role script (section 4) is for.

## 2. Every table the app binds or writes needs a role

**A table the app binds that no role grants is invisible to you and fatal to everyone else.** One app
shipped for months with a table bound by its main screen and absent from the role matrix; the first
non-admin tester could not submit at all. Another missed a change-log table the app only **creates**
into - a write-only table is easy to forget, and reading the spec found nothing; checking against the
app's actual write paths did.

- **Rule:** when a table is added to the app, it is added to the role matrix **in the same change**.
  A data source is not a data source until some role can read it.
- **Audit it from the app's side.** Enumerate the tables the canvas source binds and writes, map them
  to logical names via the solution's `Entity.xml` (or the app's `DataSources.json`), and fail when
  one is granted by no role that reaches the screen using it. Security audits usually ask whether a
  role grants too much; ask the opposite too.
- **Assign Basic User alongside custom roles.** Custom app roles carry no platform privileges
  (organisation, user settings, and so on), and a custom role alone fails at start-up on baseline
  tables. Assign the stock **Basic User** role as well; do not copy its privileges into the custom
  role, where they drift.
- **Setting a lookup needs Append on the source table and AppendTo on every target.** Miss one and the
  save fails with a permission error that **names the wrong table**. Derive the AppendTo targets from
  live `ManyToOneRelationships`. AppendTo grants no read.
- **A new column needs no new privilege** - table-level read covers it (column security aside,
  section 8).

## 3. Prove access by impersonation, and allow for caching

Reading the role definition tells you what somebody intended. The Web API's `MSCRMCallerID` header
names a user id; the call runs as them, without their credentials and without writing anything:

```powershell
$h = @{ Authorization = "Bearer $token"; MSCRMCallerID = $theirSystemUserId }
Invoke-RestMethod -Headers $h -Uri "$api/app_orders?`$top=1"
```

A denial says so plainly: `is missing prvReadapp_Order privilege`. Run it across every table a screen
touches, for one user of each role.

- **Privilege changes can take minutes to apply.** After a role fix, an affected user's reads kept
  failing for several minutes with an unchanged privilege count, then cleared; another time it was
  immediate. Retry an impersonated check over a few minutes before concluding a fix failed.
- **`RetrieveUserPrivileges` is not a quick check.** Called as an unbound action it returned "Resource
  not found for the segment"; it is a function bound to `systemusers(<id>)`. An empty or failed result
  is not evidence that the user lacks a privilege.
- Impersonation proves Dataverse access only. It says nothing about app-level gates, and a test of an
  app gate as yourself says nothing about Dataverse access - keep the two claims separate
  (`browser-verification.md`).

## 4. Roles as code: `ReplacePrivilegesRole` converges

Keep the privilege matrix (table x role x privilege x depth) in a script and apply it through the Web
API:

1. Resolve the root business unit: `businessunits?$filter=_parentbusinessunitid_value eq null`.
2. Read each table's privileges with `EntityDefinitions(LogicalName='app_order')?$select=Privileges`.
   `Privileges` is a structural property: `$expand` fails "Only navigation properties can be
   expanded".
3. Apply only the privilege types the table exposes - organisation-owned tables have no Assign or
   Share.
4. Derive Append/AppendTo from live relationships (section 2).
5. Apply with `roles(<id>)/Microsoft.Dynamics.CRM.ReplacePrivilegesRole`, one batched call per role.
   For an additive grant, `AddPrivilegesRole` takes the parameter `Privileges`, not `RolePrivileges`
   (that is the relationship name, and is rejected as not a valid parameter).
6. Offer `-WhatIf` and `-Report` modes, and re-read afterwards.

**`ReplacePrivilegesRole` converges the role onto exactly the list sent.** That makes the script
idempotent - and it **removes anything not in the list**. An emergency privilege granted by a separate
migration, or by hand in the portal, is stripped the next time the role script runs. So privileges
belong in the matrix or nowhere; before re-running after a gap, compare the live roles with the old
matrix to find manual drift.

**Design roles so sensitive grants live in a role of their own.** A privilege cannot be subtracted
from one member of a role: to stop one person reading one table, the only instrument was removing
them from the role, which cost them about 120 unrelated privileges.

**Roles can arrive through teams.** An Entra security group mapped to a role through a group team is
how a roster of admins becomes enforced; a person may hold a role only through such a team.

## 5. Reading roles back: depth is a string, platform roles are managed

- **`RetrieveRolePrivilegesRole(RoleId=...)` returns `Depth` as a string** - "Basic", "Local", "Deep",
  "Global" - not the SDK's 1/2/4/8 mask. Comparing it to an integer is always unequal and never raises;
  one over-permission check reported the opposite of the truth in both directions. The response also
  carries `PrivilegeName` directly.
- **Verify a role as a superset of the matrix, not by exact count.** Granting Read on a SharePoint
  virtual table makes Dataverse add its own `prvReadSharePointData`, `prvCreateSharePointData`,
  `prvWriteSharePointData` and `prvReadSharePointDocument`.
- **Page privilege reads.** A `$top=5000` read of the `privileges` table silently truncated.
- **Role holders:** `roles(<id>)/systemuserroles_association?$select=fullname,internalemailaddress,isdisabled,applicationid`.
  This misses roles inherited through teams; include team membership when the question is "who can
  read this table".
- **Platform roles vs yours: use `ismanaged`.** First-party service principals hold managed roles with
  blanket privileges on every table in every environment; one audit's first run produced 52 such
  "findings" out of 61. Roles created in the environment are unmanaged. List managed-role holders and
  application users as information, and fail only on roles someone here can change - never by a name
  list.

## 6. Ownership and depth in a single business unit

- **Ownership (User vs Organization) is fixed when the table is created.** Rows that need row-level
  security must be user-owned from the start; reference and configuration tables are usually
  organisation-owned.
- **Basic (User) depth does not exist on an organisation-owned table** - such tables are Global or
  nothing - so "may maintain only their own rows" cannot be enforced there. One spec put User depth on
  an org-owned table.
- **In a single-business-unit environment Local, Deep and Global all mean everyone.** Basic is the
  only real restriction. There is no "my direct reports" depth; team scope needs record sharing
  (section 7).
- **Use Global read on shared reference tables.** A narrower depth makes rows vanish by ownership,
  which looks like partial data.
- **A table a delegate or second user must read** should be organisation-owned when its rows are not
  sensitive; user-owned rows scope to their creator.

## 7. Record sharing: rows invisible to the person they address

**A Basic-depth row is readable by its owner - the person who wrote it - not by whoever a lookup on it
names.** A returned record's comment, and a request an approver had to decide, both existed, were
emailed about, and showed the addressee nothing.

- **Share each row from a flow running as the service identity** - `GrantAccess` with Read, or
  Read/Write for whoever must act. In a flow body, the key `@odata.type` must be written
  `@@odata.type` (`power-automate.md`).
- **Share outside any notification branch**, so turning notification channels off cannot remove
  access.
- **Verify with `RetrieveSharedPrincipalsAndAccess` and impersonation**, not by reading the flow.
- **Costs:** every share writes a principal-object-access row, and until the flow runs the addressee
  sees nothing. Do not paper over that with Org-level read - not even as a "temporary" placeholder.
- **"My team" when hierarchy security does not fit.** Manager hierarchy security follows the Entra
  manager chain with one edge per person, but approvers are often not the line manager, and business
  units are blunt and slow to change. Sharing on submit to the resolved approver and delegates, from a
  reporting line the app owns, worked; reorganisations move people weeks before HR feeds catch up, and
  an app table can be corrected the same day.
- To demonstrate before the sharing flow exists, share individual rows; do not widen the role.

## 8. Column security

**Row access cannot hide one column of a row a user may read** - a pay rate on a record shared with an
approver is readable through Excel, the Web API or a model-driven view, whatever the canvas app shows.
Only column (field-level) security separates a column from its row.

- **Set `IsSecured` in `Entity.xml` and import.** It could not be set by a Web API attribute PATCH (405
  in every form tried); the documented full PUT (`dataverse-web-api.md`, section 7) was not tried for
  this, and a metadata change made outside packed source is reverted by the next import anyway.
- **Then create the field security profile and its `fieldpermission` rows** - in that order: a field
  permission cannot be created against a column that is not yet secured. Permission values are
  4 = allowed, 0 = not allowed. A profile can grant Read and deny Create/Update, so nobody rewrites a
  frozen value.
- **Members:** a System Administrator reads every secured column without membership; any other admin
  must be added to the profile by hand. Everyone else sees the value as **blank**, not an error - so a
  canvas formula reading it does not fail, it silently gets nothing.
- **Secure every copy** - snapshot columns and denormalized copies of the value too - and do it while
  the columns are empty; afterwards it is a notice, not a fix.

## 9. Restricted data that a process must use

When staff and approvers must not read a table (rates), anything that needs a value from it runs
server-side under its own identity:

- The approval flow resolves the value effective for the period worked and **snapshots it onto the
  record**, so no employee or approver is ever granted the table. Delegates do not inherit restricted
  data.
- **Fail closed:** on zero or more than one match it writes nothing and alerts a support mailbox. That
  rule caught a live case where most people carried two active rate rows of different types (filter
  on the type you mean - `dataverse.md`, section 14).
- **Verification proves both halves**: the snapshot lands, **and** a non-admin still cannot read the
  table from a non-app client (impersonation, section 3).

## 10. App gates are not a boundary

A hidden or disabled control does nothing against the model-driven app, Excel or the Web API when the
role grants the privilege. One inherited app gated access with a table of per-person booleans driving
`DisplayMode`, with no row security behind it: any user could read anyone's records through another
client, and system administrators bypass app gates the same way.

- **Keep app gates as UI; the roles are the boundary.** Where an app gate is a deliberate choice
  (admin-configurable without role changes), record it as an accepted risk with the conditions for
  revisiting it. Never gate with a password typed into the app definition - every co-author can read
  it.
- **Three "admin" populations rarely match**: the app's own admin list, the system administrators, and
  the people who can read sensitive data. Audit all three. A roster table says who the admins are; a
  group team mapped to a role enforces it. Keep them in step, or the console stays hidden from three
  people who hold the admin role while one hard-coded address sees it.
- **A lock or security table with no role grant fails open.** Tables created without a grant "because
  the lock check fails open for users without read" mean the check silently allows for exactly those
  users. Flag it as a hazard.
- **Security audit questions worth automating:** (A) every role, and every enabled human, holding any
  privilege on a sensitive table, against an approved list kept in the audit with a reason per name;
  (B) the app's own roles have not drifted above Basic on user-owned tables; (C) no Global read on
  transactional tables; (D) the app's admin list vs who Dataverse treats as admin; (E) every bound
  table granted by some role reaching its screen. Audit roles from **every** app sharing the
  environment: a role in a neighbouring app gave a new joiner read on sensitive data the day they were
  added, and a decision written in one app's log does not constrain another app's role - only a check
  does. Encode accepted exceptions as a **named** allowlist with reason and date, so the next principal
  still fails (`audits.md`).
- **A downstream copy is a second boundary.** An analytics pipeline that copies tables (over the TDS
  endpoint, for example) moves restricted data into a workspace whose membership must be held to the
  same standard as the Dataverse role.

## 11. SharePoint virtual tables run as the connection owner

SharePoint lists exposed as Dataverse virtual tables are read live - nothing syncs or goes stale, so
check whether they already exist before building a sync. But the data provider runs as **the owner of
the SharePoint connection**, not the caller.

When that owner's roles changed and they lost Read on `connectionreference`, **every read failed for
every user, system administrators included**; no record could be created because the picker was
empty. The error to recognise:

```
Principal user (Id=<owner>...) is missing prvReadconnectionreference privilege ...
on OTC=10083 for entity 'connectionreference'. context.Caller = <owner>
```

- `prvReadconnectionreference` is **not** among the privileges Dataverse adds automatically for virtual
  tables. Grant Read on `connectionreference` on every role whose users read them (it is metadata, no
  connector secret).
- The owner is a **single point of failure**: record it, re-check a read after any change to their
  roles or connections, and move the connection to a service account. A later outage on the same
  tables (`InternalServerError`, "A task was canceled") had no privilege change behind it - observed
  once, cause unknown.

Measured limits, in one environment:

- **Aggregates fail** ("aggregates aren't supported"; `$apply=aggregate` rejected; `CountRows`, `Sum`
  and the rest fail at run time in canvas).
- **Reading some choice columns fails** with "Specified cast is not valid" - read the formatted value,
  or coerce with `& ""` in Power Fx. **Filtering on** a choice works server-side, and is how a large
  list stays under the row limit.
- **A wide `$select` or an unfiltered read failed** while a narrow, filtered one worked; the `*name`
  virtual columns cannot appear in `$select` (400). Pages over 500 rows returned 429: read in filtered
  id-range pages of 500 or fewer.
- **The 2,000-row limit still applies** in canvas: a list over it must always be filtered.
- **Choice codes may not match intuition** - a `Status` coded 0 = Active, 1 = Inactive was read the
  other way round by a migration and its audit. Print code and label (`data-migration.md`, section 2).
- **They cannot take custom columns.** Put per-row rules in a native side table keyed on the business
  key, as a deny-list of exceptions (no row means available). Reference virtual rows from physical
  tables as a **validated text key plus a name snapshot** taken at entry, with an admin orphan report
  of keys that no longer resolve; roles then need only Read on the virtual table. A lookup from a
  physical table was untested. Confirm from live data which of two plausible keys is the real join key.

## 12. Onboarding a user: four gates, licence first

All four are needed, and each fails differently:

1. **A Power Apps licence** (Dataverse playback is premium: per-user, per-app or pay-as-you-go).
   Provisioning took days and blocked everything else, including the first non-admin proof of any
   gate. Request licences early - for users, approvers and flow owners - and build the request from
   live directory data rather than retyped names (that caught a misspelling and two wrong addresses).
2. **Basic User plus the app's role**, assigned directly or through a group team.
3. **The app shared as "Can use".** Without it the link says "you don't have access" before roles
   matter.
4. **An identity row holding the exact sign-in address**, or the user opens the app as nobody.

Routing data (an approver on their assignment) is separate again. **Diagnose before buying**: in one
project, triggers "not delivered" were blamed on licensing for days, and the causes were authoring
defects found in run history (`power-automate.md`). A licence block returns 403 or suspends the flow;
it does not produce a parameter error. Unverified: whether an app opens cleanly for a user with no
privilege on one bound source - watch the first non-admin sign-in.

## 13. Changing production access when you cannot (or should not) do it yourself

Testing a restriction needs a non-admin. Without a second account, deactivating your own row in the
app's admin roster proves **app-level** gates only; Dataverse privileges still need impersonation or a
real non-admin account. Say which was proved.

An AI agent's safety layer may refuse - correctly - to rewrite production roles, assign roles, grant
record access (`GrantAccess`, including editing a flow to add a sharing step), or remove the only
admin's access to test as a non-admin. Do not route around it. Hand the person one safe command: the
exact line to run, why it is safe to re-run (idempotent, live drift checked, exactly what it adds or
removes), what it unblocks, and the verification with its expected result ("section E goes from 2
findings to 0"). Then verify by impersonation, and record the feature as shipped-but-unproven until
that is done.
