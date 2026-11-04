# DiaBuddy security

DiaBuddy handles a child's glucose readings, insulin doses and dose settings. Under South Africa's POPIA, that is *special personal information* (health data about a child). It also holds paid API keys. This document records:
- what is stored and where
- who can reach it
- how each risk is handled
- what to do when something goes wrong

## What is stored, and where

| Data | Where | Who can read it | Kept for |
|---|---|---|---|
| Glucose readings (one record per day) | Cloudflare KV (`glucose:YYYY-MM-DD`) | Connected phones | 120 days |
| Meal & dose log | Cloudflare KV (`event:…`) | Connected phones | 1 year |
| Dose settings + change history | Cloudflare KV (`settings`, `settings-history:…`) | Connected phones; only admin phones can change them | History: 2 years |
| Family foods | Cloudflare KV (`food:…`) | Connected phones | Until removed |
| Phone records | Cloudflare KV (`device:<sha256 of key>`) | Admin phones (names and roles only) | Until removed |
| Invites | Cloudflare KV (`invite:<sha256 of code>`) | No one; they're only redeemed | 24 hours, single use |
| Insights: one summary per day (time-of-day percentages, meal/low/correction response curves, 15-minute samples) | Cloudflare KV (`insights-day:<date>`, `insights-done`) | Connected phones | 120 days, like the readings |
| Weekly summary written by Claude | Cloudflare KV (`insights-summary:<week>`) | Connected phones | 1 year |
| Alert subscriptions (a phone's push address and keys) | Cloudflare KV (`push:<device id>`, `high-alert`) | Only the relay | Until the phone turns alerts off or is removed |
| Dexcom / LibreLinkUp logins, Anthropic API key, alert signing key (`VAPID_PRIVATE_JWK`) | Cloudflare Worker secrets (encrypted) | Only the relay code | Until rotated |
| Each phone's own key, cached settings, meal in progress | That phone's browser storage | That phone | Until "Disconnect this phone" |
| App code, USDA/Open Food Facts food data | Private GitHub repo; Cloudflare static assets | Public (no personal data) | — |

Label photos are sent to Anthropic to be read and aren't stored by DiaBuddy. The weekly Insights summary sends Anthropic only percentages, medians and counts for the week (no readings, no meal times, no names). High-glucose alerts are encrypted for each phone (Web Push, RFC 8291) before they leave the relay, so the push service (Google, Apple, Mozilla, Microsoft) passes them on but can't read them. Under Anthropic's commercial API terms, inputs aren't used for training by default.

The repo was public before 4 November 2026. Its Git history still contains old `settings.json` versions (his dose numbers). Making the repo private hides them. Removing them for good would mean re-creating the repo.

## Access model

- **Joining:** every phone joins with a **single-use invite** that expires after **24 hours**. On joining, it gets its own random 256-bit key. The relay stores only the key's SHA-256 hash, so a copy of the store can't be used to sign in.
- **Roles:**
  - **Admin:** everything below, plus dose settings, phones, invites and data deletion
  - **Family:** readings, log, foods, label photos
  - **View only (TV):** read only
- **Enforcement:** roles are checked by the relay on every request. Hiding buttons in the app is only a convenience.
- **Removing access:** an admin can remove any phone, and any phone can disconnect itself. Removal takes effect on the next request.
- **Old shared keys:** `FAMILY_KEY` and `TV_KEY` are accepted, as Family and TV, only until an admin taps **Settings → Phones → Turn off the old shared link**. After that, delete both secrets in Cloudflare.

## OWASP mapping

| Risk (OWASP Top 10 2021 / API Top 10 2023) | Control |
|---|---|
| A01 Broken access control · API1 object-level · API5 function-level | Every route checks the phone's role on the relay. Family/TV keys can't write settings, list phones or delete data (tests: `tests/auth.test.mjs`). IDs in delete routes are validated with strict patterns. |
| A02 Cryptographic failures | HTTPS only (HSTS). Keys come from `crypto.getRandomValues` (256-bit). Keys and invite codes are stored as SHA-256 hashes. Keys are compared in constant time. Secrets live in Cloudflare's encrypted secret store. |
| A03 Injection (incl. XSS) | All outside text (food names, phone names, log entries, AI label notes, Open Food Facts data) is HTML-escaped before display. Readings and settings from the relay are coerced to numbers or known values. A strict Content Security Policy allows no inline or third-party scripts (`script-src 'self'`). Tested with `<img onerror>` probes. |
| A04 Insecure design | Doses are never worked out from untrusted data without a person seeing it. Label photos only fill a form that must be checked before saving. Sensor readings fill BG only when fresh, never when LO/HI. |
| A05 Security misconfiguration | Real response headers on the app and API: CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, HSTS, `Permissions-Policy`, COOP. API responses are `no-store`, and the service worker never caches them. Only `dist/` is published (no tests, scripts or relay code). |
| A06 Vulnerable components | No third-party code runs in the browser. Relay dependencies (Anthropic SDK, zod, Wrangler) are pinned in `worker/package-lock.json`. Install scripts are blocked. Dependabot alerts are on. |
| A07 Identification & authentication · API2 broken authentication | Per-phone keys, single-use expiring invites, rate-limited joining, immediate revocation. |
| A08 Software & data integrity | Deploys come only from this repo by the admin, via Wrangler. The relay validates and size-limits every write (events, foods, settings, photos). |
| A09 Logging & monitoring | Failed joins and failed keys are logged in Cloudflare with the route and a hashed IP tag. Keys, request bodies and health data are never logged. Settings changes are kept with who made them. |
| A10 SSRF | The relay only calls fixed hosts (Dexcom, LibreView, Anthropic). The one address a phone supplies, its alert (push) address, must be HTTPS on a browser push service (`fcm.googleapis.com`, `web.push.apple.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`); anything else is refused. |
| API4 Unrestricted resource consumption | Cloudflare rate limits: 120 requests a minute per phone, 5 joins a minute per IP, 3 label photos a minute per phone plus 60 a day overall. Request bodies are size-capped. A spend limit is set on the Anthropic workspace. |
| API6 Sensitive business flows | Label photos and invites need a Family or Admin phone. Data deletion needs an admin and a typed confirmation. |
| API8 Security misconfiguration · API9 inventory | All routes are listed in `worker/worker.js` (`API_PATHS`). There are no hidden or debug endpoints. |

**Known limits:**
- Keys live in the browser's storage, which any script on the page could read. The CSP and escaping are what protect against that.
- Rate limits are per Cloudflare location and approximate.
- KV writes aren't atomic, so two phones redeeming the same invite in the same instant could both succeed.

## Threats and what to do

| If… | Do this |
|---|---|
| **A phone is lost or stolen** | Admin: Settings → Phones → **Remove** that phone. It stops working immediately. |
| **An invite link was sent to the wrong person** | If it's unused, it expires in 24 hours. If it was used, remove the phone it created. |
| **Someone might have the old shared link** | Settings → Phones → **Turn off the old shared link**, then delete `FAMILY_KEY` and `TV_KEY` in Cloudflare. |
| **The alert signing key may have leaked** | Make a new one and run `wrangler secret put VAPID_PRIVATE_JWK`. Every phone then turns alerts off and on again. |
| **The Anthropic key may have leaked** | Create a new key in the DiaBuddy workspace. In `worker/` run `npx wrangler secret put ANTHROPIC_API_KEY`, then delete the old key in the Console. Check usage for anything unexpected. |
| **The Dexcom or LibreLinkUp password may have leaked** | Change it with Dexcom or Abbott, then run `npx wrangler secret put DEXCOM_PASSWORD` (or `LIBRE_PASSWORD`). |
| **This PC is lost or compromised** | In Cloudflare: change your password, revoke Wrangler's login (My Profile → API Tokens), rotate every Worker secret above. In GitHub: revoke tokens and sessions. In Anthropic: rotate the key. |
| **His data must be deleted** (POPIA request, or leaving DiaBuddy) | Admin: Settings → **Delete his stored data** (Insights built from that data go with it). Cloudflare allows 1,000 deletions a day, so run it again if it says some are left. |

## Routine

- **Yearly:** rotate the Anthropic key, review the Phones list and remove anything unknown, and check the Anthropic spend limit.
- **When someone stops caring for him:** remove their phone.
- **Deploying:** `cd worker && npm run deploy` (builds `dist/`, then `wrangler deploy`). Run `node --test tests/*.test.mjs` first.

## Reporting a problem

DiaBuddy is a family project. If you spot a security problem, tell the admin directly, not in a group chat.
