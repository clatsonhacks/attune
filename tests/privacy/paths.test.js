'use strict';
/* Per-user data folder: OS defaults, demo subfolder, store files, one-time legacy migration (copy, never delete). */
require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { dataDir, storeFile, migrateLegacy, writeFileAtomic, FILES } = require('../../src/paths');

function tempDir(t, prefix = 'attune-paths-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('dataDir: OS defaults, ATTUNE_DATA_DIR override and the demo subfolder', () => {
  assert.strictEqual(dataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, home: 'C:\\Users\\u' }),
    'C:\\Users\\u\\AppData\\Roaming\\Attune');
  assert.strictEqual(dataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\u' }), 'C:\\Users\\u\\AppData\\Roaming\\Attune');
  assert.strictEqual(dataDir({ platform: 'darwin', env: {}, home: '/Users/u' }), '/Users/u/Library/Application Support/Attune');
  assert.strictEqual(dataDir({ platform: 'linux', env: {}, home: '/home/u' }), '/home/u/.config/attune');
  assert.strictEqual(dataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, home: '/home/u' }), '/xdg/attune');
  assert.strictEqual(dataDir({ platform: 'linux', env: {}, home: '/home/u', demo: true }), '/home/u/.config/attune/demo');
  assert.strictEqual(dataDir({ platform: 'win32', env: {}, home: 'C:\\Users\\u', demo: true }), 'C:\\Users\\u\\AppData\\Roaming\\Attune\\demo');
  const custom = path.join(os.tmpdir(), 'custom-attune');
  assert.strictEqual(dataDir({ platform: 'linux', env: { ATTUNE_DATA_DIR: custom }, home: '/home/u' }), custom);
  assert.strictEqual(dataDir({ env: { ATTUNE_DATA_DIR: custom }, demo: true }), path.join(custom, 'demo'));
  assert.deepStrictEqual(Object.values(FILES).sort(), ['activity.jsonl', 'apps.json', 'consent.json', 'memory.json', 'service.json']);
});

test('the test suite never points at the real per-user folder', () => {
  assert.ok(process.env.ATTUNE_DATA_DIR && process.env.ATTUNE_DATA_DIR.startsWith(os.tmpdir()));
  assert.strictEqual(dataDir(), path.resolve(process.env.ATTUNE_DATA_DIR));
});

test('storeFile creates the folder on demand and names each file', (t) => {
  const base = path.join(tempDir(t), 'nested', 'Attune');
  const env = { ATTUNE_DATA_DIR: base };
  assert.strictEqual(storeFile('consent', { env }), path.join(base, 'consent.json'));
  assert.ok(fs.statSync(base).isDirectory());
  assert.strictEqual(storeFile('memory', { env, demo: true }), path.join(base, 'demo', 'memory.json'));
  assert.ok(fs.statSync(path.join(base, 'demo')).isDirectory());
  assert.throws(() => storeFile('nope', { env }));
});

test('legacy migration copies a missing file once and never deletes the legacy file', (t) => {
  const legacy = tempDir(t, 'attune-legacy-');
  const data = tempDir(t, 'attune-newdata-');
  fs.writeFileSync(path.join(legacy, '.attune-consent.json'), '{"old":true}');
  fs.writeFileSync(path.join(legacy, '.attune-demo-apps.json'), '{"demo":true}');
  const logs = [];
  const log = (m) => logs.push(m);

  const target = path.join(data, 'consent.json');
  assert.strictEqual(migrateLegacy('consent', { target, legacyDirs: [legacy], log }), path.join(legacy, '.attune-consent.json'));
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"old":true}');
  assert.ok(fs.existsSync(path.join(legacy, '.attune-consent.json')), 'legacy file kept');
  assert.strictEqual(logs.length, 1);

  // Already there: never overwritten, nothing logged.
  fs.writeFileSync(target, '{"new":true}');
  assert.strictEqual(migrateLegacy('consent', { target, legacyDirs: [legacy], log }), null);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '{"new":true}');
  assert.strictEqual(logs.length, 1);

  // Demo variants map to the demo names; a missing legacy file is a no-op.
  const demoTarget = path.join(data, 'demo', 'apps.json');
  assert.ok(migrateLegacy('apps', { demo: true, target: demoTarget, legacyDirs: [legacy], log }));
  assert.strictEqual(fs.readFileSync(demoTarget, 'utf8'), '{"demo":true}');
  assert.strictEqual(migrateLegacy('memory', { target: path.join(data, 'memory.json'), legacyDirs: [legacy], log }), null);
  assert.ok(!fs.existsSync(path.join(data, 'memory.json')));
  assert.strictEqual(migrateLegacy('service', { target: path.join(data, 'service.json'), legacyDirs: [legacy], log }), null);
});

test('storeFile migrates only for the default folder, not for an explicit ATTUNE_DATA_DIR', (t) => {
  const legacy = tempDir(t, 'attune-legacy-');
  const data = tempDir(t, 'attune-newdata-');
  fs.writeFileSync(path.join(legacy, '.attune-activity.jsonl'), 'x\n');
  storeFile('activity', { env: { ATTUNE_DATA_DIR: data }, legacyDirs: [legacy], log: () => {} });
  assert.ok(!fs.existsSync(path.join(data, 'activity.jsonl')));
});

test('writeFileAtomic replaces the whole file and leaves no temp files', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'sub', 'x.json');
  writeFileAtomic(file, 'one');
  writeFileAtomic(file, 'two');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'two');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['x.json']);
});
