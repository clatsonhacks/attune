'use strict';
/* First-run setup (desktop app): the SmartSpectra key comes from an injected key store, never from .env or a log. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { tempMemory, tempConsentStore, tempApps } = require('../helpers');
const { createApp } = require('../../src/webServer');

function request(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `localhost:${port}`, ...headers, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function fakeKeyStore(initial = null, { failSet = false } = {}) {
  const calls = [];
  let value = initial;
  return {
    calls,
    get value() { return value; },
    async get() { calls.push('get'); return value; },
    async set(k) { calls.push('set'); if (failSet) { const e = new Error(`disk full for ${k}`); e.code = 'ENOSPC'; throw e; } value = k; },
    async clear() { calls.push('clear'); value = null; },
  };
}

const KEY = 'abcdEFGH1234ijklMNOP5678';

async function boot(t, { keyStore, groqStore, speechProvider, demo = false } = {}) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const mem = tempMemory();
  const cs = tempConsentStore();
  const apps = tempApps();
  const logs = [];
  const restarts = [];
  const restarter = { supported: true, async restart() { restarts.push(true); return { ok: true }; } };
  const made = [];
  const makeAdapter = (opts) => { made.push(opts); return { name: 'fake', start() {}, async stop() {} }; };
  const app = createApp({ port, demo, keyStore, groqStore, speechProvider, restarter, extensionFile: __filename, makeAdapter, memory: mem.memory, consentStore: cs.store, approvals: apps.approvals,
    activity: apps.activity, serviceFile: null, log: (m) => logs.push(m), reply: async () => ({ reply: 'ok' }) });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  t.after(async () => { await app.close(); mem.cleanup(); cs.cleanup(); apps.cleanup(); });
  const api = (path, body) => request(port, { method: body !== undefined ? 'POST' : 'GET', path, body, headers: { 'x-attune-token': app.guard.token } });
  return { port, app, api, logs, made, restarts };
}

test('setup routes need the session token and a local Host', async (t) => {
  const { port, app } = await boot(t, { keyStore: fakeKeyStore() });
  assert.strictEqual((await request(port, { path: '/api/setup' })).status, 401);
  assert.strictEqual((await request(port, { path: '/api/setup/key', method: 'POST', body: { key: KEY } })).status, 401);
  const tok = { 'x-attune-token': app.guard.token };
  assert.strictEqual((await request(port, { path: '/api/setup', headers: { ...tok, host: `evil.example:${port}` } })).status, 403);
  assert.strictEqual((await request(port, { path: '/api/setup', headers: { ...tok, origin: 'https://evil.example' } })).status, 403);
});

test('plain service (no key store): needsKey follows SMARTSPECTRA_API_KEY and the key cannot be set', async (t) => {
  const { api } = await boot(t);
  const before = process.env.SMARTSPECTRA_API_KEY;
  t.after(() => { process.env.SMARTSPECTRA_API_KEY = before; });
  process.env.SMARTSPECTRA_API_KEY = '';
  assert.deepStrictEqual((await api('/api/setup')).json, { desktop: false, needsKey: true, demo: false });
  process.env.SMARTSPECTRA_API_KEY = KEY;
  assert.strictEqual((await api('/api/setup')).json.needsKey, false);
  assert.strictEqual((await api('/api/setup/key', { key: KEY })).status, 404);
  assert.strictEqual((await api('/api/setup/key/clear', {})).status, 404);
});

test('desktop: saves a valid key through the key store, never logs it, and reports needsKey', async (t) => {
  const ks = fakeKeyStore();
  const { api, logs } = await boot(t, { keyStore: ks });
  assert.deepStrictEqual((await api('/api/setup')).json, { desktop: true, needsKey: true, demo: false });
  const r = await api('/api/setup/key', { key: `  ${KEY}\n` });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.needsKey, false);
  assert.ok(!JSON.stringify(r.json).includes(KEY)); // the key is never echoed back
  assert.strictEqual(ks.value, KEY); // trimmed
  assert.strictEqual((await api('/api/setup')).json.needsKey, false);
  assert.ok(!logs.some((l) => l.includes(KEY)));
  const c = await api('/api/setup/key/clear', {});
  assert.strictEqual(c.json.needsKey, true);
  assert.strictEqual(ks.value, null);
});

test('desktop: malformed keys are refused with 400', async (t) => {
  const ks = fakeKeyStore();
  const { api } = await boot(t, { keyStore: ks });
  for (const key of [undefined, '', '   ', 'short', 'has a space inside it 123', 'x'.repeat(257), 12345678901234567890, { k: 1 }]) {
    const r = await api('/api/setup/key', key === undefined ? {} : { key });
    assert.strictEqual(r.status, 400, `key ${JSON.stringify(key)}`);
  }
  assert.ok(!ks.calls.includes('set'));
  assert.strictEqual((await api('/api/setup/key', { key: 'a'.repeat(16) })).status, 200);
  assert.strictEqual((await api('/api/setup/key', { key: 'a'.repeat(256) })).status, 200);
});

test('desktop: a key store failure is a 500 without the key in the log or the response', async (t) => {
  const { api, logs } = await boot(t, { keyStore: fakeKeyStore(null, { failSet: true }) });
  const r = await api('/api/setup/key', { key: KEY });
  assert.strictEqual(r.status, 500);
  assert.ok(!JSON.stringify(r.json).includes(KEY));
  assert.ok(!logs.some((l) => l.includes(KEY)));
  assert.strictEqual((await api('/api/setup')).json.needsKey, true);
});

test('desktop: the stored key reaches the sensor adapter; .env is not used', async (t) => {
  const before = process.env.SMARTSPECTRA_API_KEY;
  process.env.SMARTSPECTRA_API_KEY = 'from-dotenv-should-not-be-used';
  t.after(() => { process.env.SMARTSPECTRA_API_KEY = before; });
  const { api, made } = await boot(t, { keyStore: fakeKeyStore(KEY) });
  assert.strictEqual((await api('/api/setup')).json.needsKey, false); // loaded from the store at start
  await api('/api/consent', { sensing: true, presageAck: true });
  assert.strictEqual(made.length, 1);
  assert.strictEqual(made[0].apiKey, KEY);
  // A new key stops the running camera so the next start uses it.
  const other = 'zyxwVUTS9876rqpoNMLK5432';
  await api('/api/setup/key', { key: other });
  assert.notStrictEqual((await api('/api/state')).json.sensing.state, 'active');
  await api('/api/sensing', { action: 'start' });
  assert.strictEqual(made[1].apiKey, other);
});

test('plain service passes no apiKey (the adapter reads SMARTSPECTRA_API_KEY itself)', async (t) => {
  const { api, made } = await boot(t);
  await api('/api/consent', { sensing: true, presageAck: true });
  assert.strictEqual(made.length, 1);
  assert.ok(!('apiKey' in made[0]));
});

test('Claude extension download and explicit restart confirmation', async (t) => {
  const { port, api, restarts } = await boot(t, { keyStore: fakeKeyStore() });
  assert.equal((await request(port, { path: '/api/connectors/claude/restart', method: 'POST', body: { confirmed: true } })).status, 401);
  assert.equal((await api('/api/connectors/claude/restart', {})).status, 400);
  assert.equal(restarts.length, 0);
  assert.equal((await api('/api/connectors/claude/restart', { confirmed: true })).json.ok, true);
  assert.equal(restarts.length, 1);
  const download = await fetch('http://127.0.0.1:' + port + '/downloads/attune.mcpb');
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="attune.mcpb"');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), require('node:fs').readFileSync(__filename));
});

test('demo refuses Claude restart', async (t) => {
  const { api, restarts } = await boot(t, { demo: true });
  assert.equal((await api('/api/connectors/claude/restart', { confirmed: true })).status, 403);
  assert.equal(restarts.length, 0);
});

test('desktop Groq key is independent of camera and environment keys', async (t) => {
  const previous = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'ambient-test-key';
  t.after(() => { process.env.GROQ_API_KEY = previous; });
  const camera = fakeKeyStore(KEY), groq = fakeKeyStore();
  const { api, port, logs } = await boot(t, { keyStore: camera, groqStore: groq });
  assert.equal((await api('/api/state')).json.ai.connected, false);
  assert.equal((await request(port, { path: '/api/setup/groq', method: 'POST', body: { key: KEY } })).status, 401);
  assert.equal((await api('/api/setup/groq', { key: 'short' })).status, 400);
  assert.equal((await api('/api/setup/groq', { key: KEY })).json.ok, true);
  const settings = (await api('/api/setup/keys')).json;
  assert.equal(settings.hasGroq, true);
  assert.equal(settings.needsKey, false);
  assert.equal((await api('/api/state')).json.ai.connected, true);
  assert.equal(JSON.stringify(settings).includes(KEY), false);
  assert.ok(!logs.some((line) => line.includes(KEY)));
  assert.equal(groq.value, KEY);
  await api('/api/setup/groq/clear', {});
  assert.equal(groq.value, null);
  assert.equal(camera.value, KEY);
  assert.equal((await api('/api/state')).json.ai.connected, false);
});

test('voice routes require local UI authorization and a key; demo cannot send audio', async (t) => {
  const { api, port } = await boot(t, { keyStore: fakeKeyStore() });
  for (const action of ['transcribe', 'reply', 'speak']) {
    const path = '/api/voice/' + action;
    assert.equal((await request(port, { path, method: 'POST', body: {} })).status, 401);
    assert.equal((await api(path, {})).status, 409);
  }
  const demo = await boot(t, { demo: true, keyStore: fakeKeyStore(), groqStore: fakeKeyStore(KEY) });
  assert.equal((await demo.api('/api/voice/transcribe', {})).status, 409);
});

test('Groq audio goes through the server and a voice turn never opens the camera', async (t) => {
  const calls = [];
  const speechProvider = require('../../src/voice/groq').createSpeechProvider(async (url, opts) => {
    calls.push(url);
    assert.equal(opts.headers.authorization, 'Bearer ' + KEY);
    if (url.endsWith('/transcriptions')) {
      assert.equal(opts.body.get('model'), 'whisper-large-v3');
      assert.equal(await opts.body.get('file').text(), 'synthetic audio');
      return Response.json({ text: 'hello' });
    }
    assert.deepEqual(JSON.parse(opts.body), { input: 'ok', model: 'canopylabs/orpheus-v1-english', voice: 'troy', response_format: 'wav' });
    return new Response(Buffer.from([1, 2, 3]));
  });
  const { app, api, port, made } = await boot(t, { keyStore: fakeKeyStore(), groqStore: fakeKeyStore(KEY), speechProvider });
  const audio = (body, type) => fetch('http://127.0.0.1:' + port + '/api/voice/transcribe', {
    method: 'POST', headers: { 'x-attune-token': app.guard.token, 'content-type': type }, body,
  });
  assert.equal((await audio('bad', 'text/plain')).status, 415);
  assert.equal((await audio('', 'audio/webm')).status, 400);
  assert.equal((await audio(Buffer.alloc(2100000), 'audio/webm')).status, 413);
  const transcript = await (await audio('synthetic audio', 'audio/webm')).json();
  assert.equal(transcript.text, 'hello');
  assert.equal((await api('/api/voice/reply', transcript)).json.reply, 'ok');
  assert.equal((await api('/api/voice/speak', { text: 'x'.repeat(200) })).status, 400);
  assert.equal((await api('/api/voice/speak', { text: 'ok' })).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(made.length, 0);
});
