# KYC — Stripe Identity (reloadable-card + payouts gate)

Identity verification for anything that legally requires KYC (reloadable
open-loop cards ≥ $1,000, FINTRAC MSB). The vendor is **Stripe Identity** on
the same Stripe account that already processes payments — no new vendor, no
document storage on PulseBank hosts.

## Applicant flow

1. Send the customer `https://pulsebank-gc-api.onrender.com/kyc/?reference=<their email>`
   (or they type their email on that page).
2. They complete Stripe's hosted capture: government ID photo + live selfie
   match (`require_matching_selfie`, `require_live_capture` — no gallery uploads).
3. Stripe redirects back to `/kyc/returned.html`, which polls
   `GET /api/v1/kyc/session/:reference/refresh` until a decision is stored.
4. Webhook `identity.verification_session.*` → `POST /api/v1/kyc/webhook`
   stores the authoritative verdict (signature-verified, raw-body HMAC).

Only `verified` unlocks issuance. `consent_declined` / `requires_input` are
normal outcomes the page treats as "try again", never as approval.

## Gate

`requireKYCVerified()` in `api/src/adapters/visa_mc.js` runs on every
**reloadable** open-loop issue. It re-retrieves the session from Stripe at
issue time (a stale `customers` row cannot be trusted), caches the result
(`customers.kyc_status/kyc_verified_name/kyc_verified_at`), and still honors
`KYC_PROVIDER=trulioo` rows recorded by Trulioo if that path is ever used.
Single-load cards (≤ $1,000, non-reloadable) remain KYC-exempt per FINTRAC.

## API

| Method & path | Notes |
|---|---|
| `POST /api/v1/kyc/session` | `{reference, email, account_type}` → `{client_secret, url}`. Reuses open sessions; `409 already_verified / already_processing`. |
| `GET /api/v1/kyc/session/:reference` | Stored decision (no PII beyond verified name/country). |
| `GET /api/v1/kyc/session/:reference/refresh` | Live pull from Stripe — works even with no webhook secret set. |
| `GET /api/v1/kyc` | Ops/audit list. |
| `GET /api/v1/kyc/status` | Config surface. |
| `POST /api/v1/kyc/webhook` | Stripe-signed events only. |

## One-time Stripe setup (admin)

1. **Enable Identity**: https://dashboard.stripe.com/identity/application —
   until this is submitted, the API returns `503 identity_not_enabled`.
2. **Webhook** (instant updates; optional — refresh covers gaps):
   Dashboard → Developers → Webhooks → add endpoint
   `https://pulsebank-gc-api.onrender.com/api/v1/kyc/webhook`,
   events `identity.verification_session.*`, then set the printed
   `whsec_...` as `STRIPE_WEBHOOK_SECRET` on the Render service.
3. Optional `KYC_BASE_URL` if the API is served from another origin
   (defaults to the Render URL; used for `return_url` and `verify_url`).

Data stored: reference (email), status, verified name + country, timestamps,
session id. Never documents, selfies, ID numbers, or full addresses — those
stay with Stripe. Redact a session in the Stripe dashboard to fulfill a
deletion request.
