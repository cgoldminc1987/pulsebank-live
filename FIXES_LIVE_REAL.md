# PulseBank LIVE REAL COMBINED FINAL — audit and fixes

Source: the Meta AI share bundle `pulsebank_x5f_LIVE_x5f_REAL_x5f_COMBINED_x5f_FINAL.zip`
(68 entries, 7.9 MB): 9 agentic HTML artifacts (each stored twice, byte-identical),
`code/` own-host API (v3.0.0 Cumberland build), `public/app/index.html`, and `investor_deck_v2/`.
Only `code/`, `nginx.conf.live`, `investor_deck_v2/*.html` and this doc were touched.

## Deploy blockers
1. **`nginx.conf.live`: `proxy_pass http://127.0.0.1:3000/;`** — the trailing slash strips the
   `/api/` prefix, so `/api/v1/health` reached Express as `/v1/health` → 404 on every endpoint.
   Now `proxy_pass http://127.0.0.1:3000;` with Host / X-Forwarded-Proto / idempotency headers.
2. **`nginx.conf.live`: `location /app { alias /opt/pulsebank/public/app/; }`** — an `alias` on a
   prefix that does not end in `/` mis-maps `$uri`. Replaced with `root /opt/pulsebank/public`
   + `index` + `try_files ... /app/index.html`, `/app` → `/app/`, `/commands` → `/app/`
   (the terminal UI's own nav links to `/commands`).
   TLS files and the port-80 → 443 redirect that certbot expects are now spelled out; `/health` proxied.
3. **`Dockerfile` ran `npm ci`** but the bundle ships no `package-lock.json` — `npm ci` aborts, so
   `docker compose up --build` never produced an image. Now `npm install --omit=dev`.
4. **`docker-compose.yml` published Postgres 5432 and Redis 6379 on the host** with
   `${POSTGRES_PASSWORD}` and no TLS. Both are now container-only (`expose`); the app binds
   `127.0.0.1:3000:3000`; Redis persists with `--appendonly yes`.
5. **`deploy.sh` only echoed instructions.** It now refuses to run without `.env`, brings the stack
   up, waits for Postgres with `pg_isready`, runs the migration, and calls `/api/v1/health`.

## Crashes (handlers that could not even load)
6. **Broken string literals** — `'... VALUES ($1,$2,$3,'REDEEM',$4)'` in `routes/cards.js`
   (redeem, void) and `adapters/square.js` (offline queue, ledger insert). These are parse errors:
   the whole router file fails to require, so redeem, void, offline queue and Square redemption were dead.
   All SQL containing SQL literals now uses double quotes.
7. **`SELECT * FROM cards FOR UPDATE WHERE id=$1`** — `FOR UPDATE` after `WHERE` is invalid Postgres.
   Both occurrences fixed to `SELECT * FROM cards WHERE id=$1 FOR UPDATE`.
8. **`adapters/square.js` did `require('node-fetch')`** — node-fetch v3 is ESM-only, so that throws at
   load, and the OAuth callback referenced an undefined `fetch`. Uses the Node 18+ global `fetch`;
   `node-fetch` dropped from `package.json`.
8b. **`adapters/visa_mc.js` read `recipient.email` unconditionally** — a reloadable issue without a
   recipient threw a TypeError instead of the 409 `FINTRAC_KYC_REQUIRED` the error mapper is written for.
   Fails closed now, so KYC cannot be skipped by omitting the recipient.

## Double-booking and idempotency
9. **`POST /api/v1/cards/issue` with `type: mall_open_loop` + `network: visa|mastercard` inserted a
   closed-loop card **and** ledger row, then also called the Visa/MC adapter, which inserted a second card
   and a second ISSUE entry — two cards, one charge. Open-loop issuance is delegated before any local write.
10. **Idempotency middleware** awaited `redis.get` on a client that may not be connected (request 500s
    instead of issuing) and never cached the open-loop response, so a replayed key issued twice.
    It now skips gracefully when Redis is not ready and caches both paths; `/redeem` and
    `POST /square/redeem` write `idempotency_key`, so a replayed Square payment no longer double-debits.

## Routes that were advertised but missing
11. `GET /api/v1/cards/balance/:barcode` — printed on receipts and on the Wallet back field — did not exist.
    Added (public balance lookup with the BPCPA no-expiry/no-fee notice).
12. `POST /api/v1/cards/:id/wallet` — listed in `/health` but never mounted — added, streaming
    `application/vnd.apple.pkpass` from the existing generator, 503 JSON when Apple certs are absent.
13. Anything else now returns JSON with the endpoint list instead of Express's HTML 404.

## Database
14. **`migrate.js` never applied `migrate_visa_mc.sql`**, so a fresh database had no `network`, `bin`,
    `is_reloadable`, `cdic_eligible` or `customers` — every open-loop issue would fail. The ALTER/CREATE
    statements are now part of the migration (idempotent, `IF NOT EXISTS`).
15. `/api/v1/health` no longer hardcodes `redis: 'up'`: it reports the real Redis state and returns
    **503** when Postgres is unreachable (`ok` follows the probe).

## Investor deck v2
16. **14 of 15 slide HTML files were 0 bytes** (`cover.html`, `vision.html`, … `ask.html`), while
    `slide_content.md`, `slide_outline.json` and all 6 chart PNGs were complete — the deck could not be
    opened. All 15 slides were regenerated from `slide_content.md` with the aqua `#299F99` / Lexend theme
    the deck spec calls for, each chart inlined as base64 into its slide (so a slide opens correctly from
    Files, email or a browser), with slide-to-slide nav and print CSS.
    Added `investor_deck_v2/index.html` as the deck's own table of contents.
17. **`public/app/index.html` makes no network calls at all** (no `fetch`, no XHR): every button renders a
    locally-computed fake response, and its advertised paths (`POST /api/cards`, `POST /api/redeem`,
    `GET /api/settlement`) do not exist on the server. Left as the pilot demo UI — the real API is `code/` —
    but it must be wired to `/api/v1/...` before it can drive issuance.
18. The demo's amount field defaulted to `5000` while its own zod contract caps a card at 50000 **cents**
    ($500), so the first thing a merchant saw was "$5000 / Single-load $5000" and a card the API would reject.
    Default and copy are now $500.

## Left alone on purpose
- The 9 `*_agentic_artifact_*.html` files are byte-identical duplicates of the plain-named artifacts
  (~2.2 MB of duplicate HTML). Kept, since the share page links them by that name.
- No auth on any API route (unchanged). Put nginx basic auth, mTLS or a gateway in front before exposing it.
- Apple Wallet signing still needs real certs in `certs/`; the code returns a 503 JSON fallback rather than
  pretending to sign.
- Amount unit: `amount_cad` is **cents** per the zod contract (`min(100).max(50000)` = $1–$500) and per
  the `/100` arithmetic in receipts and Wallet passes, so Square's `amount_money.amount` is already cents.
  `routes/merchants.js` summed it as dollars at 7%; the settlement endpoint now converts to dollars on the
  way out.
