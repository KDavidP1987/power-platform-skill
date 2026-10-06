# Power Pages sites

A Power Pages site is a website over Dataverse: its own address, its own sign-in, and security by
web roles and table permissions instead of Dataverse security roles. This reference covers when to
choose one, how to keep it in git, how to secure it, how to build pages that read and write, and how
to prove it works. Everything here was observed on a real site (enhanced data model, 2026) unless
it is marked as coming from documentation.

**Before the first page, settle three things** (sections 10 to 12): classic site or code site; how
rows that some signed-in people must not see are kept from them (table permissions cannot filter on
a column such as a "published" Yes/No); and how a row records whose it is. Getting any of them
wrong is a security defect, not a style choice, and the last two can need a schema change the owner
must agree to. **And put the go-live decisions to the owner in the same batch** (section 17): who
the audience is and how many (a Private site admits a fixed number of named people), where a
person's name and email come from when they are not a Dataverse user (section 18), the licence,
and how people are let in. A site that passes every test can still be unusable by the people it was
built for when these are left to the end.

| Section | Covers |
|---|---|
| 1-9 | app type, git, the two guards, sign-in, Liquid and Web API, cache, verification, security review, design |
| 10 | classic site or code site, and how each deploys |
| 11 | row-level visibility (a column decides who sees a row) |
| 12 | "my records": the contact lookup, scopes, Append and Append To |
| 13 | Web API settings, the anti-forgery token, error codes |
| 14 | Private sites, granting access, the trial |
| 15 | creating, activating and restarting a site without the Azure CLI |
| 16 | teardown |
| 17 | the go-live decisions to settle up front (audience and visibility, identity, licence, access) |
| 18 | name and email for people who are not Dataverse users |
| 19 | a write path that held every refusal: Web API off, Liquid reads, one server logic endpoint |

## 1. Choose the app type before the first screen

| | Canvas app | Power Pages site | Model-driven app |
|---|---|---|---|
| Who signs in | licensed users in the tenant | employees (Entra ID), external identities, or anonymous visitors | licensed users in the tenant |
| Licence | premium per user | per site, by monthly active authenticated or anonymous users; premium Power Apps users are covered | premium per user |
| Layout | positioned by you; responsive only if built that way | responsive web layout (Bootstrap) by default | generated from forms and views |
| Built with | Power Fx in `.pa.yaml` | Liquid, HTML, JavaScript, web templates; source by `pac pages download/upload` | forms, views, business rules |
| Security | Dataverse roles | web roles + table permissions (scope: global, contact, account, parent, self) | Dataverse roles |
| Best for | task-focused tools for staff | the many: submit, follow, read - without a premium licence each | record-heavy back-office work |

**The pattern that works:** split by audience, not by feature. The many (submitters, requesters,
customers) get a Pages site over a few tables; the few who evaluate, approve and run the process
get a canvas or model-driven app over the same tables. Do not mirror Dataverse into SharePoint to
avoid licences for readers - that is multiplexing, and it does not reduce the licences required.

A new site starts as a **trial** (section 14: 90 days in a production or sandbox environment, 30 in
a trial environment, and converting needs licences). Say so to the owner when you create one; the
conversion is their licensing decision, not a build step.

## 2. Keep the site in git

- `pac pages download --path site --webSiteId <id> --modelVersion 2` (enhanced data model) writes
  one folder per site: `web-pages/<page>/` (root page) with `content-pages/<Page>.en-US.webpage.*`
  (the language content page), `web-templates/`, `page-templates/`, `content-snippets/`,
  `weblink-sets/`, `table-permissions/`, `sitesetting.yml`, `webrole.yml`, `.portalconfig/`.
- `pac pages upload --path site/<site-folder> --modelVersion 2` writes changes back. An upload
  overwrites studio edits made since the last download - pull first if anyone used the studio.
- **Put page content in the content page** (`content-pages/<Page>.en-US.webpage.copy.html`, plus
  `.custom_css.css` and `.custom_javascript.js`), not the root page's copy: the default studio
  template renders the language content page.
- **New records can be written by hand.** A web page (root and content page), a table permission,
  a site setting or a web link written as YAML with a fresh GUID, in the shape of the downloaded
  records, is created by the next upload. Copy the field set from an existing record of the same
  kind; the root page needs `adx_isroot: true`, the content page `adx_rootwebpageid` and
  `adx_webpagelanguageid`. Web role links live inside the record (`adx_entitypermission_webrole:
  [<webroleid>]`) and are stored in the component's `content` JSON in Dataverse.
- **The upload's "be careful when you're updating public sites" warning is printed on every
  upload.** It does not mean the site is public. Check visibility by visiting signed out (section 7).
- **Schema before the site, or wait out the lock.** A site that is still provisioning holds the
  org-wide customization lock: a schema deploy during it fails with 429 `0x80071151` ("Cannot start
  another [EntityCustomization]") for minutes, longer than an ordinary 429 backoff
  (`dataverse-web-api.md` section 6).

## 3. Security: two guards on every write

**Table permissions decide which rows; the Web API column allow-list decides which columns.**

| Table | Scope | Privileges | Why |
|---|---|---|---|
| `app_request` | Contact (lookup to the signed-in contact) | create, read, append, append to | a submitter sees and creates only their own rows; no write, no delete, so nothing they submitted can be changed afterwards |
| `app_requestmessage` | Parent (through `app_request`) | create, read, append, append to | messages only on their own requests |
| `contact` | Self | read, append, append to | lets a row's contact lookup be set to the submitter - and to nobody else |

- **Associating a lookup through the Pages Web API needed Append AND Append To on both tables.**
  The documented rule (Append on the referencing table, Append To on the referenced one) was not
  enough: `"app_submitter@odata.bind": "/contacts(<me>)"` returned 403 "You don't have permission to
  associate or disassociate table contact to app_request" until the Contact permission had Append as
  well; the child-to-parent bind failed the same way until the child had Append To. Grant both on
  each side of every lookup the site sets, at the narrowest scope (Self for Contact, Parent for
  children).
- **Column allow-list:** `Webapi/<table>/enabled = true` and `Webapi/<table>/fields =
  <comma-separated logical names>`, listing only the columns the submitter owns (including the
  lookup's logical name). Process columns - stage, decision, score, rank, owner notes - stay out,
  so a crafted request is refused ("Attribute ... is not enabled for Web Api"). Do not use `*`.
- **Defaults belong to the process, not the client.** Do not let the page send the initial stage
  or submitted-on date. Show a blank stage as its first label in Liquid and use `createdon`;
  the evaluating app sets the stage.
- **Derive identity on the server side of the page.** "This message is mine" is
  `m.app_sender.id == user.id` in Liquid, not a flag the browser wrote. Keep author-name and
  from-submitter columns out of the allow-list.
- Liquid `fetchxml` applies table permissions: someone else's row id returns nothing. Still check
  for it and say "not found or not yours".

## 4. Sign-in

- **A Private site's gate is not a site sign-in.** The platform signs the visitor in before any
  page renders ("Signed in as ..." in the banner), but the site session is still anonymous: Liquid
  `user` is empty and the header still offers Sign in. Every page that needs the contact must handle
  `user == nil` with a link to `/SignIn?returnUrl=...`.
- **The first sign-in asks each person for consent** to the site's own app registration
  ("Portals-<site name>": sign in and read your profile). With a person present, they accept it in
  the opened browser. With nobody present, and the person's say-so taken in the first decision
  batch, `site-walk.mjs signin --url <site> --accept-site-consent "<site name>"` accepts it: only the
  site's own app, only sign-in and profile, never on behalf of the organisation; any other request
  (another app, wider permissions, an administrator approval) stays for a person. Record it in
  `docs/decisions.md`. A measured unattended build spent 30 of its 96 minutes waiting on this page
  before it accepted it itself. If the consent page waits too long the sign-in times out - start
  again from the site URL.
- **The built-in Entra provider creates the contact with no name or email**, so every page and
  every back-office view that shows "who" shows a blank. Observed: claims mappings set as site
  settings (`Authentication/OpenIdConnect/AzureAD/RegistrationClaimsMapping` and
  `.../LoginClaimsMapping` = `firstname=given_name,lastname=family_name,emailaddress1=upn`, the
  documented short claim names), config cleared, the site restarted from the admin centre, and a
  fresh sign-out and sign-in: the contact row did not change. The built-in provider appears to
  ignore them; the documentation describes them for a provider you configure yourself.
  **Identify the person by the contact's `adx_identity_username`** (the Entra object id the
  platform writes; it cannot be typed in by the visitor). Resolving the name and email from
  `systemuser` (`azureactivedirectoryobjectid`) works only for people who are Dataverse users -
  usually not the people a portal is for, who have no Power Apps licence. Section 18 gives the
  options; decide among them up front (section 17). Do not ask the visitor to type their own email
  as identity. Check the contact row, never the header, before relying on any mapping.
- **Turn off the profile redirect** (`Authentication/Registration/ProfileRedirectEnabled = false`)
  unless the site has a working profile form: by default every sign-in lands on `/profile/`, which on
  a blank-template site is an empty page, instead of the page the visitor asked for.

## 5. Pages that read and write: Liquid plus the Web API

For a small site, prefer this over basic forms and lists: basic forms need model-driven forms and
views in the solution, and their markup is hard to control. Liquid plus the Web API keeps the whole
site reviewable in source.

**Read** with Liquid `fetchxml` (table permissions apply):

```liquid
{% fetchxml mine %}
<fetch><entity name="app_request">
  <attribute name="app_requestid" /><attribute name="app_reference" /><attribute name="app_name" />
  <attribute name="app_stage" /><attribute name="createdon" />
  <filter><condition attribute="app_submitter" operator="eq" value="{{ user.id }}" /></filter>
  <order attribute="createdon" descending="true" />
</entity></fetch>
{% endfetchxml %}
{% for r in mine.results.entities %}
  {{ r.app_reference }} {{ r.app_name | escape }} {{ r.app_stage.label | default: 'Submitted' }}
{% endfor %}
```

Choices render as `.label` / `.value`, lookups as `.id` / `.name`, dates through `date:` with .NET
format strings (`'MMM d, yyyy'`). Escape every text column (`| escape`, then `| newline_to_br`).

**Write** with the Pages Web API from the page's JavaScript:

```js
shell.getTokenDeferred().done(function (token) {
  $.ajax({ type: 'POST', url: '/_api/app_requests', contentType: 'application/json',
    headers: { '__RequestVerificationToken': token },
    data: JSON.stringify({ app_name: title, 'app_submitter@odata.bind': '/contacts(' + contactId + ')' })
  }).done(function (d, s, xhr) { location.href = '/request/?id=' + xhr.getResponseHeader('entityid'); })
    .fail(function (xhr) { /* show xhr.status and JSON error.message to the person */ });
});
```

Render the contact id into the page from Liquid (`data-contact="{{ user.id }}"`); the lookup's
navigation property name is in `ManyToOneRelationships` (`ReferencingEntityNavigationPropertyName`).
Show the server's error message on failure: the 403 text names the missing privilege exactly.

**Liquid traps:**

- **No `for ... else`.** Standard Liquid's `{% for %}{% else %}{% endfor %}` is a parse error in
  Power Pages, and a Liquid parse error replaces the whole page body with the message. Use
  `{% if list.size == 0 %}` before the loop.
- Validate a GUID parameter before putting it in FetchXML (`{% if id.size != 36 %}`), and escape it.
- Render every page after every upload; a single parse error is a blank page, not a warning.
- **An outer `link-entity` with no related row adds no aliased attribute at all.** A key built as
  `r['pj.app_key'] | append: '-' | append: r.app_number` rendered "-1015" for an item with no
  project. Test the alias before joining (`{% if r['pj.app_key'] %}`) and choose the fallback.
- **`replace` treats its first argument as a regular expression** (observed). `| replace: '[', ''`
  is an invalid pattern, and the filter it fed silently dropped: a search box matched everything.
  Escape the characters a regular expression gives meaning to (`'\['`, `'\.'`), and test a search
  with `[`, `%` and `_` in it - FetchXML `like` treats `%` and `_` as wildcards, so escape those too
  when the person's words must match literally.

## 6. The cache

The running site caches configuration. After an upload that changes **table permissions or site
settings**, the site keeps the old ones - a correct fix still returns the old 403. Clear it before
testing: `/_services/about` (as a site administrator), **Clear config**, and **Clear cache** for
content. Authentication settings can need a site restart from the admin centre, or the Power
Platform API's restart operation (section 15), which needs no person in a portal.
Changes to the "Power Pages Web API Columns" view can take up to five minutes to reach the Web
API (documentation).

**Business data is cached too, and that sets what "fresh" can mean** (documentation, "How
server-side caching works"):

- Data a person reads on the site is cached on the server, per user (shared for anonymous visitors
  and tables with Global permission).
- **A write through the site** (any create, update or delete on that table or a related one, by any
  site user) clears that table's cache for everyone at once: the person sees their own comment or
  request immediately.
- **A change made outside the site** (the back-office app, a flow, a plug-in, a script) reaches the
  site within the cache's 15-minute service level, usually within a couple of minutes. The 15
  minutes cannot be shortened. A status an IT person changes in the back-office app took about
  2.5 minutes to show on a measured site.
- Clearing by hand: **Clear cache** at `/_services/about` (needs a web role with all website access
  permissions) or Preview in the studio; it clears every table and slows a busy site, so it is a
  test step, never a design.
- **Server logic reads are cached too** (measured). A share or a role changed in the back-office app
  reached a `Server.Connector.Dataverse.RetrieveMultipleRecords` read more than two minutes late, in
  both directions: a revoked share still let a comment through. A read that **decides access or gates a
  write** must not be served from the cache: add a condition that is always true but changes every
  second, so each query is new, for example
  `" and createdon le " + new Date(Date.now() + 86400000).toISOString().substring(0, 19) + "Z"`.
  Reads that only display can stay cached.

So: say in the hand-back that changes made outside the site appear within minutes, word any
"last updated" text on the page to match, and measure it rather than assume it -
`site-walk.mjs` waits with `expectWithin` for a change made in Dataverse and reports how long it
took. A requirement for instant reflection of back-office changes is not achievable on this
platform; raise it as a decision, do not promise it.

## 7. Verify by performing the task, then prove the refusals

1. **Signed out**: visit the site in a fresh browser. A Private site redirects to the Entra sign-in
   before any page renders; a public one shows the home page.
2. **As the submitter**: sign in, submit, find it in the list, open it, send a message - with
   Playwright, not by reading the source.
3. **Where it lands**: query Dataverse for the rows, their lookups and choice values.
4. **The refusals**, from the signed-in browser, calling the Web API directly with the anti-forgery
   token: a forbidden column on create, a PATCH, a DELETE, a bind to another contact. Expect 403 on
   each. A site that only hides a button is not secured. Say which refusals could not be tested
   (for example, no second contact exists yet).
5. **Phone width**: at 390 px, `document.documentElement.scrollWidth` must equal `clientWidth` on
   every page, and the forms must stack. No sideways scroll is not enough: text can still spill out
   of its box into the next element, and a sticky bar can sit over the field the keyboard just
   moved to. The walk checks both on every page at every width (`SW-OVERFLOW`, `SW-COVERED`).
6. **The defects blind reviews kept finding** (three measured builds passed every functional check
   and still shipped these). The walk checks each one:
   - the menu marks the page being shown, on every page (`SW-NAV-CURRENT`; section 9 rule 12);
   - every control shows focus with an indicator of 2 px or more at 3:1 against what is behind it
     (`SW-FOCUS`; a pale halo measured 1.2:1, and a 1 px colour change does not count);
   - one press makes one write: `{"pressTwice": "<button>"}` then a `confirm` with `"count": 1`, and an
     `api` probe with `"repeat": 3` on the write endpoint (a retry loop) with the same confirm;
   - the columns the site must set are set: `confirm` with `"filled": ["<source column>", ...]`
     (`SW-FILLED`; two builds left the comment's source empty);
   - no value the person never chose: a `confirm` `expect` on the optional fields left blank.

**Ship in one call**: `site-walk.mjs ship --site <folder> --scenario <file>` runs the permission
audit, `pac pages upload`, Clear config and Clear cache at `/_services/about`, then the walk, and
prints one report. Measured site builds made 220 to 295 tool calls, most of them this loop taken a
step at a time.

**Drive it with `scripts/site-walk.mjs`**, the site counterpart of the canvas walk: `signin` once
(the person completes the Entra sign-in and consent in the opened browser; the profile is kept),
then `walk --scenario <file>` for the task steps, the signed-out check, the 390 px scroll, spill and
cover checks on every page, and the refusal probes - `/_api` calls sent from inside the signed-in page with the
anti-forgery token, each expected to fail with a stated status. A probe that succeeds is a
security finding, not a flaky test. The refusals to prove on every site:

| Probe | Expected |
|---|---|
| GET a row the person must not see, by id and by `$filter` | no row (404, or an empty `value`) |
| POST with a column outside the allow-list (a stage, a visibility flag, an owner) | 403 `90040101`, or the row saved without it - then read it back to prove which |
| PATCH and DELETE on a row the person created | 403 `90040102` / `90040104` |
| POST binding the contact lookup to another contact | 403 `90040105` or `90040106` |
| POST a child row bound to a parent the person cannot see | 403, and no row |
| every page and `/_api` signed out | redirect to sign-in (Private) or no data |

Read every write back from Dataverse (Web API as the owner), not from the page.

## 8. Security review before release

Table permissions and the column allow-list (section 3) are the two guards that matter most, but
they are not the whole surface. Run this list before a site goes to more people, and again after
any change to permissions, settings or page code. Each item says whether it was **measured** on a
real site (a Private trial on the enhanced data model) or comes **from documentation** - confirm
those in your tenant.

1. **Run the permissions audit on the downloaded source** (measured):
   `python scripts/audit-pages-permissions.py site/ [--url https://<site>/]`. Download first
   (`pac pages download`), because it reads files only. It inventories every table permission
   (table, scope, privileges, parent, roles - a child permission inherits its parent's roles) and
   every Liquid `fetchxml` and `/_api` call in the page copies, templates, snippets and JavaScript,
   then reports: a table the code uses with no permission; a privilege the code needs and nobody
   grants (the call will be refused); Create, Write or Delete granted that no code uses; Global
   access for the anonymous or the authenticated role; a column the code writes that the allow-list
   lacks; allow-listed columns nothing uses; process columns (stage, owner, decision, score) in an
   allow-list; Web API enabled with `*`, with no fields, with no permission, or with no caller;
   Web API enabled on a table some role reads with Global scope (`WEBAPI-GLOBAL-READ`: every row
   is reachable through `/_api`, whatever the pages show - section 11); and `*` on a table the
   site's roles may create in or write to (`WEBAPI-WILDCARD-WRITE`).
   Exit 0 clean, 1 findings, 2 nothing examined. On the real site it read three permissions, 57
   settings and 68 code files and found nothing above info. What it cannot see: column
   permissions, the "Power Pages Web API Columns" view, basic forms and lists that use a table
   without code, and anything changed in the studio since the download.
2. **Web API allow-lists** (from documentation, wildcard behaviour matches the platform's own
   notice): `Webapi/<table>/enabled`, `Webapi/<table>/fields` as logical names, optionally
   `Webapi/<table>/UseFieldsFromView` (a system view named "Power Pages Web API Columns"; combined
   with the fields list when both are set). **`*` is deprecated and requests to a table configured
   with it now fail** - list the columns. Keep `Webapi/error/innererror` false outside development:
   it returns server error detail to the browser.
3. **The built-in roles** (measured): "Anonymous Users" applies to every visitor who has not signed
   in, "Authenticated Users" to everyone who has. Never give either one Global scope with Write or
   Delete; Global Read for Authenticated Users shows every row to every signed-in person - use
   Contact, Account, Self or Parent scope. A permission with no role (and no parent) grants nothing.
4. **Headers** (setting names from documentation; live values measured). Read what the site
   actually sends - `--url` does one anonymous GET without following the sign-in redirect:
   - `HTTP/Content-Security-Policy` (and `HTTP/Content-Security-Policy-Report-Only` to test a policy
     first). Sites created since late 2025 send a default policy with the setting unset; older
     sites send none until it is set. **Measured on a 2026 site with the setting unset:** the live
     policy was `script-src 'self'` plus the platform content hosts, a per-request nonce,
     `'unsafe-eval'`, `'unsafe-hashes'` and an inline-handler hash, and `style-src 'unsafe-inline'
     https:` - broader than the documented default (no `'unsafe-eval'` there). To disable CSP, the
     setting is cleared, not deleted. Add `frame-ancestors 'self'` and `object-src 'none'` when you
     own the policy; add third-party script hosts one by one, never `https:` for scripts, never
     `'unsafe-inline'` for scripts (the nonce covers Liquid-rendered inline scripts).
   - `HTTP/X-Frame-Options` - `SAMEORIGIN` on the measured site, and sent on every response.
   - `HTTP/SameSite/Default` - `Lax` on the measured site; the platform's own sign-in nonce and
     affinity cookies are `SameSite=None; Secure` regardless.
   - `HTTP/Access-Control-Allow-Origin` - leave unset unless another origin must call the site;
     never `*`.
   - Measured as sent by the platform: `Strict-Transport-Security` (one year, preload). Not sent:
     `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`.
5. **Web application firewall** (from documentation): **production sites only - a trial site
   cannot use it**, and it is not offered in some sovereign regions. An administrator turns it on
   in the admin centre (Performance and protection); it is on by default when a trial is converted.
   On a trial, record "WAF: not available (trial)" rather than leaving it blank.
6. **The studio's security scan** (from documentation): Security workspace > Run Deep Scan. It scans
   anonymous pages by default; authenticated pages need a username and password typed into the scan,
   which a single-sign-on Entra account may not be able to provide (not tested). The report arrives
   by email (English only, downloadable as PDF). On a Private site an anonymous scan sees only the
   sign-in redirect - plan an authenticated scan before going Public.
7. **Visibility** (measured, documentation for the limits): a Private site sends every anonymous
   request - pages and `/_api` alike - to the Entra sign-in (302); only makers, System
   Administrators and up to 50 people granted access can enter. Going Public is an administrator
   decision and restarts the site; a site in a developer environment cannot go Public. Private is
   the gate, not the security: table permissions still decide what each signed-in person sees.
   `/_services/about` answers anonymously even on a Private site (measured: a page titled "Portals",
   nothing else).
8. **Prove the refusals** in the running site as in section 7, step 4. The audit says what the
   configuration allows; only a refused call from a signed-in browser proves it.

**The reviewer's list.** Every site build ends with an independent review (a fresh helper with no
build context, `assets/templates/reviewer-prompt.md`) that works through this list on the live site and
records what it tried and what happened in `docs/review.md`; the plugin's stop gate checks the topics.
A third measured build's reviewer found the one serious defect its own walks had passed.

1. **Identity**: can a person make the site record someone else as the author or requester - by
   editing the platform's **profile page** (the measured defect: a retyped name was stamped on every
   comment), by sending a name or email in a request body, or by changing a hidden field? The name and
   email must come from the sign-in or a back-office record, never from anything the person can edit.
2. **Table permission scope**: list every permission with its scope and roles. Global read is
   acceptable only on a table whose Web API is explicitly off (`Webapi/<table>/enabled` = false, with a
   description naming the risk) and whose every read filters; `audit-pages-permissions.py` reports
   `GLOBAL-READ-UNGUARDED` otherwise. All three measured builds left this to the default.
3. **The Web API per table**: `/_api/<entity set>` for each table answers 404 (off) or returns only
   allowed rows and columns.
4. **The refusals** of section 7 step 4, sent from the signed-in browser, and the double write.
5. **Every audit warning** resolved, or listed in the hand-back with the reason it stays.

**Code sites (single-page React, Angular, Vue or Astro sites) are a different build model**
(section 10). Every security rule here applies to them unchanged - the Web API and its table
permissions are the same - but the audit reads Liquid and page JavaScript and has not been run on
a code site's compiled bundle: for a code site, audit the permissions and settings it reads and
prove the refusals in the running site.

## 9. Designing the site: the organisation's identity, not the platform's

The default site is a grey Bootstrap portal with a placeholder header and "Company name". A site
staff will trust looks like the organisation.

**Use a design skill for the design, and this reference for the platform.** The first version of
one site followed every rule in sections 2 to 7 and still looked like a stock portal: correct,
secure and basic. The same site redesigned with the third-party **impeccable** design skill (Paul
Bakaus, Apache 2.0, https://github.com/pbakaus/impeccable) was the version its owner called
finished. Recommend it before any site design work, and install it when the person agrees:

- Claude Code: `/plugin marketplace add pbakaus/impeccable`, then `/plugin` > Discover > Impeccable.
- Other agents: `npx skills add pbakaus/impeccable` (or `npx impeccable install`). Where the
  machine blocks `npx`, copy the repository's skill folder into the agent's skills directory by
  hand and note that it will not update itself.

What made it work: run its `init` first so it writes `PRODUCT.md` (who visits, what they must get
done, the brand) and a `DESIGN.md` design system the later passes keep to; give it the brand
pack, not adjectives; let it own layout, type, colour and imagery while this reference owns the
constraints it cannot know - the platform theme's overrides, the auto-linked CSS file, the
sign-in substitutions, artwork kept out of git, the cache. Finish with its `critique` or `polish`
pass on the rendered pages at desktop and phone width, then the independent review in rule 9.
The rules below are what that pairing found the platform needs, in order:

1. **Take the brand from the brand pack, not from memory.** Read the palette out of the official
   presentation template's theme and cross-check it against the logo's pixels; use the documented
   fallback typeface when the brand face is not licensed for the web. Keep display-only colours
   (a bright cyan that fails contrast on white) for graphics and dark grounds, never for text.
2. **Own the frame.** Replace the Header and Footer web templates with your own markup (keep the
   sign-in and sign-out substitutions: `website.sign_in_url_substitution`,
   `website.sign_out_url_substitution`), and put every style in one CSS web file. Draw a brand
   graphic (an angled band, a mark) as inline SVG in the header so it needs no asset.
3. **The platform theme fights you on bare elements.** The theme stylesheet sets every unclassed
   `p` (20 px, black) and every heading (weight 400). Class selectors already beat it; for bare
   paragraphs and headings inside your containers use class-scoped rules
   (`.wrap p:not([class])`). Measure computed sizes in the browser - the stylesheet looks right.
4. **A CSS web file under Home is linked into every page automatically**, with a version stamp;
   adding your own `<link>` loads it twice. The stamp changes only when the site cache is cleared,
   so after an upload the browser keeps the old stylesheet: clear the browser cache (CDP
   `Network.clearBrowserCache` in Playwright) before judging a CSS change. To tell "not uploaded"
   from "cached", read what the site serves, bypassing the cache, and look for a rule you just
   added: `await (await fetch('/site.css', { cache: 'reload' })).text()` in the page. If the served
   file has it, the upload landed and only the browser is stale.
5. **Brand artwork the owner keeps out of git** needs a prepare script that writes each web file
   and its record with fixed ids before every upload, a `.gitignore` for both, and a designed
   fallback (`onerror` to a text wordmark; a solid brand colour behind a photo). Screenshots of the
   site show the artwork too - keep review captures out of git as well.
6. **Forms that work on phones and desktops.** Required fields first and few; optional sections
   as one `<details>` each with an "Added" badge and a running count; radio groups drawn as 44 px
   pill buttons instead of selects; money as number inputs with a currency prefix and
   `inputmode="decimal"`; the submit bar sticky at the bottom on phones, with
   `html { scroll-padding-bottom: <bar height + 16px> }` so a field the keyboard moves to is never
   under it (a measured build shipped without it; the walk's `SW-COVERED` finds it). On a phone the first field
   must be on the first screen - move or drop side panels that push it down.
7. **Echo the person's own words.** Dataverse choice labels are the back office's vocabulary
   ("Enhancement"); the form may say "Improve something we have". Show answers back in the form's
   words: a Liquid lookup list indexed by `value | minus: <option base>` over a `split` string.
   Never show a number the person did not type: format money in JavaScript with
   `toLocaleString`, keeping cents when there are cents (Liquid has no thousands separator).
8. **Show the real state as a track.** Map the stage choice to a few milestones and draw where the
   item stands; a blank stage shows as the first one.
9. **Get an independent review of the rendered pages.** A fresh reviewer with the screenshots, the
   brief and the source (no shared conversation) found six defects the build's own two screenshot
   rounds passed: answers echoed in the wrong words, rounded money, headings closer to the text
   above than their own, chips under the wrong heading, a phone order that hid the first field,
   and the brand shape stopping at the home page. Budget two rounds of fixes, then stop.
10. **Know which theme you are overriding.** A classic site renders on Bootstrap (3 on older sites,
    5 on newer ones; `pac pages bootstrap-migrate` moves page HTML from 3 to 5, and the Power
    Platform API can stamp a site as Bootstrap 5 - documentation, confirm the version your site
    serves before writing selectors) plus `portalbasictheme.css`; put your tokens in custom
    properties on your own wrapper class and never restyle Bootstrap's global classes, so a
    platform update cannot undo the brand. A code site has no style workspace and no platform
    theme on your markup: the framework's own styling is the theme. On either, the logo and
    photograph are web files (classic) or compiled assets (code site), sized for the header at
    1x and 2x, with an `alt` naming the organisation.
11. **What a design critique marked down on a site that passed every functional check** (blind
    review and a heuristic critique of a measured portal; each is cheap at build time):
    - **Confirm every write where the person is looking.** After a comment, the comment appears in
      the thread with a short "Posted" state; after a request, land on the new item (or on the list
      with it at the top) under a banner naming its key ("REQ-1025 is in the backlog"). A form that
      simply clears reads as "did it work?".
    - **Rows that open something look like it.** Make the whole row or card the link, give the
      title link styling (colour and an underline on hover), and link every list that holds items -
      including the person's own requests - to the item page.
    - **Status chips carry equal weight.** One tinted style per status, the same weight for all; a
      single solid chip reads as selected or urgent.
    - **No silent defaults.** A field labelled optional and left empty is saved empty, or is
      preselected so the person can see the value, or is required. Saving a value the person never
      saw (a default type filled in for a blank one) is a defect.
    - **Errors name their field**: "Add a description", not "Describe what you need" under a label
      the reader has to connect it to; move focus to the first error and announce it (`aria-live`).
    - **Reconcile the platform's private-site bar.** A Private site shows the platform's own
      "This site is private" strip, with "Signed in as", above your header; it cannot be removed while
      the site is Private (observed). Style around it: drop your own signed-in name from the header
      at phone width so the person's name is not shown twice, and pick a header colour that sits with
      the strip's dark ground rather than against it.
    - **Filter chips on a phone show that there are more.** A chip row that scrolls sideways and
      cuts the last chip at the edge, with no fade or arrow, hides most statuses (both measured
      builds). Wrap the chips onto two lines, or switch to a select at phone width, or keep the
      scroller with a fade on the cut edge and the selected chip scrolled into view.
    - **One press, one write.** Disable the send button while the request is in flight and re-enable
      it on the answer; a double press produced a stray "comment is empty" error after a good post.
    - **Make finding work fast once there are more than a screenful**: search as you type or on
      Enter, a visible "filtered by" state with a clear control, and a sort that matches the list's
      purpose (newest first for "my requests", priority then due date for shared work).

12. **The menu marks the page being shown, computed per request.** The platform caches the Header and
    Footer web templates across pages and visitors, so a current-page marker worked out inside the
    header (from `page.url` or a variable set there) can stick to whichever page rendered it first: a
    measured build underlined "My requests" on every desktop page. Set `aria-current="page"` from the
    page's own template (a block the page fills, or a small script that compares `location.pathname`
    with each menu link), and mark detail pages under their section. The walk's `SW-NAV-CURRENT`
    checks it on every page.
13. **One colour for the main action, everywhere.** If the brand reserves a colour for "go" (green for
    submit), every primary submit uses it - "Send request" and "Post comment" alike. A critique marked
    a blue Post button beside a green Send button as an inconsistency.
14. **Long lists page or filter.** A person's own list grows (a measured "My requests" reached 25 rows,
    over 5,000 px on a phone); page it (10 to 20 rows) or give it the same search and status filter as
    the shared list, newest first. Comment threads show the newest first or put the comment box at the
    top once there are more than a few.
15. **The design critique has a floor.** Run impeccable `critique` on the live pages at 1440 and 390 px
    (screenshots), fix every P0 and P1 in one batch, critique once more, and record the score in
    `docs/design-critique.md` with the screenshot names. Thirty out of forty or more; under that, write
    "Below 30 accepted:" and the reason. Three measured builds scored 30, 29 and 25 on the same brief;
    the plugin's stop gate holds the hand-back below the floor.

## 10. Classic site or code site

Two build models share one security model (web roles, table permissions, the Web API). Pick before
the first page; they do not convert into each other.

| | Classic site | Code site (single-page app) |
|---|---|---|
| Pages | web pages, page and web templates, Liquid, basic and multistep forms, lists | one compiled app (React, Angular, Vue or Astro) with client-side routes |
| Reads | Liquid `fetchxml`, rendered on the server; the Web API | the Web API and server logic only; Liquid is not supported |
| Deploy | `pac pages download` / `upload --modelVersion 2` | `pac pages upload-code-site --rootPath . [--compiledPath dist] [--siteName ...]`; `download-code-site` |
| First deploy | create the site (studio or section 15), then download it | the first upload creates an **inactive** site; activate it (section 15) |
| Studio | pages, styling and forms workspaces | no pages or style workspace; security and set-up only |
| Fits | content, forms, lists; reads that never need the Web API | a rich interactive app built by a team that already ships a framework |

From documentation, for code sites: `pac` 1.44 or later and a site on 9.7.4 or later; the
environment must allow `.js` attachments (admin centre, Privacy + Security, remove `js` from
Blocked Attachments) or the upload fails with "The attachment is either not a valid type or is too
large"; a `powerpages.config.json` in the root can hold `siteName`, `compiledPath`,
`defaultLandingPage` and `bundleFilePatterns` (old content-hashed bundles matching those patterns
are deleted before each upload - without them stale chunks pile up in the site's web files); Power
Platform Git integration is not supported; the signed-in user is
`window.Microsoft.Dynamic365.Portal.User`. Never run `pac pages upload` on a code site project -
Microsoft's own Power Pages plugin forbids it because it damages the code site's metadata (confirm
in your tenant only on a throwaway site).

**The security consequence:** a code site reads everything through `/_api`, so every table it
shows has the Web API on, and section 11 decides whether hidden rows stay hidden. A classic site can
keep a table's Web API off and read it only in server-rendered Liquid.

## 11. Row-level visibility: when a column decides who sees a row

Table permissions scope by relationship (Global, Contact, Account, Self, Parent), not by a column's
value. "Signed-in people see only the items marked visible" cannot be a Contact or Global
permission: **Global Read on a table whose Web API is enabled exposes every row through
`/_api/<entity set>` and `$filter`, whatever the pages render** - the Web API follows table
permissions, not page code. `audit-pages-permissions.py` reports this as `WEBAPI-GLOBAL-READ`.

Options, strongest first. Each needs a refusal probe in the running site (section 7).

1. **Custom access type** (documentation; preview): a table permission whose access is a FetchXML
   `filter` (for example `<condition attribute="app_published" operator="eq" value="1" />`); only
   the filter element is evaluated. Available only on sites opted in to **enhanced authorization**,
   which maps contacts and web roles to Dataverse system users and security roles - a site-wide
   change the owner must agree to (Microsoft warns that plug-ins whose "Run As" user lacks
   privileges can fail after the switch). Confirm in your tenant that the filter applies to `/_api`
   and Liquid alike before relying on it.
2. **Server logic** (documentation; announced generally available in April 2026 - Microsoft's own
   plugin still calls it preview, so check the Learn page's banner). Server-side JavaScript at
   `/_api/serverlogics/<name>` (client, with the anti-forgery token) or the `{% serverlogic %}`
   Liquid tag. Its function reads with `Server.Connector.Dataverse.RetrieveMultipleRecords` and a
   filter on the column, and returns only the rows and columns the page needs. Its own access goes
   through web roles and table permissions, so the table still has a Read permission - **leave
   `Webapi/<table>/enabled` off** so `/_api/<entity set>` answers 404 and server logic is the only
   way in (confirm in your tenant that server logic reads a table whose Web API is off). Limits:
   no browser APIs (`fetch`, `XMLHttpRequest`), and scripts containing `eval(`, `Function(`,
   `setTimeout(`, `require(`, `delete`, `prototype` and similar are rejected (the DELETE handler is
   named `del`); 120 s timeout by default, up to 240 (`ServerLogic/TimeoutInSeconds`).
3. **Classic Liquid with the Web API off**: list and detail both read with `fetchxml` carrying the
   condition. Liquid reads need Read in a table permission, and a column-based visibility cannot be a
   scope, so this means Global read: set `Webapi/<table>/enabled` to `false` explicitly, with a
   description saying why, so the next maker who wants a list cannot switch it on by accident
   (`GLOBAL-READ-UNGUARDED` in the audit until then). **The detail page must re-check the condition with the id it was given** - a detail
   page that loads by id alone shows a hidden row to anyone who changes the id.
4. **A relationship you can scope by** (a lookup to an audience or parent row that Account or Parent
   scope can follow). Strong, but a schema change.

**When several relationships decide** ("I see an item when it is assigned to me, I requested it, I
own or sponsor its project, or someone shared it with me"), no single table permission scope expresses
the union. What held on a measured site, with option 3:

- **One scope web template, included by every page that reads the table.** It resolves the signed-in
  person once (from the directory: the contact's Entra object id to the system user, never a field the
  visitor can edit), then captures two FetchXML fragments: the outer `link-entity` elements (the
  project and this person's participant row on it, and this person's share row, each with its
  "active" condition inside the link) and a `<filter type="or">` that names them by alias
  (`<condition entityname="sh" attribute="app_itemshareid" operator="not-null" />`). List and detail
  pages put both inside their own `fetch`, so the rule lives in one place.
- **No person found means the narrowest view** (only the visitor's own requests), never everything:
  fill the person id with an empty GUID so every condition on it is false.
- **Writes re-check the same rule in server logic**, with cache-busted reads (section 6), and the two
  copies change together; a comment through the Web API would otherwise bypass it.
- **Probe each path and each revocation**: one person per relationship sees the item, a person with
  none gets the page's not-found answer by id, and turning a share or role inactive removes access
  within the measured cache window.

Not options: hiding rows in page code, a client-side `$filter`, a view. **Writes that depend on
visibility need the same check**: a child row (a comment) created through the Web API can be bound
to any parent the role can read. If the parent permission is Global Read, a crafted POST comments on
a hidden item - create such children through server logic that re-reads the parent first, or keep
the parent unreadable outside the filter.

## 12. "My records": the contact lookup, scopes, Append and Append To

- **Contact scope needs a relationship** from contact to the table: a lookup column on the table
  that points at contact (choose it when creating the permission). Account scope follows the
  contact's account; Self is the contact row itself; Parent is a child permission through a
  relationship to a parent permission (the studio adds it as a child permission; the Parent type
  itself is in the Portal Management app). No lookup, no "my records" - that is a schema change to
  agree with the owner before building.
- **Set the lookup on create to the signed-in contact**: `"<navigation property>@odata.bind":
  "/contacts(<user.id>)"` (the navigation property name is in `ManyToOneRelationships`). With
  Contact granted Self scope and Append plus Append To, a bind to anyone else's contact is refused
  (measured, section 3). Or set it in server logic from `Server.User.contactid`.
- **Never take who-it-is from the client.** Keep requester name and email columns out of the
  `fields` allow-list and fill them on the server: server logic from `Server.User` (`fullname`,
  `emailaddress1`), or a Dataverse plug-in or flow from the contact lookup. The built-in Entra
  provider can leave the contact's name and email blank (section 4), so check the contact row
  first. Falling back to `adx_identity_username` against `systemuser.azureactivedirectoryobjectid`
  works only for Dataverse users, not for the unlicensed people a portal serves - section 18.
- **Lock it after create**: give the person no Write privilege on the table (nothing they created
  can change) - or, where some edits are allowed, column permissions narrow which columns the Web
  API may change (documentation; confirm in your tenant).
- **Append and Append To**: the documented rule is Append on the table that holds the lookup and
  Append To on the one it points at; measured, both were needed on both sides (section 3).
- Known issue (documentation): a Web API GET on a table with several levels of Parent, Contact or
  Account scope can return a Dataverse error; use a `fetchXml` query parameter instead.

## 13. Web API settings, the anti-forgery token and the errors

| Site setting | Value |
|---|---|
| `Webapi/<logical name>/enabled` | `true` to expose the table; default `false` |
| `Webapi/<logical name>/fields` | comma-separated logical names, including each lookup's logical name the page binds. `*` is deprecated and requests to a table configured with it fail |
| `Webapi/<logical name>/UseFieldsFromView` | `true` adds the columns of a system view named "Power Pages Web API Columns" (site 9.8.8 or later); combined with `fields` |
| `Webapi/error/innererror` | `false` outside development |

Settings use the table's logical name; URLs use the entity set name, case-sensitively. A lookup reads
back as `_<column>_value`. The portal Web API does not call Dataverse actions or functions, and does
not write configuration tables (`adx_webpage`, `adx_sitesetting`, `adx_entitypermission` and the
rest). Authenticated users' calls need authenticated-user capacity (licensing, documentation).

**The anti-forgery token** goes in a `__RequestVerificationToken` header on every call. On a classic
page: `shell.getTokenDeferred()` (or `shell.safeAjax`, which wraps it). In a code site or a test
script: GET `/_layout/tokenhtml` and read the `value="..."` attribute. Send `Accept:
application/json`, `OData-Version: 4.0`, and `Content-Type: application/json` with a body. A create
returns the new row's id in the `entityid` response header.

**Errors** (documentation; the body is `{"error": {"code", "message", "cdscode", "innererror"}}`):

| Status | Code | Meaning |
|---|---|---|
| 403 | `90040101` | column not in the allow-list ("Attribute ... is not enabled for Web Api") |
| 403 | `90040102` / `90040103` / `90040104` | no Write / Create / Delete permission |
| 403 | `90040105` / `90040106` | missing Append / Append To on a bind |
| 400 | `90040100` | column does not exist |
| 401 | `90040109` | no site session, or no anti-forgery token (`90040107` is a token that does not match) |
| 404 | `9004010C` | resource not found - also what a table with the Web API off answers |
| 405 | | DELETE or PATCH on a collection |

Show the message to the person on failure; for a refusal probe, assert the status and the code.

## 14. Private sites, granting access, and the trial

- **Private is the default.** Only the site's makers, users with the System Administrator role in
  the environment, and up to 50 granted organisation users can enter, after an Entra sign-in. Public
  means anyone with the link. Changing visibility restarts the site; a site in a developer
  environment cannot go Public, and a tenant control can stop non-production sites going Public.
  Who may change it: Power Platform and Dynamics 365 administrators, and System Administrators
  unless the tenant setting `enableSystemAdminsToChangeSiteVisibility` is `false`. Turning off Entra
  authentication breaks a Private site.
- **Granting one person access**: studio, Security > Site visibility > Grant site access, names or
  email addresses, Share. The list is kept in an environment variable, so any role that may edit
  that variable can change it. Documentation does not say whether the grant notifies the person;
  when a test must reach nobody else, grant only after the test, or confirm in your tenant first.
  The grant only opens the door: what they see still comes from web roles (the Authenticated Users
  role covers everyone signed in; a narrower role is assigned to their contact, which the first
  Entra sign-in creates). Staff signing in with Entra need no invitation.
- **The trial** (documentation): 90 days in a production or sandbox environment, 30 days (or the
  environment's own end, if sooner) in a trial environment. At the end the site is suspended; it can
  still be converted within seven days of suspension. Converting needs licences for the site's
  users and a production or sandbox environment (not trial or developer), from the admin centre or
  the API's "Convert Trial To Production". The web application firewall comes on by default at
  conversion (section 8). Conversion is the owner's licensing decision; never do it as a build step.

## 15. Creating, activating and restarting a site without the Azure CLI

Microsoft's own Power Pages plugin gets its token from the Azure CLI, which needs an administrator
to install on a managed machine. The calls themselves are the Power Platform API:
`https://api.powerplatform.com/powerpages/environments/{environmentId}/websites`, api-version
`2024-10-01` (the plugin uses `2022-03-01-preview`), with a token for the resource
`https://api.powerplatform.com`. From PowerShell with Az.Accounts:
`Get-AzAccessToken -ResourceUrl https://api.powerplatform.com` (confirm in your tenant; on newer
Az.Accounts the token is a SecureString). `pac` has no token command, but `pac pages list` and
`pac org who` give the site ids and the Dataverse organization id.

| Operation | Call |
|---|---|
| List sites | `GET .../websites` |
| Create or activate | `POST .../websites` with `{"name", "subdomain", "templateName": "DefaultPortalTemplate", "dataverseOrganizationId", "selectedBaseLanguage": 1033}`; add `"websiteRecordId"` to activate an uploaded code site or existing configuration. 202 and an `Operation-Location` to poll; 400 for a taken subdomain, 403 without the site-creator or System Administrator role, 409 if it exists |
| Restart (clears the runtime cache) | `POST .../websites/{id}/restart` |
| Visibility | `POST .../websites/{id}/updateSiteVisibility?siteVisibility=<value>` (confirm the value names in your tenant) |
| Convert the trial | "Convert Trial To Production" (owner decision) |
| Delete the site host | `DELETE .../websites/{id}` (202) |

`{id}` is the website id from the list, which differs from the Dataverse site record id; match on
the record id the list returns (confirm the property name in your tenant). Provisioning takes
minutes and holds the org-wide customization lock (section 2), so deploy schema first.

**Changing the site address.** The admin centre's site details change the subdomain in place:
the old host answers 404 at once, Microsoft Entra sign-in keeps working on the new one, and
`pac pages upload` is unaffected because it targets the site record, not the host (the local folder
name does not matter either). Update every link and document that names the old address in the same
change.

**Renaming a site.** A rename in the Power Pages studio changes the hosting record only; the site
record keeps its old name, which is what `pac pages list`, the Portal Management app and a download
show. Rename the record too: set `adx_name` in `website.yml` and upload.

**Two data models.** The enhanced data model (`--modelVersion 2`) keeps a site as one
`powerpagesite` row plus `powerpagecomponent` rows typed by `powerpagecomponenttype` (pages,
templates, settings, table permissions, roles); the standard model uses the `adx_` tables
(`adx_website`, `adx_webpage` and so on). New sites use the enhanced model; check which one before
reading or writing records directly, and prefer `pac pages` to direct writes.

## 16. Teardown

A site is three things: the **site host** (the running web app), the **site configuration** in
Dataverse (the site record and its components), and the **Power Pages solutions** shared by every
site in the environment. Remove a site in this order, listing first and confirming with the owner:

1. List what belongs to it: `pac pages download` (keep the copy), its web roles, table permissions,
   site settings, server logic, and any rows its tests created.
2. Delete the **site host**: admin centre, Power Pages sites > Manage > Delete this site, or the
   API's DELETE. This removes the hosted resources only; it fails without permissions on the site's
   Entra application.
3. Delete the **site configuration**: the site record (`powerpagesite` on the enhanced model, the
   website record in the Portal Management app on the standard one). Confirm in your tenant that
   its components go with it, and list any that remain.
4. Leave the **Power Pages solutions** while any other site uses the environment.

What stays by design: contacts created by sign-ins, rows the site's users wrote, and any column or
relationship added to your own tables for the site - remove those deliberately, as schema changes of
their own.

## 17. The go-live decisions to settle up front

A portal can pass every functional check and still be unusable by its audience, because who can get
in and who they are is decided by platform settings nobody asked about. Put these to the owner in the
first decision batch, each with the recommendation below; when no person is present, take the
recommendation, build to it, and list it in the hand-back. Template:
`assets/templates/pages-decisions.md`.

| Decision | Why it matters | Recommendation when no person answers |
|---|---|---|
| **Identity source** for people who are not Dataverse users - **settle it first** | All three measured builds passed every check and hit the same go-live blocker: staff without a licence could not be named on what they post (section 18). | Hand the person `assets/templates/pages-decisions.md`'s "Steps for the administrator" before the build; with the app registration in place, build option 1 of section 18 and prove it. Without it, ship the fallback and record the blocker. |
| **Audience and visibility.** How many people, inside the organisation only? | A Private site admits its makers, environment System Administrators and up to 50 people granted by name (section 14). Past that, the site must be Public, with every page and the Web API restricted to signed-in people through web roles, and the organisation's Entra ID as the only identity provider (local sign-up and other providers off). | Build Private for the pilot; say in the hand-back that going organisation-wide means Public plus page-level restrictions, and that changing visibility is an administrator action. Write every page so it does not depend on Private: check the web role in Liquid or server logic on every page and endpoint. |
| **Licence** | A new site is a 90-day trial (30 in a trial environment); production needs capacity for the site's monthly authenticated users. | Stay on trial; never convert as a build step. |
| **Letting people in** | Granting access is a list the owner keeps; whether a grant notifies the person is not documented. | Grant nobody during the build. At go-live, the owner grants named people (Private) or opens the site to the organisation (Public). Staff signing in with Entra ID need no invitation. |
| **The site's own sign-in consent** when nobody is present | Every first sign-in asks for consent to the site's own app (section 4); an unattended build that waits for a person loses the time (a measured build lost 30 minutes). | The agent accepts it for the builder's own account with `site-walk.mjs signin --accept-site-consent`; anything wider stays for a person. |
| **Freshness of back-office changes** | Changes made outside the site take up to 15 minutes to appear (section 6). | Accept it and say so on the page ("updates within a few minutes"); measure it with `site-walk.mjs expectWithin`. |

## 18. Name and email for people who are not Dataverse users

The people a portal is built for usually have no Power Apps licence and are not Dataverse users.
Their contact record is all the site knows about them, and the built-in Entra provider has been seen
to leave its name and email blank (section 4). Options, best first:

1. **The Entra ID provider configured as OpenID Connect** (documentation, "Set up an OpenID Connect
   provider with Microsoft Entra ID"): an app registration in Entra (redirect URI = the site's reply
   URL, a client secret, ID tokens enabled), then in the studio a new OpenID Connect provider with
   Authority `https://login.microsoftonline.com/<tenant id>/`, the client id and secret, Response type
   `code id_token`, Response mode `form_post`, and **Scope `openid email profile`**. The `email` scope
   fills the email on sign-in; Registration and Login claims mapping
   (`firstname=given_name,lastname=family_name`, text and boolean contact columns only) fill the
   name. "Contact mapping with email" (`AllowContactMappingWithEmail`) matches an existing contact by
   the `email`, `emails` or `upn` claim instead of the object id. Creating the app registration needs
   app-registration rights in the tenant, and a tenant that blocks user consent needs an
   administrator to consent (confirm in your tenant); the person or an administrator does this, the
   agent cannot. Then turn the built-in provider off so there is one way in, and sign in again with a
   new contact to check the row, not the header.
2. **Read the name the person already sees.** The Private-site strip shows "Signed in as <name>"
   from the sign-in, but nothing documented exposes that value to Liquid or server logic; do not
   scrape it (confirm in your tenant whether `user` or `Server.User` carries it on your site).
3. **Ask once, then keep it.** On the first write, show a one-time "Your name as colleagues know it"
   field, saved to the contact's first and last name through server logic. The email still has to
   come from a trusted source (option 1, or the contact's `emailaddress1` if the provider filled it);
   never take an email the visitor typed as their identity.
4. **Resolve through `systemuser`** by `azureactivedirectoryobjectid`: correct for staff who are
   Dataverse users, empty for everyone else. Use it only as one source among these.

**Whatever the option: a write the site cannot attribute is refused, not saved anonymously.** Tell
the person why and who to contact, and list it in the hand-back as a go-live blocker with the fix
that needs the owner (option 1). Test it: the owner is usually a Dataverse user, so the walk cannot
prove the unlicensed path by signing in as the owner - say so, and prove at least that a contact
with no name and no matching `systemuser` is refused with the message.

## 19. A write path that held every refusal

One measured classic site passed every refusal a blind evaluator tried (hidden rows by id, filter
and `/_api`; another person's rows; PATCH and DELETE; a comment bound to a hidden item; a request
that sent its own author, status, project and visibility). Its shape:

- **The Web API off on every table**: every `/_api/<entity set>` answers 404 to a signed-in person and
  redirects a signed-out one to sign-in. The measured builds left the setting absent; set
  `Webapi/<table>/enabled` = false explicitly on each Global-read table (section 11, option 3).
- **Reads in Liquid `fetchxml`** with the visibility condition on every query (list, counts, search,
  status filter), and on the detail page the condition **and** the id from the address: visible, or
  the signed-in person's own request (`<requester lookup> eq user.id`). An id that fails either shows
  "not found or not shared", the same message for both.
- **Every write through one server logic endpoint** (`/_api/serverlogics/<name>`, POST with the
  anti-forgery token): it sets the author or requester from the signed-in contact, the fixed project,
  the first status and "not visible" itself, ignores any such field the browser sent, re-reads the
  parent before a comment and refuses one on an item that is not visible, and validates required
  fields and dates again on the server (the page's checks are for the person, the server's for
  security).
- **Table permissions grant Read, Create, Append and Append To only** - no Write, no Delete - so
  nothing anyone created can be changed or removed through the site.
- **A double press makes one row**: the button is disabled on submit (measured: two quick presses
  created one comment). A server-side check that refuses a second identical write from the same
  contact within a few seconds also covers a retry loop - the same build left duplicate debug rows
  from its own retries.

What it did not cover, and the next build should: identity for unlicensed people (section 18), and
freshness of back-office changes (section 6).
