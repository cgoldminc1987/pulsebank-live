const express = require('express');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { refundToCreditCard, refundToBankAccount } = require('../adapters/stripe');

// POST /api/v1/refunds
// Refund store credit off a gift card back to the original payment method:
//   destination 'original'    -> use the rail captured at issue time (stripe)
//   destination 'credit_card' -> Stripe refund to the credit card of the original PaymentIntent
//   destination 'stripe'      -> same as credit_card (explicit)
//   destination 'bank_account'-> Stripe Connect transfer to the recipient account, bank payout follows
const RefundSchema = z.object({
  card_id: z.string(),
  amount_cad: z.number().int().min(100).max(50000), // cents - mirrors issue limits
  destination: z.enum(['original','credit_card','bank_account','stripe']).default('original'),
  stripe_payment_intent_id: z.string().optional(),
  stripe_account: z.string().optional(), // recipient connected account, overrides STRIPE_CONNECT_ACCOUNT_ID
  reason: z.string().max(500).optional()
});

router.post('/', async (req,res,next) => {
  const pool = req.app.locals.pool;
  let data, card, newBal, dest, idemKey, refundId;
  try {
    data = RefundSchema.parse(req.body);

    // Replay guard for when the redis idempotency middleware is not available
    idemKey = req.idemKey || `refund_${uuidv4()}`;
    const replay = await pool.query('SELECT * FROM refunds WHERE idempotency_key=$1', [idemKey]);
    if (replay.rows[0]) return res.status(200).json({ idempotent_replay: true, refund: replay.rows[0] });

    await pool.query('BEGIN');
    const { rows } = await pool.query('SELECT * FROM cards WHERE id=$1 FOR UPDATE', [data.card_id]);
    card = rows[0];
    if (!card) { await pool.query('ROLLBACK'); return res.status(404).json({error:'card not found'}); }
    if (card.status !== 'issued') { await pool.query('ROLLBACK'); return res.status(400).json({error:`card ${card.status} - only active cards can be refunded`}); }
    if (card.balance_cad < data.amount_cad) {
      await pool.query('ROLLBACK');
      return res.status(402).json({ error:'insufficient balance - only unredeemed store credit can be auto-refunded', balance_cad: card.balance_cad });
    }

    dest = data.destination;
    if (dest === 'stripe') dest = 'credit_card'; // alias, normalize before persisting
    if (dest === 'original') {
      if (card.payment_rail === 'stripe' || card.stripe_payment_intent_id) {
        dest = 'credit_card';
      } else {
        await pool.query('ROLLBACK');
        return res.status(400).json({ error:'no original payment method on file for this card - pass destination plus stripe_payment_intent_id' });
      }
    }

    newBal = card.balance_cad - data.amount_cad;
    refundId = uuidv4();
    await pool.query("UPDATE cards SET balance_cad=$1, status=CASE WHEN $1::int=0 THEN 'refunded' ELSE status END WHERE id=$2", [newBal, card.id]);
    await pool.query("INSERT INTO ledger_entries (id, card_id, merchant_id, type, amount_cad, balance_after, idempotency_key) VALUES ($1,$2,$3,'REFUND',$4,$5,$6)", [uuidv4(), card.id, card.merchant_id, -data.amount_cad, newBal, idemKey]);
    await pool.query(
      `INSERT INTO refunds (id, card_id, merchant_id, amount_cad, destination, status, stripe_payment_intent_id, idempotency_key, reason)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7,$8)`,
      [refundId, card.id, card.merchant_id, data.amount_cad, dest, data.stripe_payment_intent_id || card.stripe_payment_intent_id || null, idemKey, data.reason || null]
    );
    await pool.query('COMMIT');
  } catch(e) { await pool.query('ROLLBACK').catch(()=>{}); next(e); return; }

  // Money movement happens outside the ledger txn; failures leave the refund
  // 'pending' on the books for ops reconciliation rather than silently reversing.
  try {
    let result;
    if (dest === 'bank_account') {
      result = await refundToBankAccount({ amount_cad: data.amount_cad, connected_account_id: data.stripe_account, idempotency_key: idemKey });
    } else {
      result = await refundToCreditCard({ amount_cad: data.amount_cad, payment_intent_id: data.stripe_payment_intent_id || card.stripe_payment_intent_id, idempotency_key: idemKey });
    }
    const dbStatus = result.status === 'pending_payout' ? 'pending_payout' : result.status;
    await pool.query('UPDATE refunds SET status=$1, processor_reference=$2, completed_at=NOW() WHERE id=$3', [dbStatus, result.reference, refundId]);
    return res.status(201).json({
      id: refundId,
      card_id: card.id,
      merchant_id: card.merchant_id,
      amount_cad: data.amount_cad,
      destination: dest,
      status: dbStatus,
      balance_after: newBal,
      processor: result,
      disclosure: 'Refund returns unredeemed store credit to the original payment method; funds leave trust_bc_001.'
    });
  } catch (e) {
    if (e.code === 'STRIPE_NOT_CONFIGURED' || e.code === 'MISSING_PAYMENT_INTENT' || e.code === 'STRIPE_SELF_DESTINATION') {
      await pool.query("UPDATE refunds SET status='blocked', error=$1 WHERE id=$2", [e.message, refundId]);
      return res.status(e.code === 'MISSING_PAYMENT_INTENT' ? 400 : 503).json({
        error: e.message,
        code: e.code,
        refund_id: refundId,
        status: 'blocked',
        card_balance_after: newBal,
        note: 'Store credit is back on the ledger as pending; fix configuration (STRIPE_SECRET_KEY / stripe_payment_intent_id) and re-issue the processor refund.'
      });
    }
    await pool.query("UPDATE refunds SET status='failed', error=$1 WHERE id=$2", [e.message, refundId]);
    return res.status(502).json({ error:`processor refund failed: ${e.message}`, refund_id: refundId, status:'failed', card_balance_after: newBal });
  }
});

router.get('/:id', async (req,res) => {
  const { rows } = await req.app.locals.pool.query('SELECT * FROM refunds WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({error:'refund not found'});
  res.json(rows[0]);
});

module.exports = router;
