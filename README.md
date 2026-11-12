# PulseBank LIVE REAL COMBINED — api.pulsebank.ca

Own-host gift-card API + merchant terminal + investor deck v2, from the Meta AI share bundle
"Pulsebank LIVE REAL COMBINED FINAL". BINs 469344 / 511340 (Peoples Trust, Thredd) and
492726 Vanilla-style single-load.

```
code/                 Express API (Postgres immutable ledger, Redis idempotency, Thredd/Square adapters)
public/app/index.html Merchant terminal (single-file React build, served at /app)
investor_deck_v2/     15 slides + 6 charts (charts/*.png)
nginx.conf.live       TLS vhost: /app static, /api -> 127.0.0.1:3000
FIXES_LIVE_REAL.md    what was broken in the bundle and what changed
```

## Status (2026-11-01)

`api.pulsebank.ca` is **not registered in public DNS yet** (NXDOMAIN via 1.1.1.1; the saved SSH
host also fails to resolve). Everything else is ready: the terminal at `public/app/index.html`
now issues real requests to the routes below, and `nginx.conf.live` matches the Express
contract. Register/point the domain first — certbot cannot issue a certificate until it
resolves — or point `window.PULSEBANK_API_BASE` at wherever the API actually runs.

## Deploy

```bash
cd code
cp ../.env.production.live.keys.template .env     # fill in real keys, never commit .env
./deploy.sh                                        # docker compose up, migrate, health check
sudo cp ../nginx.conf.live /etc/nginx/sites-available/pulsebank
sudo ln -s /etc/nginx/sites-available/pulsebank /etc/nginx/sites-enabled/
sudo certbot --nginx -d api.pulsebank.ca && sudo nginx -t && sudo systemctl reload nginx
```

Only nginx is public: the app binds 127.0.0.1:3000 and Postgres/Redis are container-only.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/health` | db + redis + processor probe (503 if Postgres down) |
| POST | `/api/v1/cards/issue` | issue closed-loop or mall/Visa/MC card |
| GET | `/api/v1/cards/:id/balance` | balance by card id |
| GET | `/api/v1/cards/balance/:barcode` | public balance lookup (receipt / pass link) |
| POST | `/api/v1/cards/:id/redeem` | redeem (row-locked, idempotent) |
| POST | `/api/v1/cards/:id/void` | void remaining balance |
| POST | `/api/v1/cards/:id/wallet` | Apple Wallet `.pkpass` |
| GET | `/api/v1/merchants/:id/settlement` | daily settlement + fee |
| POST | `/api/v1/distributor/issue` | Givex / DataCandy / Tango proxy |
| POST | `/api/v1/square/redeem` | Square POS redeem, offline queue |
| POST | `/api/v1/refunds` | Stripe refund to card or connected account (503/400 `blocked` without live key) |
| GET | `/api/v1/refunds/:id` | refund status for ops reconciliation |

## Merchant terminal (`public/app/index.html`)

The single-file React terminal now calls the live API instead of rendering a canned response:

| Tab | Call |
| --- | --- |
| Issue card | `POST /api/v1/cards/issue` — `merchant_id`, `amount_cad` (cents), `type: mall_open_loop`, `network` from BIN, `reloadable` |
| Redeem | `POST /api/v1/square/redeem` — card barcode + cents + `merchant_id` + `square_payment_id` |
| Balance check | `GET /api/v1/cards/:id/balance` |
| Settlement | `GET /api/v1/merchants/:id/settlement` |
| Apple Wallet | `POST /api/v1/cards/:id/wallet` |

- Amounts are entered in CAD and sent as cents (`$500` → `50000`).
- A successful issue writes the returned card `id` and `barcode` back into the form, so
  issue → balance → redeem runs without copy-pasting.
- The response panel shows the real HTTP status and timestamp. Requests are relative to the
  serving host; when the terminal is hosted away from the API origin, set
  `window.PULSEBANK_API_BASE` (e.g. `https://api.pulsebank.ca`) before load.
- The embedded nginx snippet matches `nginx.conf.live`: `location /api/` with **no trailing
  slash** on `proxy_pass` (otherwise `/api/v1/...` is rewritten to `/v1/...` and 404s) and
  `X-Idempotency-Key` passed through.

## Before going live

- All `/api/v1` routes require the server-side `ADMIN_TOKEN` in the `X-Admin-Token` header
  (or a Bearer Authorization header), except `GET /api/v1/health`, public barcode balance
  lookup, and Stripe, PayPal, and KYC webhooks, which verify their processor signatures.
  The self-service KYC endpoints and Square OAuth callback are admin-only for now; do not
  expose those flows until customer-scoped access and OAuth state validation are implemented.
- The default CORS list includes `https://pulsebank-website.fly.dev`; add any custom website
  origin to `ALLOWED_ORIGINS` on the API host. CORS is not a substitute for API authentication.
- Apple Wallet needs `certs/wwdr.pem`, `signerCert.pem`, `signerKey.pem` (+ passphrase).
- Square OAuth needs `SQUARE_APP_ID` / `SQUARE_APP_SECRET`; Square redemption needs
  `node >= 18` for the global `fetch`.
- `docker compose exec app npm run migrate` must run once on a new database (deploy.sh does it).
