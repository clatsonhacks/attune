'use strict';
/*
 * Isolated adapter (plan M1-04): runs the real sensor adapter in a child process so the camera/SDK handle,
 * the API key and native code never live in the server process that talks to browsers and AIs.
 *
 *  - Narrow IPC (see worker.js); every message from the worker is validated against an allowlist.
 *  - The worker gets a minimal environment (no unrelated secrets such as GROQ_API_KEY).
 *  - A worker crash or exit while running is reported through onError → sensing goes to "error".
 *
 * This is process separation, not an OS sandbox; see docs/THREAT_MODEL.md.
 */
const { fork } = require('child_process');
const path = require('path');

const ENV_ALLOW = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'LANG', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'SMARTSPECTRA_CAPI_PATH'];
const EXPRESSIONS = new Set(['neutral', 'tense', 'sad', 'smile', 'surprise', 'fear', 'anger', 'unknown']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
// Missing confidence stays missing (the interpreter treats it as unknown), never silently 0.
const conf = (v) => { const n = num(v); return n == null ? null : Math.max(0, Math.min(1, n)); };

/** Rebuild a sample from known fields only; anything else from the worker is dropped. */
function sanitizeSample(s) {
  if (!s || typeof s !== 'object') return null;
  return {
    tMs: num(s.tMs) ?? Date.now(), // 0 is a valid timestamp (the mock starts at 0)
    pulseBpm: num(s.pulseBpm),
    pulseConfidence: conf(s.pulseConfidence),
    expression: EXPRESSIONS.has(s.expression) ? s.expression : 'unknown',
    expressionConfidence: conf(s.expressionConfidence),
    talking: s.talking === true,
    speechFast: s.speechFast === true,
    breathingRate: num(s.breathingRate),
    breathingConfidence: conf(s.breathingConfidence),
    hrvMs: num(s.hrvMs),
    hrvConfidence: conf(s.hrvConfidence),
  };
}

function sanitizeInsight(i) {
  if (!i || typeof i !== 'object') return null;
  return {
    requestId: Number.isInteger(i.requestId) ? i.requestId : 0,
    requested: i.requested === true,
    processedAt: typeof i.processedAt === 'string' ? i.processedAt.slice(0, 40) : null,
    analysis: typeof i.analysis === 'string' ? i.analysis.slice(0, 2000) : null,
    error: typeof i.error === 'string' ? i.error.slice(0, 300) : null,
    type: 'INSIGHT_TYPE_VITALS',
  };
}

/** The worker's whole environment: an allowlist plus, for the real SDK, its API key. Nothing else. */
function buildWorkerEnv(kind, extra = {}, source = process.env) {
  const env = { ATTUNE_WORKER_ADAPTER: kind };
  for (const k of ENV_ALLOW) if (source[k] != null) env[k] = source[k];
  if (kind === 'smartspectra') env.SMARTSPECTRA_API_KEY = source.SMARTSPECTRA_API_KEY || '';
  return Object.assign(env, extra);
}

function createIsolatedAdapter({ kind = 'smartspectra', env = {}, log = (m) => process.stderr.write(`[attune] ${m}\n`) } = {}) {
  let child = null;
  let stopping = false;
  let ref = 0;
  const waiting = new Map();

  return {
    name: `${kind} (isolated)`,

    start(onSample, { onInsight = () => {}, onError = () => {} } = {}) {
      const childEnv = buildWorkerEnv(kind, env);

      stopping = false;
      child = fork(path.join(__dirname, 'worker.js'), [], { env: childEnv, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'json' });
      const me = child;
      // Forward only our own log lines; native SDK noise stays out of the parent log.
      me.stderr.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => { if (l.startsWith('[attune]')) log(l.replace(/^\[attune\]\s*/, 'worker: ')); }));
      me.on('message', (m) => {
        if (!m || me !== child) return;
        if (m.type === 'sample') { const s = sanitizeSample(m.sample); if (s) onSample(s); }
        else if (m.type === 'insight') { const i = sanitizeInsight(m.insight); if (i) onInsight(i); }
        else if (m.type === 'error') onError({ code: String(m.error && m.error.code || 'sdk_error').slice(0, 40), message: String(m.error && m.error.message || '').slice(0, 300) });
        else if (m.type === 'insightRequested' && waiting.has(m.ref)) { waiting.get(m.ref)(Number.isInteger(m.id) ? m.id : null); waiting.delete(m.ref); }
      });
      me.on('exit', (code, signal) => {
        if (me === child) child = null;
        for (const r of waiting.values()) r(null);
        waiting.clear();
        if (!stopping) onError({ code: 'worker_crashed', message: `sensor process exited (${signal || code})` });
      });
      me.send({ type: 'start' });
    },

    /** Resolves to the request id, or null (not running, rate-limited, or no reply within 2 s). */
    requestInsight(text) {
      if (!child) return Promise.resolve(null);
      const r = ++ref;
      return new Promise((resolve) => {
        waiting.set(r, resolve);
        child.send({ type: 'requestInsight', ref: r, text: String(text).slice(0, 500) });
        const t = setTimeout(() => { if (waiting.delete(r)) resolve(null); }, 2000);
        if (t.unref) t.unref();
      });
    },

    async stop() {
      const c = child;
      if (!c) return;
      stopping = true;
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { c.kill(); } catch {} resolve(); }, 3000);
        c.once('exit', () => { clearTimeout(t); resolve(); });
        try { c.send({ type: 'stop' }); } catch { clearTimeout(t); resolve(); }
      });
      child = null;
    },

    /** Test hook: the worker process id (to simulate a crash). */
    _pid() { return child ? child.pid : null; },
  };
}

module.exports = { createIsolatedAdapter, buildWorkerEnv, sanitizeSample, sanitizeInsight };
