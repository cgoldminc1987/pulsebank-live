
/**
 * PulseBank Lithic Adapter
 * Card issuing + transaction simulation via the Lithic API.
 *
 * Env:
 *   LITHIC_API_KEY - program API key (sent as the RAW Authorization header value)
 *   LITHIC_ENV     - "sandbox" (default) or "production"; picks the base URL
 *
 * Docs: https://docs.lithic.com/docs/api-basics
 *   Sandbox base: https://sandbox.lithic.com/v1
 *   Production:   https://api.lithic.com/v1
 */

const LITHIC_BASE = (process.env.LITHIC_ENV || 'sandbox') === 'production'
  ? 'https://api.lithic.com/v1'
  : 'https://sandbox.lithic.com/v1';

function lithicEnabled() {
  return Boolean(process.env.LITHIC_API_KEY);
}

function lithicHeaders() {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    // Lithic requires the raw key - no "Bearer"/"Basic" prefix
    'Authorization': process.env.LITHIC_API_KEY || ''
  };
}

async function lithicFetch(path, { method = 'GET', body } = {}) {
  if (!lithicEnabled()) {
    const err = new Error('LITHIC_API_KEY not configured on this host');
    err.code = 'LITHIC_NOT_CONFIGURED';
    throw err;
  }
  const res = await fetch(`${LITHIC_BASE}${path}`, {
    method,
    headers: lithicHeaders(),
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Lithic ${res.status}: ${json.message || 'unknown error'}`);
    err.code = 'LITHIC_ERROR';
    err.status = res.status;
    err.lithic = json;
    throw err;
  }
  return json;
}

/** Create a virtual card. spend_limit is in cents (Lithic amounts are smallest-unit). */
async function createLithicCard({ memo, spend_limit, spend_limit_duration = 'TRANSACTION', account_holder_token, state = 'OPEN' }) {
  const body = { type: 'VIRTUAL', memo, spend_limit, spend_limit_duration, state };
  if (account_holder_token) body.account_holder_token = account_holder_token;
  return lithicFetch('/cards', { method: 'POST', body });
}

async function getLithicCard(token) {
  return lithicFetch(`/cards/${encodeURIComponent(token)}`);
}

async function listLithicTransactions({ card_token, page_size = 25 } = {}) {
  const qs = new URLSearchParams();
  if (card_token) qs.set('card_token', card_token);
  qs.set('page_size', String(page_size));
  return lithicFetch(`/transactions?${qs.toString()}`);
}

async function getLithicTransaction(token) {
  return lithicFetch(`/transactions/${encodeURIComponent(token)}`);
}

// Simulation helpers - the production base has no /simulate endpoints
function ensureSandbox() {
  if (!LITHIC_BASE.includes('sandbox')) {
    const err = new Error('Simulation endpoints only exist in the Lithic sandbox');
    err.code = 'LITHIC_SIMULATE_PROD';
    throw err;
  }
}

async function simulateAuth({ pan, amount, descriptor, mcc }) {
  ensureSandbox();
  return lithicFetch('/simulate/authorize', { method: 'POST', body: { pan, amount, descriptor, mcc } });
}

async function simulateClearing({ token }) {
  ensureSandbox();
  return lithicFetch('/simulate/clearing', { method: 'POST', body: { token } });
}

async function createAccountHolder(individual) {
  return lithicFetch('/account_holders', { method: 'POST', body: individual });
}

module.exports = {
  LITHIC_BASE,
  lithicEnabled,
  createLithicCard,
  getLithicCard,
  listLithicTransactions,
  getLithicTransaction,
  simulateAuth,
  simulateClearing,
  createAccountHolder
};
