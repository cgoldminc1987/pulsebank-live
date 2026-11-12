const crypto = require('node:crypto');

const PUBLIC_EXACT_ROUTES = new Set([
  'GET /health',
  'POST /stripe/webhook',
  'POST /paypal/webhook',
  'POST /kyc/webhook'
]);

function normalizePath(path) {
  const withoutQuery = String(path || '/').split('?')[0];
  return withoutQuery.replace(/\/+$/, '') || '/';
}

function isPublicApiRequest(method, path) {
  const verb = String(method || '').toUpperCase();
  const normalizedPath = normalizePath(path);
  if (PUBLIC_EXACT_ROUTES.has(`${verb} ${normalizedPath}`)) return true;

  // Public gift-card balance lookup is printed on receipts and card passes.
  return verb === 'GET' && /^\/cards\/balance\/[^/]+$/.test(normalizedPath);
}

function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'ADMIN_TOKEN is not configured on the API service' });
  }

  const adminHeader = typeof req.get === 'function' ? req.get('X-Admin-Token') : undefined;
  const authorization = typeof req.get === 'function' ? req.get('Authorization') : undefined;
  const bearerToken = typeof authorization === 'string'
    ? authorization.match(/^Bearer\s+(.+)$/i)?.[1]
    : undefined;
  const provided = adminHeader || bearerToken;
  if (typeof provided !== 'string') {
    return res.status(401).json({ error: 'admin token required' });
  }

  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  if (expectedBytes.length !== providedBytes.length
      || !crypto.timingSafeEqual(expectedBytes, providedBytes)) {
    return res.status(401).json({ error: 'admin token required' });
  }

  return next();
}

module.exports = { isPublicApiRequest, requireAdmin };
