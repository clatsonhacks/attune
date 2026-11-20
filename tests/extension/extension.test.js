'use strict';
/*
 * The Claude Desktop extension (extension/ → dist/attune.mcpb): manifest validity, and that the built bundle holds only
 * the connector and its own production dependencies. Build it with `npm run build:extension`; the bundle checks are
 * skipped (with a message) when dist/attune.mcpb has not been built.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { listZipEntries, checkBundleEntries, productionPackages, OUT, EXT } = require('../../scripts/build-extension');

const ROOT = path.join(__dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const rootPkg = require(path.join(ROOT, 'package.json'));
const extPkg = require(path.join(EXT, 'package.json'));

test('manifest: required MCPB fields, version from package.json, node entry point with the claude-desktop app id', () => {
  for (const k of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) assert.ok(manifest[k], k);
  assert.strictEqual(manifest.manifest_version, '0.3');
  assert.strictEqual(manifest.name, 'attune-sense');
  assert.strictEqual(manifest.display_name, 'Attune');
  assert.strictEqual(manifest.version, rootPkg.version);
  assert.strictEqual(extPkg.version, rootPkg.version);
  assert.deepStrictEqual(manifest.author, { name: 'Attune' });
  assert.strictEqual(manifest.server.type, 'node');
  assert.strictEqual(manifest.server.entry_point, 'server/index.js');
  assert.strictEqual(manifest.server.mcp_config.command, 'node');
  assert.deepStrictEqual(manifest.server.mcp_config.args, ['${__dirname}/server/index.js']);
  assert.strictEqual(manifest.server.mcp_config.env.ATTUNE_APP_ID, 'claude-desktop');
  // The optional data folder is substituted from user_config and may arrive empty or unsubstituted (see connector tests).
  assert.strictEqual(manifest.server.mcp_config.env.ATTUNE_DATA_DIR, '${user_config.data_dir}');
  assert.strictEqual(manifest.user_config.data_dir.type, 'directory');
  assert.strictEqual(manifest.user_config.data_dir.required, false);
  assert.deepStrictEqual(manifest.compatibility.platforms.slice().sort(), ['darwin', 'win32']);
  assert.strictEqual(manifest.compatibility.runtimes.node, '>=20.0.0');
  assert.ok(fs.existsSync(path.join(EXT, manifest.icon)), 'icon exists');
  const png = fs.readFileSync(path.join(EXT, manifest.icon));
  assert.strictEqual(png.toString('latin1', 1, 4), 'PNG');
  assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [512, 512]);
});

test('manifest tools match the tools the connector registers', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  const registered = [...src.matchAll(/registerTool\('([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(manifest.tools.map((t) => t.name).sort(), registered);
  for (const t of manifest.tools) assert.ok(t.description && t.description.length > 10, t.name);
});

test('extension package: only the connector dependencies, pinned exactly as in the root', () => {
  assert.strictEqual(extPkg.private, true);
  assert.deepStrictEqual(Object.keys(extPkg.dependencies).sort(), ['@modelcontextprotocol/sdk', 'zod']);
  for (const [k, v] of Object.entries(extPkg.dependencies)) assert.strictEqual(v, rootPkg.dependencies[k], k);
  assert.match(extPkg.devDependencies['@anthropic-ai/mcpb'], /^\d+\.\d+\.\d+$/);
  const prod = productionPackages();
  assert.ok(prod.includes('node_modules/zod') && prod.includes('node_modules/@modelcontextprotocol/sdk'));
  assert.ok(!prod.some((p) => /smartspectra|koffi|protobufjs|@anthropic-ai\/mcpb/.test(p)), prod.join());
});

test('bundle check: rejects root packages, mcpb itself, sources and stray files', () => {
  const prod = ['node_modules/zod', 'node_modules/@modelcontextprotocol/sdk'];
  const good = ['manifest.json', 'icon.png', 'package.json', 'server/index.js', 'node_modules/zod/package.json', 'node_modules/@modelcontextprotocol/sdk/dist/cjs/x.js'];
  assert.deepStrictEqual(checkBundleEntries(good, prod), []);
  for (const bad of ['node_modules/@smartspectra/node-sdk/index.js', 'node_modules/koffi/index.js', 'node_modules/protobufjs/index.js',
    'node_modules/@anthropic-ai/mcpb/dist/cli.js', 'node_modules/express/index.js', 'src/webServer.js', '.env', 'icon.svg']) {
    assert.strictEqual(checkBundleEntries([...good, bad], prod).length, 1, bad);
  }
  assert.deepStrictEqual(checkBundleEntries(['manifest.json'], prod), ['missing server/index.js', 'missing icon.png']);
});

test('built bundle (dist/attune.mcpb): connector + production dependencies only, small', (t) => {
  if (!fs.existsSync(OUT)) { t.skip('dist/attune.mcpb not built — run `npm run build:extension` to check the bundle'); return; }
  const entries = listZipEntries(OUT);
  assert.deepStrictEqual(checkBundleEntries(entries), []);
  assert.ok(!entries.some((e) => /smartspectra|koffi|protobufjs/i.test(e)));
  const inside = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  assert.strictEqual(inside.version, rootPkg.version);
  assert.ok(fs.existsSync(path.join(EXT, 'server', 'index.js')), 'entry point exists after the build');
  if (fs.readFileSync(path.join(EXT, 'server', 'index.js'), 'utf8') !== fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8')) {
    t.diagnostic('src/server.js changed since the last build — run `npm run build:extension` again');
  }
  assert.ok(fs.statSync(OUT).size < 8 * 1024 * 1024, 'bundle under 8 MB');
});
