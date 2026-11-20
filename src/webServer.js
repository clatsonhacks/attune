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
 *  - Lenses: the built-in companion reads through the lens the person picked (POST /api/mode, default companion).
 *    Other apps (MCP connectors) are approved per lens here (/api/apps/*) — nothing an AI can call reaches these
 *    routes. Who read which lens is in the number-free activity log (/api/activity).
 *  - Connector API (/connector/v1/*): the ONLY way an MCP connector (src/server.js, a thin stdio client) reaches
 *    Attune. Bearer token from service.json in the per-user data folder; any request carrying an Origin (or
 *    Sec-Fetch-*) header is refused, so a browser can never call it. It reads status, purposes, context and memory
 *    and records corrections and notes; it cannot grant consent, approve a purpose or forget memory — only the person
 *    can, in this UI. This service is the only process that ever opens the camera.
 *
 * Run: npm run web   (PORT env optional, default 3000; settings can live in .env)
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createSession } = require('./session');
const { createMemory, defaultMemoryFile } = require('./memory');
const { createAdapter, isDemo } = require('./adapter');
const { createCompanion } = require('./companion');
const { connectorsStatus, registerClaudeDesktop } = require('./connectors');
const { createConsent } = require('./privacy/consent');
const { createLocalGuard } = require('./privacy/localGuard');
const { createSensing } = require('./sensing');
const { createConsentStore, defaultConsentFile } = require('./privacy/consentStore');
const { createCapabilities } = require('./privacy/capabilities');
const { createContextBridge } = require('./contextBridge');
const { normalizeInsight } = require('./insights/normalizer');
const { getLens, listLenses, DEFAULT_LENS } = require('./lenses');
const { createAppApprovals, defaultAppsFile, isAppId, labelFor } = require('./privacy/appApprovals');
const { createActivityLog, defaultActivityFile } = require('./activity');
const { storeFile, writeFileAtomic } = require('./paths');

const WEB_DIR = path.join(__dirname, '..', 'web');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
// Third-party UI libraries, served from node_modules (no CDN, works offline). Explicit allowlist only.
const OS_DIR = path.join(__dirname, '..', 'node_modules', 'overlayscrollbars');
const VENDOR = {
  '/vendor/overlayscrollbars.css': path.join(OS_DIR, 'styles', 'overlayscrollbars.min.css'),
  '/vendor/overlayscrollbars.js': path.join(OS_DIR, 'browser', 'overlayscrollbars.browser.es6.min.js'),
};
const NO_CONTEXT = { state: 'off', say: false, directive: null, suggestedUtterance: null, confidence: 0 };
const BUILTIN_APP = 'attune'; // this web companion: the person's own UI, may use every lens, never stored
const CONNECTOR_PREFIX = '/connector/v1/';
const CONNECTOR_ROUTES = new Set(['GET status', 'GET purposes', 'POST context', 'POST correction', 'GET memory', 'POST memory']);
const CONSENT_HINT = 'Open Attune and allow camera sensing and sharing with AI apps.';
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** Reuse the connector token from an existing service.json (e.g. one a previous run left behind), else null. */
function savedConnectorToken(file) {
  if (!file) return null;
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && d.version === 1 && typeof d.token === 'string' && TOKEN_RE.test(d.token) ? d.token : null;
  } catch { return null; }
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createApp({
  port = 3000,
  adapterFactory = null, // default: createAdapter(), with the key from keyStore in desktop mode
  demo = isDemo(),
  // Everything lives in the per-user data folder (src/paths.js); demo mode uses its own subfolder.
  memory = createMemory(defaultMemoryFile(demo)),
  companion = null,
  reply = null, // test hook: replace the companion's reply function
  consentStore = createConsentStore(defaultConsentFile(demo)),
  idleMs = Number(process.env.ATTUNE_SENSE_IDLE_MS) || 5 * 60 * 1000,
  log = (m) => process.stderr.write(`[attune] ${m}\n`),
  approvals = createAppApprovals(defaultAppsFile(demo)),
  activity = createActivityLog(defaultActivityFile(demo)),
  registerClaude = registerClaudeDesktop, // test hook
  // Where the running service announces its port + connector token to connectors (null: don't announce).
  serviceFile = storeFile('service', { demo }),
  // Desktop app only: { get(): Promise<string|null>, set(key): Promise<void>, clear(): Promise<void> }, backed by
  // OS-encrypted storage. When given, the SmartSpectra key comes from here (never from .env), is kept in memory only
  // and reaches nothing but the sensor worker's environment.
  keyStore = null,
  makeAdapter = createAdapter, // test hook: what the default adapterFactory calls
} = {}) {
  const desktop = !!keyStore;
  let storedKey = null;
  const keyReady = desktop
    ? Promise.resolve().then(() => keyStore.get()).then((k) => { storedKey = typeof k === 'string' && k ? k : null; })
      .catch((e) => log(`could not read the saved camera key (${(e && e.code) || 'error'})`))
    : Promise.resolve();
  const hasKey = () => (desktop ? !!storedKey : !!process.env.SMARTSPECTRA_API_KEY);
  adapterFactory = adapterFactory || (() => makeAdapter({
    intervalMs: Number(process.env.ATTUNE_TICK_MS) || 250, ...(desktop ? { apiKey: storedKey || '' } : {}) }));
  companion = companion || createCompanion({ demo, log });
  const replyFn = reply || companion.reply;
  const guard = createLocalGuard({ port });
  // Connector API token: 32 random bytes, kept in service.json and reused when a previous run left one there.
  const connectorToken = savedConnectorToken(serviceFile) || crypto.randomBytes(32).toString('hex');
  const lastSeen = new Map(); // app id → ISO time of its last connector call (in memory)
  const consent = createConsent();
  const capabilities = createCapabilities({ consent });
  const bridge = createContextBridge({ capabilities });
  consent.onChange(() => bridge.onConsentChange());
  let companionCap = null;
  let lensMode = DEFAULT_LENS; // the lens the built-in companion reads through (POST /api/mode)
  // The person's own UI: a capability without a lens restriction.
  const ensureCompanionCap = () => {
    if (!capabilities.valid(companionCap)) companionCap = capabilities.issue({ scope: 'aiSharing', purpose: 'companion' });
    return companionCap;
  };
  function record(event) { try { activity.append({ app: BUILTIN_APP, ...event }); } catch {} }
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
      bridge.updateSnapshot(session.getNeutralSnapshot(), gen);
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
    const ctx = bridge.getLensContext(ensureCompanionCap(), lensMode);
    record({ kind: 'context', lens: lensMode, state: ctx.state, say: !!ctx.say });
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
      mode: demo ? 'demo' : 'real', lensMode, ai: companion.status(), consent: { ...c, remembered: !!consentStore.load() },
      sensing: { state: s.state, error: s.error, errorCode: s.errorCode, adapter: adapterName, simulated, camera: s.camera,
        paused, lastTrigger, idleInMs: idleAt ? Math.max(0, idleAt - Date.now()) : null },
    };
    if (!sensingActive()) {
      const st = s.state === 'error' ? 'error' : !c.sensing ? 'consent_required' : paused ? 'paused' : s.state === 'starting' ? 'starting' : 'standby';
      return { ...base, ...NO_CONTEXT, state: st, pulseBpm: null, signals: [], evidence: [] };
    }
    const ctx = session.getBodyContext();
    // Measurements are shown to the consenting human only; the AI path uses bridge.getLensContext().
    // Measured breathing for the person's own pacer (human UI only; AI apps get it only via an approved yoga lens).
    const snap = session.getNeutralSnapshot();
    const breath = { perMin: snap.breathingRate != null && snap.breathingConfidence >= 0.4 ? Math.round(snap.breathingRate) : null, talking: snap.talking };
    return { ...base, ...ctx, pulseBpm: lastSample && lastSample.pulseBpm ? Math.round(lastSample.pulseBpm) : null, signals: session.getSignals(), breath, insight: bridge.getHumanView().insight };
  }

  /* ---- Connector API: what an MCP connector may do (never consent, approvals or forgetting) ---- */
  function connectorDenied(req) {
    // Browsers send Origin (and Sec-Fetch-*) on any request that could carry a token; a connector never does.
    if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) return { code: 403, error: 'not available to browsers' };
    const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
    if (!m || !sameSecret(m[1], connectorToken)) return { code: 401, error: 'missing or invalid connector token' };
    return null;
  }
  const recordFor = (app, event) => { try { activity.append({ ...event, app }); } catch {} };
  function cleanName(n) {
    const s = typeof n === 'string' ? n.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
    return s ? s.slice(0, 60) : null;
  }
  function displayName(app, given) {
    try { const a = approvals.get(app); if (a) return a.name; } catch {}
    return cleanName(given) || labelFor(app);
  }
  function approvedFor(app, strict) { try { return approvals.approvedLenses(app, { strict }); } catch { return []; } }

  function connectorStatus(app, strict) {
    const sensingAllowed = consent.has('sensing');
    const aiSharingAllowed = consent.has('aiSharing');
    return {
      attune: 'running', mode: demo ? 'demo' : 'real', sensingAllowed, aiSharingAllowed, memoryAllowed: consent.has('memory'),
      paused, camera: sensing.status().state, app, approvedPurposes: approvedFor(app, strict),
      ...(sensingAllowed && aiSharingAllowed ? {} : { howToEnable: CONSENT_HINT }),
    };
  }

  /** Same semantics as the connector's get_body_context: consent, purpose approval, then an immediate cache read. */
  async function connectorContext(app, { purpose, appName } = {}, strict) {
    const lens = getLens(purpose == null || purpose === '' ? DEFAULT_LENS : String(purpose).slice(0, 60));
    if (!consent.has('sensing') || !consent.has('aiSharing')) {
      recordFor(app, { kind: 'context', lens: lens ? lens.id : null, state: 'consent_required', say: false });
      return { state: 'consent_required', say: false, sensingAllowed: consent.has('sensing'), aiSharingAllowed: consent.has('aiSharing'), howToEnable: CONSENT_HINT };
    }
    if (!lens) {
      recordFor(app, { kind: 'unknown', lens: null, state: 'unknown_purpose', say: false });
      return { state: 'unknown_purpose', say: false, availablePurposes: listLenses().map((l) => l.id) };
    }
    if (!approvedFor(app, strict).includes(lens.id)) {
      let wasPending = false;
      try {
        wasPending = approvals.pending().some((p) => p.app === app && p.lens === lens.id);
        approvals.recordRequest(app, lens.id);
      } catch {}
      recordFor(app, { kind: wasPending ? 'denied' : 'request', lens: lens.id, state: 'purpose_not_approved', say: false });
      return { state: 'purpose_not_approved', lens: lens.id, say: false,
        howToEnable: `Open Attune → Connectors and allow ${displayName(app, appName)} to use ${lens.name}.` };
    }
    if (paused) {
      recordFor(app, { kind: 'context', lens: lens.id, state: 'paused', say: false });
      return { ...NO_CONTEXT, lens: lens.id, state: 'paused' };
    }
    const st = await wake('ai_requested'); // respects pause and idle; never waits for frames
    if (st.state === 'error') {
      recordFor(app, { kind: 'context', lens: lens.id, state: 'unavailable', say: false });
      return { state: 'unavailable', say: false, error: st.error };
    }
    let ctx;
    if (st.state !== 'active') ctx = { ...NO_CONTEXT, lens: lens.id, state: 'starting' };
    else {
      // A capability limited to the app's CURRENT approvals (re-read now), used for this one read only.
      const cap = capabilities.issue({ scope: 'aiSharing', purpose: `mcp:${app}`, lenses: approvedFor(app, strict) });
      try { ctx = bridge.getLensContext(cap, lens.id); } finally { capabilities.revoke(cap); } // immediate cache read
      if (ctx.state === 'off') ctx = { ...ctx, state: 'starting' };
    }
    recordFor(app, { kind: ctx.state === 'purpose_not_approved' ? 'denied' : 'context', lens: lens.id, state: ctx.state, say: !!ctx.say });
    return ctx;
  }

  async function handleConnector(req, res, method, route, query) {
    const denied = connectorDenied(req);
    if (denied) return sendJSON(res, denied.code, { error: denied.error });
    if (!CONNECTOR_ROUTES.has(`${method} ${route}`)) return sendJSON(res, 404, { error: 'not found' });
    const body = method === 'POST' ? await readBody(req) : {};
    const q = new URLSearchParams(query);
    const app = method === 'POST' ? body.app : q.get('app');
    if (!isAppId(app) || app === BUILTIN_APP) return sendJSON(res, 400, { error: 'invalid app' });
    const strict = method === 'POST' ? body.strict === true : ['1', 'true'].includes(q.get('strict'));
    lastSeen.set(app, new Date().toISOString());

    if (route === 'status') return sendJSON(res, 200, connectorStatus(app, strict));
    if (route === 'purposes') {
      const ok = approvedFor(app, strict);
      return sendJSON(res, 200, { app, purposes: listLenses().map(({ id, name, description, sharesNumbers }) => ({ id, name, description, sharesNumbers, approved: ok.includes(id) })) });
    }
    if (route === 'context') return sendJSON(res, 200, await connectorContext(app, body, strict));
    if (route === 'correction') {
      if (!sensingActive()) return sendJSON(res, 200, { ok: false, reason: 'sensing is not active' });
      return sendJSON(res, 200, session.recordCorrection({ wasAccurate: body.wasAccurate === true }));
    }
    if (method === 'GET') { // memory
      if (!consent.has('memory') || !consent.has('aiSharing')) return sendJSON(res, 200, { memory: 'disabled', reason: 'Memory and sharing with AI apps must both be on in Attune.' });
      return sendJSON(res, 200, memory.summary());
    }
    if (typeof body.note !== 'string' || !body.note.trim()) return sendJSON(res, 400, { error: 'note must be a non-empty string' });
    if (!consent.has('memory')) return sendJSON(res, 200, { ok: false, reason: 'Memory is off in Attune.' });
    memory.append({ type: 'note', note: body.note.slice(0, 500) });
    return sendJSON(res, 200, { ok: true });
  }

  /* ---- First-run setup (desktop app): the SmartSpectra key ---- */
  const setupPayload = () => ({ desktop, needsKey: !hasKey(), demo });
  /** Loose shape check only: 16–256 visible characters, no whitespace inside. Returns the trimmed key or null. */
  function cleanKey(k) {
    if (typeof k !== 'string') return null;
    const t = k.trim();
    return t.length >= 16 && t.length <= 256 && /^\S+$/.test(t) ? t : null;
  }
  async function handleSetup(req, res, method, url) {
    if (method === 'GET' && url === '/api/setup') return sendJSON(res, 200, setupPayload());
    if (method !== 'POST' || (url !== '/api/setup/key' && url !== '/api/setup/key/clear')) return sendJSON(res, 404, { error: 'not found' });
    if (!desktop) return sendJSON(res, 404, { error: 'The camera key can only be set in the Attune desktop app. Use .env with npm run web.' });
    const body = await readBody(req);
    const clearing = url === '/api/setup/key/clear';
    const key = clearing ? null : cleanKey(body.key);
    if (!clearing && !key) return sendJSON(res, 400, { error: 'That does not look like a SmartSpectra key. Paste the whole key, without spaces.' });
    try {
      if (clearing) await keyStore.clear(); else await keyStore.set(key);
    } catch (e) {
      log(`could not ${clearing ? 'remove' : 'save'} the camera key (${(e && e.code) || 'error'})`); // never the key itself
      return sendJSON(res, 500, { error: clearing ? 'Could not remove the key.' : 'Could not save the key securely on this computer.' });
    }
    storedKey = key;
    log(clearing ? 'camera key removed' : 'camera key saved');
    // A running camera keeps the old key; stop it so the next start uses the new one (or none).
    if (sensing.status().state === 'active' || sensing.status().state === 'starting') { clearTimeout(idleTimer); idleAt = null; await sensing.release('key_changed'); }
    return sendJSON(res, 200, { ok: true, ...setupPayload() });
  }

  async function handle(req, res) {
    const { method } = req;
    const [url, query = ''] = req.url.split('?');
    const isApi = url.startsWith('/api/');
    const denied = guard.check(req, { requireToken: isApi });
    if (denied) return sendJSON(res, denied.code, { error: denied.error });
    await keyReady; // the saved key is loaded before anything can start the camera
    if (url === '/api/setup' || url.startsWith('/api/setup/')) return handleSetup(req, res, method, url);
    if (url.startsWith(CONNECTOR_PREFIX)) return handleConnector(req, res, method, url.slice(CONNECTOR_PREFIX.length), query);

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
      const share = consent.has('aiSharing') && sensingActive();
      const ctx = share ? bridge.getLensContext(ensureCompanionCap(), lensMode) : NO_CONTEXT;
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
    /* ---- Lenses, app approvals and activity (the person's decisions; never reachable by an AI tool) ---- */
    if (method === 'GET' && url === '/api/lenses') return sendJSON(res, 200, { lenses: listLenses() });
    if (method === 'POST' && url === '/api/mode') {
      const { lens } = await readBody(req);
      const l = typeof lens === 'string' ? getLens(lens) : null;
      if (!l || l.id !== lens) return sendJSON(res, 400, { error: 'unknown lens' });
      lensMode = l.id;
      return sendJSON(res, 200, { ok: true, lensMode });
    }
    if (method === 'GET' && url === '/api/apps') {
      const builtin = { id: BUILTIN_APP, name: 'Attune', lenses: listLenses().map((l) => l.id), builtin: true, lastSeenAt: null };
      const stored = approvals.list().filter((a) => a.id !== BUILTIN_APP)
        .map(({ id, name, lenses }) => ({ id, name, lenses, builtin: false, lastSeenAt: lastSeen.get(id) || null }));
      // lastSeen also covers connected apps that have no approvals entry yet.
      return sendJSON(res, 200, { apps: [builtin, ...stored], pending: approvals.pending().filter((p) => p.app !== BUILTIN_APP),
        lastSeen: Object.fromEntries(lastSeen) });
    }
    if (method === 'POST' && url === '/api/apps/lens') {
      const { app, lens, allow, name } = await readBody(req);
      if (!isAppId(app)) return sendJSON(res, 400, { error: 'invalid app' });
      if (app === BUILTIN_APP) return sendJSON(res, 400, { error: 'Attune itself always uses the mode you pick.' });
      const l = typeof lens === 'string' ? getLens(lens) : null;
      if (!l || l.id !== lens) return sendJSON(res, 400, { error: 'unknown lens' });
      if (typeof allow !== 'boolean') return sendJSON(res, 400, { error: 'allow must be true or false' });
      if (name != null && typeof name !== 'string') return sendJSON(res, 400, { error: 'invalid name' });
      const a = approvals.setLens(app, l.id, allow, { name });
      log(`${allow ? 'allowed' : 'denied'} ${l.id} for ${app}`);
      return sendJSON(res, 200, { ok: true, app: { id: a.id, name: a.name, lenses: a.lenses, builtin: false } });
    }
    if (method === 'POST' && url === '/api/apps/remove') {
      const { app } = await readBody(req);
      if (!isAppId(app)) return sendJSON(res, 400, { error: 'invalid app' });
      if (app === BUILTIN_APP) return sendJSON(res, 400, { error: 'Attune itself cannot be removed.' });
      approvals.remove(app);
      return sendJSON(res, 200, { ok: true });
    }
    if (method === 'GET' && url === '/api/activity') {
      const n = Number(new URLSearchParams(query).get('limit'));
      const limit = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : 100;
      return sendJSON(res, 200, { events: activity.recent(limit) });
    }
    if (method === 'POST' && url === '/api/activity/clear') { activity.clear(); return sendJSON(res, 200, { ok: true }); }

    if (method === 'GET' && url === '/api/connectors') return sendJSON(res, 200, connectorsStatus({ lastSeenAt: (id) => lastSeen.get(id) || null }));
    if (method === 'POST' && url === '/api/connectors/claude') {
      if (demo) return sendJSON(res, 403, { error: 'Open Attune in real mode to register Claude Desktop.' });
      const body = await readBody(req);
      if (!body || body.approved !== true) return sendJSON(res, 400, { error: 'Approve Claude sharing before connecting.' });
      const result = registerClaude();
      // The new connector identifies as claude-desktop; start it on the companion lens only.
      if (result.ok) {
        try { if (!approvals.hasEntry('claude-desktop')) approvals.setLens('claude-desktop', DEFAULT_LENS, true, { name: 'Claude Desktop' }); }
        catch (e) { log(`could not save Claude Desktop approvals: ${e.message}`); }
      }
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

  // Announce the running service to connectors: { version, port, token, pid, startedAt }, user-only, atomic.
  let announced = null;
  server.on('listening', () => {
    if (!serviceFile) return;
    const info = { version: 1, port: server.address().port, token: connectorToken, pid: process.pid, startedAt: new Date().toISOString() };
    try { writeFileAtomic(serviceFile, JSON.stringify(info, null, 2) + '\n'); announced = info; }
    catch (e) { log(`could not write ${path.basename(serviceFile)}: ${e.code || e.message}`); }
  });
  /** Remove service.json only if it still describes this run (another instance may have replaced it). */
  function withdraw() {
    if (!announced) return;
    const mine = announced;
    announced = null;
    try {
      const cur = JSON.parse(fs.readFileSync(serviceFile, 'utf8'));
      if (cur && cur.pid === mine.pid && cur.port === mine.port && cur.startedAt === mine.startedAt) fs.unlinkSync(serviceFile);
    } catch {}
  }

  async function close() {
    withdraw();
    clearTimeout(idleTimer);
    await sensing.shutdown();
    await new Promise((r) => server.close(() => r()));
  }

  return { server, consent, sensing, guard, bridge, capabilities, approvals, activity, close, serviceFile, connectorToken, keyReady };
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
