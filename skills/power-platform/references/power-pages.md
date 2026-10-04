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
- **The built-in Entra provider creates the contact with no name or email**, so every page and
  every back-office view that shows "who" shows a blank. Observed: claims mappings set as site
  settings (`Authentication/OpenIdConnect/AzureAD/RegistrationClaimsMapping` and
  `.../LoginClaimsMapping` = `firstname=given_name,lastname=family_name,emailaddress1=upn`, the
  documented short claim names), config cleared, the site restarted from the admin centre, and a
  fresh sign-out and sign-in: the contact row did not change. The built-in provider appears to
  ignore them; the documentation describes them for a provider you configure yourself.
  **Best approach: identify the person by the contact's `adx_identity_username`** (the Entra object
  id the platform writes; it cannot be typed in by the visitor) and resolve the name and email
  where they are needed - in the back-office app, from the user directory or `systemuser`
  (`azureactivedirectoryobjectid`). Do not ask the visitor to type their own email as identity.
  Check the contact row, never the header, before relying on any mapping.
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

## 8. Designing the site: the organisation's identity, not the platform's

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
   `Network.clearBrowserCache` in Playwright) before judging a CSS change.
5. **Brand artwork the owner keeps out of git** needs a prepare script that writes each web file
   and its record with fixed ids before every upload, a `.gitignore` for both, and a designed
   fallback (`onerror` to a text wordmark; a solid brand colour behind a photo). Screenshots of the
   site show the artwork too - keep review captures out of git as well.
6. **Forms that work on phones and desktops.** Required fields first and few; optional sections
   as one `<details>` each with an "Added" badge and a running count; radio groups drawn as 44 px
   pill buttons instead of selects; money as number inputs with a currency prefix and
   `inputmode="decimal"`; the submit bar sticky at the bottom on phones. On a phone the first field
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
