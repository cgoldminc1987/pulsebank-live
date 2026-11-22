const express = require('express');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const router = express.Router();

const SANDBOX_BASE = 'https://acquirersandbox.rp-2023app.com';
const SANDBOX_WEBHOOK_KEY_V1 = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuctrVK3eP8hpoJf7FMet
lcR77FYcj9HtrkySyGDRt5HHwdwgM8jK0kfE4ag/zI8goe8M0iJ2o7n3VCfTzn8O
yfU0bu6KzDti1WOJV9fv4XtSmhm9W4WKjIc8uDQViR7E8trzcrbKFVbKVGng1+z0
KobQBDtWhjUeXKktUq1lpiejTS+XjXej26ANPfwbqbY+/6kBB3sWbt9BLDI/WhPY
XnFV9oJWod9I/dYUgUUA/b/+bI1wlobNntBDxiNmX0kbqpGZbzO6l9wWFXZiFCD2
5QtBOZlMbn9noH4KW3DnKGc2nKNz/f2FEM9DJKn3P7NGFVy6O/Q5NzcbFs+DI6nT
ywIDAQAB
-----END PUBLIC KEY-----`;

const appKey = () => process.env.REDOTPAY_APP_KEY || '';
const enabled = () => Boolean(appKey());

function admin(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.header('X-Admin-Token') !== token) {
    return res.status(401).json({ error: 'admin token required' });
  }
  next();
}

function verifyWebhook(req) {
  const timestamp = req.header('X-R-TS');
  const signature = req.header('X-R-Signature');
  const version = req.header('X-R-KEY-VERSION');
  if (!timestamp || !signature || version !== '1' || !req.rawBody || !appKey()) return false;
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp)) > 5 * 60 * 1000) return false;
  try {
    const message = `${appKey()}.${timestamp}.${req.rawBody.toString('utf8')}`;
    return crypto.verify('RSA-SHA256', Buffer.from(message, 'utf8'), SANDBOX_WEBHOOK_KEY_V1, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS redotpay_orders (
      outer_order_sn TEXT PRIMARY KEY,
      outer_uid TEXT NOT NULL,
      amount NUMERIC(18,6) NOT NULL,
      currency CHAR(3) NOT NULL,
      provider_order_sn TEXT,
      checkout_url TEXT,
      provider_status TEXT NOT NULL DEFAULT 'CREATED',
      provider_tx_id TEXT,
      payment_time BIGINT,
      webhook_payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS redotpay_webhook_events (
      event_key TEXT PRIMARY KEY,
      outer_order_sn TEXT NOT NULL,
      payload JSONB NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function safeCheckoutUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && /(^|\.)redotpay\.com$/i.test(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

router.get('/status', (req, res) => res.json({
  provider: 'redotpay_connect',
  environment: 'sandbox',
  credentialsConfigured: enabled(),
  merchantAccessVerified: false,
  livePaymentsEnabled: false,
  walletCreditEnabled: false,
  webhookUrl: '/api/v1/redotpay/webhook'
}));

router.post('/orders', admin, async (req, res, next) => {
  const pool = req.app.locals.pool;
  if (!enabled()) return res.status(503).json({ error: 'REDOTPAY_APP_KEY sandbox credential is not configured' });
  if (!pool) return res.status(503).json({ error: 'database unavailable' });

  const amount = Number(req.body && req.body.amount);
  const currency = String(process.env.REDOTPAY_ORDER_CURRENCY || 'USD').toUpperCase();
  const outerUid = String((req.body && req.body.user_id) || '');
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10000 || Math.round(amount * 100) !== amount * 100) {
    return res.status(400).json({ error: 'amount must be a positive amount with at most 2 decimals, up to 10000' });
  }
  if (!/^[A-Z]{3}$/.test(currency)) return res.status(500).json({ error: 'invalid REDOTPAY_ORDER_CURRENCY' });
  if (!outerUid || outerUid.length > 32) return res.status(400).json({ error: 'user_id is required and must be at most 32 characters' });

  const outerOrderSn = `VPR${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(5).toString('hex').toUpperCase()}`.slice(0, 32);
  const body = {
    outerOrderSn,
    outerUid,
    orderAmount: amount,
    orderCurrency: currency,
    env: 'WEB',
    orderDesc: 'Vipercard sandbox checkout'
  };
  if (process.env.REDOTPAY_REDIRECT_URL) body.redirectUrl = process.env.REDOTPAY_REDIRECT_URL;

  try {
    await ensureTable(pool);
    const privateKey = process.env.REDOTPAY_PRIVATE_KEY;
    const keyVersion = String(process.env.REDOTPAY_KEY_VERSION || '1');
    const timestamp = String(Date.now());
    const requestBody = JSON.stringify(body);
    const headers = {
      'content-type': 'application/json',
      'accept': 'application/json',
      'X-R-AK': appKey(),
      'X-R-TS': timestamp,
      'X-R-KEY-VERSION': keyVersion
    };
    if (privateKey) {
      const stringToSign = `POST /openapi/v2/order/create\n${appKey()}.${timestamp}.${requestBody}`;
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(stringToSign, 'utf8');
      headers['X-R-Signature'] = signer.sign(privateKey.replace(/\\n/g, '\n'), 'base64');
    }
    const response = await fetch(`${SANDBOX_BASE}/openapi/v2/order/create`, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: AbortSignal.timeout(15000)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 'SUCCESS') {
      console.warn('RedotPay sandbox order rejected:', data.code || response.status);
      return res.status(502).json({ error: 'RedotPay sandbox order creation failed', providerCode: data.code || String(response.status) });
    }
    const result = data.data || {};
    const checkoutUrl = safeCheckoutUrl(result.h5Url || result.webUrl || result.checkoutUrl || result.payUrl);
    if (!checkoutUrl || !result.orderSn) return res.status(502).json({ error: 'RedotPay response missing valid checkout URL or order number' });
    await pool.query(
      `INSERT INTO redotpay_orders (outer_order_sn, outer_uid, amount, currency, provider_order_sn, checkout_url)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [outerOrderSn, outerUid, amount, currency, String(result.orderSn), checkoutUrl]
    );
    return res.status(201).json({
      order_id: outerOrderSn,
      provider_order_id: String(result.orderSn),
      amount,
      currency,
      environment: 'sandbox',
      checkout_url: checkoutUrl,
      financial_status: 'pending',
      wallet_credit: 'disabled_pending_reconciliation'
    });
  } catch (error) {
    console.error('RedotPay sandbox order error:', error.message);
    return res.status(502).json({ error: 'RedotPay sandbox request failed' });
  }
});

router.post('/webhook', async (req, res) => {
  const pool = req.app.locals.pool;
  if (!pool) return res.status(503).json({ code: 'FAIL', requestId: randomUUID(), msg: 'database unavailable' });
  if (!verifyWebhook(req)) return res.status(401).json({ code: 'FAIL', requestId: randomUUID(), msg: 'invalid signature' });
  let payload;
  try { payload = JSON.parse(req.rawBody.toString('utf8')); }
  catch { return res.status(400).json({ code: 'FAIL', requestId: randomUUID(), msg: 'invalid JSON' }); }
  const outerOrderSn = String(payload.outerOrderSn || payload.outerOrder || '');
  const eventKey = String(payload.txId || payload.orderSn || payload.preSn || '');
  if (!outerOrderSn || !eventKey) return res.status(400).json({ code: 'FAIL', requestId: randomUUID(), msg: 'missing order reference' });

  const client = await pool.connect();
  try {
    await ensureTable(pool);
    await client.query('BEGIN');
    const inserted = await client.query(
      'INSERT INTO redotpay_webhook_events (event_key, outer_order_sn, payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT (event_key) DO NOTHING RETURNING event_key',
      [eventKey, outerOrderSn, JSON.stringify(payload)]
    );
    if (inserted.rowCount) {
      const status = Number(payload.orderStatus);
      const mapped = status === 2 ? 'SUCCESS' : status === 3 ? 'FAILED' : status === 4 ? 'CLOSED' : 'PAYING';
      await client.query(
        `UPDATE redotpay_orders
           SET provider_status=$2, provider_tx_id=COALESCE($3, provider_tx_id),
               payment_time=COALESCE($4, payment_time), webhook_payload=$5::jsonb, updated_at=NOW()
         WHERE outer_order_sn=$1`,
        [outerOrderSn, mapped, payload.txId ? String(payload.txId) : null, payload.paymentTime || null, JSON.stringify(payload)]
      );
    }
    await client.query('COMMIT');
    return res.json({ code: 'SUCCESS', requestId: randomUUID() });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('RedotPay webhook persistence failed:', error.message);
    return res.status(503).json({ code: 'FAIL', requestId: randomUUID(), msg: 'persistence failed' });
  } finally {
    client.release();
  }
});

router.get('/orders/:orderId', admin, async (req, res, next) => {
  try {
    const pool = req.app.locals.pool;
    await ensureTable(pool);
    const result = await pool.query(
      `SELECT outer_order_sn AS order_id, outer_uid AS user_id, amount, currency,
              provider_order_sn AS provider_order_id, provider_status AS status,
              provider_tx_id AS provider_transaction_id, payment_time, created_at, updated_at
         FROM redotpay_orders WHERE outer_order_sn=$1`,
      [String(req.params.orderId)]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'order not found' });
    return res.json(result.rows[0]);
  } catch (error) { return next(error); }
});

module.exports = router;
