'use strict';
require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCompanion, bodyNote, groqKey } = require('../../src/companion');
const { claudeDesktopStatus, registerClaudeDesktop, SERVER_JS } = require('../../src/connectors');

const ENV = { GROQ_API_KEY: 'test-key' };
function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    const { status = 200, json } = await responder(body, calls.length);
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
  fn.calls = calls;
  return fn;
}
const textReply = (t) => ({ json: { model: 'openai/gpt-oss-120b', choices: [{ message: { role: 'assistant', content: t }, finish_reason: 'stop' }] } });
const TENSE = { state: 'elevated', say: true, directive: 'slow down and check in', confidence: 0.8 };

test('Groq companion: correct endpoint, model and auth; keeps history', async () => {
  const f = fakeFetch((b, n) => textReply(`reply ${n}`));
  const c = createCompanion({ fetchFn: f, env: ENV, log: () => {} });
  assert.strictEqual((await c.reply({ message: 'hi', ctx: null })).reply, 'reply 1');
  await c.reply({ message: 'second', ctx: null });
  const call = f.calls[1];
  assert.strictEqual(call.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.strictEqual(call.headers.authorization, 'Bearer test-key');
  assert.strictEqual(call.body.model, 'openai/gpt-oss-120b');
  assert.deepStrictEqual(call.body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.strictEqual(call.body.messages[2].content, 'reply 1');
});

test('body context goes in a per-turn system note only when shared; the main prompt never changes', async () => {
  const f = fakeFetch(() => textReply('ok'));
  const c = createCompanion({ fetchFn: f, env: ENV, log: () => {} });
  await c.reply({ message: 'a', ctx: null });
  await c.reply({ message: "I'm fine", ctx: TENSE });
  const [first, second] = f.calls.map((x) => x.body.messages);
  assert.deepStrictEqual(first[0], second[0]);
  assert.strictEqual(first.length, 2);
  const last = second[second.length - 1];
  assert.strictEqual(last.role, 'system');
  assert.match(last.content, /elevated/);
  assert.ok(!/\d/.test(last.content));
  assert.strictEqual(bodyNote({ state: 'off' }), null);
  for (const st of ['purpose_not_approved', 'unknown_purpose', 'unavailable']) assert.strictEqual(bodyNote({ state: st }), null);
  assert.match(bodyNote({ state: 'unclear' }), /Say nothing/);
});

test('errors are reported, never replaced by fake replies', async () => {
  const cases = [[401, 'not_connected'], [429, 'rate_limited'], [400, 'bad_request'], [503, 'unavailable']];
  for (const [status, code] of cases) {
    const c = createCompanion({ fetchFn: fakeFetch(() => ({ status, json: { error: { message: 'x' } } })), env: ENV, log: () => {} });
    const r = await c.reply({ message: 'hi', ctx: null });
    assert.strictEqual(r.reply, null);
    assert.strictEqual(r.error, code, `HTTP ${status}`);
  }
  const offline = createCompanion({ fetchFn: async () => { throw new TypeError('fetch failed'); }, env: ENV, log: () => {} });
  assert.strictEqual((await offline.reply({ message: 'hi', ctx: null })).error, 'offline');
});

test('no GROQ_API_KEY → not connected, and no request is made', async () => {
  const f = fakeFetch(() => textReply('x'));
  const c = createCompanion({ fetchFn: f, env: {}, log: () => {} });
  assert.strictEqual(c.status().connected, false);
  const r = await c.reply({ message: 'hi', ctx: null });
  assert.strictEqual(r.error, 'not_connected');
  assert.match(r.errorText, /GROQ_API_KEY/);
  assert.strictEqual(f.calls.length, 0);
});

test('a stray space before "=" in .env still finds the key', () => {
  assert.strictEqual(groqKey({ 'GROQ_API_KEY ': ' abc ' }), 'abc');
  assert.strictEqual(groqKey({ GROQ_API_KEY: '' }), null);
});

test('demo companion stays scripted and offline', async () => {
  const c = createCompanion({ demo: true });
  const r = await c.reply({ message: "I'm fine", ctx: TENSE });
  assert.strictEqual(r.usedBody, true);
  assert.strictEqual(c.status().mode, 'demo');
});

test('real mode is the default; demo only when asked', () => {
  const { adapterKind } = require('../../src/adapter');
  const saved = process.env.ATTUNE_ADAPTER;
  try {
    delete process.env.ATTUNE_ADAPTER;
    assert.strictEqual(adapterKind(), 'smartspectra');
    process.env.ATTUNE_ADAPTER = 'mock';
    assert.strictEqual(adapterKind(), 'mock');
  } finally { process.env.ATTUNE_ADAPTER = saved; }
});

test('connector status reads the Claude Desktop config without exposing other servers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attune-cfg-'));
  const file = path.join(dir, 'claude_desktop_config.json');
  try {
    assert.strictEqual(claudeDesktopStatus(file).status, 'no_config');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x', env: { SECRET: 's3cret' } } } }));
    const none = claudeDesktopStatus(file);
    assert.strictEqual(none.status, 'not_registered');
    assert.ok(!JSON.stringify(none).includes('s3cret'));
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'attune-sense': { command: 'node', args: [SERVER_JS], env: { ATTUNE_CONSENT: 'sensing,presage-ack' } } } }));
    const ok = claudeDesktopStatus(file);
    assert.strictEqual(ok.status, 'registered');
    assert.strictEqual(ok.pointsToThisInstall, true);
    assert.deepStrictEqual(ok.consent, { sensing: true, aiSharing: false, memory: false });
    fs.writeFileSync(file, '{ not json');
    assert.strictEqual(claudeDesktopStatus(file).status, 'unreadable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude registration creates an entry and preserves existing configuration', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attune-cfg-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const existing = path.join(dir, 'existing.json');
  const fresh = path.join(dir, 'Claude', 'new.json');
  const invalid = path.join(dir, 'invalid.json');
  const original = { theme: 'dark', mcpServers: { other: { command: 'other' } } };
  fs.writeFileSync(existing, JSON.stringify(original));
  fs.writeFileSync(invalid, '{ malformed');

  assert.deepStrictEqual(registerClaudeDesktop(fresh), { ok: true });
  assert.deepStrictEqual(registerClaudeDesktop(existing), { ok: true });
  const written = fs.readFileSync(existing, 'utf8');
  const config = JSON.parse(written);
  assert.strictEqual(config.theme, original.theme);
  assert.deepStrictEqual(config.mcpServers.other, original.mcpServers.other);
  assert.deepStrictEqual(config.mcpServers['attune-sense'].args, [SERVER_JS]);
  assert.deepStrictEqual(claudeDesktopStatus(existing).consent, { sensing: true, aiSharing: true, memory: false });

  assert.match(registerClaudeDesktop(existing).error, /already has an Attune entry/);
  assert.strictEqual(fs.readFileSync(existing, 'utf8'), written);
  assert.match(registerClaudeDesktop(invalid).error, /could not be read/);
  assert.strictEqual(fs.readFileSync(invalid, 'utf8'), '{ malformed');
});

test('real mode removes demo-seeded history', () => {
  const { tempMemory } = require('../helpers');
  const mem = tempMemory();
  try {
    mem.memory.seedDemo();
    assert.ok(Object.keys(mem.memory.calendar()).length > 0);
    assert.ok(mem.memory.dropDemo() > 0);
    assert.strictEqual(Object.keys(mem.memory.calendar()).length, 0);
  } finally { mem.cleanup(); }
});
