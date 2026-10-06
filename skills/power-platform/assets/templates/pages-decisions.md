# Portal go-live decisions

Put these to the owner in the first decision batch (`references/power-pages.md` section 17). When no
person answers, take the recommendation, build to it, and list it in the hand-back. Fill one row each.
Identity comes first: hand the person the administrator's steps below before the build starts, so the
build can finish identity rather than stop at a workaround (three measured builds stopped there).

| Decision | Options | Recommendation | Answer | By, date |
|---|---|---|---|---|
| **Identity for people who are not Dataverse users - settle first** | Entra ID OpenID Connect provider with `openid email profile` and claims mapping (needs an app registration) / ask the name once, email from a trusted claim / Dataverse users only | The OpenID Connect provider; until it exists, refuse unattributable writes and record the go-live blocker | | |
| Audience | named people (up to 50) / the whole organisation / external visitors | Private for the pilot; organisation-wide means Public with every page and endpoint restricted to signed-in people and Entra ID the only provider | | |
| Licence | stay on trial / convert (needs authenticated-user capacity) | Stay on trial; conversion is the owner's step | | |
| Who is let in, and how | grant by name / open to the organisation / nobody during the build | Nobody during the build; the owner grants at go-live (staff using Entra ID need no invitation) | | |
| Freshness of back-office changes | accept up to 15 minutes / clear cache by hand (test only) | Accept, and say "updates within a few minutes" on the page | | |
| The site's own sign-in consent in an unattended run | the person accepts it in the opened browser / the agent accepts it for the builder's own account (`site-walk.mjs signin --accept-site-consent`) | The agent accepts it: only the site's `Portals-<site>` app, sign-in and profile only, never for the organisation | | |
| Notifications from the site's writes | existing flows only / new messages | Existing flows only, recipients checked; no new message during the build | | |

**Go-live blockers found during the build** (each with the owner's fix):

-

## Steps for the administrator: sign-in that names everyone (power-pages.md section 18, option 1)

Someone with rights to create app registrations in Microsoft Entra ID does steps 1 to 4; the site's
maker does 5 and 6. The client secret goes straight into the studio and is never sent to the builder.

1. Entra admin centre > Applications > App registrations > New registration. Name: `<site name> sign-in`.
   Supported account types: this organisational directory only. Leave the redirect URI empty for now.
2. On the new registration: Certificates & secrets > New client secret; copy the value once, for step 5.
   Authentication > enable "ID tokens".
3. API permissions > Add > Microsoft Graph > Delegated: `openid`, `email`, `profile`. Grant admin
   consent if the tenant requires it.
4. Note the Application (client) ID and the Directory (tenant) ID from Overview.
5. Power Pages studio > the site > Set up > Identity providers > Add provider > Other > OpenID Connect.
   Authority `https://login.microsoftonline.com/<tenant id>/`, client ID and secret from steps 2 and 4,
   Response type `code id_token`, Response mode `form_post`, Scope `openid email profile`. Copy the reply
   URL the studio shows into the app registration: Authentication > Add a platform > Web > Redirect URI.
6. Tell the builder it is done. The builder sets the claims mapping
   (`firstname=given_name,lastname=family_name,emailaddress1=email`), turns the built-in provider off,
   and proves with a new contact that the name and email arrive.
