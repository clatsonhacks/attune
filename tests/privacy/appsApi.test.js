'use strict';
/* Web API for lenses, app approvals, activity and the built-in companion's mode. */
const { fakeAdapterFactory, SAMPLE, tempMemory, tempConsentStore, tempApps } = require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const { createApp } = require('../../src/webServer');
const { register, listLenses } = require('../../src/lenses');

register({ id: 'test-web-lens', name: 'Test web lens', description: 'Only for tests.',
  render: (snap) => ({ state: snap.state, say: false, directive: null, confidence: 1 }) });

function request(port, path, { body, token, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method: body ? 'POST' : 'GET', path,
      headers: { host: `localhost:${port}`, ...(token ? { 'x-attune-token': token } : {}), ...headers, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function boot(t, opts = {}) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const { factory, calls } = fakeAdapterFactory();
  const mem = tempMemory();
  const cs = tempConsentStore();
  const apps = tempApps();
  const seen = [];
  const app = createApp({ port, adapterFactory: factory, memory: mem.memory, consentStore: cs.store, log: () => {},
    approvals: apps.approvals, activity: apps.activity,
    reply: async ({ ctx, onBodyRequest }) => { seen.push({ ctx, onBodyRequest }); return { reply: 'ok' }; }, ...opts });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  t.after(async () => { await app.close(); mem.cleanup(); cs.cleanup(); apps.cleanup(); });
  const api = (path, body) => request(port, path, { body, token: app.guard.token });
  return { port, app, calls, api, apps, seen };
}

test('every new route needs the session token and a local host/origin', async (t) => {
  const { port, app } = await boot(t);
  const routes = [['/api/lenses'], ['/api/apps'], ['/api/activity'], ['/api/apps/lens', { app: 'x', lens: 'companion', allow: true }],
    ['/api/apps/remove', { app: 'x' }], ['/api/activity/clear', {}], ['/api/mode', { lens: 'companion' }]];
  for (const [path, body] of routes) {
    assert.strictEqual((await request(port, path, { body })).status, 401, path);
    assert.strictEqual((await request(port, path, { body, token: app.guard.token, headers: { origin: 'https://evil.example' } })).status, 403, path);
  }
});

test('GET /api/lenses lists the registry', async (t) => {
  const { api } = await boot(t);
  const r = await api('/api/lenses');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { lenses: listLenses() });
});

test('apps: built-in Attune is listed and protected; approvals and pending are managed by the person', async (t) => {
  const { api, apps } = await boot(t);
  let r = (await api('/api/apps')).json;
  assert.deepStrictEqual(r.apps, [{ id: 'attune', name: 'Attune', lenses: listLenses().map((l) => l.id), builtin: true }]);
  assert.deepStrictEqual(r.pending, []);

  apps.approvals.recordRequest('chatgpt', 'test-web-lens'); // the connector asked
  r = (await api('/api/apps')).json;
  assert.deepStrictEqual(r.pending.map((p) => [p.app, p.lens]), [['chatgpt', 'test-web-lens']]);

  const set = await api('/api/apps/lens', { app: 'chatgpt', lens: 'test-web-lens', allow: true, name: 'ChatGPT' });
  assert.strictEqual(set.status, 200);
  assert.deepStrictEqual(set.json, { ok: true, app: { id: 'chatgpt', name: 'ChatGPT', lenses: ['companion', 'test-web-lens'], builtin: false } });
  r = (await api('/api/apps')).json;
  assert.deepStrictEqual(r.pending, []);
  assert.deepStrictEqual(r.apps[1], { id: 'chatgpt', name: 'ChatGPT', lenses: ['companion', 'test-web-lens'], builtin: false });
  assert.strictEqual(apps.approvals.isApproved('chatgpt', 'test-web-lens'), true);

  assert.strictEqual((await api('/api/apps/lens', { app: 'chatgpt', lens: 'companion', allow: false })).json.app.lenses.join(), 'test-web-lens');

  for (const bad of [{ app: 'Bad App', lens: 'companion', allow: true }, { app: 'x', lens: 'nope', allow: true },
    { app: 'x', lens: 'companion', allow: 'yes' }, { app: 'x', lens: 'companion', allow: true, name: 5 }, { lens: 'companion', allow: true }]) {
    assert.strictEqual((await api('/api/apps/lens', bad)).status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await api('/api/apps/lens', { app: 'attune', lens: 'companion', allow: false })).status, 400);
  assert.strictEqual((await api('/api/apps/remove', { app: 'attune' })).status, 400);
  assert.strictEqual((await api('/api/apps/remove', { app: '../x' })).status, 400);
  assert.ok(!apps.approvals.hasEntry('attune'));

  assert.deepStrictEqual((await api('/api/apps/remove', { app: 'chatgpt' })).json, { ok: true });
  assert.strictEqual((await api('/api/apps')).json.apps.length, 1);
});

test('activity: newest first with a limit (max 500), and can be cleared', async (t) => {
  const { api, apps } = await boot(t);
  for (let i = 0; i < 5; i++) apps.activity.append({ kind: 'context', app: `app-${i}`, lens: 'companion', state: 'neutral' });
  let r = (await api('/api/activity?limit=2')).json;
  assert.deepStrictEqual(r.events.map((e) => e.app), ['app-4', 'app-3']);
  assert.deepStrictEqual(Object.keys(r.events[0]).sort(), ['app', 'at', 'kind', 'lens', 'say', 'state']);
  assert.strictEqual((await api('/api/activity?limit=abc')).json.events.length, 5);
  assert.strictEqual((await api('/api/activity?limit=100000')).json.events.length, 5);
  assert.deepStrictEqual((await api('/api/activity/clear', {})).json, { ok: true });
  assert.deepStrictEqual((await api('/api/activity')).json, { events: [] });
});

test('mode: switching the built-in companion lens changes what the chat and the AI tool read', async (t) => {
  const { api, calls, seen, apps } = await boot(t);
  assert.strictEqual((await api('/api/state')).json.lensMode, 'companion');
  await api('/api/consent', { sensing: true, presageAck: true, aiSharing: true });
  calls.callbacks[0](SAMPLE);
  await api('/api/chat', { message: 'hi' });
  assert.strictEqual(seen[0].ctx.lens, 'companion');

  assert.strictEqual((await api('/api/mode', { lens: 'nope' })).status, 400);
  assert.strictEqual((await api('/api/mode', {})).status, 400);
  assert.deepStrictEqual((await api('/api/mode', { lens: 'test-web-lens' })).json, { ok: true, lensMode: 'test-web-lens' });
  assert.strictEqual((await api('/api/state')).json.lensMode, 'test-web-lens');
  await api('/api/chat', { message: 'again' });
  assert.strictEqual(seen[1].ctx.lens, 'test-web-lens');

  const r = await seen[1].onBodyRequest('checking');
  assert.ok(['warming_up', 'ok'].includes(r.status), r.status); // one sample: usually still calibrating
  if (r.status === 'ok') assert.strictEqual(r.lens, 'test-web-lens');
  const [e] = apps.activity.recent(1);
  assert.deepStrictEqual([e.app, e.lens, e.kind], ['attune', 'test-web-lens', 'context']);
  assert.ok(!fs.readFileSync(apps.activityFile, 'utf8').includes('directive'));
});

test('registering Claude Desktop creates its approvals entry with the companion lens only', async (t) => {
  let registered = 0;
  const { api, apps } = await boot(t, { demo: false, registerClaude: () => { registered++; return { ok: true }; } });
  apps.approvals.recordRequest('claude-desktop', 'test-web-lens');
  assert.strictEqual((await api('/api/connectors/claude', { approved: true })).status, 200);
  assert.strictEqual(registered, 1);
  assert.deepStrictEqual(apps.approvals.get('claude-desktop').lenses, ['companion']);
  assert.strictEqual(apps.approvals.get('claude-desktop').name, 'Claude Desktop');
  assert.strictEqual(apps.approvals.isApproved('claude-desktop', 'test-web-lens'), false);
});

test('a failed Claude Desktop registration creates no approvals entry', async (t) => {
  const { api, apps } = await boot(t, { demo: false, registerClaude: () => ({ error: 'nope' }) });
  assert.strictEqual((await api('/api/connectors/claude', { approved: true })).status, 409);
  assert.strictEqual(apps.approvals.hasEntry('claude-desktop'), false);
});
