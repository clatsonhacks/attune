'use strict';
/* Connector purposes: the AI suggests a lens, only the person approves it; every call is logged without content. */
const { fakeAdapterFactory, SAMPLE, tempMemory, tempApps } = require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createConnectorCore } = require('../../src/server');
const { register } = require('../../src/lenses');
const { createAppApprovals } = require('../../src/privacy/appApprovals');

register({ id: 'test-purpose', name: 'Test purpose', description: 'Only for tests.',
  render: (snap) => ({ state: snap.state, say: false, directive: null, confidence: 1, marker: 'test-purpose' }) });

const ON = 'sensing,presage-ack,ai-sharing';

function core(t, extra = {}) {
  const { factory, calls } = fakeAdapterFactory();
  const mem = tempMemory();
  const apps = tempApps();
  const c = createConnectorCore({ consentString: ON, adapterFactory: factory, memory: mem.memory, log: () => {},
    approvals: apps.approvals, activity: apps.activity, appId: 'test-app', ...extra });
  t.after(async () => { await c.shutdown(); mem.cleanup(); apps.cleanup(); });
  return { c, calls, apps };
}

test('no approvals entry: the default companion purpose works and is logged', async (t) => {
  const { c, calls, apps } = core(t);
  await c.getBodyContext();
  calls.callbacks[0](SAMPLE);
  const ctx = await c.getBodyContext({ purpose: 'companion' });
  assert.strictEqual(ctx.lens, 'companion');
  assert.ok(!JSON.stringify(ctx).includes('72'));
  const ev = apps.activity.recent(10);
  assert.strictEqual(ev.length, 2);
  assert.deepStrictEqual(ev.map((e) => [e.app, e.lens, e.kind]), [['test-app', 'companion', 'context'], ['test-app', 'companion', 'context']]);
  assert.ok(!fs.readFileSync(apps.activityFile, 'utf8').includes('directive'));
});

test('unapproved purpose: refused, camera stays off, pending request + activity recorded', async (t) => {
  const { c, calls, apps } = core(t);
  const r = await c.getBodyContext({ purpose: 'test-purpose' });
  assert.deepStrictEqual(r, { state: 'purpose_not_approved', lens: 'test-purpose', say: false,
    howToEnable: 'Open Attune → Connectors and allow Test App to use Test purpose.' });
  assert.strictEqual(calls.created, 0);
  await c.getBodyContext({ purpose: 'test-purpose' });
  assert.deepStrictEqual(apps.approvals.pending().map((p) => [p.app, p.lens]), [['test-app', 'test-purpose']]);
  assert.deepStrictEqual(apps.activity.recent(10).map((e) => [e.kind, e.state]),
    [['denied', 'purpose_not_approved'], ['request', 'purpose_not_approved']]);
});

test('approving in the store applies to the next call without a restart; revoking applies too', async (t) => {
  const { c, calls, apps } = core(t);
  assert.strictEqual((await c.getBodyContext({ purpose: 'test-purpose' })).state, 'purpose_not_approved');
  // Another process (the web UI) writes the shared file.
  createAppApprovals(apps.appsFile).setLens('test-app', 'test-purpose', true);
  assert.deepStrictEqual(apps.approvals.pending(), []);
  await c.getBodyContext({ purpose: 'test-purpose' });
  calls.callbacks[0](SAMPLE);
  const ok = await c.getBodyContext({ purpose: 'test-purpose' });
  assert.strictEqual(ok.lens, 'test-purpose');
  assert.strictEqual(ok.marker, 'test-purpose');
  assert.strictEqual(c.listPurposes().purposes.find((p) => p.id === 'test-purpose').approved, true);

  createAppApprovals(apps.appsFile).setLens('test-app', 'test-purpose', false);
  assert.strictEqual((await c.getBodyContext({ purpose: 'test-purpose' })).state, 'purpose_not_approved');
  // The entry now exists and started from the default lens, so companion still works.
  assert.strictEqual((await c.getBodyContext({ purpose: 'companion' })).lens, 'companion');
});

test('unknown purpose: refused with the list of purposes, camera stays off', async (t) => {
  const { c, calls, apps } = core(t);
  const r = await c.getBodyContext({ purpose: 'mind-reading' });
  assert.strictEqual(r.state, 'unknown_purpose');
  assert.strictEqual(r.say, false);
  assert.ok(r.availablePurposes.includes('companion') && r.availablePurposes.includes('test-purpose'));
  assert.strictEqual(calls.created, 0);
  assert.deepStrictEqual(apps.activity.recent(1).map((e) => [e.kind, e.lens]), [['unknown', null]]);
  assert.deepStrictEqual(apps.approvals.pending(), []);
});

test('consent gates still come first, whatever the purpose', async (t) => {
  const { c, calls, apps } = core(t, { consentString: '' });
  assert.strictEqual((await c.getBodyContext({ purpose: 'test-purpose' })).state, 'consent_required');
  assert.strictEqual(calls.created, 0);
  assert.deepStrictEqual(apps.approvals.pending(), []);
});

test('list_purposes reflects current approvals; app identity falls back from env to client name to default', (t) => {
  const { c, apps } = core(t);
  const l = c.listPurposes();
  assert.strictEqual(l.app, 'test-app');
  assert.deepStrictEqual(l.purposes.find((p) => p.id === 'companion'),
    { id: 'companion', name: 'Emotional companion', description: l.purposes[0].description, sharesNumbers: false, approved: true });
  assert.strictEqual(l.purposes.find((p) => p.id === 'test-purpose').approved, false);
  apps.approvals.setLens('test-app', 'companion', false);
  assert.strictEqual(c.listPurposes().purposes.find((p) => p.id === 'companion').approved, false);

  let name = null;
  const { c: c2 } = core(t, { appId: 'Not Valid!', clientName: () => name, defaultAppId: 'chatgpt' });
  assert.strictEqual(c2.appId(), 'chatgpt');
  name = 'Claude Desktop';
  assert.strictEqual(c2.appId(), 'claude-desktop');
  const { c: c3 } = core(t, { appId: undefined });
  assert.strictEqual(c3.appId(), 'claude-desktop');
});

async function stdioClient(t, env, clientName = 'attune-purpose-test') {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const mem = tempMemory();
  const apps = tempApps();
  const childEnv = { ...process.env, ATTUNE_ADAPTER: 'mock', ATTUNE_CONSENT: ON,
    ATTUNE_APPS_FILE: apps.appsFile, ATTUNE_ACTIVITY_FILE: apps.activityFile, ...env };
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', '..', 'src', 'server.js')],
    env: childEnv,
    cwd: path.dirname(mem.file),
    stderr: 'ignore',
  });
  const client = new Client({ name: clientName, version: '0.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); mem.cleanup(); apps.cleanup(); });
  const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
  return { client, call, apps };
}

test('stdio connector: purposes follow the shared approvals file live; no approval tool exists', async (t) => {
  const { client, call, apps } = await stdioClient(t, { ATTUNE_APP_ID: 'stdio-app' });
  const tools = (await client.listTools()).tools;
  assert.ok(!tools.some((x) => /consent|approv|allow|grant|permi/.test(x.name)));
  const ctxTool = tools.find((x) => x.name === 'get_body_context');
  assert.ok(ctxTool.inputSchema.properties.purpose);
  assert.match(ctxTool.description, /cannot approve/);

  const list = await call('list_purposes');
  assert.strictEqual(list.app, 'stdio-app');
  assert.strictEqual(list.purposes.find((p) => p.id === 'companion').approved, true);

  assert.strictEqual((await call('get_body_context', { purpose: 'mind-reading' })).state, 'unknown_purpose');
  const first = await call('get_body_context', {});
  assert.notStrictEqual(first.state, 'purpose_not_approved');
  assert.ok(!/\d{2,}/.test(JSON.stringify({ ...first, confidence: 0 })));

  apps.approvals.setLens('stdio-app', 'companion', false); // the person denies it in the web UI
  const denied = await call('get_body_context', { purpose: 'companion' });
  assert.strictEqual(denied.state, 'purpose_not_approved');
  assert.match(denied.howToEnable, /allow Stdio App to use Emotional companion/);
  assert.deepStrictEqual(apps.approvals.pending().map((p) => p.app), ['stdio-app']);

  apps.approvals.setLens('stdio-app', 'companion', true); // ...and allows it again: no restart needed
  assert.notStrictEqual((await call('get_body_context', { purpose: 'companion' })).state, 'purpose_not_approved');
  const kinds = apps.activity.recent(10).map((e) => e.kind);
  assert.deepStrictEqual(kinds, ['context', 'request', 'context', 'unknown']);
});

test('stdio connector: without ATTUNE_APP_ID the app is named after the MCP client', async (t) => {
  const { call } = await stdioClient(t, { ATTUNE_APP_ID: undefined }, 'My Test Client');
  assert.strictEqual((await call('list_purposes')).app, 'my-test-client');
});
