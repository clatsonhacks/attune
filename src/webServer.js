'use strict';
/*
 * Attune — self-contained demo backend (no camera, no credentials).
 * Feeds the mock vitals stream through the session and serves a small web UI + JSON API so the
 * whole signal→nudge→companion loop is visible in a browser. Swap the mock adapter for the real
 * SmartSpectra adapter and the mock companion for a real LLM when you move this to its own repo.
 *
 * Run: npm run web   (PORT env optional, default 3000)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createSession } = require('./session');
const { createMemory } = require('./memory');
const { createAdapter } = require('./adapter');
const { companionReply } = require('./companion');

const PORT = process.env.PORT || 3000;
const WEB_DIR = path.join(__dirname, '..', 'web');

const memory = createMemory();
memory.seedDemo();
const session = createSession({ memory });
const adapter = createAdapter({ intervalMs: Number(process.env.ATTUNE_TICK_MS) || 250 });

// Demo connector states (which AI platforms are linked). In-process for the prototype.
const connectors = [
  { id: 'claude', name: 'Claude', desc: 'Desktop · MCP connector', connected: true },
  { id: 'chatgpt', name: 'ChatGPT', desc: 'Desktop · MCP connector', connected: false },
  { id: 'mcp', name: 'attune-sense (local MCP)', desc: 'This device · stdio', connected: true },
];

let consent = false;
let lastSample = null;
adapter.start((sample) => {
  lastSample = sample;
  session.ingest(sample);
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });
}

function serveStatic(res, urlPath) {
  const file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.join(WEB_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(WEB_DIR)) return sendJSON(res, 403, { error: 'forbidden' });
  fs.readFile(full, (err, data) => {
    if (err) return sendJSON(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  if (method === 'GET' && url === '/api/state') {
    const ctx = consent ? session.getBodyContext() : { state: 'consent_required', say: false, directive: null, evidence: [], confidence: 0 };
    // Raw pulse is shown to the human viewer (credibility anchor) but never handed to the AI.
    return sendJSON(res, 200, {
      consent,
      pulseBpm: lastSample && lastSample.pulseBpm ? Math.round(lastSample.pulseBpm) : null,
      signals: consent ? session.getSignals() : [],
      ...ctx,
    });
  }
  if (method === 'POST' && url === '/api/consent') {
    const { allow } = await readBody(req);
    consent = !!allow;
    return sendJSON(res, 200, { consent });
  }
  if (method === 'POST' && url === '/api/chat') {
    const { message } = await readBody(req);
    const ctx = consent ? session.getBodyContext() : { state: 'consent_required', say: false };
    const out = await companionReply({ message: String(message || ''), ctx });
    return sendJSON(res, 200, { ...out, state: ctx.state });
  }
  if (method === 'POST' && url === '/api/correction') {
    const { wasAccurate } = await readBody(req);
    return sendJSON(res, 200, session.recordCorrection({ wasAccurate: !!wasAccurate }));
  }
  if (method === 'GET' && url === '/api/memory') return sendJSON(res, 200, memory.summary());
  if (method === 'GET' && url === '/api/memory/calendar') return sendJSON(res, 200, { today: new Date().toISOString().slice(0, 10), days: memory.calendar(), private: memory.isMuted() });
  if (method === 'POST' && url === '/api/forget') { memory.clear(); return sendJSON(res, 200, { cleared: true }); }
  if (method === 'POST' && url === '/api/memory/forgetDay') { const { date } = await readBody(req); memory.forgetDay(date); return sendJSON(res, 200, { ok: true }); }
  if (method === 'POST' && url === '/api/incognito') {
    const { on } = await readBody(req);
    memory.setMuted(!!on);
    if (on) memory.clear(); // private: drop anything already captured this session
    return sendJSON(res, 200, { private: memory.isMuted() });
  }
  if (method === 'GET' && url === '/api/connectors') return sendJSON(res, 200, { connectors });
  if (method === 'POST' && url === '/api/connectors') {
    const { id, connected } = await readBody(req);
    const c = connectors.find((x) => x.id === id);
    if (c) c.connected = !!connected;
    return sendJSON(res, 200, { connectors });
  }

  if (method === 'GET') return serveStatic(res, url.split('?')[0]);
  sendJSON(res, 405, { error: 'method not allowed' });
});

server.listen(PORT, () => {
  process.stdout.write(`[attune] demo UI on http://localhost:${PORT}  (mock vitals; consent required)\n`);
});
