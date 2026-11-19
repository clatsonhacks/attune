'use strict';
/* App approvals store: validation, atomic writes, backward-compatible default lens, pending requests. */
require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAppApprovals, defaultAppsFile, slugAppId, MAX_PENDING } = require('../../src/privacy/appApprovals');
const { register } = require('../../src/lenses');

// Throwaway lens so tests do not depend on lenses built elsewhere.
register({ id: 'test-apps-lens', name: 'Test lens', description: 'Only for tests.', render: () => ({ state: 'neutral', say: false, directive: null, confidence: 1 }) });

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attune-apps-'));
  const file = path.join(dir, 'apps.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { store: createAppApprovals(file), file, dir };
}

test('an app with no entry may use only the default companion lens', (t) => {
  const { store } = tempStore(t);
  assert.strictEqual(store.hasEntry('claude-desktop'), false);
  assert.strictEqual(store.isApproved('claude-desktop', 'companion'), true);
  assert.strictEqual(store.isApproved('claude-desktop', 'test-apps-lens'), false);
  assert.strictEqual(store.isApproved('claude-desktop', 'nope'), false);
  assert.deepStrictEqual(store.list(), []);
});

test('setLens creates an entry that keeps the default lens, and deny removes it', (t) => {
  const { store, file } = tempStore(t);
  const a = store.setLens('chatgpt', 'test-apps-lens', true, { name: 'ChatGPT' });
  assert.deepStrictEqual(a.lenses.sort(), ['companion', 'test-apps-lens']);
  assert.strictEqual(a.name, 'ChatGPT');
  assert.strictEqual(store.isApproved('chatgpt', 'test-apps-lens'), true);
  store.setLens('chatgpt', 'companion', false);
  assert.strictEqual(store.isApproved('chatgpt', 'companion'), false); // explicit entry: no implicit default
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(disk.version, 1);
  assert.deepStrictEqual(disk.apps.chatgpt.lenses, ['test-apps-lens']);
  assert.ok(disk.apps.chatgpt.createdAt && disk.apps.chatgpt.updatedAt);
  assert.strictEqual(store.remove('chatgpt'), true);
  assert.strictEqual(store.hasEntry('chatgpt'), false);
});

test('invalid app ids and unknown lenses are rejected', (t) => {
  const { store, file } = tempStore(t);
  for (const bad of ['', 'Claude', '-x', 'a b', 'a'.repeat(41), '../x', null, 7]) {
    assert.throws(() => store.setLens(bad, 'companion', true), /invalid app id/);
    assert.throws(() => store.recordRequest(bad, 'companion'), /invalid app id/);
  }
  for (const bad of ['', 'nope', 'COMPANION', null, 3]) {
    assert.throws(() => store.setLens('app', bad, true), /unknown lens/);
    assert.throws(() => store.recordRequest('app', bad), /unknown lens/);
  }
  assert.ok(!fs.existsSync(file));
});

test('writes are atomic: no temp files left behind, other instances see changes immediately', (t) => {
  const { store, file, dir } = tempStore(t);
  const other = createAppApprovals(file); // e.g. the connector process
  assert.strictEqual(other.isApproved('app', 'test-apps-lens'), false);
  store.setLens('app', 'test-apps-lens', true);
  assert.strictEqual(other.isApproved('app', 'test-apps-lens'), true);
  store.setLens('app', 'test-apps-lens', false);
  assert.strictEqual(other.isApproved('app', 'test-apps-lens'), false);
  assert.deepStrictEqual(fs.readdirSync(dir), ['apps.json']);
});

test('corrupt or tampered files are not trusted', (t) => {
  const { store, file } = tempStore(t);
  fs.writeFileSync(file, '{not json');
  assert.deepStrictEqual(store.list(), []);
  assert.strictEqual(store.isApproved('app', 'companion'), true); // as if no entry
  fs.writeFileSync(file, JSON.stringify({ version: 1, apps: { 'BAD ID': { lenses: ['companion'] }, ok: { lenses: ['companion', 'made-up'] } }, pending: [{ app: 'ok', lens: 'made-up', at: 'x' }] }));
  assert.deepStrictEqual(store.list().map((a) => [a.id, a.lenses]), [['ok', ['companion']]]);
  assert.deepStrictEqual(store.pending(), []);
  fs.writeFileSync(file, JSON.stringify({ version: 99, apps: { ok: { lenses: [] } } }));
  assert.strictEqual(store.hasEntry('ok'), false);
});

test('pending requests are de-duplicated, capped and cleared by a decision', (t) => {
  const { store } = tempStore(t);
  store.recordRequest('app', 'test-apps-lens');
  store.recordRequest('app', 'test-apps-lens');
  store.recordRequest('other', 'test-apps-lens');
  assert.deepStrictEqual(store.pending().map((p) => p.app), ['app', 'other']);
  store.setLens('app', 'test-apps-lens', true);
  assert.deepStrictEqual(store.pending().map((p) => p.app), ['other']);
  store.setLens('other', 'test-apps-lens', false); // denying clears it too
  assert.deepStrictEqual(store.pending(), []);

  for (let i = 0; i < MAX_PENDING + 5; i++) store.recordRequest(`app-${i}`, 'test-apps-lens');
  const p = store.pending();
  assert.strictEqual(p.length, MAX_PENDING);
  assert.strictEqual(p[p.length - 1].app, `app-${MAX_PENDING + 4}`); // oldest dropped
  store.clearPending(`app-${MAX_PENDING + 4}`);
  assert.strictEqual(store.pending().length, MAX_PENDING - 1);
  store.remove('app-10');
  assert.ok(!store.pending().some((x) => x.app === 'app-10'));
});

test('default file is absolute at the repo root; env override; client names become safe ids', () => {
  const root = path.join(__dirname, '..', '..');
  assert.strictEqual(defaultAppsFile(false, {}), path.join(root, '.attune-apps.json'));
  assert.strictEqual(defaultAppsFile(true, {}), path.join(root, '.attune-demo-apps.json'));
  assert.ok(path.isAbsolute(defaultAppsFile(false, { ATTUNE_APPS_FILE: 'x.json' })));
  assert.strictEqual(slugAppId('Claude Desktop'), 'claude-desktop');
  assert.strictEqual(slugAppId('  --My_App 2!! '), 'my-app-2');
  assert.strictEqual(slugAppId('***'), null);
  assert.strictEqual(slugAppId('x'.repeat(80)).length, 40);
});
