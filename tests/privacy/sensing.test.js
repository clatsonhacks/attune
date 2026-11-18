'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createConsent } = require('../../src/privacy/consent');
const { createSensing } = require('../../src/sensing');
const { fakeAdapterFactory, SAMPLE } = require('../helpers');

function setup(opts) {
  const consent = createConsent();
  const { factory, calls } = fakeAdapterFactory(opts);
  const received = [];
  const sensing = createSensing({ adapterFactory: factory, consent, onSample: (s) => received.push(s) });
  return { consent, sensing, calls, received };
}

test('the sensor is not created before consent', async () => {
  const { sensing, calls } = setup();
  assert.strictEqual((await sensing.settled()).state, 'idle');
  assert.strictEqual(calls.created, 0);
});

test('granting sensing starts it; revoking stops it', async () => {
  const { consent, sensing, calls } = setup();
  consent.grant({ sensing: true, presageAck: true });
  assert.strictEqual((await sensing.settled()).state, 'active');
  assert.strictEqual(calls.started, 1);
  consent.revoke(['sensing']);
  assert.strictEqual((await sensing.settled()).state, 'stopped');
  assert.strictEqual(calls.stopped, 1);
});

test('granting other scopes does not start the sensor', async () => {
  const { consent, sensing, calls } = setup();
  consent.grant({ aiSharing: true, memory: true });
  await sensing.settled();
  assert.strictEqual(calls.created, 0);
});

test('samples from a revoked run are dropped (late callbacks)', async () => {
  const { consent, sensing, calls, received } = setup();
  consent.grant({ sensing: true, presageAck: true });
  await sensing.settled();
  const oldCallback = calls.callbacks[0];
  oldCallback(SAMPLE);
  assert.strictEqual(received.length, 1);
  consent.revoke(['sensing']);
  await sensing.settled();
  oldCallback(SAMPLE); // arrives after revoke
  assert.strictEqual(received.length, 1);

  consent.grant({ sensing: true, presageAck: true }); // new run
  await sensing.settled();
  oldCallback(SAMPLE); // stale callback from run 1 must still be ignored
  calls.callbacks[1](SAMPLE);
  assert.strictEqual(received.length, 2);
});

test('a fast grant → revoke leaves the sensor stopped', async () => {
  const { consent, sensing, calls } = setup();
  consent.grant({ sensing: true, presageAck: true });
  consent.revoke(['sensing']);
  assert.strictEqual((await sensing.settled()).state, 'stopped');
  assert.strictEqual(calls.started, calls.stopped);
});

test('a start failure is reported as error, not active', async () => {
  const { consent, sensing } = setup({ failWith: 'camera busy' });
  consent.grant({ sensing: true, presageAck: true });
  const st = await sensing.settled();
  assert.strictEqual(st.state, 'error');
  assert.match(st.error, /camera busy/);
});

test('shutdown stops a running sensor', async () => {
  const { consent, sensing, calls } = setup();
  consent.grant({ sensing: true, presageAck: true });
  await sensing.settled();
  await sensing.shutdown();
  assert.strictEqual(calls.stopped, 1);
});
