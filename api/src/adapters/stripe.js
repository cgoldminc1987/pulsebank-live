const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

/**
 * Refund rails for PulseBank store credit
 * - credit_card / stripe : Stripe Refunds API against the original PaymentIntent
 *                          (money returns to the credit card that funded the gift card)
 * - bank_account         : Stripe Transfer to a recipient connected account; their bank payout follows
 * Env: STRIPE_SECRET_KEY, STRIPE_CONNECT_ACCOUNT_ID (default recipient for bank payouts)
 * Column ACH origination can be swapped in here later for non-Stripe bank rails.
 */

const STRIPE_API = 'https://api.stripe.com/v1';

function env(name) {
  try { return (typeof process !== 'undefined' && process.env && process.env[name]) || undefined; }
  catch { return undefined; }
}

function stripeKey() {
  const key = env('STRIPE_SECRET_KEY');
  if (!key) {
    const e = new Error('STRIPE_SECRET_KEY not configured on this host - cannot move money');
    e.code = 'STRIPE_NOT_CONFIGURED';
    throw e;
  }
  return key;
}

async function stripeForm(endpoint, params, idempotencyKey) {
  const res = await fetch(`${STRIPE_API}${endpoint}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${stripeKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey || uuidv4()
    },
    body: new URLSearchParams(params).toString()
  });
  const json = await res.json();
  if (!res.ok) {
    const e = new Error((json.error && json.error.message) || `Stripe error ${res.status}`);
    e.code = 'STRIPE_ERROR';
    e.stripe_error = json.error || null;
    throw e;
  }
  return json;
}

// Refund a card payment: back to the credit card that funded the gift card
async function refundToCreditCard({ amount_cad, payment_intent_id, idempotency_key }) {
  if (!payment_intent_id) {
    const e = new Error('stripe_payment_intent_id required - no original card charge to refund against');
    e.code = 'MISSING_PAYMENT_INTENT';
    throw e;
  }
  const refund = await stripeForm(
    '/refunds',
    { payment_intent: payment_intent_id, amount: String(amount_cad), currency: 'cad' },
    idempotency_key
  );
  // refund.status: succeeded | pending | failed
  return { rail: 'stripe', reference: refund.id, status: refund.status || 'pending' };
}

// Refund to a bank account: transfer to the recipient connected account, payout to their bank follows
async function refundToBankAccount({ amount_cad, connected_account_id, idempotency_key }) {
  const destination = connected_account_id || env('STRIPE_CONNECT_ACCOUNT_ID');
  if (!destination) {
    const e = new Error('Bank refunds need STRIPE_CONNECT_ACCOUNT_ID (recipient connected account) or stripe_account on the request');
    e.code = 'STRIPE_NOT_CONFIGURED';
    throw e;
  }
  // Refusing to transfer to our own platform account (self-pay loop, not a payout)
  const self = env('STRIPE_PLATFORM_ACCOUNT_ID');
  if (self && destination === self) {
    const e = new Error('destination is the platform account itself - bank_account refunds need a recipient connected account');
    e.code = 'STRIPE_SELF_DESTINATION';
    throw e;
  }
  const transfer = await stripeForm(
    '/transfers',
    { amount: String(amount_cad), currency: 'cad', destination },
    idempotency_key
  );
  return { rail: 'stripe_connect', reference: transfer.id, status: 'pending_payout' };
}

// ---------------------------------------------------------------------------
// Stripe Identity (KYC / identity verification)
// ---------------------------------------------------------------------------

function stripeError(json, res) {
  const e = new Error((json.error && json.error.message) || `Stripe error ${res.status}`);
  e.code = 'STRIPE_ERROR';
  e.stripe_error = json.error || null;
  // Stripe returns 403 identity_api_invalid_application until an account admin
  // has submitted the Identity application once.
  if (json.error && json.error.code === 'identity_api_invalid_application') {
    e.code = 'IDENTITY_NOT_ENABLED';
  }
  return e;
}

async function createVerificationSession({ reference, email, return_url, metadata, idempotency_key }) {
  const params = {
    type: 'document',
    client_reference_id: reference,
    return_url,
    'options[document][require_matching_selfie]': 'true', // government ID + liveness selfie match
    'options[document][require_live_capture]': 'true',    // no gallery uploads
  };
  if (email) params['provided_details[email]'] = email;
  for (const [k, v] of Object.entries(metadata || {})) params[`metadata[${k}]`] = v;

  const res = await fetch(`${STRIPE_API}/identity/verification_sessions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${stripeKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotency_key || uuidv4()
    },
    body: new URLSearchParams(params).toString()
  });
  const json = await res.json();
  if (!res.ok) throw stripeError(json, res);
  return json; // .id, .status, .client_secret, .url, .livemode
}

async function retrieveVerificationSession(sessionId) {
  const res = await fetch(
    `${STRIPE_API}/identity/verification_sessions/${encodeURIComponent(sessionId)}?expand%5B%5D=verified_outputs`,
    { headers: { 'Authorization': `Bearer ${stripeKey()}` } }
  );
  const json = await res.json();
  if (!res.ok) throw stripeError(json, res);
  return json;
}

// Manual signature check (no SDK dependency): Stripe-Signature carries
// t=<unix ts>,v1=<HMAC-SHA256(secret, "<ts>.<rawBody>")>
function constructWebhookEvent(rawBody, signatureHeader, secret) {
  if (!secret) {
    const e = new Error('STRIPE_WEBHOOK_SECRET not configured - refusing unsigned webhook');
    e.code = 'WEBHOOK_SECRET_MISSING';
    throw e;
  }
  if (!signatureHeader) {
    const e = new Error('missing stripe-signature header');
    e.code = 'WEBHOOK_SIGNATURE_INVALID';
    throw e;
  }
  const parts = Object.fromEntries(
    String(signatureHeader).split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    })
  );
  const timestamp = parts.t;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody.toString('utf8')}`).digest('hex');
  const given = String(parts.v1 || '');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(given, 'hex');
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  const fresh = timestamp && Math.abs(Date.now() / 1000 - Number(timestamp)) < 300;
  if (!ok) {
    const e = new Error('webhook signature mismatch');
    e.code = 'WEBHOOK_SIGNATURE_INVALID';
    throw e;
  }
  if (!fresh) {
    const e = new Error('webhook timestamp outside tolerance (replay?)');
    e.code = 'WEBHOOK_STALE';
    throw e;
  }
  return JSON.parse(rawBody.toString('utf8'));
}

module.exports = { refundToCreditCard, refundToBankAccount, createVerificationSession, retrieveVerificationSession, constructWebhookEvent };
