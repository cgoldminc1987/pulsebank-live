const { v4: uuidv4 } = require('uuid');

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

module.exports = { refundToCreditCard, refundToBankAccount };
