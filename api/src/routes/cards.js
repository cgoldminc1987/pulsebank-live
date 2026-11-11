
const express = require('express');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const { issueOpenLoopCard } = require('../adapters/visa_mc');
const { generateGiftCardPass } = require('../wallet/apple');

const IssueSchema = z.object({
  merchant_id: z.string(),
  amount_cad: z.number().int().min(100).max(99900), // $1 - $999 in cents
  type: z.enum(['closed_loop','mall_open_loop']).default('closed_loop'),
  delivery: z.enum(['email','sms','apple_wallet','google_pay']).default('email'),
  recipient: z.object({ email: z.string().email().optional(), phone: z.string().optional(), first_name: z.string().optional() }).optional(),
  compliance: z.object({
    no_expiry: z.boolean().default(true),
    trust_account_id: z.string().default('trust_bc_001'),
    lang: z.enum(['en','fr']).default('en')
  }).optional(),
  external_reference: z.string().optional(),
  payment: z.object({
    rail: z.enum(['stripe','cash','invoiced','other']).default('cash'), // how the buyer funded this gift card
    stripe_payment_intent_id: z.string().optional() // enables "refund to original card"
  }).optional(),
  aggregator: z.enum(['givex','datacandy','tango']).optional()
});

// POST /issue - core issuing endpoint for PulseBank /commands
router.post('/issue', (req,res,next) => {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.header('X-Admin-Token') !== token) {
    return res.status(401).json({ error: token ? 'admin token required' : 'ADMIN_TOKEN is not configured on the API service' });
  }
  next();
}, async (req,res,next) => {
  try {
    const data = IssueSchema.parse(req.body);
    const pool = req.app.locals.pool;
    const redis = req.app.locals.redis;

    // Replay guard when redis is down: same X-Idempotency-Key must not double-issue
    if (req.idemKey) {
      const seen = await pool.query("SELECT card_id FROM ledger_entries WHERE idempotency_key=$1 AND type='ISSUE'", [req.idemKey]);
      if (seen.rows[0]) {
        const { rows: c2 } = await pool.query('SELECT * FROM cards WHERE id=$1', [seen.rows[0].card_id]);
        if (c2[0]) {
          const c = c2[0];
          return res.status(201).json({ idempotent_replay: true, id: c.id, merchant_id: c.merchant_id, amount_cad: c.amount_cad, balance_cad: c.balance_cad, type: c.type, barcode: c.barcode, status: c.status });
        }
      }
    }

    // BC Compliance: closed-loop must have no_expiry = true, no fees
    if (data.type === 'closed_loop' && data.compliance && data.compliance.no_expiry === false) {
      const err = new Error('BC expiry not allowed'); err.code = 'BC_EXPIRY_NOT_ALLOWED'; throw err;
    }
    // Block reload attempt for closed-loop at issue time handled in /load

    // Visa/Mastercard open-loop issuance is delegated BEFORE any local write, otherwise the
    // merchant is charged twice (one closed-loop card + one open-loop card for a single POST).
    if (data.type === 'mall_open_loop' && (req.body.network === 'visa' || req.body.network === 'mastercard')) {
      const openCard = await issueOpenLoopCard({
        pool, merchant_id: data.merchant_id, amount_cad: data.amount_cad,
        network: req.body.network, type: req.body.reloadable ? 'reloadable' : 'single_load_non_reloadable',
        recipient: data.recipient || {}, idemKey: req.idemKey
      });
      if (req.idemKey && redis?.isReady) {
        await redis.set(`idem:${req.idemKey}`, JSON.stringify(openCard), { EX: 86400 }).catch(()=>{});
      }
      return res.status(201).json(openCard);
    }

    const cardId = `card_${uuidv4().slice(0,8)}`;
    const barcode = `${Math.floor(Math.random()*1e12)}`.padStart(12,'0');

    // Insert card + ledger entry in transaction
    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO cards (id, merchant_id, amount_cad, balance_cad, type, status, barcode, no_expiry, recipient_email, aggregator, external_reference, payment_rail, stripe_payment_intent_id)
       VALUES ($1,$2,$3,$3,$4,'issued',$5,true,$6,$7,$8,$9,$10)`,
      [cardId, data.merchant_id, data.amount_cad, data.type, barcode, data.recipient?.email, data.aggregator || null, data.external_reference || null, data.payment?.rail || 'cash', data.payment?.stripe_payment_intent_id || null]
    );
    const ledgerId = uuidv4();
    await pool.query(
      `INSERT INTO ledger_entries (id, card_id, merchant_id, type, amount_cad, balance_after, idempotency_key)
       VALUES ($1,$2,$3,'ISSUE',$4,$4,$5)`,
      [ledgerId, cardId, data.merchant_id, data.amount_cad, req.idemKey || ledgerId]
    );
    await pool.query('COMMIT');

    const response = {
      id: cardId,
      merchant_id: data.merchant_id,
      amount_cad: data.amount_cad,
      balance_cad: data.amount_cad,
      type: data.type,
      barcode,
      status: 'issued',
      wallet_url: data.delivery === 'apple_wallet' ? `https://api.pulsebank.ca/wallet/${cardId}.pkpass` : null,
      compliance: {
        no_expiry: true,
        fees_disclosure: data.type === 'mall_open_loop' 
          ? 'Mall card: $1.50 activation fee, $2.50/mo dormancy after 15mo per BC Reg 292/2008' 
          : 'No fees. No expiry per BC BPCPA s.56',
        trust_account_id: data.compliance?.trust_account_id || 'trust_bc_001',
        balance_check_url: `https://api.pulsebank.ca/api/v1/cards/balance/${barcode}`
      },
      external_reference: data.external_reference
    };

    if (req.idemKey && redis?.isReady) {
      await redis.set(`idem:${req.idemKey}`, JSON.stringify(response), { EX: 86400 }).catch(()=>{});
    }

    // Webhook
    // await fetch(process.env.WEBHOOK_URL, { method:'POST', body: JSON.stringify({ event:'card.issued', card: response }) })

    res.status(201).json(response);
  } catch(e){
 await req.app.locals.pool.query('ROLLBACK').catch(()=>{}); next(e); }
});

router.get('/:id/balance', async (req,res) => {
  const { rows } = await req.app.locals.pool.query('SELECT balance_cad, status, barcode FROM cards WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({error:'card not found'});
  res.json(rows[0]);
});

// Public balance lookup by barcode (printed on the card / linked from receipts)
router.get('/balance/:barcode', async (req,res) => {
  const { rows } = await req.app.locals.pool.query(
    `SELECT c.barcode, c.balance_cad, c.status, c.no_expiry
       FROM cards c
      WHERE c.barcode=$1
         OR EXISTS (SELECT 1 FROM barcode_aliases b WHERE b.card_id=c.id AND b.barcode=$1)
      LIMIT 1`, [req.params.barcode]);
  if (!rows[0]) return res.status(404).json({error:'card not found'});
  res.json({ ...rows[0], balance_check: 'no expiry, no fees per BC BPCPA s.56' });
});

// Apple Wallet .pkpass (health endpoint has always advertised this route)
router.post('/:id/wallet', async (req,res) => {
  const { rows } = await req.app.locals.pool.query(
    'SELECT * FROM cards WHERE id=$1', [req.params.id]);
  const card = rows[0];
  if (!card) return res.status(404).json({error:'card not found'});
  const pass = await generateGiftCardPass({
    cardId: card.id, barcode: card.barcode, amount_cad: card.amount_cad,
    balance_cad: card.balance_cad, merchantName: req.body?.merchant_name || card.merchant_id,
    recipientEmail: card.recipient_email
  });
  if (pass.fallback) return res.status(503).json({ ...pass, error: 'Apple Wallet certificates not configured on this host' });
  res.type('application/vnd.apple.pkpass').send(pass.buffer);
});

// Barcode registration moved to routes/barcodes.js (mounted at /api/v1/barcodes)

router.post('/:id/redeem', async (req,res,next) => {
  const { amount_cad } = req.body; // amount to redeem in cents
  const pool = req.app.locals.pool;
  try {
    if (!Number.isInteger(amount_cad) || amount_cad <= 0) {
      return res.status(400).json({ error: 'amount_cad must be a positive integer in cents' });
    }
    // Replay guard when redis is down: same X-Idempotency-Key must not double-debit
    if (req.idemKey) {
      const seen = await pool.query("SELECT 1 FROM ledger_entries WHERE idempotency_key=$1 AND type='REDEEM'", [req.idemKey]);
      if (seen.rows[0]) return res.status(200).json({ idempotent_replay: true, id: req.params.id });
    }
    await pool.query('BEGIN');
    const { rows } = await pool.query('SELECT * FROM cards WHERE id=$1 FOR UPDATE', [req.params.id]);
    const card = rows[0];
    if (!card) { await pool.query('ROLLBACK'); return res.status(404).json({error:'not found'}); }
    if (card.status !== 'issued') { await pool.query('ROLLBACK'); return res.status(400).json({error:`card ${card.status}`}); }
    if (card.balance_cad < amount_cad) { await pool.query('ROLLBACK'); return res.status(402).json({error:'insufficient balance'}); }
    const newBal = card.balance_cad - amount_cad;
    await pool.query("UPDATE cards SET balance_cad=$1, status=CASE WHEN $1::int=0 THEN 'redeemed' ELSE status END WHERE id=$2", [newBal, card.id]);
    await pool.query("INSERT INTO ledger_entries (id, card_id, merchant_id, type, amount_cad, balance_after, idempotency_key) VALUES ($1,$2,$3,'REDEEM',$4,$5,$6)", [uuidv4(), card.id, card.merchant_id, -amount_cad, newBal, req.idemKey || null]);
    await pool.query('COMMIT');
    res.json({ id: card.id, redeemed_cad: amount_cad, balance_after: newBal });
  } catch(e) { await pool.query('ROLLBACK').catch(()=>{}); next(e); }
});

router.post('/:id/void', async (req,res,next) => {
  const pool = req.app.locals.pool;
  try {
    await pool.query('BEGIN');
    const { rows } = await pool.query('SELECT * FROM cards WHERE id=$1 FOR UPDATE', [req.params.id]);
    const card = rows[0];
    if (!card || card.status !== 'issued') { await pool.query('ROLLBACK'); return res.status(400).json({error:'cannot void'}); }
    await pool.query("UPDATE cards SET status='voided', balance_cad=0 WHERE id=$1", [card.id]);
    await pool.query("INSERT INTO ledger_entries (id, card_id, merchant_id, type, amount_cad, balance_after) VALUES ($1,$2,$3,'VOID',$4,0)", [uuidv4(), card.id, card.merchant_id, -card.balance_cad]);
    await pool.query('COMMIT');
    res.json({ id: card.id, status:'voided' });
  } catch(e) { await pool.query('ROLLBACK').catch(()=>{}); next(e); }
});

module.exports = router;
