'use strict';
require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const { createConsent } = require('../../src/privacy/consent');
const { createCapabilities } = require('../../src/privacy/capabilities');
const { createContextBridge } = require('../../src/contextBridge');

const CALM = { state: 'neutral', say: false, directive: null, suggestedUtterance: null, confidence: 0.9 };
const TENSE = { state: 'elevated', say: true, directive: 'slow down', suggestedUtterance: 'want to pause?', confidence: 0.8 };
const insight = (iso, text = 'Things look calmer than before.') => ({ ok: true, requestId: 0, origin: 'automatic', processedAt: iso, receivedAtMs: Date.parse(iso), humanText: text, aiNote: text, error: null });

function setup({ minPushIntervalMs = 15000, ttlMs = 5000 } = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const consent = createConsent();
  consent.grant({ aiSharing: true });
  const capabilities = createCapabilities({ consent, now: clock.now });
  const bridge = createContextBridge({ capabilities, ttlMs, minPushIntervalMs, now: clock.now });
  consent.onChange(() => bridge.onConsentChange());
  const cap = capabilities.issue({ purpose: 'test' });
  bridge.openSession(1);
  return { consent, capabilities, bridge, cap, clock };
}

test('reads without a valid capability are denied', () => {
  const { bridge } = setup();
  bridge.update(CALM, 1);
  assert.strictEqual(bridge.getApprovedContext(null).state, 'not_authorized');
  assert.strictEqual(bridge.getApprovedContext({ id: 'forged' }).state, 'not_authorized');
});

test('fresh context is returned; past the TTL it is reported stale', () => {
  const { bridge, cap, clock } = setup();
  bridge.update(TENSE, 1);
  assert.strictEqual(bridge.getApprovedContext(cap).state, 'elevated');
  clock.advance(5001);
  const c = bridge.getApprovedContext(cap);
  assert.strictEqual(c.state, 'stale');
  assert.strictEqual(c.say, false);
});

test('updates from another or closed session are rejected', () => {
  const { bridge, cap } = setup();
  assert.strictEqual(bridge.update(TENSE, 2), false);
  bridge.closeSession();
  assert.strictEqual(bridge.update(TENSE, 1), false);
  assert.strictEqual(bridge.getApprovedContext(cap).state, 'off');
  assert.strictEqual(bridge.stats().rejectedSession, 2);
});

test('identical updates are de-duplicated (no new sequence)', () => {
  const { bridge } = setup();
  bridge.update(CALM, 1);
  const seq = bridge.getHumanView().seq;
  bridge.update(CALM, 1);
  bridge.update(CALM, 1);
  assert.strictEqual(bridge.getHumanView().seq, seq);
  assert.strictEqual(bridge.stats().deduped, 2);
});

test('malformed and low-confidence updates never surface as guidance', () => {
  const { bridge, cap } = setup();
  assert.strictEqual(bridge.update({ state: 'panic', confidence: 1 }, 1), false);
  bridge.update({ ...TENSE, confidence: 0.2 }, 1);
  const c = bridge.getApprovedContext(cap);
  assert.strictEqual(c.state, 'unclear');
  assert.strictEqual(c.directive, null);
});

test('an older insight never overwrites a newer one; notes expire', () => {
  const { bridge, cap, clock } = setup();
  bridge.update(CALM, 1);
  assert.ok(bridge.addInsight(insight(new Date(clock.now()).toISOString(), 'Newer reading looks settled overall.'), 1));
  assert.strictEqual(bridge.addInsight(insight(new Date(clock.now() - 60000).toISOString(), 'Older reading looked busier.'), 1), false);
  assert.strictEqual(bridge.getApprovedContext(cap).note, 'Newer reading looks settled overall.');
  clock.advance(91000);
  bridge.update(CALM, 1);
  assert.strictEqual(bridge.getApprovedContext(cap).note, undefined);
});

test('insights from a closed session are ignored', () => {
  const { bridge } = setup();
  bridge.closeSession();
  assert.strictEqual(bridge.addInsight(insight(new Date().toISOString()), 1), false);
});

test('a read never waits for an insight that never arrives', () => {
  const { bridge, cap } = setup();
  bridge.update(CALM, 1);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) bridge.getApprovedContext(cap);
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 200);
});

test('revoking AI sharing cuts off subscribers immediately', () => {
  const { bridge, cap, consent } = setup();
  const got = [];
  bridge.subscribe(cap, (c) => got.push(c && c.state));
  bridge.update(TENSE, 1);
  consent.revoke(['aiSharing']);
  assert.deepStrictEqual(got, ['elevated', null]);
  assert.strictEqual(bridge.getApprovedContext(cap).state, 'not_authorized');
});

test('pushes are coalesced to at most one per interval and deliver the latest value', async () => {
  const { bridge, cap } = setup({ minPushIntervalMs: 60 });
  const got = [];
  bridge.subscribe(cap, (c) => got.push(c && c.state));
  bridge.update(CALM, 1);    // immediate push
  bridge.update(TENSE, 1);   // queued
  bridge.update(CALM, 1);    // replaces queued value
  bridge.update(TENSE, 1);
  assert.deepStrictEqual(got, ['neutral']);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepStrictEqual(got, ['neutral', 'elevated']);
});

test('closing the session pushes an invalidation', () => {
  const { bridge, cap } = setup();
  const got = [];
  bridge.subscribe(cap, (c) => got.push(c && c.state));
  bridge.update(CALM, 1);
  bridge.closeSession();
  assert.deepStrictEqual(got, ['neutral', null]);
});
