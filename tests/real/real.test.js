'use strict';
require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { createCompanion, bodyNote } = require('../../src/companion');
const { claudeDesktopStatus, SERVER_JS } = require('../../src/connectors');

function fakeClient(responder) {
  const calls = [];
  return { calls, beta: { messages: { create: async (req) => { calls.push(JSON.parse(JSON.stringify(req))); return responder(req, calls.length); } } } };
}
const textReply = (t) => ({ model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: t }] });
const TENSE = { state: 'elevated', say: true, directive: 'slow down and check in', confidence: 0.8 };

test('real companion keeps history and replays full assistant content (incl. thinking blocks)', async () => {
  const client = fakeClient((req, n) => textReply(`reply ${n}`));
  const c = createCompanion({ client, log: () => {} });
  assert.strictEqual((await c.reply({ message: 'hi', ctx: null })).reply, 'reply 1');
  await c.reply({ message: 'second', ctx: null });
  const msgs = client.calls[1].messages;
  assert.deepStrictEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.strictEqual(msgs[1].content[0].type, 'thinking');
  assert.strictEqual(client.calls[1].model, 'claude-opus-5-5');
  assert.strictEqual(client.calls[1].fallbacks, 'default');
});

test('body context goes in a per-turn system note only when shared; the system prompt never changes', async () => {
  const client = fakeClient(() => textReply('ok'));
  const c = createCompanion({ client, log: () => {} });
  await c.reply({ message: 'a', ctx: null });
  await c.reply({ message: "I'm fine", ctx: TENSE });
  const [first, second] = client.calls;
  assert.deepStrictEqual(first.system, second.system);
  assert.strictEqual(first.messages.length, 1);
  const last = second.messages[second.messages.length - 1];
  assert.strictEqual(last.role, 'system');
  assert.match(last.content, /elevated/);
  assert.ok(!/\d/.test(last.content));
  assert.strictEqual(bodyNote({ state: 'off' }), null);
  assert.match(bodyNote({ state: 'unclear' }), /Say nothing/);
});

test('refusals are answered gracefully and not stored as history', async () => {
  const client = fakeClient((req, n) => (n === 1 ? { stop_reason: 'refusal', content: [] } : textReply('fine')));
  const c = createCompanion({ client, log: () => {} });
  const r = await c.reply({ message: 'x', ctx: null });
  assert.strictEqual(r.refused, true);
  await c.reply({ message: 'y', ctx: null });
  assert.strictEqual(client.calls[1].messages.length, 1);
});

test('no credentials / offline → an error, never a fake reply', async () => {
  const offline = fakeClient(() => { throw new Anthropic.APIConnectionError({ message: 'down' }); });
  const c1 = createCompanion({ client: offline, log: () => {} });
  const r1 = await c1.reply({ message: 'hi', ctx: null });
  assert.strictEqual(r1.reply, null);
  assert.strictEqual(r1.error, 'offline');

  const noKey = fakeClient(() => { throw new Error('Could not resolve authentication method. Expected the apiKey to be set.'); });
  const c2 = createCompanion({ client: noKey, log: () => {} });
  const r2 = await c2.reply({ message: 'hi', ctx: null });
  assert.strictEqual(r2.error, 'not_connected');
  assert.match(r2.errorText, /ANTHROPIC_API_KEY/);
  assert.strictEqual(c2.status().connected, false);
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

test('real mode removes demo-seeded history; status is honest before the first call', async () => {
  const { tempMemory } = require('../helpers');
  const mem = tempMemory();
  try {
    mem.memory.seedDemo();
    assert.ok(Object.keys(mem.memory.calendar()).length > 0);
    assert.ok(mem.memory.dropDemo() > 0);
    assert.strictEqual(Object.keys(mem.memory.calendar()).length, 0);
  } finally { mem.cleanup(); }
  const saved = { a: process.env.ANTHROPIC_API_KEY, b: process.env.ANTHROPIC_AUTH_TOKEN, c: process.env.ATTUNE_ANTHROPIC_KEY };
  try {
    delete process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_AUTH_TOKEN; process.env.ATTUNE_ANTHROPIC_KEY = '';
    assert.strictEqual(createCompanion({ log: () => {} }).status().connected, false);
  } finally { for (const [k, v] of [['ANTHROPIC_API_KEY', saved.a], ['ANTHROPIC_AUTH_TOKEN', saved.b], ['ATTUNE_ANTHROPIC_KEY', saved.c]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
});
