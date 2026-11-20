'use strict';
require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const { getLens, listLenses } = require('../../src/lenses');
const { createSession } = require('../../src/session');
const { createConsent } = require('../../src/privacy/consent');
const { createCapabilities } = require('../../src/privacy/capabilities');
const { createContextBridge } = require('../../src/contextBridge');
const { mockStream } = require('../../src/mockVitals');

const yoga = getLens('yoga');
const snap = (o = {}) => ({
  state: 'neutral', confidence: 0.9, pulseBpm: 87, pulseDeltaBpm: 13.4, hrvMs: 41,
  breathingRate: 14.3, breathingConfidence: 0.856, expression: 'neutral', expressionConfidence: 0.9,
  talking: false, observedAtMs: 0, ...o,
});
const NO_NUMBERS = (out) => !('breathsPerMin' in out) && !('targetBreathsPerMin' in out) && !('pace' in out);

test('yoga is listed as guidance only for connectors', () => {
  const l = listLenses().find((x) => x.id === 'yoga');
  assert.ok(l);
  assert.strictEqual(l.name, 'Yoga & breathwork');
  assert.deepStrictEqual(l.needs, ['breathing']);
  assert.strictEqual(l.sharesNumbers, false);
});

test('faster than the default target guides a longer exhale', () => {
  const out = yoga.render(snap());
  assert.deepStrictEqual(Object.keys(out).sort(), ['breathsPerMin', 'confidence', 'directive', 'pace', 'say', 'state', 'targetBreathsPerMin']);
  assert.strictEqual(out.state, 'faster_than_target');
  assert.strictEqual(out.pace, 'faster_than_target');
  assert.strictEqual(out.say, true);
  assert.strictEqual(out.breathsPerMin, 14);
  assert.strictEqual(out.targetBreathsPerMin, 6);
  assert.strictEqual(out.confidence, 0.86);
  assert.match(out.directive, /exhale/i);
});

test('the tolerance band decides on, faster or slower than target', () => {
  assert.strictEqual(yoga.render(snap({ breathingRate: 7.4 })).pace, 'on_target');
  assert.strictEqual(yoga.render(snap({ breathingRate: 4.6 })).pace, 'on_target');
  assert.strictEqual(yoga.render(snap({ breathingRate: 7.6 })).pace, 'faster_than_target');
  const slow = yoga.render(snap({ breathingRate: 4.4 }));
  assert.strictEqual(slow.pace, 'slower_than_target');
  assert.match(slow.directive, /comfortable pace is fine/i);
  const on = yoga.render(snap({ breathingRate: 6 }));
  assert.ok(on.directive);
  assert.deepStrictEqual(on, yoga.render(snap({ breathingRate: 6 }))); // deterministic
});

test('target override is honoured and clamped to 4–12', () => {
  const target = (t) => yoga.render(snap(), { targetBreathsPerMin: t }).targetBreathsPerMin;
  assert.strictEqual(target(10), 10);
  assert.strictEqual(target(30), 12);
  assert.strictEqual(target(1), 4);
  assert.strictEqual(target('abc'), 6);
  assert.strictEqual(target(undefined), 6);
  assert.strictEqual(yoga.render(snap({ breathingRate: 13 }), { targetBreathsPerMin: 30 }).pace, 'on_target');
});

test('no breathing or low confidence asks for the chest to be visible, with no numbers', () => {
  for (const o of [{ breathingRate: null, breathingConfidence: 0 }, { breathingRate: 12, breathingConfidence: 0.3 }]) {
    const out = yoga.render(snap(o));
    assert.strictEqual(out.state, 'need_breathing');
    assert.strictEqual(out.say, false);
    assert.match(out.directive, /chest/i);
    assert.match(out.directive, /still/i);
    assert.ok(NO_NUMBERS(out));
  }
});

test('while talking, breathing is not guided and no numbers are shared', () => {
  const out = yoga.render(snap({ talking: true }));
  assert.strictEqual(out.say, false);
  assert.match(out.directive, /quiet/i);
  assert.ok(NO_NUMBERS(out));
});

test('elevated state adds a calming cue without heart numbers', () => {
  const calm = yoga.render(snap());
  const tense = yoga.render(snap({ state: 'elevated' }));
  assert.ok(tense.directive.startsWith(calm.directive));
  assert.ok(tense.directive.length > calm.directive.length);
  assert.ok(!/pulse|heart|bpm|hrv/i.test(tense.directive));
});

test('yoga output never carries pulse, pulse delta or HRV', () => {
  const s = snap({ state: 'elevated', pulseBpm: 97, pulseDeltaBpm: 23.7, hrvMs: 38.2, breathingRate: 18 });
  for (const o of [{}, { talking: true }, { breathingRate: null }, { breathingRate: 6 }, { breathingRate: 4 }]) {
    const json = JSON.stringify(yoga.render({ ...s, ...o }));
    for (const v of ['97', '23.7', '24', '38']) assert.ok(!json.includes(v), `${v} leaked: ${json}`);
    assert.ok(!/pulse|heart|bpm|hrv/i.test(json), json);
  }
});

test('the demo stream yields measured breathing for the yoga lens', () => {
  const session = createSession();
  const rates = [];
  for (const s of mockStream()) {
    session.ingest(s);
    const out = yoga.render(session.getNeutralSnapshot());
    if (s.talking) assert.ok(NO_NUMBERS(out));
    if (out.breathsPerMin != null) rates.push(out.breathsPerMin);
  }
  assert.ok(rates.length > 0);
  assert.ok(rates.some((r) => r >= 17), 'recovery starts faster');
  assert.ok(rates.every((r) => r >= 12 && r <= 21));
});

test('getLensContext serves the yoga lens end-to-end over the mock stream', () => {
  const consent = createConsent();
  consent.grant({ aiSharing: true });
  const capabilities = createCapabilities({ consent });
  const bridge = createContextBridge({ capabilities });
  bridge.openSession(1);
  const cap = capabilities.issue({ purpose: 'app', lenses: ['yoga'] });
  const session = createSession();
  const seen = [];
  for (const s of mockStream()) {
    session.ingest(s);
    const raw = session.getNeutralSnapshot();
    bridge.updateSnapshot(raw, 1);
    const out = bridge.getLensContext(cap, 'yoga');
    assert.strictEqual(out.lens, 'yoga');
    const json = JSON.stringify(out);
    assert.ok(!/pulse|hrv|bpm|heart/i.test(json), json);
    for (const v of [raw.pulseBpm, raw.pulseDeltaBpm, raw.hrvMs]) {
      if (v != null && Math.abs(v) >= 10) assert.ok(!json.includes(String(v)), `${v} leaked: ${json}`);
    }
    seen.push(out);
  }
  const measured = seen.filter((o) => typeof o.breathsPerMin === 'number');
  assert.ok(measured.length > 0, 'at least one measured breathing value');
  assert.ok(measured.every((o) => o.targetBreathsPerMin === 6 && o.pace === o.state));
  assert.ok(seen.some((o) => o.state === 'talking'));
  // Approved for yoga only: other lenses stay closed on this capability.
  assert.strictEqual(bridge.getLensContext(cap, 'companion').state, 'purpose_not_approved');
});
