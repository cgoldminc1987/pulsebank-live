const assert = require('node:assert/strict');
const { test } = require('node:test');
const { isPublicApiRequest, requireAdmin } = require('../src/middleware/api-access');

test('allows only the intended public health, balance, and signed webhook routes', () => {
  const allowed = [
    ['GET', '/health'],
    ['GET', '/cards/balance/ABC-123'],
    ['POST', '/stripe/webhook'],
    ['POST', '/paypal/webhook'],
    ['POST', '/kyc/webhook']
  ];
  for (const [method, path] of allowed) {
    assert.equal(isPublicApiRequest(method, path), true, `${method} ${path}`);
  }
});

test('requires admin authorization for transaction and non-public routes', () => {
  const protectedRoutes = [
    ['POST', '/cards/123/redeem'],
    ['POST', '/cards/123/void'],
    ['POST', '/refunds'],
    ['POST', '/cards/issue'],
    ['GET', '/cards/123/balance'],
    ['POST', '/kyc/session'],
    ['GET', '/stripe/orders/session-123'],
    ['POST', '/health']
  ];
  for (const [method, path] of protectedRoutes) {
    assert.equal(isPublicApiRequest(method, path), false, `${method} ${path}`);
  }
});

function runGuard(headers) {
  const response = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
  let calledNext = false;
  requireAdmin({ get: name => headers[name.toLowerCase()] }, response, () => {
    calledNext = true;
  });
  return { response, calledNext };
}

test('fails closed when ADMIN_TOKEN is missing', t => {
  const previous = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  t.after(() => {
    if (previous === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previous;
  });

  const { response, calledNext } = runGuard({});
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.error, 'ADMIN_TOKEN is not configured on the API service');
  assert.equal(calledNext, false);
});

test('rejects a missing or incorrect admin token', t => {
  const previous = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'expected-token';
  t.after(() => {
    if (previous === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previous;
  });

  for (const headers of [{}, { 'x-admin-token': 'wrong-token' }]) {
    const { response, calledNext } = runGuard(headers);
    assert.equal(response.statusCode, 401);
    assert.equal(calledNext, false);
  }
});

test('accepts the existing admin header and Bearer form', t => {
  const previous = process.env.ADMIN_TOKEN;
  process.env.ADMIN_TOKEN = 'expected-token';
  t.after(() => {
    if (previous === undefined) delete process.env.ADMIN_TOKEN;
    else process.env.ADMIN_TOKEN = previous;
  });

  for (const headers of [
    { 'x-admin-token': 'expected-token' },
    { authorization: 'Bearer expected-token' }
  ]) {
    const { response, calledNext } = runGuard(headers);
    assert.equal(response.statusCode, null);
    assert.equal(calledNext, true);
  }
});
