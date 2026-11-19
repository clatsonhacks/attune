'use strict';
/*
 * Activity log: which app read which lens, and when — so the person can see who used Attune.
 * JSON Lines, appended (the connector and the web server are separate processes and may both append).
 *
 * Stores ONLY { at, app, lens, kind, state, say }. Never directive text, notes, numbers or measurements:
 * fields are whitelisted and coerced, everything else an event carries is dropped.
 */
const fs = require('fs');
const path = require('path');

const KINDS = new Set(['context', 'denied', 'request', 'unknown']);
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STATE = /^[a-z_]{1,32}$/;
const ROOT = path.join(__dirname, '..');

/** Absolute activity file shared by the web server and the connector (ATTUNE_ACTIVITY_FILE overrides). */
function defaultActivityFile(demo, env = process.env) {
  if (env.ATTUNE_ACTIVITY_FILE) return path.resolve(env.ATTUNE_ACTIVITY_FILE);
  return path.join(ROOT, demo ? '.attune-demo-activity.jsonl' : '.attune-activity.jsonl');
}

/** Whitelist + coerce. Returns null for anything that is not a valid event. */
function clean(e) {
  if (!e || typeof e !== 'object' || !KINDS.has(e.kind)) return null;
  const app = String(e.app || '');
  if (!ID.test(app)) return null;
  const lens = e.lens == null ? null : String(e.lens);
  const state = e.state == null ? null : String(e.state);
  const at = typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) ? new Date(e.at).toISOString() : new Date().toISOString();
  return {
    at,
    app,
    lens: lens && ID.test(lens) ? lens : null,
    kind: e.kind,
    state: state && STATE.test(state) ? state : null,
    say: e.say === true,
  };
}

function createActivityLog(filePath, { max = 500 } = {}) {
  if (!filePath) throw new Error('activity file path required');

  function readLines() {
    try { return fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim()); } catch { return []; }
  }

  function trim(lines) {
    if (lines.length <= 2 * max) return;
    const tmp = filePath + '.' + process.pid + '.tmp';
    try {
      fs.writeFileSync(tmp, lines.slice(-max).join('\n') + '\n', { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch { try { fs.unlinkSync(tmp); } catch {} }
  }

  function append(event) {
    const e = clean(event);
    if (!e) return null;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, JSON.stringify(e) + '\n', { mode: 0o600 });
      trim(readLines());
    } catch { return null; }
    return e;
  }

  /** Newest first; malformed lines are skipped. */
  function recent(limit = 100) {
    const n = Math.max(0, Math.min(Number(limit) || 0, max));
    const out = [];
    const lines = readLines();
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      let e;
      try { e = clean(JSON.parse(lines[i])); } catch { e = null; }
      if (e) out.push(e);
    }
    return out;
  }

  function clear() { try { fs.unlinkSync(filePath); } catch {} }

  return { append, recent, clear, file: filePath };
}

module.exports = { createActivityLog, defaultActivityFile, KINDS };
