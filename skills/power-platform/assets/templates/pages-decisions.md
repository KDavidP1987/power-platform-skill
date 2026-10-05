# Portal go-live decisions

Put these to the owner in the first decision batch (`references/power-pages.md` section 17). When no
person answers, take the recommendation, build to it, and list it in the hand-back. Fill one row each.

| Decision | Options | Recommendation | Answer | By, date |
|---|---|---|---|---|
| Audience | named people (up to 50) / the whole organisation / external visitors | Private for the pilot; organisation-wide means Public with every page and endpoint restricted to signed-in people and Entra ID the only provider | | |
| Identity for people who are not Dataverse users | Entra ID OpenID Connect provider with `openid email profile` and claims mapping (needs an app registration) / ask the name once, email from a trusted claim / Dataverse users only | The OpenID Connect provider; until it exists, refuse unattributable writes and record the go-live blocker | | |
| Licence | stay on trial / convert (needs authenticated-user capacity) | Stay on trial; conversion is the owner's step | | |
| Who is let in, and how | grant by name / open to the organisation / nobody during the build | Nobody during the build; the owner grants at go-live (staff using Entra ID need no invitation) | | |
| Freshness of back-office changes | accept up to 15 minutes / clear cache by hand (test only) | Accept, and say "updates within a few minutes" on the page | | |
| Notifications from the site's writes | existing flows only / new messages | Existing flows only, recipients checked; no new message during the build | | |

**Go-live blockers found during the build** (each with the owner's fix):

-
