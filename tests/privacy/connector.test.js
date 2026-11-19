'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { createConnectorCore } = require('../../src/server');
const { fakeAdapterFactory, SAMPLE, tempMemory } = require('../helpers');

function core(t, consentString, extra = {}) {
  const { factory, calls } = fakeAdapterFactory();
  const mem = tempMemory();
  const c = createConnectorCore({ consentString, adapterFactory: factory, memory: mem.memory, log: () => {}, ...extra });
  t.after(async () => { await c.shutdown(); mem.cleanup(); });
  return { c, calls, mem };
}

test('without human consent the connector never starts the sensor', async (t) => {
  const { c, calls } = core(t, '');
  const r = await c.getBodyContext();
  assert.strictEqual(r.state, 'consent_required');
  assert.match(r.howToEnable, /ATTUNE_CONSENT/);
  assert.strictEqual(calls.created, 0);
});

test('sensing consent without ai-sharing still returns nothing to the AI', async (t) => {
  const { c, calls } = core(t, 'sensing,presage-ack');
  assert.strictEqual((await c.getBodyContext()).state, 'consent_required');
  assert.strictEqual(calls.created, 0);
});

test('sensing without presage-ack is not allowed', async (t) => {
  const { c, calls } = core(t, 'sensing,ai-sharing');
  assert.strictEqual((await c.getBodyContext()).state, 'consent_required');
  assert.strictEqual(calls.created, 0);
});

test('with consent: starts lazily on first request, returns number-free context', async (t) => {
  const { c, calls } = core(t, 'sensing,presage-ack,ai-sharing');
  assert.strictEqual(calls.created, 0); // not at boot
  await c.getBodyContext();
  assert.strictEqual(calls.started, 1);
  calls.callbacks[0](SAMPLE);
  const ctx = await c.getBodyContext();
  assert.deepStrictEqual(Object.keys(ctx).sort(), ['confidence', 'directive', 'say', 'state', 'suggestedUtterance']);
  assert.strictEqual(calls.started, 1); // reused, not restarted
});

test('sensor stops after the idle timeout', async (t) => {
  const { c, calls } = core(t, 'sensing,presage-ack,ai-sharing', { idleMs: 50 });
  await c.getBodyContext();
  await new Promise((r) => setTimeout(r, 120));
  await c.sensing.settled();
  assert.strictEqual(calls.stopped, 1);
});

test('memory tools respect the memory scope', async (t) => {
  const { c } = core(t, 'sensing,presage-ack,ai-sharing');
  assert.strictEqual(c.memoryAppend({ note: 'x' }).ok, false);
  assert.strictEqual(c.memoryGet().memory, 'disabled');
});

test('MCP server exposes no AI-callable consent tool', async (t) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const mem = tempMemory();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', '..', 'src', 'server.js')],
    env: { ...process.env, ATTUNE_ADAPTER: 'mock', ATTUNE_CONSENT: '' },
    cwd: path.dirname(mem.file),
    stderr: 'ignore',
  });
  const client = new Client({ name: 'attune-test', version: '0.0.0' });
  await client.connect(transport);
  t.after(async () => { await client.close(); mem.cleanup(); });
  const names = (await client.listTools()).tools.map((x) => x.name).sort();
  assert.ok(!names.includes('grant_consent'));
  assert.deepStrictEqual(names, ['forget_me', 'get_attune_status', 'get_body_context', 'memory_append', 'memory_get', 'record_correction']);
  const res = await client.callTool({ name: 'get_body_context', arguments: {} });
  assert.strictEqual(JSON.parse(res.content[0].text).state, 'consent_required');
});

test('ChatGPT stdio profile exposes status and context and requires separate consent', async (t) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const mem = tempMemory();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, '..', '..', 'src', 'server.js'), '--chatgpt'],
    env: { ...process.env, ATTUNE_ADAPTER: 'mock',
      ATTUNE_CONSENT: 'sensing,presage-ack,ai-sharing,memory', ATTUNE_CHATGPT_CONSENT: '' },
    cwd: path.dirname(mem.file),
    stderr: 'ignore',
  });
  const client = new Client({ name: 'attune-chatgpt-test', version: '0.0.0' });
  t.after(async () => { await client.close(); mem.cleanup(); });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepStrictEqual(tools, ['get_attune_status', 'get_body_context']);
  const result = await client.callTool({ name: 'get_body_context', arguments: {} });
  const context = JSON.parse(result.content[0].text);
  assert.strictEqual(context.state, 'consent_required');
  assert.match(context.howToEnable, /ATTUNE_CHATGPT_CONSENT/);
});
