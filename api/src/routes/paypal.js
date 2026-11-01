const express = require('express');
const router = express.Router();

/**
 * PayPal webhook receiver.
 * Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID (from the PayPal dashboard),
 *      PAYPAL_ENV = "live" (default) | "sandbox"
 * Fails closed: without all three env vars it answers 503 and trusts nothing.
 */
const BASE = (process.env.PAYPAL_ENV || 'live') === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

async function accessToken() {
  const auth = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`PayPal token ${r.status}`);
  return j.access_token;
}

async function verifySignature(req, event) {
  const token = await accessToken();
  const r = await fetch(`${BASE}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: req.header('paypal-auth-algo'),
      cert_url: req.header('paypal-cert-url'),
      transmission_id: req.header('paypal-transmission-id'),
      transmission_sig: req.header('paypal-transmission-sig'),
      transmission_time: req.header('paypal-transmission-time'),
      webhook_id: process.env.PAYPAL_WEBHOOK_ID,
      webhook_event: event
    })
  });
  const j = await r.json().catch(() => ({}));
  return r.ok && j.verification_status === 'SUCCESS';
}

router.post('/webhook', async (req, res) => {
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET || !process.env.PAYPAL_WEBHOOK_ID) {
    return res.status(503).json({ error: 'PayPal webhook not configured on this host' });
  }
  let event;
  try { event = req.rawBody ? JSON.parse(req.rawBody.toString('utf8')) : req.body; }
  catch (e) { return res.status(400).json({ error: 'invalid JSON' }); }

  let ok = false;
  try { ok = await verifySignature(req, event); }
  catch (e) { console.error('paypal verify error:', e.message); return res.status(502).json({ error: 'verification unavailable' }); }
  if (!ok) return res.status(401).json({ error: 'invalid signature' });

  const type = event.event_type;
  const r = event.resource || {};
  switch (type) {
    case 'PAYMENT.CAPTURE.COMPLETED':
    case 'PAYMENT.CAPTURE.PENDING':
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED':
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED':
      console.log(`paypal ${type} id=${r.id} amount=${r.amount && r.amount.value} ${r.amount && r.amount.currency_code} event=${event.id}`);
      break;
    default:
      console.log(`paypal event ignored: ${type} event=${event.id}`);
  }
  res.json({ received: true });
});

module.exports = router;
