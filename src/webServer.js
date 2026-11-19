'use strict';
/*
 * Attune — local backend + web UI. Real by default (SmartSpectra SDK + Groq); demo only with --demo.
 *
 * Privacy boundary (see docs/DATA_FLOW.md):
 *  - Consent is asked once and remembered (src/privacy/consentStore.js). It grants PERMISSION only: the camera
 *    starts when a chat starts, when the AI asks (check_in_with_body tool) or when the person turns it on, and
 *    stops after ATTUNE_SENSE_IDLE_MS (default 5 min) without chat activity, on pause, or on revoke.
 *  - The sensor (the real SmartSpectra SDK, or synthetic vitals in demo mode) does NOT start at
 *    boot. It starts only after the human grants the `sensing` scope (with the Presage disclosure
 *    acknowledged) in the UI, and stops on revoke.
 *  - Binds to 127.0.0.1 only; every /api call needs the per-boot session token (src/privacy/localGuard.js).
 *  - The AI (companion) receives approved, number-free context only when the `aiSharing` scope is on.
 *
 * Run: npm run web   (PORT env optional, default 3000; settings can live in .env)
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createSession } = require('./session');
const { createMemory } = require('./memory');
const { createAdapter, isDemo } = require('./adapter');
const { createCompanion } = require('./companion');
const { connectorsStatus, registerClaudeDesktop } = require('./connectors');
const { createConsent } = require('./privacy/consent');
const { createLocalGuard } = require('./privacy/localGuard');
const { createSensing } = require('./sensing');
const { createConsentStore } = require('./privacy/consentStore');
const { createCapabilities } = require('./privacy/capabilities');
const { createContextBridge } = require('./contextBridge');
const { normalizeInsight } = require('./insights/normalizer');

const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
// Third-party UI libraries, served from node_modules (no CDN, works offline). Explicit allowlist only.
const OS_DIR = path.join(__dirname, '..', 'node_modules', 'overlayscrollbars');
const VENDOR = {
  '/vendor/overlayscrollbars.css': path.join(OS_DIR, 'styles', 'overlayscrollbars.min.css'),
  '/vendor/overlayscrollbars.js': path.join(OS_DIR, 'browser', 'overlayscrollbars.browser.es6.min.js'),
};
const NO_CONTEXT = { state: 'off', say: false, directive: null, suggestedUtterance: null, confidence: 0 };

function createApp({
  port = 3000,
  adapterFactory = () => createAdapter({ intervalMs: Number(process.env.ATTUNE_TICK_MS) || 250 }),
  demo = isDemo(),
  // Demo and real keep separate memory files so synthetic history never mixes with yours.
  memory = createMemory(path.join(process.cwd(), demo ? '.attune-demo-memory.json' : '.attune-memory.json')),
  companion = null,
  reply = null, // test hook: replace the companion's reply function
  consentStore = createConsentStore(path.join(process.cwd(), demo ? '.attune-demo-consent.json' : '.attune-consent.json')),
  idleMs = Number(process.env.ATTUNE_SENSE_IDLE_MS) || 5 * 60 * 1000,
  log = (m) => process.stderr.write(`[attune] ${m}\n`),
} = {}) {
  companion = companion || createCompanion({ demo, log });
  const replyFn = reply || companion.reply;
  const guard = createLocalGuard({ port });
  const consent = createConsent();
  const capabilities = createCapabilities({ consent });
  const bridge = createContextBridge({ capabilities });
  consent.onChange(() => bridge.onConsentChange());
  let companionCap = null;
  let chatStarted = false; // the first message of a conversation turns the camera on
  const simulated = demo;
  const adapterName = demo ? 'mock' : 'smartspectra';

  // Memory writes only with the memory scope; demo history is seeded only in mock mode.
  memory.setMuted(true);
  if (simulated) memory.seedDemo();
  else if (memory.dropDemo()) log('removed demo history from real memory');

  let session = createSession({ simulatedSignals: simulated });
  let lastSample = null;

  const sensing = createSensing({
    adapterFactory,
    consent,
    log,
    onStart: (gen) => {
      lastSample = null;
      session = createSession({ memory: consent.has('memory') ? memory : null, simulatedSignals: simulated });
      bridge.openSession(gen);
    },
    onSample: (sample, gen) => {
      lastSample = sample;
      session.ingest(sample);
      bridge.update(session.getApprovedContext(), gen);
    },
    onInsight: (insight, gen) => bridge.addInsight(normalizeInsight(insight, { requested: insight.requested }), gen),
    onStop: () => { lastSample = null; bridge.closeSession(); },
    autoStart: false, // permission ≠ camera on; see the sensing policy below
  });

  /* ---- Sensing policy: when the camera runs ---- */
  let paused = false;        // the person paused the camera; stays paused until they resume
  let lastTrigger = null;    // why the camera last turned on
  let idleTimer = null;
  let idleAt = null;
  const remembered = consentStore.load();
  if (remembered) {
    paused = remembered.paused;
    try { consent.grant(remembered.scopes); log('restored saved consent (camera stays off until a chat starts)'); } catch {}
  }
  function persist() {
    const c = consent.snapshot();
    if (c.sensing || c.aiSharing || c.memory) consentStore.save({ scopes: c, paused, grantedAt: remembered && remembered.grantedAt });
    else consentStore.clear();
  }
  function touchIdle() {
    clearTimeout(idleTimer);
    idleAt = Date.now() + idleMs;
    idleTimer = setTimeout(() => { idleAt = null; sensing.release('idle'); }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }
  /** Turn the camera on for `reason` if the person allowed it and has not paused it. Never waits for frames. */
  async function wake(reason) {
    if (!consent.has('sensing') || paused) return sensing.status();
    touchIdle();
    if (sensingActive()) return sensing.status();
    lastTrigger = reason;
    return sensing.request(reason);
  }
  /** Answer to the AI's check_in_with_body tool: immediate, from cache. */
  async function bodyRequest(reason) {
    if (!consent.has('aiSharing')) return { status: 'not_shared', note: 'The person has not allowed sharing body signals with you. Do not mention the body.' };
    if (!consent.has('sensing')) return { status: 'not_permitted', note: 'Camera sensing is not allowed. Do not mention the body.' };
    if (paused) return { status: 'paused', note: 'The person paused the camera. Do not mention the body.' };
    const wasActive = sensingActive();
    await wake('ai_requested');
    log(`AI asked for a body reading${reason ? ` (${reason.slice(0, 80)})` : ''}`);
    if (!wasActive || !sensingActive()) return { status: 'camera_starting', note: 'A reading will be available in about 20–30 seconds. Carry on; do not mention the body yet.' };
    if (!capabilities.valid(companionCap)) companionCap = capabilities.issue({ scope: 'aiSharing', purpose: 'companion' });
    const ctx = bridge.getApprovedContext(companionCap);
    if (['off', 'stale', 'starting', 'calibrating'].includes(ctx.state)) return { status: 'warming_up', note: 'Still calibrating. Do not mention the body yet.' };
    return { status: 'ok', ...ctx };
  }

  consent.onChange((next) => memory.setMuted(!next.memory));
  consent.onChange(() => persist());

  const sensingActive = () => sensing.status().state === 'active';

  function sendJSON(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let b = '';
      req.on('data', (c) => { b += c; if (b.length > 64 * 1024) req.destroy(); });
      req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    });
  }

  function serveStatic(res, urlPath) {
    const file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const full = path.join(WEB_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(WEB_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
    fs.readFile(full, (err, data) => {
      if (err) return sendJSON(res, 404, { error: 'not found' });
      const headers = { 'content-type': MIME[path.extname(full)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' };
      if (full.endsWith('index.html')) {
        // Hand the session token to our own page only; other origins can't read this response.
        // The per-response style nonce lets the scrollbar library's one measuring <style> through CSP.
        const nonce = crypto.randomBytes(16).toString('base64');
        data = Buffer.from(String(data).replace('</head>',
          `  <meta name="attune-token" content="${guard.token}" />\n  <meta name="attune-style-nonce" content="${nonce}" />\n</head>`));
        headers['cache-control'] = 'no-store';
        headers['content-security-policy'] =
          `default-src 'self'; style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'`;
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  function statePayload() {
    const c = consent.snapshot();
    const s = sensing.status();
    const base = {
      mode: demo ? 'demo' : 'real', ai: companion.status(), consent: { ...c, remembered: !!consentStore.load() },
      sensing: { state: s.state, error: s.error, errorCode: s.errorCode, adapter: adapterName, simulated, camera: s.camera,
        paused, lastTrigger, idleInMs: idleAt ? Math.max(0, idleAt - Date.now()) : null },
    };
    if (!sensingActive()) {
      const st = s.state === 'error' ? 'error' : !c.sensing ? 'consent_required' : paused ? 'paused' : s.state === 'starting' ? 'starting' : 'standby';
      return { ...base, ...NO_CONTEXT, state: st, pulseBpm: null, signals: [], evidence: [] };
    }
    const ctx = session.getBodyContext();
    // Measurements are shown to the consenting human only; the AI path uses getApprovedContext().
    return { ...base, ...ctx, pulseBpm: lastSample && lastSample.pulseBpm ? Math.round(lastSample.pulseBpm) : null, signals: session.getSignals(), insight: bridge.getHumanView().insight };
  }

  async function handle(req, res) {
    const { method } = req;
    const url = req.url.split('?')[0];
    const isApi = url.startsWith('/api/');
    const denied = guard.check(req, { requireToken: isApi });
    if (denied) return sendJSON(res, denied.code, { error: denied.error });

    if (method === 'GET' && url === '/api/state') return sendJSON(res, 200, statePayload());

    if (method === 'POST' && url === '/api/consent') {
      const body = await readBody(req);
      try {
        consent.grant({
          sensing: body.sensing, presageAck: body.presageAck, aiSharing: body.aiSharing,
          memory: body.memory, diagnostics: body.diagnostics,
        });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message, code: e.code });
      }
      if (body.sensing) { paused = false; persist(); await wake('consent_granted'); }
      await sensing.settled();
      return sendJSON(res, 200, statePayload());
    }
    if (method === 'POST' && url === '/api/sensing') {
      const { action } = await readBody(req);
      if (action === 'pause') { paused = true; clearTimeout(idleTimer); idleAt = null; persist(); await sensing.release('paused'); }
      else if (action === 'resume' || action === 'start') { paused = false; persist(); await wake('turned_on'); }
      else return sendJSON(res, 400, { error: 'action must be pause, resume or start' });
      await sensing.settled();
      return sendJSON(res, 200, statePayload());
    }
    if (method === 'POST' && url === '/api/revoke') {
      const { scopes } = await readBody(req);
      consent.revoke(Array.isArray(scopes) ? scopes : undefined);
      if (!consent.has('sensing')) { paused = false; clearTimeout(idleTimer); idleAt = null; }
      await sensing.settled();
      return sendJSON(res, 200, statePayload());
    }

    if (method === 'POST' && url === '/api/chat') {
      const { message } = await readBody(req);
      if (!chatStarted) { chatStarted = true; wake('chat_started'); } // fire-and-forget: never delay the reply
      else if (sensingActive()) touchIdle();
      // Immediate cache read from the Context Bridge — never waits on the SDK or an Insight.
      if (consent.has('aiSharing') && !capabilities.valid(companionCap)) companionCap = capabilities.issue({ scope: 'aiSharing', purpose: 'companion' });
      const share = consent.has('aiSharing') && sensingActive();
      const ctx = share ? bridge.getApprovedContext(companionCap) : NO_CONTEXT;
      const out = await replyFn({ message: String(message || '').slice(0, 4000), ctx, onBodyRequest: consent.has('aiSharing') ? bodyRequest : undefined });
      return sendJSON(res, 200, { ...out, state: ctx.state, aiSharing: share, ai: companion.status() });
    }
    if (method === 'POST' && url === '/api/chat/reset') {
      companion.reset();
      chatStarted = false;
      return sendJSON(res, 200, { ok: true });
    }
    if (method === 'POST' && url === '/api/insight') {
      // User-initiated Presage Insight. Returns at once; the answer arrives later via /api/state.
      const { text } = await readBody(req);
      const prompt = String(text || 'Provide a short, friendly check-in on how my readings look right now.').slice(0, 300);
      const requestId = await sensing.requestInsight(prompt);
      return sendJSON(res, requestId == null ? 429 : 202, { requestId, note: requestId == null ? 'not running or rate-limited (one request per 30 s)' : 'requested' });
    }
    if (method === 'GET' && url === '/api/bridge/stats') return sendJSON(res, 200, bridge.stats());
    if (method === 'POST' && url === '/api/correction') {
      const { wasAccurate } = await readBody(req);
      if (!sensingActive()) return sendJSON(res, 409, { error: 'sensing is not active' });
      return sendJSON(res, 200, session.recordCorrection({ wasAccurate: !!wasAccurate }));
    }

    if (method === 'GET' && url === '/api/memory') return sendJSON(res, 200, memory.summary());
    if (method === 'GET' && url === '/api/memory/calendar') return sendJSON(res, 200, { today: new Date().toISOString().slice(0, 10), days: memory.calendar(), private: memory.isMuted() });
    if (method === 'POST' && url === '/api/forget') { memory.clear(); return sendJSON(res, 200, { cleared: true }); }
    if (method === 'POST' && url === '/api/memory/forgetDay') { const { date } = await readBody(req); memory.forgetDay(date); return sendJSON(res, 200, { ok: true }); }
    if (method === 'POST' && url === '/api/incognito') {
      const { on } = await readBody(req);
      if (on) { consent.revoke(['memory']); memory.clear(); }
      else consent.grant({ memory: true });
      return sendJSON(res, 200, { private: memory.isMuted() });
    }
    if (method === 'GET' && url === '/api/connectors') return sendJSON(res, 200, connectorsStatus());
    if (method === 'POST' && url === '/api/connectors/claude') {
      if (demo) return sendJSON(res, 403, { error: 'Open Attune in real mode to register Claude Desktop.' });
      const body = await readBody(req);
      if (!body || body.approved !== true) return sendJSON(res, 400, { error: 'Approve Claude sharing before connecting.' });
      const result = registerClaudeDesktop();
      return sendJSON(res, result.ok ? 200 : 409, result);
    }

    if (method === 'GET' && VENDOR[url]) {
      return fs.readFile(VENDOR[url], (err, data) => {
        if (err) return sendJSON(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[path.extname(VENDOR[url])], 'cache-control': 'max-age=3600', 'x-content-type-options': 'nosniff' });
        res.end(data);
      });
    }
    if (method === 'GET' && !isApi) return serveStatic(res, url);
    sendJSON(res, isApi ? 404 : 405, { error: isApi ? 'not found' : 'method not allowed' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { log(`request failed: ${e.message}`); if (!res.headersSent) sendJSON(res, 500, { error: 'internal error' }); });
  });

  async function close() {
    clearTimeout(idleTimer);
    await sensing.shutdown();
    await new Promise((r) => server.close(() => r()));
  }

  return { server, consent, sensing, guard, bridge, capabilities, close };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({ port });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); process.exit(0); });
  app.server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`[attune] http://localhost:${port}  (${isDemo() ? 'DEMO mode: synthetic vitals, scripted replies' : 'real mode: SmartSpectra + Groq'}; sensing starts only after consent)\n`);
  });
}

module.exports = { createApp };
