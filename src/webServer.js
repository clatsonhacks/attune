'use strict';
/*
 * Attune — local backend + web UI. Real by default (SmartSpectra SDK + Claude); demo only with --demo.
 *
 * Privacy boundary (see docs/DATA_FLOW.md):
 *  - The sensor (the real SmartSpectra SDK, or synthetic vitals in demo mode) does NOT start at
 *    boot. It starts only after the human grants the `sensing` scope (with the Presage disclosure
 *    acknowledged) in the UI, and stops on revoke.
 *  - Binds to 127.0.0.1 only; every /api call needs the per-boot session token (src/privacy/localGuard.js).
 *  - The AI (companion) receives approved, number-free context only when the `aiSharing` scope is on.
 *
 * Run: npm run web   (PORT env optional, default 3000; settings can live in .env)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSession } = require('./session');
const { createMemory } = require('./memory');
const { createAdapter, isDemo } = require('./adapter');
const { createCompanion } = require('./companion');
const { connectorsStatus } = require('./connectors');
const { createConsent } = require('./privacy/consent');
const { createLocalGuard } = require('./privacy/localGuard');
const { createSensing } = require('./sensing');
const { createCapabilities } = require('./privacy/capabilities');
const { createContextBridge } = require('./contextBridge');
const { normalizeInsight } = require('./insights/normalizer');

const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const NO_CONTEXT = { state: 'off', say: false, directive: null, suggestedUtterance: null, confidence: 0 };

function createApp({
  port = 3000,
  adapterFactory = () => createAdapter({ intervalMs: Number(process.env.ATTUNE_TICK_MS) || 250 }),
  demo = isDemo(),
  // Demo and real keep separate memory files so synthetic history never mixes with yours.
  memory = createMemory(path.join(process.cwd(), demo ? '.attune-demo-memory.json' : '.attune-memory.json')),
  companion = null,
  reply = null, // test hook: replace the companion's reply function
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
  });

  consent.onChange((next) => memory.setMuted(!next.memory));

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
        data = Buffer.from(String(data).replace('</head>', `  <meta name="attune-token" content="${guard.token}" />\n</head>`));
        headers['cache-control'] = 'no-store';
        headers['content-security-policy'] =
          "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  }

  function statePayload() {
    const c = consent.snapshot();
    const s = sensing.status();
    const base = { mode: demo ? 'demo' : 'real', ai: companion.status(), consent: c, sensing: { state: s.state, error: s.error, errorCode: s.errorCode, adapter: adapterName, simulated } };
    if (!sensingActive()) return { ...base, ...NO_CONTEXT, state: s.state === 'error' ? 'error' : c.sensing ? 'starting' : 'consent_required', pulseBpm: null, signals: [], evidence: [] };
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
      await sensing.settled();
      return sendJSON(res, 200, statePayload());
    }
    if (method === 'POST' && url === '/api/revoke') {
      const { scopes } = await readBody(req);
      consent.revoke(Array.isArray(scopes) ? scopes : undefined);
      await sensing.settled();
      return sendJSON(res, 200, statePayload());
    }

    if (method === 'POST' && url === '/api/chat') {
      const { message } = await readBody(req);
      // Immediate cache read from the Context Bridge — never waits on the SDK or an Insight.
      if (consent.has('aiSharing') && !capabilities.valid(companionCap)) companionCap = capabilities.issue({ scope: 'aiSharing', purpose: 'companion' });
      const share = consent.has('aiSharing') && sensingActive();
      const ctx = share ? bridge.getApprovedContext(companionCap) : NO_CONTEXT;
      const out = await replyFn({ message: String(message || '').slice(0, 4000), ctx });
      return sendJSON(res, 200, { ...out, state: ctx.state, aiSharing: share, ai: companion.status() });
    }
    if (method === 'POST' && url === '/api/chat/reset') {
      companion.reset();
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

    if (method === 'GET' && !isApi) return serveStatic(res, url);
    sendJSON(res, isApi ? 404 : 405, { error: isApi ? 'not found' : 'method not allowed' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { log(`request failed: ${e.message}`); if (!res.headersSent) sendJSON(res, 500, { error: 'internal error' }); });
  });

  async function close() {
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
    process.stdout.write(`[attune] http://localhost:${port}  (${isDemo() ? 'DEMO mode: synthetic vitals, scripted replies' : 'real mode: SmartSpectra + Claude'}; sensing starts only after consent)\n`);
  });
}

module.exports = { createApp };
