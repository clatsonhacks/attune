'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createApp } = require('../../src/webServer');
const { fakeAdapterFactory, SAMPLE, tempMemory } = require('../helpers');

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(b); } catch {}
        resolve({ status: res.statusCode, body: b, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function boot(t) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const { factory, calls } = fakeAdapterFactory();
  const mem = tempMemory();
  const replies = [];
  const app = createApp({ port, adapterFactory: factory, memory: mem.memory, log: () => {},
    reply: async ({ message, ctx }) => { replies.push(ctx); return { reply: 'ok', usedBody: !!ctx.say }; } });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  t.after(async () => { await app.close(); mem.cleanup(); });
  const api = (path, body) => request(port, { method: body ? 'POST' : 'GET', path, body, headers: { 'x-attune-token': app.guard.token } });
  return { port, app, calls, replies, api, mem };
}

test('API rejects requests without the session token', async (t) => {
  const { port } = await boot(t);
  assert.strictEqual((await request(port, { path: '/api/state' })).status, 401);
  assert.strictEqual((await request(port, { path: '/api/state', headers: { 'x-attune-token': 'nope' } })).status, 401);
});

test('API rejects foreign Host (DNS rebinding) and foreign Origin', async (t) => {
  const { port, app } = await boot(t);
  const tok = { 'x-attune-token': app.guard.token };
  assert.strictEqual((await request(port, { path: '/api/state', headers: { ...tok, host: `evil.example:${port}` } })).status, 403);
  assert.strictEqual((await request(port, { path: '/api/state', headers: { ...tok, origin: 'https://evil.example' } })).status, 403);
  assert.strictEqual((await request(port, { path: '/api/state', headers: { ...tok, origin: `http://localhost:${port}` } })).status, 200);
});

test('index.html carries the token; other origins cannot fetch the API with it', async (t) => {
  const { port, app } = await boot(t);
  const page = await request(port, { path: '/' });
  assert.strictEqual(page.status, 200);
  assert.ok(page.body.includes(`content="${app.guard.token}"`));
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
});

test('before consent: sensor not started, no measurements exposed', async (t) => {
  const { api, calls } = await boot(t);
  const s = (await api('/api/state')).json;
  assert.strictEqual(calls.created, 0);
  assert.strictEqual(s.state, 'consent_required');
  assert.strictEqual(s.pulseBpm, null);
  assert.deepStrictEqual(s.signals, []);
});

test('sensing without the Presage acknowledgement is refused', async (t) => {
  const { api, calls } = await boot(t);
  const r = await api('/api/consent', { sensing: true });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.json.code, 'presage_ack_required');
  assert.strictEqual(calls.created, 0);
});

test('consent starts sensing; revoke stops it and ignores late samples', async (t) => {
  const { api, calls } = await boot(t);
  const r = await api('/api/consent', { sensing: true, presageAck: true });
  assert.strictEqual(r.json.sensing.state, 'active');
  calls.callbacks[0](SAMPLE);
  assert.strictEqual((await api('/api/state')).json.pulseBpm, 72);

  await api('/api/revoke', { scopes: ['sensing'] });
  assert.strictEqual(calls.stopped, 1);
  calls.callbacks[0]({ ...SAMPLE, pulseBpm: 99 }); // late
  const s = (await api('/api/state')).json;
  assert.strictEqual(s.state, 'consent_required');
  assert.strictEqual(s.pulseBpm, null);
});

test('AI gets no body context unless aiSharing is on, and never numbers', async (t) => {
  const { api, calls, replies } = await boot(t);
  await api('/api/consent', { sensing: true, presageAck: true });
  calls.callbacks[0](SAMPLE);

  await api('/api/chat', { message: 'hi' });
  assert.strictEqual(replies[0].state, 'off');
  assert.strictEqual(replies[0].directive, null);

  await api('/api/consent', { aiSharing: true });
  const chat = (await api('/api/chat', { message: 'hi' })).json;
  assert.strictEqual(chat.aiSharing, true);
  const ctx = replies[1];
  assert.deepStrictEqual(Object.keys(ctx).sort(), ['confidence', 'directive', 'say', 'state', 'suggestedUtterance']);
  assert.ok(!JSON.stringify(ctx).includes('72'));
});

test('memory is not written without the memory scope', async (t) => {
  const { api, calls, mem } = await boot(t);
  const before = JSON.stringify(mem.memory.summary());
  await api('/api/consent', { sensing: true, presageAck: true });
  for (let i = 0; i < 40; i++) calls.callbacks[0]({ ...SAMPLE, pulseBpm: i < 25 ? 70 : 95, expression: i < 25 ? 'neutral' : 'tense' });
  await api('/api/correction', { wasAccurate: false });
  assert.strictEqual(JSON.stringify(mem.memory.summary()), before);
});

test('insights reach the human UI; the AI only gets a number-free note; chat never waits', async (t) => {
  const { createMockAdapter } = require('../../src/adapter/mock');
  const port = 30000 + Math.floor(Math.random() * 20000);
  const mem = tempMemory();
  const ctxs = [];
  const app = createApp({ port, memory: mem.memory, log: () => {},
    adapterFactory: () => createMockAdapter({ intervalMs: 15, insightEverySamples: 4, insightNeverArrives: true }),
    reply: async ({ ctx }) => { ctxs.push(ctx); return { reply: 'ok', usedBody: !!ctx.say }; } });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  t.after(async () => { await app.close(); mem.cleanup(); });
  const api = (path, body) => request(port, { method: body ? 'POST' : 'GET', path, body, headers: { 'x-attune-token': app.guard.token } });

  await api('/api/consent', { sensing: true, presageAck: true, aiSharing: true });
  let s;
  for (let i = 0; i < 40; i++) { s = (await api('/api/state')).json; if (s.insight && /bpm/.test(s.insight.text)) break; await new Promise((r) => setTimeout(r, 50)); }
  assert.ok(s.insight, 'insight visible to the human');

  const req = await api('/api/insight', { text: 'how am I doing?' });
  assert.strictEqual(req.status, 202); // accepted; the answer will never arrive (insightNeverArrives)
  const t0 = Date.now();
  await api('/api/chat', { message: 'hi' });
  assert.ok(Date.now() - t0 < 500, 'chat did not wait for the insight');
  const last = ctxs[ctxs.length - 1];
  if (last.note) assert.ok(!/\d|bpm/.test(last.note), last.note);
  assert.strictEqual((await api('/api/insight', {})).status, 429); // rate limited is reported, not hidden
});
