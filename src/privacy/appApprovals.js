'use strict';
/*
 * App approvals: which app may use which lens. Only the person decides this, from Attune's own UI
 * (src/webServer.js → /api/apps/*). An AI can SUGGEST a purpose (the connector records it as a pending
 * request) but nothing an AI can call reaches setLens()/remove().
 *
 * The file lives in the per-user data folder (src/paths.js → apps.json). Every check re-reads it, so approvals
 * changed in the UI apply to the next request without a restart.
 *
 * File: { version: 1, apps: { [appId]: { name, lenses: [ids], createdAt, updatedAt } }, pending: [{ app, lens, at }] }
 * Writes are atomic (temp file + rename).
 *
 * Backward compatibility: an app with NO entry may use the default lens (companion) only — that is what every
 * connector could read before lenses existed. Any other lens needs an explicit approval.
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getLens, DEFAULT_LENS } = require('../lenses');
const { storeFile } = require('../paths');

const VERSION = 1;
const APP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_PENDING = 20;

const isAppId = (id) => typeof id === 'string' && APP_ID.test(id);

/** Approvals file in the per-user data folder (ATTUNE_APPS_FILE overrides). */
function defaultAppsFile(demo, env = process.env) {
  if (env.ATTUNE_APPS_FILE) return path.resolve(env.ATTUNE_APPS_FILE);
  return storeFile('apps', { demo, env });
}

/** Turn an MCP client name ("Claude Desktop", "openai-mcp") into a valid app id, or null. */
function slugAppId(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
  return isAppId(s) ? s : null;
}

/** Human label for an app id when none was given ("claude-desktop" → "Claude Desktop"). */
const KNOWN_NAMES = { 'claude-desktop': 'Claude Desktop', chatgpt: 'ChatGPT', attune: 'Attune' };
const labelFor = (id) => KNOWN_NAMES[id] || id.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

function invalid(message) {
  const err = new Error(message);
  err.code = 'invalid';
  return err;
}

function createAppApprovals(filePath) {
  if (!filePath) throw new Error('approvals file path required');

  function empty() { return { version: VERSION, apps: {}, pending: [] }; }

  /** Read and sanitize the file. Anything invalid is dropped rather than trusted. */
  function read() {
    let d;
    try { d = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '')); } catch { return empty(); }
    if (!d || d.version !== VERSION || typeof d.apps !== 'object' || !d.apps) return empty();
    const out = empty();
    for (const [id, a] of Object.entries(d.apps)) {
      if (!isAppId(id) || !a || typeof a !== 'object') continue;
      const lenses = [...new Set((Array.isArray(a.lenses) ? a.lenses : []).map(String))].filter((l) => getLens(l) && getLens(l).id === l);
      out.apps[id] = {
        name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 60) : labelFor(id),
        lenses,
        createdAt: typeof a.createdAt === 'string' ? a.createdAt : null,
        updatedAt: typeof a.updatedAt === 'string' ? a.updatedAt : null,
      };
    }
    for (const p of Array.isArray(d.pending) ? d.pending : []) {
      if (p && isAppId(p.app) && getLens(p.lens) && typeof p.at === 'string') out.pending.push({ app: p.app, lens: p.lens, at: p.at });
    }
    out.pending = out.pending.slice(-MAX_PENDING);
    return out;
  }

  function write(data) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.attune-apps-' + randomUUID() + '.tmp');
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      // Windows can refuse a rename briefly while the other process reads the file; retry a few times.
      for (let i = 0; ; i++) {
        try { fs.renameSync(tmp, filePath); break; } catch (e) {
          if (i >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
          const until = Date.now() + 20; while (Date.now() < until) { /* short spin */ }
        }
      }
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  }

  function checkApp(appId) { if (!isAppId(appId)) throw invalid('invalid app id'); }
  function checkLens(lensId) {
    const lens = typeof lensId === 'string' ? getLens(lensId) : null;
    if (!lens || lens.id !== lensId) throw invalid('unknown lens');
    return lens.id;
  }

  const view = (id, a) => ({ id, name: a.name, lenses: [...a.lenses], createdAt: a.createdAt, updatedAt: a.updatedAt });

  function list() { return Object.entries(read().apps).map(([id, a]) => view(id, a)); }
  function get(appId) { if (!isAppId(appId)) return null; const a = read().apps[appId]; return a ? view(appId, a) : null; }
  function hasEntry(appId) { return isAppId(appId) && !!read().apps[appId]; }

  /** Lenses this app may use right now (re-read from disk on every call). */
  function approvedLenses(appId) {
    if (!isAppId(appId)) return [];
    const a = read().apps[appId];
    return a ? [...a.lenses] : [DEFAULT_LENS];
  }

  function isApproved(appId, lensId) {
    const lens = typeof lensId === 'string' ? getLens(lensId) : null;
    if (!lens || lens.id !== lensId) return false;
    return approvedLenses(appId).includes(lens.id);
  }

  /**
   * Allow or deny one lens for one app (the person's decision). Creates the entry if needed, starting from
   * what the app could already use (the default lens), so approving a new lens never silently removes it.
   * Clears any pending request for that app + lens.
   */
  function setLens(appId, lensId, allow, { name } = {}) {
    checkApp(appId);
    const lens = checkLens(lensId);
    const d = read();
    const at = new Date().toISOString();
    const a = d.apps[appId] || { name: labelFor(appId), lenses: [DEFAULT_LENS], createdAt: at, updatedAt: at };
    if (typeof name === 'string' && name.trim()) a.name = name.trim().slice(0, 60);
    const set = new Set(a.lenses);
    if (allow) set.add(lens); else set.delete(lens);
    a.lenses = [...set];
    a.updatedAt = at;
    d.apps[appId] = a;
    d.pending = d.pending.filter((p) => !(p.app === appId && p.lens === lens));
    write(d);
    return view(appId, a);
  }

  /** Forget an app entirely (its approvals and pending requests). */
  function remove(appId) {
    checkApp(appId);
    const d = read();
    const had = !!d.apps[appId] || d.pending.some((p) => p.app === appId);
    delete d.apps[appId];
    d.pending = d.pending.filter((p) => p.app !== appId);
    if (had) write(d);
    return had;
  }

  /** An app asked for a lens it may not use. De-duplicated by app + lens (newest kept), capped. */
  function recordRequest(appId, lensId) {
    checkApp(appId);
    const lens = checkLens(lensId);
    const d = read();
    d.pending = d.pending.filter((p) => !(p.app === appId && p.lens === lens));
    d.pending.push({ app: appId, lens, at: new Date().toISOString() });
    d.pending = d.pending.slice(-MAX_PENDING);
    write(d);
  }

  function pending() { return read().pending.map((p) => ({ ...p })); }

  /** Drop pending requests for an app (one lens, or all of its lenses). */
  function clearPending(appId, lensId) {
    if (!isAppId(appId)) return;
    const d = read();
    const before = d.pending.length;
    d.pending = d.pending.filter((p) => !(p.app === appId && (lensId == null || p.lens === lensId)));
    if (d.pending.length !== before) write(d);
  }

  return { list, get, hasEntry, isApproved, approvedLenses, setLens, remove, recordRequest, pending, clearPending, file: filePath };
}

module.exports = { createAppApprovals, defaultAppsFile, slugAppId, isAppId, labelFor, MAX_PENDING };
