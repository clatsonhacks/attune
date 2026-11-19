'use strict';
require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const { getLens, listLenses, DEFAULT_LENS } = require('../../src/lenses');
const { createSession } = require('../../src/session');
const { createConsent } = require('../../src/privacy/consent');
const { createCapabilities } = require('../../src/privacy/capabilities');
const { createContextBridge } = require('../../src/contextBridge');
const { mockStream } = require('../../src/mockVitals');

test('registry lists the companion lens without exposing render functions', () => {
  assert.strictEqual(DEFAULT_LENS, 'companion');
  const l = listLenses().find((x) => x.id === 'companion');
  assert.ok(l && l.name && l.description);
  assert.strictEqual(l.sharesNumbers, false);
  assert.strictEqual(l.render, undefined);
  assert.strictEqual(getLens('nope'), null);
});

test('companion lens reproduces the existing approved context for every state', () => {
  const session = createSession();
  const lens = getLens('companion');
  for (const s of mockStream()) {
    session.ingest(s);
    const expected = session.getApprovedContext();
    const got = lens.render(session.getNeutralSnapshot());
    assert.deepStrictEqual(got, expected);
  }
});

test('neutral snapshot carries measurements internally; companion output has no numbers', () => {
  const session = createSession();
  for (const s of mockStream()) session.ingest(s);
  const snap = session.getNeutralSnapshot();
  assert.strictEqual(typeof snap.pulseBpm, 'number');
  assert.strictEqual(typeof snap.pulseDeltaBpm, 'number');
  const out = getLens('companion').render(snap);
  assert.ok(!/\d{2,}/.test(JSON.stringify({ ...out, confidence: 0 })));
});

function bridgeSetup() {
  const consent = createConsent();
  consent.grant({ aiSharing: true });
  const capabilities = createCapabilities({ consent });
  const bridge = createContextBridge({ capabilities });
  bridge.openSession(1);
  const session = createSession();
  for (const s of mockStream()) { session.ingest(s); bridge.updateSnapshot(session.getNeutralSnapshot(), 1); }
  return { consent, capabilities, bridge };
}

test('getLensContext honours the lenses recorded on the capability', () => {
  const { capabilities, bridge } = bridgeSetup();
  const onlyCompanion = capabilities.issue({ purpose: 'app', lenses: ['companion'] });
  const ok = bridge.getLensContext(onlyCompanion, 'companion');
  assert.strictEqual(ok.lens, 'companion');
  assert.ok(['neutral', 'elevated', 'unclear', 'calibrating'].includes(ok.state));

  const none = capabilities.issue({ purpose: 'app', lenses: [] });
  assert.strictEqual(bridge.getLensContext(none, 'companion').state, 'purpose_not_approved');

  // A caller editing its own copy cannot widen access.
  const forged = { ...none, lenses: ['companion'] };
  assert.strictEqual(bridge.getLensContext(forged, 'companion').state, 'purpose_not_approved');

  assert.strictEqual(bridge.getLensContext(onlyCompanion, 'made-up').state, 'unknown_purpose');
  assert.strictEqual(bridge.getLensContext(null, 'companion').state, 'not_authorized');
});

test('getLensContext goes quiet when the session closes or consent is revoked', () => {
  const { consent, capabilities, bridge } = bridgeSetup();
  const cap = capabilities.issue({ purpose: 'app', lenses: ['companion'] });
  bridge.closeSession();
  assert.strictEqual(bridge.getLensContext(cap, 'companion').state, 'off');
  consent.revoke(['aiSharing']);
  assert.strictEqual(bridge.getLensContext(cap, 'companion').state, 'not_authorized');
});
