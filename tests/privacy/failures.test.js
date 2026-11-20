'use strict';
/* Plan M1-04 / M1-07: process isolation, crash, device loss, permission failure, restart. */
const { tempMemory, tempConsentStore } = require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const { createConsent } = require('../../src/privacy/consent');
const { createSensing } = require('../../src/sensing');
const { createIsolatedAdapter, buildWorkerEnv, sanitizeSample, sanitizeInsight } = require('../../src/adapter/isolated');
const { createApp } = require('../../src/webServer');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(25); }
  return false;
}

function isolatedSetup(t, env = {}) {
  const consent = createConsent();
  const received = [];
  let adapter = null;
  const sensing = createSensing({
    consent,
    adapterFactory: () => (adapter = createIsolatedAdapter({ kind: 'mock', env: { ATTUNE_TICK_MS: '20', ...env }, log: () => {} })),
    onSample: (s) => received.push(s),
  });
  t.after(() => sensing.shutdown());
  return { consent, sensing, received, adapter: () => adapter };
}

test('isolated worker: samples arrive from a separate process and stop on revoke', async (t) => {
  const { consent, sensing, received, adapter } = isolatedSetup(t);
  consent.grant({ sensing: true, presageAck: true });
  await sensing.settled();
  const pid = adapter()._pid();
  assert.ok(pid && pid !== process.pid);
  assert.ok(await until(() => received.length >= 3), 'samples from worker');
  consent.revoke(['sensing']);
  await sensing.settled();
  const n = received.length;
  await wait(150);
  assert.strictEqual(received.length, n, 'no samples after revoke');
  assert.strictEqual(adapter()._pid(), null);
});

test('worker crash → sensing error (worker_crashed), not a silent restart', async (t) => {
  const { consent, sensing, received, adapter } = isolatedSetup(t);
  consent.grant({ sensing: true, presageAck: true });
  await sensing.settled();
  assert.ok(await until(() => received.length > 0));
  process.kill(adapter()._pid());
  assert.ok(await until(() => sensing.status().state === 'error'));
  assert.strictEqual(sensing.status().errorCode, 'worker_crashed');
});

test('camera disconnect → sensing error (device_unavailable)', async (t) => {
  const { consent, sensing } = isolatedSetup(t, { ATTUNE_MOCK_FAIL_AFTER: '3' });
  consent.grant({ sensing: true, presageAck: true });
  await sensing.settled();
  assert.ok(await until(() => sensing.status().state === 'error'));
  assert.strictEqual(sensing.status().errorCode, 'device_unavailable');
});

test('OS camera permission failure at start → error state with the reason', async () => {
  const consent = createConsent();
  const sensing = createSensing({
    consent,
    adapterFactory: () => ({ name: 'denied', start() { throw new Error('camera access denied by the operating system'); }, async stop() {} }),
    onSample: () => {},
  });
  consent.grant({ sensing: true, presageAck: true });
  const st = await sensing.settled();
  assert.strictEqual(st.state, 'error');
  assert.strictEqual(st.errorCode, 'start_failed');
  assert.match(st.error, /denied/);
  await sensing.shutdown();
});

test('worker messages are rebuilt from an allowlist', () => {
  const s = sanitizeSample({ pulseBpm: 70, pulseConfidence: 5, expression: '<script>', evil: 'x', talking: 'yes' });
  assert.strictEqual(s.pulseConfidence, 1);
  assert.strictEqual(s.expression, 'unknown');
  assert.strictEqual(s.talking, false);
  assert.ok(!('evil' in s));
  assert.strictEqual(sanitizeSample('nope'), null);
  assert.strictEqual(sanitizeSample({ pulseBpm: 70 }).pulseConfidence, null); // missing stays missing
  assert.strictEqual(sanitizeSample({ tMs: 0 }).tMs, 0); // 0 is a real timestamp, not 'missing'
  const i = sanitizeInsight({ requestId: 1.5, analysis: 'a'.repeat(5000), requested: 'true' });
  assert.strictEqual(i.requestId, 0);
  assert.strictEqual(i.analysis.length, 2000);
  assert.strictEqual(i.requested, false);
});

test('worker environment excludes unrelated secrets', () => {
  const env = buildWorkerEnv('smartspectra', {}, { PATH: '/bin', SMARTSPECTRA_API_KEY: 'k', ATTUNE_ANTHROPIC_KEY: 'secret', GROQ_API_KEY: 'g', AWS_SECRET_ACCESS_KEY: 'x' });
  assert.deepStrictEqual(Object.keys(env).sort(), ['ATTUNE_WORKER_ADAPTER', 'PATH', 'SMARTSPECTRA_API_KEY']);
  assert.ok(!('SMARTSPECTRA_API_KEY' in buildWorkerEnv('mock', {}, { SMARTSPECTRA_API_KEY: 'k' })));
});

test('worker env: an explicit key overrides the environment; Electron gets ELECTRON_RUN_AS_NODE', () => {
  const env = buildWorkerEnv('smartspectra', { SMARTSPECTRA_API_KEY: 'stored' }, { SMARTSPECTRA_API_KEY: 'dotenv', PATH: '/bin' }, { node: '24' });
  assert.strictEqual(env.SMARTSPECTRA_API_KEY, 'stored');
  assert.ok(!('ELECTRON_RUN_AS_NODE' in env));
  const capi = 'C:\\app\\resources\\smartspectra\\smartspectra_capi.dll';
  const e2 = buildWorkerEnv('mock', {}, { SMARTSPECTRA_CAPI_PATH: capi, ELECTRON_RUN_AS_NODE: '0', OTHER: 'x' }, { electron: '45.4.1' });
  assert.strictEqual(e2.ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(e2.SMARTSPECTRA_CAPI_PATH, capi);
  assert.ok(!('OTHER' in e2));
});

test('app restart remembers permission but never turns the camera on by itself', async (t) => {
  const mem = tempMemory();
  const cs = tempConsentStore();
  t.after(() => { mem.cleanup(); cs.cleanup(); });
  let created = 0;
  const factory = () => { created++; return { name: 'fake', start() {}, async stop() {} }; };
  const a = createApp({ port: 39001, adapterFactory: factory, memory: mem.memory, consentStore: cs.store, log: () => {} });
  a.consent.grant({ sensing: true, presageAck: true, aiSharing: true });
  await a.sensing.settled();
  await a.sensing.shutdown();
  const b = createApp({ port: 39001, adapterFactory: factory, memory: mem.memory, consentStore: cs.store, log: () => {} });
  t.after(() => b.sensing.shutdown());
  assert.strictEqual(b.consent.has('sensing'), true);   // asked once, remembered
  assert.strictEqual(b.consent.has('aiSharing'), true);
  await b.sensing.settled();
  assert.strictEqual(b.sensing.status().state, 'idle'); // …but the camera waits for a chat or the AI
  assert.strictEqual(created, 0);                       // granting directly (not via the UI) never started it
});
