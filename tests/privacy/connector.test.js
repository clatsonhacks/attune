'use strict';
/*
 * The thin stdio connector against a real Attune service: a createApp on a random high port with a temp data folder,
 * and the connector process (src/server.js) driven by an MCP client. The connector never opens the camera itself.
 */
const { fakeAdapterFactory, SAMPLE, tempMemory, tempConsentStore, tempApps } = require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createApp } = require('../../src/webServer');
const { listLenses } = require('../../src/lenses');
const paths = require('../../src/paths');
const connector = require('../../src/server');

const SERVER_JS = path.join(__dirname, '..', '..', 'src', 'server.js');
const ALLOW = { sensing: true, presageAck: true, aiSharing: true };

function tempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attune-conn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function uiRequest(port, token, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method: body ? 'POST' : 'GET', path: route,
      headers: { host: `localhost:${port}`, 'x-attune-token': token, ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b || '{}')));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

/** A running Attune service announcing itself in `dataDir` (the real, non-demo location). */
async function startService(t, dataDir) {
  const port = 30000 + Math.floor(Math.random() * 20000);
  const { factory, calls } = fakeAdapterFactory();
  const mem = tempMemory();
  const cs = tempConsentStore();
  const apps = tempApps();
  const app = createApp({ port, adapterFactory: factory, memory: mem.memory, consentStore: cs.store, log: () => {},
    approvals: apps.approvals, activity: apps.activity, serviceFile: path.join(dataDir, 'service.json'), reply: async () => ({ reply: 'ok' }) });
  await new Promise((r) => app.server.listen(port, '127.0.0.1', r));
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); mem.cleanup(); cs.cleanup(); apps.cleanup(); });
  return { app, port, calls, apps, mem, close, ui: (route, body) => uiRequest(port, app.guard.token, route, body) };
}

async function stdio(t, dataDir, { args = [], env = {}, clientName = 'attune-test' } = {}) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const childEnv = { ...process.env, ATTUNE_DATA_DIR: dataDir, ATTUNE_APP_ID: undefined, ...env };
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_JS, ...args], env: childEnv, cwd: os.tmpdir(), stderr: 'ignore' });
  const client = new Client({ name: clientName, version: '0.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const call = async (name, a = {}) => JSON.parse((await client.callTool({ name, arguments: a })).content[0].text);
  const tools = async () => (await client.listTools()).tools;
  return { client, call, tools };
}

test('the connector is self-contained: no sensing, camera, SDK or consent modules', () => {
  const src = fs.readFileSync(SERVER_JS, 'utf8');
  const requires = [...src.matchAll(/(?:require|import)\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(requires, ['@modelcontextprotocol/sdk/server/mcp.js', '@modelcontextprotocol/sdk/server/stdio.js', 'fs', 'os', 'path', 'zod']);
  assert.ok(!/ATTUNE_CONSENT|ATTUNE_CHATGPT_CONSENT|smartspectra|loadEnvFile/i.test(src));
});

test('connector data folder matches the service (paths.dataDir) on every OS', () => {
  const cases = [
    { platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u' },
    { platform: 'win32', env: {}, home: 'C:\\Users\\u' },
    { platform: 'darwin', env: {}, home: '/Users/u' },
    { platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/u' },
    { platform: 'linux', env: {}, home: '/home/u' },
    { platform: 'linux', env: { ATTUNE_DATA_DIR: path.join(os.tmpdir(), 'x') }, home: '/home/u' },
  ];
  for (const c of cases) for (const demo of [false, true]) assert.strictEqual(connector.dataDir({ ...c, demo }), paths.dataDir({ ...c, demo }), JSON.stringify(c));
  const env = { ATTUNE_DATA_DIR: path.join(os.tmpdir(), 'x') };
  assert.deepStrictEqual(connector.serviceFiles({ env }), [path.join(env.ATTUNE_DATA_DIR, 'service.json'), path.join(env.ATTUNE_DATA_DIR, 'demo', 'service.json')]);
  assert.deepStrictEqual(connector.serviceFiles({ env, demoOnly: true }), [path.join(env.ATTUNE_DATA_DIR, 'demo', 'service.json')]);
});

test('an empty or unsubstituted ATTUNE_DATA_DIR (extension setting left blank) counts as unset', () => {
  const win = { platform: 'win32', home: 'C:\\Users\\u' };
  const expected = 'C:\\Users\\u\\AppData\\Roaming\\Attune';
  for (const v of ['', '   ', '${user_config.data_dir}', ' ${user_config.data_dir} ', '${HOME}/x']) {
    assert.strictEqual(connector.customDataDir({ ATTUNE_DATA_DIR: v }), null, JSON.stringify(v));
    for (const demo of [false, true]) {
      const env = { ATTUNE_DATA_DIR: v };
      assert.strictEqual(connector.dataDir({ ...win, env, demo }), demo ? `${expected}\\demo` : expected, JSON.stringify(v));
      assert.strictEqual(paths.dataDir({ ...win, env, demo }), connector.dataDir({ ...win, env, demo }), JSON.stringify(v));
    }
  }
  const real = path.join(os.tmpdir(), 'attune-x');
  assert.strictEqual(connector.customDataDir({ ATTUNE_DATA_DIR: real }), real);
  assert.strictEqual(connector.dataDir({ env: { ATTUNE_DATA_DIR: ` ${real} ` } }), path.resolve(real));
  assert.strictEqual(paths.customDataDir({ ATTUNE_DATA_DIR: '${user_config.data_dir}' }), null);
});

test('the connector process with an unsubstituted ATTUNE_DATA_DIR uses the default folder, not a "${…}" folder', async (t) => {
  // Point the default folder at a temp dir (APPDATA / HOME / XDG) so nothing touches the real per-user folder.
  const home = tempDataDir(t);
  const env = { ATTUNE_DATA_DIR: '${user_config.data_dir}', APPDATA: home, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home };
  const defaultDir = connector.dataDir({ env: { APPDATA: home, XDG_CONFIG_HOME: home }, home });
  fs.mkdirSync(defaultDir, { recursive: true });
  await startService(t, defaultDir);
  const { call } = await stdio(t, home, { env, clientName: 'Claude Desktop' });
  const status = await call('get_attune_status');
  assert.strictEqual(status.attune, 'running', JSON.stringify(status));
  assert.strictEqual(status.app, 'claude-desktop');
});

test('service not running (or a stale/garbled service.json) → attune_not_running from every tool, no crash', async (t) => {
  const dataDir = tempDataDir(t);
  const { call, tools } = await stdio(t, dataDir);
  const names = (await tools()).map((x) => x.name).sort();
  assert.deepStrictEqual(names, ['get_attune_status', 'get_body_context', 'list_purposes', 'memory_append', 'memory_get', 'record_correction']);
  assert.ok(!names.some((n) => /consent|approv|allow|grant|permi|forget/.test(n)), names.join());
  const expected = { state: 'attune_not_running', say: false, howToEnable: 'Open Attune and try again.' };
  for (const [name, a] of [['get_attune_status'], ['list_purposes'], ['get_body_context', { purpose: 'yoga' }],
    ['record_correction', { wasAccurate: false }], ['memory_get'], ['memory_append', { note: 'x' }]]) {
    assert.deepStrictEqual(await call(name, a), expected, name);
  }
  fs.writeFileSync(path.join(dataDir, 'service.json'), '{ not json');
  assert.deepStrictEqual(await call('get_body_context'), expected);
  // A file left by a crashed run: nothing listens on that port.
  fs.writeFileSync(path.join(dataDir, 'service.json'), JSON.stringify({ version: 1, port: 1, token: 'a'.repeat(64), pid: 1, startedAt: 'x' }));
  assert.deepStrictEqual(await call('get_attune_status'), expected);
});

test('a token that does not match the running service → attune_not_running (never another answer)', async (t) => {
  const dataDir = tempDataDir(t);
  const svc = await startService(t, dataDir);
  const file = path.join(dataDir, 'service.json');
  const info = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...info, token: 'b'.repeat(64) }));
  const { call } = await stdio(t, dataDir);
  assert.strictEqual((await call('get_attune_status')).state, 'attune_not_running');
  fs.writeFileSync(file, JSON.stringify(info));
  assert.strictEqual((await call('get_attune_status')).attune, 'running'); // re-read on every call
  await svc.close();
});

test('consent lives in the service: missing → consent_required, and the camera stays off', async (t) => {
  const dataDir = tempDataDir(t);
  const { calls } = await startService(t, dataDir);
  const { call } = await stdio(t, dataDir, { env: { ATTUNE_APP_ID: 'stdio-app', ATTUNE_CONSENT: 'sensing,presage-ack,ai-sharing' } });
  const st = await call('get_attune_status');
  assert.strictEqual(st.attune, 'running');
  assert.strictEqual(st.sensingAllowed, false);
  assert.strictEqual(st.app, 'stdio-app');
  const ctx = await call('get_body_context');
  assert.strictEqual(ctx.state, 'consent_required');
  assert.match(ctx.howToEnable, /Open Attune/);
  assert.strictEqual(calls.created, 0); // the old env consent is ignored
  assert.strictEqual((await call('memory_get')).memory, 'disabled');
});

test('approved: the service starts the camera; the connector gets number-free context; activity is logged', async (t) => {
  const dataDir = tempDataDir(t);
  const svc = await startService(t, dataDir);
  await svc.ui('/api/consent', ALLOW);
  await svc.ui('/api/sensing', { action: 'pause' });
  const { call } = await stdio(t, dataDir, { env: { ATTUNE_APP_ID: 'stdio-app' } });
  assert.strictEqual((await call('get_body_context')).state, 'paused');
  assert.strictEqual(svc.calls.started, 1);
  await svc.ui('/api/sensing', { action: 'resume' });
  await svc.app.sensing.release('idle'); // camera off again (idle), permission kept
  await svc.app.sensing.settled();
  const first = await call('get_body_context', {});
  assert.strictEqual(first.state, 'starting');
  assert.strictEqual(svc.calls.started, 3); // turned on by the service because the app asked
  assert.strictEqual((await svc.ui('/api/state')).sensing.lastTrigger, 'ai_requested');
  svc.calls.callbacks[2](SAMPLE);
  const ctx = await call('get_body_context', { purpose: 'companion' });
  assert.deepStrictEqual(Object.keys(ctx).sort(), ['confidence', 'directive', 'lens', 'say', 'state', 'suggestedUtterance']);
  assert.ok(!/\d{2,}/.test(JSON.stringify({ ...ctx, confidence: 0 })));
  assert.notStrictEqual((await call('record_correction', { wasAccurate: false })).ok, false);
  const events = svc.apps.activity.recent(10);
  assert.deepStrictEqual(events.map((e) => [e.app, e.lens, e.kind]).slice(0, 3),
    [['stdio-app', 'companion', 'context'], ['stdio-app', 'companion', 'context'], ['stdio-app', 'companion', 'context']]);
  assert.ok(!fs.readFileSync(svc.apps.activityFile, 'utf8').includes('directive'));
  const apps = await svc.ui('/api/apps');
  assert.ok(apps.lastSeen['stdio-app']);
});

test('unapproved and unknown purposes: request + activity in the service; approvals apply live', async (t) => {
  const dataDir = tempDataDir(t);
  const svc = await startService(t, dataDir);
  await svc.ui('/api/consent', ALLOW);
  const { call, tools } = await stdio(t, dataDir, { clientName: 'My Test Client' });
  const ctxTool = (await tools()).find((x) => x.name === 'get_body_context');
  assert.ok(ctxTool.inputSchema.properties.purpose);
  assert.match(ctxTool.description, /cannot approve/);
  for (const l of listLenses().filter((x) => ['companion', 'yoga', 'casual'].includes(x.id))) {
    assert.ok(ctxTool.inputSchema.properties.purpose.description.includes(`"${l.id}" (${l.name})`), l.id);
  }

  const list = await call('list_purposes');
  assert.strictEqual(list.app, 'my-test-client'); // named after the MCP client
  assert.strictEqual(list.purposes.find((p) => p.id === 'companion').approved, true);
  assert.strictEqual(list.purposes.find((p) => p.id === 'yoga').approved, false);

  assert.strictEqual((await call('get_body_context', { purpose: 'mind-reading' })).state, 'unknown_purpose');
  const denied = await call('get_body_context', { purpose: 'yoga' });
  assert.deepStrictEqual(denied, { state: 'purpose_not_approved', lens: 'yoga', say: false,
    howToEnable: 'Open Attune → Connectors and allow My Test Client to use Yoga & breathwork.' });
  assert.deepStrictEqual(svc.apps.approvals.pending().map((p) => [p.app, p.lens]), [['my-test-client', 'yoga']]);
  assert.deepStrictEqual(svc.apps.activity.recent(2).map((e) => [e.kind, e.state]),
    [['request', 'purpose_not_approved'], ['unknown', 'unknown_purpose']]);

  await svc.ui('/api/apps/lens', { app: 'my-test-client', lens: 'yoga', allow: true }); // the person allows it
  const ok = await call('get_body_context', { purpose: 'yoga' });
  assert.strictEqual(ok.lens, 'yoga');
  assert.strictEqual((await call('list_purposes')).purposes.find((p) => p.id === 'yoga').approved, true);
});

test('ChatGPT profile: three tools, strict approvals (companion needs an explicit entry), default id chatgpt', async (t) => {
  const dataDir = tempDataDir(t);
  const svc = await startService(t, dataDir);
  await svc.ui('/api/consent', ALLOW);
  const { call, tools } = await stdio(t, dataDir, { args: ['--chatgpt'], clientName: 'openai-mcp' });
  assert.deepStrictEqual((await tools()).map((x) => x.name).sort(), ['get_attune_status', 'get_body_context', 'list_purposes']);
  const st = await call('get_attune_status');
  assert.strictEqual(st.app, 'openai-mcp');
  assert.deepStrictEqual(st.approvedPurposes, []);
  const r = await call('get_body_context');
  assert.strictEqual(r.state, 'purpose_not_approved');
  assert.deepStrictEqual(svc.apps.approvals.pending().map((p) => [p.app, p.lens]), [['openai-mcp', 'companion']]);
  assert.strictEqual(svc.calls.started, 1); // started by the consent grant only, never by the refused call

  const { call: call2 } = await stdio(t, dataDir, { args: ['--chatgpt'], clientName: '***' });
  assert.strictEqual((await call2('list_purposes')).app, 'chatgpt');
  await svc.ui('/api/apps/lens', { app: 'chatgpt', lens: 'companion', allow: true });
  assert.strictEqual((await call2('get_body_context')).lens, 'companion');
});

test('a service started after the connector is found; one that stops is reported as not running', async (t) => {
  const dataDir = tempDataDir(t);
  const { call } = await stdio(t, dataDir, { env: { ATTUNE_APP_ID: 'late-app' } });
  assert.strictEqual((await call('get_attune_status')).state, 'attune_not_running');
  const svc = await startService(t, dataDir);
  assert.strictEqual((await call('get_attune_status')).attune, 'running');
  await svc.close();
  assert.ok(!fs.existsSync(path.join(dataDir, 'service.json')));
  assert.strictEqual((await call('get_attune_status')).state, 'attune_not_running');
});

test('connector core: a demo service is tried after the real one; --demo uses only the demo folder', async (t) => {
  const dataDir = tempDataDir(t);
  fs.mkdirSync(path.join(dataDir, 'demo'));
  const seen = [];
  const fetchFn = async (url) => { seen.push(url); return { status: 200, json: async () => ({ attune: 'running', url }) }; };
  fs.writeFileSync(path.join(dataDir, 'demo', 'service.json'), JSON.stringify({ version: 1, port: 4321, token: 'c'.repeat(64) }));
  const core = connector.createConnector({ env: { ATTUNE_DATA_DIR: dataDir }, fetchFn });
  assert.match((await core.status()).url, /^http:\/\/127\.0\.0\.1:4321\/connector\/v1\/status\?app=claude-desktop$/);
  fs.writeFileSync(path.join(dataDir, 'service.json'), JSON.stringify({ version: 1, port: 1234, token: 'd'.repeat(64) }));
  assert.match((await core.status()).url, /:1234\//);
  const demoCore = connector.createConnector({ env: { ATTUNE_DATA_DIR: dataDir }, fetchFn, demoOnly: true, chatgpt: true });
  assert.match((await demoCore.status()).url, /:4321\/connector\/v1\/status\?app=chatgpt&strict=1$/);
  assert.ok(seen.every((u) => u.startsWith('http://127.0.0.1:')));
});
