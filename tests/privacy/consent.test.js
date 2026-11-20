'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createConsent } = require('../../src/privacy/consent');

test('all scopes are off by default', () => {
  const c = createConsent();
  for (const k of ['sensing', 'aiSharing', 'memory', 'diagnostics']) assert.strictEqual(c.has(k), false);
});

test('sensing cannot be granted without the Presage disclosure', () => {
  const c = createConsent();
  assert.throws(() => c.grant({ sensing: true }), (e) => e.code === 'presage_ack_required');
  assert.strictEqual(c.has('sensing'), false);
});

test('scopes are independent', () => {
  const c = createConsent();
  c.grant({ sensing: true, presageAck: true });
  assert.strictEqual(c.has('sensing'), true);
  assert.strictEqual(c.has('aiSharing'), false);
  assert.strictEqual(c.has('memory'), false);
});

test('revoke with no args clears everything and notifies listeners', () => {
  const c = createConsent();
  const seen = [];
  c.onChange((next) => seen.push(next.sensing));
  c.grant({ sensing: true, presageAck: true, aiSharing: true, memory: true });
  c.revoke();
  assert.deepStrictEqual(seen, [true, false]);
  assert.strictEqual(c.has('aiSharing'), false);
  assert.strictEqual(c.has('memory'), false);
});

test('withdrawing the Presage acknowledgement also stops sensing', () => {
  const c = createConsent();
  c.grant({ sensing: true, presageAck: true });
  c.grant({ presageAck: false });
  assert.strictEqual(c.has('sensing'), false);
});
