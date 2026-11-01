
const express = require('express');
const { z } = require('zod');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const {
  LITHIC_BASE, lithicEnabled, createLithicCard, getLithicCard,
  listLithicTransactions, getLithicTransaction,
  simulateAuth, simulateClearing
} = require('../adapters/lithic');

// GET /status - is Lithic wired on this host, and which environment?
router.get('/status', (req, res) => {
  res.json({
    enabled: lithicEnabled(),
    environment: LITHIC_BASE.includes('sandbox') ? 'sandbox' : 'production',
    base_url: LITHIC_BASE,
    endpoints: [
      'POST /api/v1/lithic/cards',
      'GET  /api/v1/lithic/cards/:token',
      'GET  /api/v1/lithic/cards/:token/transactions',
      'POST /api/v1/lithic/simulate/auth (sandbox only)',
      'POST /api/v1/lithic/simulate/clearing (sandbox only)',
      'GET  /api/v1/lithic/transactions/:token'
    ]
  });
});

const IssueSchema = z.object({
  memo: z.string().max(255).default('PulseBank card'),
  spend_limit_cents: z.number().int().positive().default(500000), // $5,000 per transaction
  spend_limit_duration: z.enum(['TRANSACTION','ANNUAL','PER_DAY','PER_MONTH','LIFETIME']).default('TRANSACTION'),
  account_holder_token: z.string().optional(),
  state: z.enum(['OPEN','PAUSED','CLOSED']).default('OPEN')
});

// POST /cards - issue a Lithic virtual card and mirror the issue into the ledger
router.post('/cards', async (req, res, next) => {
  const pool = req.app.locals.pool;
  try {
    const data = IssueSchema.parse(req.body);
    const card = await createLithicCard({
      memo: data.memo,
      spend_limit: data.spend_limit_cents,
      spend_limit_duration: data.spend_limit_duration,
      account_holder_token: data.account_holder_token,
      state: data.state
    });

    // Mirror into the local ledger so /commands + settlements see the issue
    const ledgerId = uuidv4();
    try {
      await pool.query(
        `INSERT INTO ledger_entries (id, card_id, merchant_id, type, amount_cad, balance_after, idempotency_key)
         VALUES ($1,$2,'lithic','LITHIC_ISSUE',$3,$3,$4)`,
        [ledgerId, card.token, Math.round((card.spend_limit || 0) / 100), req.idemKey || ledgerId]
      );
    } catch (e) {
      console.warn('lithic ledger mirror skipped:', e.message);
    }

    // PAN/CVV are returned once here for the merchant terminal to display
    res.status(201).json({
      id: card.token,
      network: card.network || null,
      type: card.type,
      state: card.state,
      last_four: card.last_four,
      pan: card.pan,
      cvv: card.cvv,
      exp_month: card.exp_month,
      exp_year: card.exp_year,
      spend_limit_cents: card.spend_limit,
      spend_limit_duration: card.spend_limit_duration,
      memo: card.memo,
      currency: card.cardholder_currency,
      lithic_base: LITHIC_BASE
    });
  } catch (e) { next(e); }
});

// GET /cards/:token - card configuration from Lithic
router.get('/cards/:token', async (req, res, next) => {
  try { res.json(await getLithicCard(req.params.token)); } catch (e) { next(e); }
});

// GET /cards/:token/transactions - auth + clearing events for one card
router.get('/cards/:token/transactions', async (req, res, next) => {
  try { res.json(await listLithicTransactions({ card_token: req.params.token })); } catch (e) { next(e); }
});

const AuthSchema = z.object({
  pan: z.string().min(12).max(19),
  amount: z.number().int().positive(), // cents
  descriptor: z.string().max(40).default('PULSE MERCHANT TEST'),
  mcc: z.string().length(4).default('5812')
});

// POST /simulate/auth - sandbox only
router.post('/simulate/auth', async (req, res, next) => {
  try {
    const data = AuthSchema.parse(req.body);
    const out = await simulateAuth(data);
    res.status(201).json({ token: out.token });
  } catch (e) { next(e); }
});

// POST /simulate/clearing - sandbox only
router.post('/simulate/clearing', async (req, res, next) => {
  try {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    await simulateClearing({ token });
    res.status(201).json({ cleared: true, token });
  } catch (e) { next(e); }
});

// GET /transactions/:token - full lifecycle of one transaction
router.get('/transactions/:token', async (req, res, next) => {
  try { res.json(await getLithicTransaction(req.params.token)); } catch (e) { next(e); }
});

module.exports = router;
