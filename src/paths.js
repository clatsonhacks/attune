'use strict';
/*
 * Per-user data folder. The Attune service (npm run web, later the desktop app) keeps everything it remembers here:
 *   consent.json · memory.json · apps.json · activity.jsonl · service.json (port + connector token while running)
 *
 * Location: ATTUNE_DATA_DIR if set, else the OS default —
 *   Windows  %APPDATA%\Attune
 *   macOS    ~/Library/Application Support/Attune
 *   Linux    $XDG_CONFIG_HOME/attune (or ~/.config/attune)
 * Demo mode uses a `demo` subfolder so synthetic history never mixes with real data.
 *
 * One-time migration: older builds kept these files at the repo root (.attune-consent.json, …). When a file is missing
 * in the new folder and the legacy file exists, it is COPIED over (the legacy file is never deleted) and logged once.
 * Migration only runs for the default folder: an explicit ATTUNE_DATA_DIR (tests, custom setups) starts clean.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const REPO_ROOT = path.join(__dirname, '..');
const FILES = Object.freeze({ consent: 'consent.json', memory: 'memory.json', apps: 'apps.json', activity: 'activity.jsonl', service: 'service.json' });
// Legacy repo-root names: [real, demo].
const LEGACY = Object.freeze({
  consent: ['.attune-consent.json', '.attune-demo-consent.json'],
  memory: ['.attune-memory.json', '.attune-demo-memory.json'],
  apps: ['.attune-apps.json', '.attune-demo-apps.json'],
  activity: ['.attune-activity.jsonl', '.attune-demo-activity.jsonl'],
});

/** The per-user Attune folder (pure: nothing is created). */
function dataDir({ demo = false, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let base;
  if (env.ATTUNE_DATA_DIR) base = path.resolve(env.ATTUNE_DATA_DIR);
  else if (platform === 'win32') base = p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Attune');
  else if (platform === 'darwin') base = p.join(home, 'Library', 'Application Support', 'Attune');
  else base = p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'attune');
  return demo ? (env.ATTUNE_DATA_DIR ? path : p).join(base, 'demo') : base;
}

/** Create a folder (and parents) readable by this user only where the OS supports it. */
function ensureDir(dir) {
  const existed = fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existed && process.platform !== 'win32') { try { fs.chmodSync(dir, 0o700); } catch {} }
  return dir;
}

const migrated = new Set(); // log each copy once per process

/**
 * Copy a legacy repo-root file into `target` if `target` is missing. Never deletes the legacy file.
 * Returns the copied source path, or null.
 */
function migrateLegacy(kind, { demo = false, target, legacyDirs = [REPO_ROOT, process.cwd()], log = () => {} } = {}) {
  const names = LEGACY[kind];
  if (!names || !target || fs.existsSync(target)) return null;
  const name = names[demo ? 1 : 0];
  for (const dir of [...new Set(legacyDirs.map((d) => path.resolve(d)))]) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) continue;
    try {
      ensureDir(path.dirname(target));
      fs.copyFileSync(src, target, fs.constants.COPYFILE_EXCL);
      try { fs.chmodSync(target, 0o600); } catch {}
    } catch { return null; }
    if (!migrated.has(target)) { migrated.add(target); log(`copied ${name} to ${target} (the old file was left in place)`); }
    return src;
  }
  return null;
}

const defaultLog = (m) => process.stderr.write(`[attune] ${m}\n`);

/**
 * Path of one named store file in the data folder, creating the folder on demand and migrating a legacy file
 * (default folder only). kind: consent | memory | apps | activity | service.
 */
function storeFile(kind, { demo = false, env = process.env, log = defaultLog, legacyDirs } = {}) {
  if (!FILES[kind]) throw new Error(`unknown store file: ${kind}`);
  const dir = ensureDir(dataDir({ demo, env }));
  const file = path.join(dir, FILES[kind]);
  if (!env.ATTUNE_DATA_DIR && LEGACY[kind]) migrateLegacy(kind, { demo, target: file, log, ...(legacyDirs ? { legacyDirs } : {}) });
  return file;
}

/** Write a whole file atomically (temp file + rename), user-only permissions where supported. */
function writeFileAtomic(file, data, { mode = 0o600 } = {}) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, data, { mode, flag: 'wx' });
    // Windows can refuse a rename briefly while another process reads the file; retry a few times.
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, file); break; } catch (e) {
        if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
        const until = Date.now() + 20; while (Date.now() < until) { /* short spin */ }
      }
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = { dataDir, ensureDir, storeFile, migrateLegacy, writeFileAtomic, FILES, LEGACY, REPO_ROOT };
