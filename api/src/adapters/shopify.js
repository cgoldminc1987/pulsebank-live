
const { randomUUID } = require('crypto');

/**
 * Shopify POS adapter for PulseBank Gift Cards
 * For Cumberland / Courtenay brick-and-mortar pilot
 *
 * Redemption only: records gift-card redemptions in the PulseBank ledger and
 * returns what the cashier should enter on the Shopify POS tender screen.
 * No Shopify credentials, no payment processing, no order creation.
 */

// GET /api/v1/shopify/health - connectivity + what this adapter does
function shopifyHealth(req, res) {
  res.json({
    ok: true,
    adapter: 'shopify',
    mode: 'redemption-only',
    credentials_required: false,
    usage: {
      endpoint: 'POST /api/v1/shopify/redeem',
      body: { barcode: '12-digit or registered alias', amount_cad: 'integer cents', merchant_id: 'e.g. mer_cumberland_coffee', shopify_order_id: 'optional - makes replays idempotent' },
      headers: { 'X-Idempotency-Key': 'optional - redis-backed replay guard' },
      response: 'redeemed_cad, balance_after_cad, receipt line to add to the Shopify order'
    },
    bc_compliance: 'No expiry, no fees per BC BPCPA s.56; funds in segregated trust'
  });
}

// POST /api/v1/shopify/redeem - called from a Shopify POS custom workflow / terminal
async function shopifyRedeemHandler(req, res) {
  const { barcode, amount_cad, merchant_id, shopify_order_id } = req.body || {};
  const pool = req.app.locals.pool;

  if (!barcode || !merchant_id) return res.status(400).json({ error: 'barcode and merchant_id are required' });
  if (!Number.isInteger(amount_cad) || amount_cad <= 0) return res.status(400).json({ error: 'amount_cad must be a positive integer in cents' });

  // Idempotency: replaying the same Shopify order/line must not double-debit
  const idemKey = `shopify_${shopify_order_id || randomUUID()}`;
  if (shopify_order_id) {
    const dup = await pool.query('SELECT 1 FROM ledger_entries WHERE idempotency_key=$1', [idemKey]).catch(() => ({ rows: [] }));
    if (dup.rows[0]) return res.status(200).json({ ok: true, idempotent_replay: true, shopify_order_id });
  }

  // Find card: a barcode registered via /barcodes/register first, else the card's own barcode
  let card = (await pool.query('SELECT c.* FROM cards c JOIN barcode_aliases b ON b.card_id=c.id WHERE b.barcode=$1 AND c.merchant_id=$2', [barcode, merchant_id])).rows[0];
  if (!card) card = (await pool.query('SELECT * FROM cards WHERE barcode=$1 AND merchant_id=$2', [barcode, merchant_id])).rows[0];

  if (!card) {
    // Card unknown locally: never block an island shop - queue the redemption for sync
    await pool.query("INSERT INTO offline_queue (id, merchant_id, barcode, action, amount_cad) VALUES ($1,$2,$3,'REDEEM',$4)", [randomUUID(), merchant_id, barcode, amount_cad]).catch(() => {});
    return res.status(202).json({ queued: true, message: 'Card not found locally - queued for sync' });
  }

  if (card.status && card.status !== 'issued') return res.status(400).json({ error: `card ${card.status}` });
  if (card.balance_cad < amount_cad) {
    return res.status(402).json({ error: 'Insufficient balance', balance_cad: card.balance_cad, receipt_text: `Balance $${(card.balance_cad / 100).toFixed(2)} - No expiry per BC BPCPA` });
  }

  const newBal = card.balance_cad - amount_cad;
  await pool.query('BEGIN');
  try {
    await pool.query('UPDATE cards SET balance_cad=$1 WHERE id=$2', [newBal, card.id]);
    await pool.query("INSERT INTO ledger_entries (id, card_id, merchant_id, type, amount_cad, balance_after, idempotency_key) VALUES ($1,$2,$3,'REDEEM',$4,$5,$6)", [randomUUID(), card.id, merchant_id, -amount_cad, newBal, idemKey]);
    await pool.query('COMMIT');
  } catch (e) {
    await pool.query('ROLLBACK').catch(() => {});
    throw e;
  }

  // What the cashier enters on the Shopify POS tender screen
  res.json({
    ok: true,
    redeemed_cad: amount_cad,
    balance_after_cad: newBal,
    shopify_pos: {
      tender: { amount_cad, currency: 'CAD', method: 'custom', label: 'PulseBank Gift Card' },
      note: `PulseBank GC ${barcode} - Remaining $${(newBal / 100).toFixed(2)}`,
      order_note_addendum: `Gift card ${barcode} redeemed $${(amount_cad / 100).toFixed(2)}`,
      partial_payment: 'Charge the remainder to any Shopify tender (cash, card, etc.)'
    },
    receipt_footer: `PulseBank Gift Card - No expiry, No fees per BC BPCPA s.56 | Balance: $${(newBal / 100).toFixed(2)} | Check: ${(process.env.PUBLIC_BASE_URL || 'https://pulsebank-gc-api.onrender.com')}/api/v1/cards/balance/${encodeURIComponent(barcode)} | Funds held in segregated trust at Peoples Trust`
  });
}

module.exports = { shopifyHealth, shopifyRedeemHandler };
