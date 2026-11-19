'use strict';
require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const { getLens, listLenses } = require('../../src/lenses');
const { createSession } = require('../../src/session');
const { mockStream } = require('../../src/mockVitals');

const casual = getLens('casual');
const snap = (o = {}) => ({
  state: 'neutral', confidence: 0.9, pulseBpm: 88, pulseDeltaBpm: 14, hrvMs: 40, breathingRate: 15, breathingConfidence: 0.8,
  expression: 'neutral', expressionConfidence: 0.9, talking: false, observedAtMs: 0, ...o,
});
const FORBIDDEN = /stress|tense|body|pulse|heart|breath|bpm|hrv|\d/i;
const textOf = (out) => JSON.stringify({ state: out.state, say: out.say, directive: out.directive });

test('casual is listed and never shares numbers', () => {
  const l = listLenses().find((x) => x.id === 'casual');
  assert.ok(l);
  assert.strictEqual(l.name, 'Casual chat');
  assert.deepStrictEqual(l.needs, ['expression']);
  assert.strictEqual(l.sharesNumbers, false);
  assert.strictEqual(l.render, undefined);
});

test('smile or surprise with good confidence reads as engaged', () => {
  for (const expression of ['smile', 'surprise']) {
    const out = casual.render(snap({ expression }));
    assert.strictEqual(out.state, 'engaged');
    assert.strictEqual(out.say, true);
    assert.match(out.directive, /light tone/);
  }
});

test('neutral and unclear cases stay quiet', () => {
  assert.deepStrictEqual(casual.render(snap()), { state: 'neutral', say: false, directive: null, confidence: 0.9 });
  assert.strictEqual(casual.render(snap({ expression: 'tense' })).state, 'neutral');
  assert.strictEqual(casual.render(snap({ expression: 'smile', expressionConfidence: 0.3 })).state, 'unclear');
  for (const state of ['unclear', 'calibrating', 'starting']) {
    const out = casual.render(snap({ state, expression: 'smile' }));
    assert.strictEqual(out.state, 'unclear');
    assert.strictEqual(out.say, false);
    assert.strictEqual(out.directive, null);
  }
});

test('casual output never mentions stress, the body or numbers', () => {
  const cases = ['smile', 'surprise', 'neutral', 'tense', 'unknown'].flatMap((expression) =>
    ['neutral', 'elevated', 'unclear'].map((state) => snap({ expression, state })));
  const session = createSession();
  for (const s of mockStream()) { session.ingest(s); cases.push(session.getNeutralSnapshot()); }
  for (const c of cases) {
    const out = casual.render(c);
    assert.deepStrictEqual(Object.keys(out), ['state', 'say', 'directive', 'confidence']);
    assert.ok(!FORBIDDEN.test(textOf(out)), textOf(out));
    assert.ok(out.confidence >= 0 && out.confidence <= 1);
  }
});
