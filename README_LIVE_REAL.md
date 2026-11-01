# PulseBank LIVE REAL — api.pulsebank.ca

Gift-card + refunds stack: Express API (cards / merchants / distributor / square / refunds),
Postgres ledger, Redis idempotency, Stripe rails. BINs 469344 Visa / 511340 MC / 492726 Vanilla ref.

## Run it (own host)
1. `cp .env.production.live.keys.template code/.env` — deploy.sh does this if missing and rotates
   the placeholder `POSTGRES_PASSWORD` into a generated one on first seed.
2. `cd code && ./deploy.sh` — builds + starts postgres/redis/app, runs migrations, health-checks.
3. TLS: install `nginx.conf.live` into sites-available, symlink into sites-enabled, then
   `certbot --nginx -d api.pulsebank.ca`. nginx proxies `/api/`, `/health` and `/wallet/` to
   127.0.0.1:3000; port 3000 is only bound to loopback.

## Refund rails
- `POST /api/v1/refunds` `destination: credit_card` → Stripe refund against the original
  PaymentIntent (card must have been issued with `payment.stripe_payment_intent_id`).
- `destination: bank_account` → Stripe transfer to `STRIPE_CONNECT_ACCOUNT_ID` or a per-request
  `stripe_account`. Guarded: a transfer to the platform account itself
  (`STRIPE_PLATFORM_ACCOUNT_ID`) is refused (`STRIPE_SELF_DESTINATION`) until a real recipient
  connected account is configured.
- Processor failures leave the refund row `pending`/`failed`/`blocked` for ops reconciliation;
  the store credit stays on the ledger either way.

## Verify
- `GET /api/v1/health` — postgres/redis/processor status.
- Smoke chain: issue → balance → redeem → settlement.
- Wallet: `POST /api/v1/cards/:id/wallet` then `GET /wallet/<card>.pkpass`.
- Refunds need the live key + an original PI; without them the route answers 503/400 `blocked`,
  never silently.
