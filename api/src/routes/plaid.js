const express = require('express');
const router = express.Router();

const ENV = process.env.PLAID_ENV || 'production';
const BASE = `https://${ENV === 'sandbox' ? 'sandbox' : 'production'}.plaid.com`;
const enabled = () => Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);

async function plaid(path, body) {
  if (!enabled()) {
    const e = new Error('PLAID_CLIENT_ID / PLAID_SECRET not configured');
    e.status = 503;
    throw e;
  }
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, ...body })
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Plaid ${r.status}: ${json.error_message || 'error'}`);
    e.status = r.status;
    e.plaid = { error_code: json.error_code, error_type: json.error_type, request_id: json.request_id };
    throw e;
  }
  return json;
}

// Everything except /status needs the admin token (access tokens are bank credentials)
function admin(req, res, next) {
  const t = process.env.ADMIN_TOKEN;
  if (!t || req.header('X-Admin-Token') !== t) return res.status(401).json({ error: 'admin token required' });
  next();
}

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS plaid_items (
    item_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, institution_id TEXT,
    email TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
}

router.get('/status', (req, res) => res.json({
  enabled: enabled(), environment: ENV, base_url: BASE,
  endpoints: ['POST /api/v1/plaid/link-token', 'POST /api/v1/plaid/exchange', 'GET /api/v1/plaid/items/:itemId/accounts', 'GET /api/v1/plaid/items/:itemId/balance']
}));

// POST /link-token { user_id, products? }
router.post('/link-token', admin, async (req, res, next) => {
  try {
    const { user_id = 'pulsebank-user', products = ['auth'] } = req.body || {};
    const j = await plaid('/link/token/create', {
      client_name: 'PulseBank',
      language: 'en',
      country_codes: ['CA', 'US'],
      user: { client_user_id: String(user_id) },
      products
    });
    res.json({ link_token: j.link_token, expiration: j.expiration });
  } catch (e) { next(e); }
});

// POST /exchange { public_token, email? } - stores access_token server-side only
router.post('/exchange', admin, async (req, res, next) => {
  try {
    const { public_token, email } = req.body || {};
    if (!public_token) return res.status(400).json({ error: 'public_token required' });
    const j = await plaid('/item/public_token/exchange', { public_token });
    const pool = req.app.locals.pool;
    await ensureTable(pool);
    await pool.query(
      `INSERT INTO plaid_items (item_id, access_token, email) VALUES ($1,$2,$3)
       ON CONFLICT (item_id) DO UPDATE SET access_token=EXCLUDED.access_token`,
      [j.item_id, j.access_token, email || null]);
    res.status(201).json({ item_id: j.item_id });
  } catch (e) { next(e); }
});

async function tokenFor(req) {
  const pool = req.app.locals.pool;
  await ensureTable(pool);
  const { rows } = await pool.query('SELECT access_token FROM plaid_items WHERE item_id=$1', [req.params.itemId]);
  return rows[0] && rows[0].access_token;
}

router.get('/items/:itemId/accounts', admin, async (req, res, next) => {
  try {
    const access_token = await tokenFor(req);
    if (!access_token) return res.status(404).json({ error: 'item not found' });
    res.json(await plaid('/accounts/get', { access_token }));
  } catch (e) { next(e); }
});

router.get('/items/:itemId/balance', admin, async (req, res, next) => {
  try {
    const access_token = await tokenFor(req);
    if (!access_token) return res.status(404).json({ error: 'item not found' });
    res.json(await plaid('/accounts/balance/get', { access_token }));
  } catch (e) { next(e); }
});

router.use((err, req, res, next) => {
  if (err.status) return res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({ error: err.message, plaid: err.plaid });
  next(err);
});

module.exports = router;
