'use strict';
/*
 * Builds the one-click Claude Desktop extension: dist/attune.mcpb (an MCP Bundle, a zip with manifest.json).
 *
 *   1. src/server.js (the single source of truth) is copied to extension/server/index.js (a build artifact, gitignored).
 *   2. extension/ is staged in dist/extension/ and ONLY its production dependencies (@modelcontextprotocol/sdk, zod)
 *      are installed there from extension/package-lock.json — nothing from the repo root (no SmartSpectra, koffi, …).
 *   3. The mcpb CLI (a devDependency of extension/, installed in extension/node_modules) validates and packs it.
 *   4. The bundle's file list is checked: forbidden packages or unexpected files fail the build.
 *
 * Run: npm run build:extension
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXT = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, 'extension');
const OUT = path.join(DIST, 'attune.mcpb');
const MCPB_CLI = path.join(EXT, 'node_modules', '@anthropic-ai', 'mcpb', 'dist', 'cli', 'cli.js');
// Copied into the staging folder; everything else in extension/ (icon.svg, node_modules, …) stays out.
const STAGED = ['manifest.json', 'icon.png', 'package.json', 'package-lock.json', '.mcpbignore', path.join('server', 'index.js')];
// Top-level files allowed in the bundle besides node_modules/.
const ALLOWED_FILES = new Set(['manifest.json', 'icon.png', 'package.json', 'server/index.js']);
// Never in the bundle: the root's sensing stack, UI libraries, secrets and sources other than the connector.
const FORBIDDEN = [/(^|\/)node_modules\/@smartspectra\//, /(^|\/)node_modules\/koffi\//, /(^|\/)node_modules\/protobufjs\//,
  /(^|\/)node_modules\/(lucide-static|simple-icons|overlayscrollbars)\//, /(^|\/)node_modules\/@anthropic-ai\//,
  /(^|\/)\.env/, /\.attune-/, /^src\//, /^web\//, /^tests?\//];

/** File names inside a zip, read from its central directory (no extraction). */
function listZipEntries(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${path.basename(file)} is not a zip file`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/'));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

/** Production packages in extension/package-lock.json, as "node_modules/…" prefixes. */
function productionPackages(lockFile = path.join(EXT, 'package-lock.json')) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  return Object.entries(lock.packages || {}).filter(([k, v]) => k && !v.dev).map(([k]) => k);
}

/** Problems with a bundle's file list (empty when it is fine). */
function checkBundleEntries(entries, prodPackages = productionPackages()) {
  const problems = [];
  const files = entries.filter((e) => !e.endsWith('/'));
  for (const f of ['manifest.json', 'server/index.js', 'icon.png']) if (!files.includes(f)) problems.push(`missing ${f}`);
  for (const f of files) {
    if (FORBIDDEN.some((re) => re.test(f))) { problems.push(`forbidden: ${f}`); continue; }
    if (f.startsWith('node_modules/')) {
      // The deepest lockfile package that contains this file must be a production dependency.
      const owner = prodPackages.filter((pkg) => f.startsWith(pkg + '/')).sort((a, b) => b.length - a.length)[0];
      if (!owner) problems.push(`not a production dependency: ${f}`);
    } else if (!ALLOWED_FILES.has(f)) problems.push(`unexpected file: ${f}`);
  }
  return problems;
}

function run(cmd, args, opts = {}) {
  // npm is npm.cmd on Windows and needs a shell there; the arguments are fixed strings, joined into one command.
  const shell = process.platform === 'win32' && cmd === 'npm';
  const r = shell ? spawnSync([cmd, ...args].join(' '), { stdio: 'inherit', timeout: 300000, shell: true, ...opts })
    : spawnSync(cmd, args, { stdio: 'inherit', timeout: 300000, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.error ? r.error.message : `exit ${r.status}`})`);
}

function build({ log = (m) => process.stdout.write(m + '\n') } = {}) {
  const rootVersion = require(path.join(ROOT, 'package.json')).version;
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  const extPkg = JSON.parse(fs.readFileSync(path.join(EXT, 'package.json'), 'utf8'));
  if (manifest.version !== rootVersion || extPkg.version !== rootVersion) {
    throw new Error(`version mismatch: package.json ${rootVersion}, extension/manifest.json ${manifest.version}, extension/package.json ${extPkg.version}`);
  }

  log('1/4 copy src/server.js → extension/server/index.js');
  fs.mkdirSync(path.join(EXT, 'server'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'src', 'server.js'), path.join(EXT, 'server', 'index.js'));

  if (!fs.existsSync(MCPB_CLI)) { log('    installing the mcpb CLI in extension/'); run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: EXT }); }

  log('2/4 stage extension/ in dist/extension and install production dependencies only');
  fs.rmSync(STAGE, { recursive: true, force: true });
  for (const f of STAGED) {
    fs.mkdirSync(path.dirname(path.join(STAGE, f)), { recursive: true });
    fs.copyFileSync(path.join(EXT, f), path.join(STAGE, f));
  }
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline'], { cwd: STAGE });

  log('3/4 mcpb validate + pack');
  run(process.execPath, [MCPB_CLI, 'validate', path.join(STAGE, 'manifest.json')]);
  fs.rmSync(OUT, { force: true });
  run(process.execPath, [MCPB_CLI, 'pack', STAGE, OUT]);

  log('4/4 check the bundle contents');
  const entries = listZipEntries(OUT);
  const problems = checkBundleEntries(entries);
  if (problems.length) throw new Error(`bundle check failed:\n  ${problems.slice(0, 20).join('\n  ')}`);
  const size = fs.statSync(OUT).size;
  log(`dist/attune.mcpb: ${(size / 1024).toFixed(0)} KB, ${entries.filter((e) => !e.endsWith('/')).length} files — OK`);
  return { file: OUT, size, entries };
}

if (require.main === module) {
  try { build(); } catch (e) { process.stderr.write(`[build:extension] ${e.message}\n`); process.exit(1); }
}

module.exports = { build, listZipEntries, checkBundleEntries, productionPackages, FORBIDDEN, OUT, EXT };
