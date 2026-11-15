const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { constructWebhookEvent } = require('../src/adapters/stripe');

function signed(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = crypto.createHmac('sha256', secret).update(`${timestamp}.${body.toString('utf8')}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

test('accepts a correctly signed raw Stripe payload', () => {
  const body = Buffer.from(JSON.stringify({ id: 'evt_test_123', type: 'checkout.session.completed', data: { object: { id: 'cs_test_123' } } }));
  const event = constructWebhookEvent(body, signed(body, 'whsec_test'), 'whsec_test');
  assert.equal(event.id, 'evt_test_123');
  assert.equal(event.data.object.id, 'cs_test_123');
});

test('accepts one of multiple configured webhook secrets', () => {
  const body = Buffer.from('{"id":"evt_multi"}');
  assert.equal(constructWebhookEvent(body, signed(body, 'whsec_second'), 'whsec_first,whsec_second').id, 'evt_multi');
});

test('rejects when the webhook secret is missing', () => {
  assert.throws(() => constructWebhookEvent(Buffer.from('{}'), 't=1,v1=abc', undefined), { code: 'WEBHOOK_SECRET_MISSING' });
});

test('rejects a missing signature header', () => {
  assert.throws(() => constructWebhookEvent(Buffer.from('{}'), undefined, 'whsec_test'), { code: 'WEBHOOK_SIGNATURE_INVALID' });
});

test('rejects a modified payload', () => {
  const body = Buffer.from('{"id":"evt_original"}');
  const signature = signed(body, 'whsec_test');
  assert.throws(() => constructWebhookEvent(Buffer.from('{"id":"evt_tampered"}'), signature, 'whsec_test'), { code: 'WEBHOOK_SIGNATURE_INVALID' });
});

test('rejects a stale signed payload', () => {
  const body = Buffer.from('{"id":"evt_old"}');
  const oldTimestamp = Math.floor(Date.now() / 1000) - 600;
  assert.throws(() => constructWebhookEvent(body, signed(body, 'whsec_test', oldTimestamp), 'whsec_test'), { code: 'WEBHOOK_STALE' });
});
