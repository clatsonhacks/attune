'use strict';
/* Remembered consent + when the camera runs (chat started, AI asked, idle stop, pause, forget). */
const { fakeAdapterFactory, SAMPLE, tempMemory, tempConsentStore } = require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const { createApp } = require('../../src/webServer');
const { createConsentStore, DISCLOSURE_VERSION } = require('../../src/privacy/consentStore');
const { createCompanion } = require('../../src/companion');
const { sanitizeStatus } = require('../../src/adapter/isolated');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function request(port, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method: body ? 'POST' : 'GET', path,
      headers: { host: `localhost:${port}`, 'x-attune-token': token, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b || '{}') }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function boot(t, { idleMs = 60000, store } = {}) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const { factory, calls } = fakeAdapterFactory();
  const mem = tempMemory();
  const cs = store || tempConsentStore();
  const seen = [];
  const app = createApp({ port, adapterFactory: factory, memory: mem.memory, consentStore: cs.store, idleMs, log: () => {},
    reply: async ({ ctx, onBodyRequest }) => { seen.push({ ctx, hasTool: !!onBodyRequest, onBodyRequest }); return { reply: 'ok' }; } });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  t.after(async () => { await app.close(); mem.cleanup(); if (!store) cs.cleanup(); });
  const api = (path, body) => request(port, path, body, app.guard.token);
  return { app, calls, seen, api, cs };
}

test('without permission, chatting never turns the camera on', async (t) => {
  const { api, calls } = await boot(t);
  await api('/api/chat', { message: 'hi' });
  await wait(30);
  assert.strictEqual(calls.created, 0);
  assert.strictEqual((await api('/api/state')).json.state, 'consent_required');
});

test('asked once: consent is saved; after a restart the first chat message turns the camera on', async (t) => {
  const cs = tempConsentStore();
  t.after(() => cs.cleanup());
  const a = await boot(t, { store: cs });
  await a.api('/api/consent', { sensing: true, presageAck: true, aiSharing: true });
  assert.strictEqual(a.calls.started, 1); // turned on right after the person allowed it
  assert.ok(fs.existsSync(cs.file));
  await a.app.close();

  const b = await boot(t, { store: cs });
  let s = (await b.api('/api/state')).json;
  assert.strictEqual(s.consent.remembered, true);
  assert.strictEqual(s.state, 'standby'); // permission, camera off
  assert.strictEqual(b.calls.created, 0);
  await b.api('/api/chat', { message: 'hello' });
  await b.app.sensing.settled();
  assert.strictEqual(b.calls.started, 1);
  s = (await b.api('/api/state')).json;
  assert.strictEqual(s.sensing.lastTrigger, 'chat_started');
  await b.api('/api/chat', { message: 'again' });
  await b.app.sensing.settled();
  assert.strictEqual(b.calls.started, 1); // not restarted per message
});

test('the camera turns off after the idle time, keeping permission', async (t) => {
  const { api, app, calls } = await boot(t, { idleMs: 60 });
  await api('/api/consent', { sensing: true, presageAck: true });
  assert.strictEqual(calls.started, 1);
  await wait(150);
  await app.sensing.settled();
  assert.strictEqual(calls.stopped, 1);
  const s = (await api('/api/state')).json;
  assert.strictEqual(s.consent.sensing, true);
  assert.strictEqual(s.state, 'standby');
});

test('pause sticks until resume — new chats do not turn the camera back on', async (t) => {
  const { api, app, calls } = await boot(t);
  await api('/api/consent', { sensing: true, presageAck: true });
  await api('/api/sensing', { action: 'pause' });
  assert.strictEqual(calls.stopped, 1);
  await api('/api/chat/reset', {});
  await api('/api/chat', { message: 'hi' });
  await app.sensing.settled();
  assert.strictEqual(calls.started, 1);
  assert.strictEqual((await api('/api/state')).json.state, 'paused');
  await api('/api/sensing', { action: 'resume' });
  assert.strictEqual(calls.started, 2);
});

test('forgetting permission stops the camera and deletes the saved consent', async (t) => {
  const { api, calls, cs } = await boot(t);
  await api('/api/consent', { sensing: true, presageAck: true, aiSharing: true });
  assert.ok(fs.existsSync(cs.file));
  await api('/api/revoke', {});
  assert.strictEqual(calls.stopped, 1);
  assert.ok(!fs.existsSync(cs.file));
});

test('the AI tool is offered only with AI sharing, and turns the camera on without waiting', async (t) => {
  const { api, app, calls, seen } = await boot(t);
  await api('/api/consent', { sensing: true, presageAck: true });
  await api('/api/sensing', { action: 'pause' });
  await api('/api/sensing', { action: 'resume' });
  await api('/api/chat', { message: 'hi' });
  assert.strictEqual(seen[0].hasTool, false); // no AI sharing → no tool

  await api('/api/consent', { aiSharing: true });
  await app.sensing.release('idle'); // camera off; only the AI can turn it on now (chat already started)
  await api('/api/chat', { message: 'again' });
  const tool = seen[1];
  assert.strictEqual(tool.hasTool, true);
  const before = calls.started;
  const t0 = Date.now();
  const r = await tool.onBodyRequest('they sound stressed');
  assert.ok(Date.now() - t0 < 200, 'answers immediately');
  assert.strictEqual(r.status, 'camera_starting');
  await app.sensing.settled();
  assert.strictEqual(calls.started, before + 1);
  assert.strictEqual((await api('/api/state')).json.sensing.lastTrigger, 'ai_requested');
  calls.callbacks[calls.callbacks.length - 1](SAMPLE);
  assert.ok(['warming_up', 'ok'].includes((await tool.onBodyRequest('again')).status));
});

test('saved consent from an older disclosure version is ignored', () => {
  const cs = tempConsentStore();
  try {
    fs.writeFileSync(cs.file, JSON.stringify({ version: DISCLOSURE_VERSION - 1, scopes: { sensing: true, presageAck: true } }));
    assert.strictEqual(createConsentStore(cs.file).load(), null);
    createConsentStore(cs.file).save({ scopes: { sensing: true, presageAck: true } });
    assert.strictEqual(createConsentStore(cs.file).load().scopes.sensing, true);
  } finally { cs.cleanup(); }
});

test('companion: tool call → callback → second request with the tool result', async () => {
  const bodies = [];
  const fetchFn = async (url, init) => {
    const b = JSON.parse(init.body); bodies.push(b);
    const msg = bodies.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'check_in_with_body', arguments: '{"reason":"stressed"}' } }] }
      : { role: 'assistant', content: 'Take a slow breath with me.' };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: msg }] }) };
  };
  const reasons = [];
  const c = createCompanion({ fetchFn, env: { GROQ_API_KEY: 'k' }, log: () => {} });
  const r = await c.reply({ message: "I'm fine, just deadlines", ctx: null, onBodyRequest: async (why) => { reasons.push(why); return { status: 'camera_starting' }; } });
  assert.strictEqual(r.reply, 'Take a slow breath with me.');
  assert.strictEqual(r.askedBody, true);
  assert.deepStrictEqual(reasons, ['stressed']);
  assert.strictEqual(bodies[0].tools[0].function.name, 'check_in_with_body');
  const toolMsg = bodies[1].messages.find((m) => m.role === 'tool');
  assert.strictEqual(toolMsg.tool_call_id, 'c1');
  assert.match(toolMsg.content, /camera_starting/);

  const plain = [];
  const c2 = createCompanion({ fetchFn: async (u, i) => { plain.push(JSON.parse(i.body)); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'hi' } }] }) }; }, env: { GROQ_API_KEY: 'k' }, log: () => {} });
  await c2.reply({ message: 'hi', ctx: null });
  assert.strictEqual(plain[0].tools, undefined); // no callback → no tool offered
});

test('camera status from the worker is validated', () => {
  assert.deepStrictEqual(sanitizeStatus({ validationCode: 7, hint: 'Place more of the chest in view.', processing: 'starting', mode: 'full', x: 1 }),
    { validationCode: 7, hint: 'Place more of the chest in view.', processing: 'starting', mode: 'full' });
  assert.strictEqual(sanitizeStatus({ processing: 'hacked' }), null);
  assert.strictEqual(sanitizeStatus({ hint: 'a'.repeat(500) }).hint.length, 120);
});
