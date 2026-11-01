const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const {
  createVerificationSession,
  retrieveVerificationSession,
  constructWebhookEvent,
} = require('../adapters/stripe');

/**
 * KYC (identity verification) - Stripe Identity is the verification vendor.
 *
 * A reference (the customer's email) owns at most one live verification.
 * The only ways a reference becomes 'verified':
 *   1. a signed identity.verification_session.verified webhook, or
 *   2. a confirmed API retrieve (the /refresh endpoint).
 * The applicant page and the client can never set or fake a status.
 * Stored PII is deliberately minimal: verified name + country only.
 */

const VERIFIED_STATUSES = new Set(['verified', 'canceled', 'redacted']);

// Fallback when Stripe Identity isn't enabled on the account: queue the
// reference for manual review instead of failing hard with 503.
const MANUAL_REVIEW = 'manual_review';
const MANUAL_REVIEW_ENABLED = process.env.KYC_MANUAL_REVIEW !== 'off';

function kycBaseUrl() {
  return process.env.KYC_BASE_URL || process.env.PUBLIC_BASE_URL || 'https://pulsebank-gc-api.onrender.com';
}

function publicView(row) {
  if (!row) return null;
  return {
    reference: row.reference,
    status: row.status,
    approved: row.status === 'verified',
    account_type: row.account_type,
    livemode: row.livemode,
    verified_name: row.verified_name || null,
    verified_country: row.verified_country || null,
    verified_at: row.verified_at || null,
    last_error: row.last_error || null,
    session_id: row.session_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    verify_url: row.status === 'verified' ? null : `${kycBaseUrl()}/kyc/?reference=${encodeURIComponent(row.reference)}`,
  };
}

async function latestByReference(pool, reference) {
  const { rows } = await pool.query(
    'SELECT * FROM kyc_verifications WHERE reference=$1 ORDER BY created_at DESC LIMIT 1',
    [reference]
  );
  return rows[0] || null;
}

// POST /api/v1/kyc/session - start (or resume) a verification for a reference
router.post('/session', async (req, res, next) => {
  const pool = req.app.locals.pool;
  try {
    const { reference, email, account_type } = req.body || {};
    if (!reference || typeof reference !== 'string' || reference.length > 120) {
      return res.status(400).json({
        error: 'reference_required',
        message: 'Pass {"reference": "<customer email or your own id>"} - the verification binds to it.',
      });
    }

    // Stripe bills per session: reuse an open one instead of stacking
    // duplicates on retries and page reloads.
    const prior = await latestByReference(pool, reference);
    if (prior && prior.status === 'verified') {
      return res.status(409).json({ error: 'already_verified', ...publicView(prior) });
    }
    if (prior && prior.status === 'processing') {
      return res.status(409).json({ error: 'already_processing', ...publicView(prior) });
    }
    if (prior && prior.session_id && !VERIFIED_STATUSES.has(prior.status)) {
      try {
        const s = await retrieveVerificationSession(prior.session_id);
        if (s.status === 'requires_input' && (s.client_secret || s.url)) {
          await pool.query('UPDATE kyc_verifications SET updated_at=NOW() WHERE id=$1', [prior.id]);
          return res.json({
            session_id: s.id,
            client_secret: s.client_secret || null,
            url: s.url || null,
            status: s.status,
            reference,
            reused: true,
          });
        }
      } catch (_) { /* stale/deleted session: fall through and create fresh */ }
    }

    const session = await createVerificationSession({
      reference,
      email,
      return_url: `${kycBaseUrl()}/kyc/returned.html?reference=${encodeURIComponent(reference)}`,
      idempotency_key: req.idemKey || `kyc_session_${crypto.randomUUID()}`,
      metadata: {
        account_type: String(account_type || 'reloadable_card').slice(0, 60),
        issued_by: 'pulsebank-gc-api',
      },
    });

    await pool.query(
      `INSERT INTO kyc_verifications (session_id, reference, email, status, livemode, client_secret, account_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (session_id) DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
      [session.id, reference, email || null, session.status, Boolean(session.livemode), session.client_secret || null, String(account_type || 'reloadable_card').slice(0, 60)]
    );

    return res.status(201).json({
      session_id: session.id,
      client_secret: session.client_secret || null,
      url: session.url || null,
      status: session.status,
      reference,
    });
  } catch (e) {
    // try-block destructuring is out of scope here: re-read the request body
    const body = req.body || {};
    const reference = typeof body.reference === 'string' ? body.reference : undefined;
    const email = typeof body.email === 'string' ? body.email : undefined;
    const account_type = body.account_type;
    if (e.code === 'IDENTITY_NOT_ENABLED') {
      if (MANUAL_REVIEW_ENABLED) {
        const prior = await latestByReference(pool, reference).catch(() => null);
        if (!(prior && prior.status === MANUAL_REVIEW)) {
          try {
            await pool.query(
              `INSERT INTO kyc_verifications (reference, email, status, account_type, livemode)
               VALUES ($1,$2,$3,$4,false)`,
              [reference, email || null, MANUAL_REVIEW, String(account_type || 'reloadable_card').slice(0, 60)]
            );
          } catch (err) {
            console.error('kyc manual_review insert failed:', err && err.message);
          }
        }
        return res.status(202).json({
          status: MANUAL_REVIEW,
          reference,
          manual_review: true,
          message: 'Stripe Identity is not enabled on this Stripe account yet. The reference has been queued for manual KYC review; no Stripe session was created and no per-session fee is charged.',
        });
      }
      return res.status(503).json({
        error: 'identity_not_enabled',
        message: 'Stripe Identity is not enabled on this Stripe account yet. An account admin must submit the application once.',
        apply_url: 'https://dashboard.stripe.com/identity/application',
      });
    }
    if (e.code === 'STRIPE_NOT_CONFIGURED') return res.status(503).json({ error: 'stripe_not_configured' });
    return next(e);
  }
});

// GET /api/v1/kyc/session/:reference - stored decision (no client secret, no
// PII beyond the verified name / country)
router.get('/session/:reference', async (req, res) => {
  const row = await latestByReference(req.app.locals.pool, req.params.reference);
  if (!row) return res.status(404).json({ error: 'not_found' });
  return res.json(publicView(row));
});

// GET /api/v1/kyc/session/:reference/refresh - pull the latest from Stripe.
// The webhook is the source of truth; this covers a missed delivery or a
// page that was closed before the redirect landed.
router.get('/session/:reference/refresh', async (req, res, next) => {
  const pool = req.app.locals.pool;
  try {
    const row = await latestByReference(pool, req.params.reference);
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (VERIFIED_STATUSES.has(row.status)) return res.json(publicView(row));
    // manual_review rows have no Stripe session to refresh
    if (!row.session_id) return res.json(publicView(row));

    const s = await retrieveVerificationSession(row.session_id);
    const outputs = s.verified_outputs || {};
    await pool.query(
      `UPDATE kyc_verifications SET
         status = $2,
         last_error = $3,
         verified_name = COALESCE(NULLIF(TRIM(CONCAT(COALESCE($4,''),' ',COALESCE($5,''))), ''), verified_name),
         verified_country = COALESCE($6, verified_country),
         verified_at = CASE WHEN $2 = 'verified' AND verified_at IS NULL THEN NOW() ELSE verified_at END,
         updated_at = NOW()
       WHERE id = $1`,
      [
        row.id,
        s.status,
        s.last_error ? JSON.stringify({ code: s.last_error.code, reason: s.last_error.reason }) : null,
        outputs.first_name || null,
        outputs.last_name || null,
        (outputs.address && outputs.address.country) || null,
      ]
    );
    const fresh = await pool.query('SELECT * FROM kyc_verifications WHERE id=$1', [row.id]);
    return res.json(publicView(fresh.rows[0]));
  } catch (e) {
    if (e.code === 'IDENTITY_NOT_ENABLED') {
      return res.status(503).json({ error: 'identity_not_enabled', apply_url: 'https://dashboard.stripe.com/identity/application' });
    }
    return next(e);
  }
});

// GET /api/v1/kyc - ops list (audit view)
router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const { rows } = await req.app.locals.pool.query(
    'SELECT * FROM kyc_verifications ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return res.json(rows.map(publicView));
});

// GET /api/v1/kyc/status - config surface
router.get('/status', (_req, res) => {
  res.json({
    provider: 'stripe_identity',
    checks: ['government_id_document', 'selfie_match', 'live_capture'],
    secret_configured: Boolean(process.env.STRIPE_SECRET_KEY),
    webhook_configured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    base_url: kycBaseUrl(),
  });
});

// POST /api/v1/kyc/webhook - the authoritative outcome (signature-checked).
// Registered in the Stripe Dashboard for identity.verification_session.*.
const STATUS_BY_EVENT = {
  'identity.verification_session.verified': 'verified',
  'identity.verification_session.processing': 'processing',
  'identity.verification_session.requires_input': 'requires_input',
  'identity.verification_session.canceled': 'canceled',
  'identity.verification_session.redacted': 'redacted',
};

router.post('/webhook', async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('kyc webhook rejected:', e.message);
    return res.status(e.code === 'WEBHOOK_SECRET_MISSING' ? 503 : 400).json({ error: e.code || 'webhook_invalid', message: e.message });
  }

  const status = STATUS_BY_EVENT[event.type];
  if (!status) return res.json({ received: true, ignored: event.type });

  const session = event.data.object || {};
  const outputs = session.verified_outputs || {};
  try {
    // A verified reference is terminal: a late or replayed webhook cannot
    // downgrade it.
    await req.app.locals.pool.query(
      `UPDATE kyc_verifications SET
         status = $2,
         last_error = $3,
         verified_name = COALESCE(NULLIF(TRIM(CONCAT(COALESCE($4,''),' ',COALESCE($5,''))), ''), verified_name),
         verified_country = COALESCE($6, verified_country),
         verified_at = CASE WHEN $2 = 'verified' AND verified_at IS NULL THEN NOW() ELSE verified_at END,
         livemode = $7,
         updated_at = NOW()
       WHERE session_id = $1
         AND (status IS DISTINCT FROM 'verified' OR $2 = 'verified')`,
      [
        session.id,
        status,
        session.last_error ? JSON.stringify({ code: session.last_error.code, reason: session.last_error.reason }) : null,
        outputs.first_name || null,
        outputs.last_name || null,
        (outputs.address && outputs.address.country) || null,
        Boolean(session.livemode),
      ]
    );
    return res.json({ received: true });
  } catch (e) {
    console.error('kyc webhook handler failed:', e.message);
    return res.status(500).send('handler error'); // 500 -> Stripe retries
  }
});

module.exports = router;
