const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { constructWebhookEvent } = require('../adapters/stripe');

/**
 * Consumer storefront fulfillment - Stripe Payment Links -> gift cards.
 *
 *   buy.stripe.com (Payment Link)
 *     -> Stripe fires checkout.session.completed
 *     -> POST /api/v1/stripe/webhook (signature-verified, same manual check as the KYC webhook)
 *     -> stripe_orders row (idempotent on the Stripe event id)
 *     -> closed-loop card issued straight into cards + ledger_entries
 *        (same tables the merchant terminal's /cards/issue writes)
 *
 * Signature-verified with STRIPE_WEBHOOK_SECRET (shared with the KYC webhook).
 * The client/browser can never mint a card: only a Stripe-signed event reaches
 * fulfillment, and each Stripe event id is consumed exactly once.
 */

const ONLINE_MERCHANT_ID = 'mer_pulsebank_online';
let ordersTableEnsured = false;

// Canonical DDL also lives in ledger/migrate.js; this safety net keeps the
// webhook working on deploys where the migration step did not run.
async function ensureOrdersTable(pool) {
  if (ordersTableEnsured) return;
  await pool.query(`
  CREATE TABLE IF NOT EXISTS stripe_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_event_id TEXT UNIQUE NOT NULL,
    stripe_session_id TEXT UNIQUE NOT NULL,
    payment_intent TEXT,
    amount_cad INT NOT NULL,
    currency TEXT DEFAULT 'cad',
    customer_email TEXT,
    card_id TEXT,
    barcode TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    fulfilled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(
    `INSERT INTO merchants (id, name, city) VALUES ($1,'PulseBank Online','Courtenay') ON CONFLICT DO NOTHING`,
    [ONLINE_MERCHANT_ID]
  );
  ordersTableEnsured = true;
}

// Issue the closed-loop card for a paid checkout session.
// Idempotent: a redelivered/concurrent event finds the ledger entry by the
// session-derived idempotency key instead of double-issuing.
async function fulfillSession(pool, session) {
  const amount = Number(session.amount_total || 0);
  if (amount <= 0) throw new Error('checkout session has no amount_total - refusing to fulfill');
  const email = (session.customer_details && session.customer_details.email) || null;
  const idemKey = `stripe_order_${session.id}`;

  const done = await pool.query('SELECT card_id FROM ledger_entries WHERE idempotency_key=$1', [idemKey]);
  if (done.rows[0]) {
    const c = await pool.query('SELECT id, barcode FROM cards WHERE id=$1', [done.rows[0].card_id]);
    if (c.rows[0]) return { cardId: c.rows[0].id, barcode: c.rows[0].barcode, resumed: true };
  }

  const cardId = `card_${uuidv4().slice(0, 8)}`;
  const barcode = `${Math.floor(Math.random() * 1e12)}`.padStart(12, '0');

  await pool.query('BEGIN');
  try {
    await pool.query(
      `INSERT INTO cards (id, merchant_id, amount_cad, balance_cad, type, status, barcode, no_expiry, recipient_email, payment_rail, stripe_payment_intent_id, external_reference)
       VALUES ($1,$2,$3,$3,'closed_loop','issued',$4,true,$5,'stripe',$6,$7)`,
      [cardId, ONLINE_MERCHANT_ID, amount, barcode, email, session.payment_intent || null, session.id]
    );
    const ledgerId = uuidv4();
    await pool.query(
      `INSERT INTO ledger_entries (id, card_id, merchant_id, type, amount_cad, balance_after, idempotency_key)
       VALUES ($1,$2,$3,'ISSUE',$4,$4,$5)`,
      [ledgerId, cardId, ONLINE_MERCHANT_ID, amount, idemKey]
    );
    await pool.query('COMMIT');
    return { cardId, barcode, amount, email };
  } catch (e) {
    await pool.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

// POST /api/v1/stripe/webhook - Stripe-signed events only.
// Raw bytes come from the global json parser's verify hook (req.rawBody):
// signature verification must run over the body exactly as Stripe signed it.
router.post('/webhook', async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('stripe webhook rejected:', e.message);
    return res.status(e.code === 'WEBHOOK_SECRET_MISSING' ? 503 : 400).json({ error: e.code || 'webhook_invalid', message: e.message });
  }

  if (event.type !== 'checkout.session.completed') {
    return res.json({ received: true, ignored: event.type });
  }

  const session = event.data.object || {};
  const pool = req.app.locals.pool;
  try {
    await ensureOrdersTable(pool);
    const amount = Number(session.amount_total || 0);
    const email = (session.customer_details && session.customer_details.email) || null;

    // One fulfillment per Stripe event id; redeliveries fall through to the
    // idempotency-key check inside fulfillSession.
    const up = await pool.query(
      `INSERT INTO stripe_orders (stripe_event_id, stripe_session_id, payment_intent, amount_cad, currency, customer_email, status)
       VALUES ($1,$2,$3,$4,$5,$6,'processing')
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING id`,
      [event.id, session.id, session.payment_intent || null, amount, session.currency || 'cad', email]
    );

    if (up.rows.length) {
      const fulfil = await fulfillSession(pool, session);
      await pool.query(
        `UPDATE stripe_orders SET card_id=$2, barcode=$3, status='fulfilled', fulfilled_at=NOW(), updated_at=NOW() WHERE stripe_event_id=$1`,
        [event.id, fulfil.cardId, fulfil.barcode]
      );
      console.log(`stripe order fulfilled: ${session.id} -> ${fulfil.cardId} ($${(amount / 100).toFixed(2)} ${session.currency || 'cad'})`);
    } else {
      await pool.query(`UPDATE stripe_orders SET updated_at=NOW() WHERE stripe_event_id=$1 AND status='processing'`, [event.id]);
    }
    return res.json({ received: true });
  } catch (e) {
    console.error('stripe webhook handler failed:', e.message);
    return res.status(500).send('handler error'); // 500 -> Stripe retries
  }
});

// GET /api/v1/stripe/orders/:sessionId - ops lookup (was this checkout fulfilled?)
router.get('/orders/:sessionId', async (req, res) => {
  const { rows } = await req.app.locals.pool.query(
    `SELECT stripe_session_id, amount_cad, currency, customer_email, card_id, barcode, status, created_at, fulfilled_at
       FROM stripe_orders WHERE stripe_session_id=$1`,
    [req.params.sessionId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'order not found' });
  return res.json(rows[0]);
});

module.exports = router;
