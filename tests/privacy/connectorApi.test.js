'use strict';
/* Service connector API (/connector/v1/*): auth, service.json, consent from the service, purposes, strict profile. */
const { fakeAdapterFactory, SAMPLE, tempMemory, tempConsentStore, tempApps } = require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../../src/webServer');
const { register, listLenses } = require('../../src/lenses');
const { createAppApprovals } = require('../../src/privacy/appApprovals');

register({ id: 'test-api-lens', name: 'Test API lens', description: 'Only for tests.',
  render: (snap) => ({ state: snap.state, say: false, directive: null, confidence: 1, marker: 'test-api-lens' }) });

function request(port, route, { method, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method: method || (body ? 'POST' : 'GET'), path: route,
      headers: { host: `127.0.0.1:${port}`, ...headers, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
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
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'attune-svc-'));
  const serviceFile = path.join(dataDir, 'service.json');
  const app = createApp({ port, adapterFactory: factory, memory: mem.memory, consentStore: cs.store, log: () => {},
    approvals: apps.approvals, activity: apps.activity, serviceFile, reply: async () => ({ reply: 'ok' }), ...opts.app });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); mem.cleanup(); cs.cleanup(); apps.cleanup(); if (!opts.dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); });
  const auth = { authorization: `Bearer ${app.connectorToken}` };
  const conn = (route, body) => request(port, `/connector/v1/${route}`, { body, headers: auth });
  const ui = (route, body) => request(port, route, { body, headers: { host: `localhost:${port}`, 'x-attune-token': app.guard.token } });
  return { port, app, calls, apps, mem, conn, ui, serviceFile, dataDir, close };
}

const ALLOW = { sensing: true, presageAck: true, aiSharing: true };

test('service.json is written on listen (user-only, atomic) and removed on clean close', async (t) => {
  const { app, port, serviceFile, close } = await boot(t);
  const info = JSON.parse(fs.readFileSync(serviceFile, 'utf8'));
  assert.deepStrictEqual(Object.keys(info).sort(), ['pid', 'port', 'startedAt', 'token', 'version']);
  assert.strictEqual(info.version, 1);
  assert.strictEqual(info.port, port);
  assert.strictEqual(info.pid, process.pid);
  assert.match(info.token, /^[0-9a-f]{64}$/);
  assert.strictEqual(info.token, app.connectorToken);
  assert.notStrictEqual(info.token, app.guard.token);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(serviceFile).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(serviceFile)), ['service.json']); // no temp files left
  await close();
  assert.ok(!fs.existsSync(serviceFile));
});

test('close leaves service.json alone when another instance has replaced it', async (t) => {
  const { serviceFile, close } = await boot(t);
  const other = { version: 1, port: 1, token: 'f'.repeat(64), pid: 999999, startedAt: new Date().toISOString() };
  fs.writeFileSync(serviceFile, JSON.stringify(other));
  await close();
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(serviceFile, 'utf8')), other);
});

test('the connector token is reused across restarts when service.json survives', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attune-svc-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const a = await boot(t, { dataDir });
  const token = a.app.connectorToken;
  // Unclean exit: the process dies without withdrawing service.json.
  await new Promise((r) => a.app.server.close(r));
  await a.app.sensing.shutdown();
  assert.ok(fs.existsSync(a.serviceFile));
  const b = await boot(t, { dataDir });
  assert.strictEqual(b.app.connectorToken, token);
  assert.strictEqual(JSON.parse(fs.readFileSync(b.serviceFile, 'utf8')).port, b.port);
  assert.strictEqual((await b.conn('status?app=x')).status, 200);
});

test('auth: bad or missing token → 401; any Origin → 403; foreign Host → 403; UI token is not a connector token', async (t) => {
  const { port, app, conn } = await boot(t);
  const r = (headers, route = '/connector/v1/status?app=x') => request(port, route, { headers });
  assert.strictEqual((await r({})).status, 401);
  assert.strictEqual((await r({ authorization: 'Bearer nope' })).status, 401);
  assert.strictEqual((await r({ authorization: `Bearer ${'0'.repeat(64)}` })).status, 401);
  assert.strictEqual((await r({ authorization: app.connectorToken })).status, 401);
  assert.strictEqual((await r({ authorization: `Bearer ${app.guard.token}` })).status, 401);
  assert.strictEqual((await r({ 'x-attune-token': app.guard.token })).status, 401);
  const good = { authorization: `Bearer ${app.connectorToken}` };
  assert.strictEqual((await r(good)).status, 200);
  assert.strictEqual((await r({ ...good, origin: `http://localhost:${port}` })).status, 403); // even our own page
  assert.strictEqual((await r({ ...good, origin: 'null' })).status, 403);
  assert.strictEqual((await r({ ...good, origin: 'https://evil.example' })).status, 403);
  assert.strictEqual((await r({ ...good, 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.strictEqual((await r({ ...good, host: `evil.example:${port}` })).status, 403);
  assert.strictEqual((await request(port, '/connector/v1/context', { body: { app: 'x' }, headers: { ...good, origin: 'https://evil.example' } })).status, 403);
  // The connector token opens nothing in the UI API.
  assert.strictEqual((await r(good, '/api/state')).status, 401);
  // Unknown routes and bad app ids.
  assert.strictEqual((await conn('consent', { app: 'x', sensing: true })).status, 404);
  assert.strictEqual((await conn('forget', { app: 'x' })).status, 404);
  assert.strictEqual((await conn('approve', { app: 'x', lens: 'yoga' })).status, 404);
  assert.strictEqual((await conn('status?app=Bad%20App')).status, 400);
  assert.strictEqual((await conn('status')).status, 400);
  assert.strictEqual((await conn('status?app=attune')).status, 400);
});

test('status and purposes come from the service; consent missing → consent_required, camera off', async (t) => {
  const { conn, ui, calls, apps } = await boot(t);
  let s = (await conn('status?app=test-app')).json;
  assert.deepStrictEqual(s, { attune: 'running', mode: 'demo', sensingAllowed: false, aiSharingAllowed: false, memoryAllowed: false,
    paused: false, camera: 'idle', app: 'test-app', approvedPurposes: ['companion'], howToEnable: s.howToEnable });
  assert.match(s.howToEnable, /Open Attune/);
  const ctx = (await conn('context', { app: 'test-app' })).json;
  assert.strictEqual(ctx.state, 'consent_required');
  assert.strictEqual(ctx.say, false);
  assert.match(ctx.howToEnable, /Open Attune/);
  assert.strictEqual(calls.created, 0);

  await ui('/api/consent', { sensing: true, presageAck: true }); // sensing without AI sharing is still not enough
  await ui('/api/sensing', { action: 'pause' });
  assert.strictEqual((await conn('context', { app: 'test-app' })).json.state, 'consent_required');
  assert.deepStrictEqual(apps.activity.recent(10).map((e) => [e.app, e.kind, e.state]),
    [['test-app', 'context', 'consent_required'], ['test-app', 'context', 'consent_required']]);

  const p = (await conn('purposes?app=test-app')).json;
  assert.strictEqual(p.app, 'test-app');
  assert.deepStrictEqual(p.purposes.map((x) => x.id), listLenses().map((l) => l.id));
  assert.deepStrictEqual(Object.keys(p.purposes[0]).sort(), ['approved', 'description', 'id', 'name', 'sharesNumbers']);
  assert.strictEqual(p.purposes.find((x) => x.id === 'companion').approved, true);
  assert.strictEqual(p.purposes.find((x) => x.id === 'test-api-lens').approved, false);
  assert.strictEqual((await conn('purposes?app=test-app&strict=1')).json.purposes.find((x) => x.id === 'companion').approved, false);
});

test('approved: the service wakes the camera; first call says starting, then number-free context; logged', async (t) => {
  const { conn, ui, calls, apps } = await boot(t);
  await ui('/api/consent', ALLOW);
  await ui('/api/sensing', { action: 'pause' });
  assert.strictEqual(calls.stopped, 1);
  const paused = (await conn('context', { app: 'test-app' })).json;
  assert.deepStrictEqual(paused, { state: 'paused', say: false, directive: null, lens: 'companion' });
  assert.strictEqual(calls.started, 1); // pause is respected: no new start
  await ui('/api/sensing', { action: 'resume' });
  assert.strictEqual(calls.started, 2);
  const starting = (await conn('context', { app: 'test-app' })).json;
  assert.strictEqual(starting.state, 'starting'); // active, but no sample yet
  calls.callbacks[1](SAMPLE);
  const ctx = (await conn('context', { app: 'test-app', purpose: 'companion' })).json;
  assert.deepStrictEqual(Object.keys(ctx).sort(), ['directive', 'lens', 'say', 'state']);
  assert.strictEqual(ctx.lens, 'companion');
  assert.ok(!JSON.stringify(ctx).includes('72'));
  assert.strictEqual(calls.started, 2);
  const s = (await conn('status?app=test-app')).json;
  assert.strictEqual(s.camera, 'active');
  assert.strictEqual(s.howToEnable, undefined);
  assert.deepStrictEqual(apps.activity.recent(3).map((e) => [e.app, e.lens, e.kind]),
    [['test-app', 'companion', 'context'], ['test-app', 'companion', 'context'], ['test-app', 'companion', 'context']]);
  assert.strictEqual(apps.activity.recent(3)[2].state, 'paused');
});

test('the camera is started by the service when an approved app asks and it was off', async (t) => {
  const { conn, ui, calls, app } = await boot(t);
  await ui('/api/consent', ALLOW);
  await app.sensing.release('idle'); // idle timeout turned it off
  await app.sensing.settled();
  assert.strictEqual(calls.stopped, 1);
  const r = (await conn('context', { app: 'test-app' })).json;
  assert.ok(['starting'].includes(r.state), r.state);
  assert.strictEqual(calls.started, 2);
  assert.strictEqual((await ui('/api/state')).json.sensing.lastTrigger, 'ai_requested');
});

test('unknown and unapproved purposes: refused, camera untouched, pending request + activity; approvals apply live', async (t) => {
  const { conn, ui, calls, apps } = await boot(t);
  await ui('/api/consent', ALLOW);
  await ui('/api/sensing', { action: 'pause' });
  const unknown = (await conn('context', { app: 'test-app', purpose: 'mind-reading' })).json;
  assert.strictEqual(unknown.state, 'unknown_purpose');
  assert.ok(unknown.availablePurposes.includes('companion'));
  const r = (await conn('context', { app: 'test-app', appName: 'My Test App', purpose: 'test-api-lens' })).json;
  assert.deepStrictEqual(r, { state: 'purpose_not_approved', lens: 'test-api-lens', say: false,
    howToEnable: 'Open Attune → Connectors and allow My Test App to use Test API lens.' });
  await conn('context', { app: 'test-app', purpose: 'test-api-lens' });
  assert.deepStrictEqual(apps.approvals.pending().map((p) => [p.app, p.lens]), [['test-app', 'test-api-lens']]);
  assert.deepStrictEqual(apps.activity.recent(3).map((e) => [e.kind, e.state]),
    [['denied', 'purpose_not_approved'], ['request', 'purpose_not_approved'], ['unknown', 'unknown_purpose']]);
  assert.strictEqual(calls.started, 1);

  createAppApprovals(apps.appsFile).setLens('test-app', 'test-api-lens', true); // the person allows it
  await ui('/api/sensing', { action: 'resume' });
  calls.callbacks[1](SAMPLE);
  const ok = (await conn('context', { app: 'test-app', purpose: 'test-api-lens' })).json;
  assert.equal(ok.lens, 'test-api-lens');
  assert.equal(ok.marker, undefined);
  assert.deepStrictEqual((await conn('status?app=test-app')).json.approvedPurposes, ['companion', 'test-api-lens']);
});

test('strict profile: no approvals entry means no lens at all, companion included', async (t) => {
  const { conn, ui, calls, apps } = await boot(t);
  await ui('/api/consent', ALLOW);
  calls.callbacks[0](SAMPLE);
  assert.deepStrictEqual((await conn('status?app=chatgpt&strict=1')).json.approvedPurposes, []);
  const r = (await conn('context', { app: 'chatgpt', strict: true })).json;
  assert.strictEqual(r.state, 'purpose_not_approved');
  assert.match(r.howToEnable, /allow ChatGPT to use Emotional companion/);
  assert.deepStrictEqual(apps.approvals.pending().map((p) => [p.app, p.lens]), [['chatgpt', 'companion']]);
  // Non-strict, the same app would have had companion by default.
  assert.strictEqual((await conn('context', { app: 'chatgpt' })).json.lens, 'companion');
  await ui('/api/apps/lens', { app: 'chatgpt', lens: 'companion', allow: true });
  assert.strictEqual((await conn('context', { app: 'chatgpt', strict: true })).json.lens, 'companion');
});

test('correction and memory: scopes from the service; no forget route', async (t) => {
  const { conn, ui, calls, mem } = await boot(t);
  assert.deepStrictEqual((await conn('correction', { app: 'a', wasAccurate: false })).json, { ok: false, reason: 'sensing is not active' });
  assert.strictEqual((await conn('memory?app=a')).json.memory, 'disabled');
  assert.strictEqual((await conn('memory', { app: 'a', note: 'x' })).json.ok, false);
  assert.strictEqual((await conn('memory', { app: 'a' })).status, 400);
  await ui('/api/consent', { ...ALLOW, memory: true });
  calls.callbacks[0](SAMPLE);
  assert.notStrictEqual((await conn('correction', { app: 'a', wasAccurate: false })).json.ok, false);
  assert.deepStrictEqual((await conn('memory', { app: 'a', note: 'talked about work' })).json, { ok: true });
  assert.ok(JSON.stringify(mem.memory.getAll()).includes('talked about work'));
  assert.ok('sessionsRemembered' in (await conn('memory?app=a')).json);
  await ui('/api/revoke', { scopes: ['aiSharing'] });
  assert.strictEqual((await conn('memory?app=a')).json.memory, 'disabled');
});

test('apps list shows when each connected app was last seen', async (t) => {
  const { conn, ui } = await boot(t);
  await ui('/api/apps/lens', { app: 'claude-desktop', lens: 'companion', allow: true });
  let r = (await ui('/api/apps')).json;
  assert.strictEqual(r.apps.find((a) => a.id === 'claude-desktop').lastSeenAt, null);
  await conn('status?app=claude-desktop');
  await conn('purposes?app=other-app');
  r = (await ui('/api/apps')).json;
  assert.ok(!Number.isNaN(Date.parse(r.apps.find((a) => a.id === 'claude-desktop').lastSeenAt)));
  assert.deepStrictEqual(Object.keys(r.lastSeen).sort(), ['claude-desktop', 'other-app']);
  assert.strictEqual(r.apps[0].lastSeenAt, null);
});

test('explicit vital requests cannot retrieve measurements, notes or correction thresholds through an approved lens', async (t) => {
  const { conn, ui, calls, mem } = await boot(t);
  await ui('/api/consent', { ...ALLOW, memory: true });
  const sample = { ...SAMPLE, breathingRate: 23, breathingConfidence: 0.93 };
  calls.callbacks[0](sample);
  for (const app of ['claude-desktop', 'chatgpt', 'other-client']) {
    await ui('/api/apps/lens', { app, lens: 'yoga', allow: true });
    const result = await conn('context', { app, purpose: 'yoga', strict: true, fields: ['pulseBpm', 'breathsPerMin'], includeRaw: true });
    assert.deepEqual(result.json, { lens: 'yoga', state: 'guidance', say: true,
      directive: 'Gently invite a longer exhale and let them set a comfortable pace.' });
    assert.equal((await conn('purposes?app=' + app)).json.purposes.some(p => p.sharesNumbers), false);
    assert.deepEqual((await conn('correction', { app, wasAccurate: false })).json, { ok: true });
  }
  mem.memory.append({ type: 'state', state: 'neutral', note: 'pulse 72 bpm, breathing 23/min' });
  assert.ok(!JSON.stringify((await conn('memory?app=other-client')).json).includes('bpm'));
  assert.equal((await ui('/api/state')).json.pulseBpm, 72);
});
