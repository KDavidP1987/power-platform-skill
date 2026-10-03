# Power Pages sites

A Power Pages site is a website over Dataverse: its own address, its own sign-in, and security by
web roles and table permissions instead of Dataverse security roles. This reference covers when to
choose one, how to keep it in git, how to secure it, how to build pages that read and write, and how
to prove it works. Everything here was observed on a real site (enhanced data model, 2026).

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

A new site starts as a **trial** (in a production environment it expires after 90 days unless
converted, and converting needs capacity licences). Say so to the owner when you create one; the
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
  ("Portals-<site name>": sign in and read your profile). Plan it as a human step in a verification
  run; if the consent page waits too long the sign-in times out - start again from the site URL.
- **The built-in Entra provider creates the contact with no name or email**, so every page that
  shows "who" shows a blank. Do not build on the contact's name until it is proved filled. The
  documented fix is claims mappings as site settings with the short claim names
  (`Authentication/OpenIdConnect/AzureAD/RegistrationClaimsMapping` and `.../LoginClaimsMapping` =
  `firstname=given_name,lastname=family_name,emailaddress1=upn`). Observed: with both settings
  stored, config cleared, and a fresh sign-out and sign-in, the contact stayed blank - authentication
  settings can need a site restart from the admin centre. Check the contact row, not the header,
  and record the mapping as unverified until the row changes.

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

## 6. The cache

The running site caches configuration. After an upload that changes **table permissions or site
settings**, the site keeps the old ones - a correct fix still returns the old 403. Clear it before
testing: `/_services/about` (as a site administrator), **Clear config**, and **Clear cache** for
content. Authentication settings can need a site restart from the admin centre.

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
   every page, and the forms must stack.
