
const { randomUUID } = require('crypto');
// Node 18+ has global fetch; node-fetch v3 is ESM-only and breaks require()

// Public base URL advertised in receipt footers (balance-check link).
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || 'https://pulsebank-gc-api.onrender.com';

/**
 * Square POS Middleware for PulseBank Gift Cards
 * For Cumberland / Courtenay brick-and-mortar pilot
 * Handles OAuth + redeem flow + offline queue
 */

// 1. OAuth - connect Square location to PulseBank merchant
// Redirect merchant to Square OAuth: https://connect.squareup.com/oauth2/authorize?client_id=...&scope=PAYMENTS_READ+MERCHANT_PROFILE_READ
async function squareOAuthCallback(req, res) {
  const { code, merchant_id } = req.query; // merchant_id = pulsebank merchant e.g. mer_cumberland_coffee
  // Exchange code for access token
  const tokenRes = await fetch('https://connect.squareup.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SQUARE_APP_ID,
      client_secret: process.env.SQUARE_APP_SECRET,
      code,
      grant_type: 'authorization_code'
    })
  });
  const tokens = await tokenRes.json();
  // Save to merchants table
  const pool = req.app.locals.pool;
  await pool.query('UPDATE merchants SET square_location_id=$1, square_access_token=$2 WHERE id=$3', [tokens.merchant_id, tokens.access_token, merchant_id]);
  res.json({ ok:true, message:`Connected Square location ${tokens.merchant_id} to PulseBank ${merchant_id}`, next: 'Scan gift cards at POS' });
}

// 2. Middleware that intercepts Square payment webhook or local POS scan
// POST /api/v1/square/redeem - called from Square Terminal custom app or local Electron POS
async function squareRedeemHandler(req, res) {
  const { barcode, amount_cad, merchant_id, square_payment_id } = req.body;
  const pool = req.app.locals.pool;
  const idemKey = `square_${square_payment_id || randomUUID()}`;

  // Idempotency: replay the same Square payment without double-debiting
  if (square_payment_id) {
    const dup = await pool.query('SELECT 1 FROM ledger_entries WHERE idempotency_key=$1', [idemKey]).catch(()=>({rows:[]}));
    if (dup.rows[0]) return res.status(200).json({ ok:true, idempotent_replay:true, square_payment_id });
  }

  // Find card
  const { rows } = await pool.query('SELECT * FROM cards WHERE barcode=$1 AND merchant_id=$2', [barcode, merchant_id]);
  if (!rows[0]) {
    // Card unknown locally: never block an island shop - queue the redemption for sync
    await pool.query("INSERT INTO offline_queue (id, merchant_id, barcode, action, amount_cad) VALUES ($1,$2,$3,'REDEEM',$4)", [randomUUID(), merchant_id, barcode, amount_cad]).catch(()=>{});
    return res.status(202).json({ queued:true, message:'Card not found locally - queued for sync (important for island shops)' });
  }
  const card = rows[0];
  if (card.balance_cad < amount_cad) return res.status(402).json({ error:'Insufficient balance', balance_cad: card.balance_cad, receipt_text: `Balance $${(card.balance_cad/100).toFixed(2)} - No expiry per BC BPCPA` });

  const newBal = card.balance_cad - amount_cad;
  await pool.query('BEGIN');
  try {
    await pool.query('UPDATE cards SET balance_cad=$1 WHERE id=$2', [newBal, card.id]);
    await pool.query("INSERT INTO ledger_entries (id, card_id, merchant_id, type, amount_cad, balance_after, idempotency_key) VALUES ($1,$2,$3,'REDEEM',$4,$5,$6)", [randomUUID(), card.id, merchant_id, -amount_cad, newBal, idemKey]);
    await pool.query('COMMIT');
  } catch(e) {
    await pool.query('ROLLBACK').catch(()=>{});
    throw e;
  }

  // Respond to Square POS with partial payment handling
  res.json({
    ok: true,
    redeemed_cad: amount_cad,
    balance_after_cad: newBal,
    square_partial_payment: {
      amount_money: { amount: amount_cad, currency: 'CAD' },
      tender_type: 'OTHER',
      note: `PulseBank GC ${barcode} - Remaining $${(newBal/100).toFixed(2)}`
    },
    receipt_footer: `PulseBank Gift Card - No expiry, No fees per BC BPCPA s.56 | Balance: $${(newBal/100).toFixed(2)} | Check: ${PUBLIC_BASE}/api/v1/cards/balance/${barcode} | Funds held in segregated trust at Peoples Trust`
  });
}

module.exports = { squareOAuthCallback, squareRedeemHandler };
