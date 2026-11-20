'use strict';
/*
 * Attune MCP connector — a thin stdio MCP client of the running Attune service.
 *
 * It has NO camera, sensing, SDK or consent code. The Attune service (npm run web, later the desktop app) is the only
 * process that opens the camera and holds consent, purpose approvals, activity and memory. This connector finds the
 * service through service.json in the per-user Attune data folder (re-read on every call, so a restarted service is
 * picked up) and calls its local connector API on 127.0.0.1 with the token from that file.
 *
 *   Data folder: ATTUNE_DATA_DIR, else %APPDATA%\Attune · ~/Library/Application Support/Attune · $XDG_CONFIG_HOME/attune
 *   (a demo service writes to its `demo` subfolder; that is tried second, or only with --demo).
 *
 * Consent and approvals are NOT AI tools: the person gives them in Attune. If the service is not running, every tool
 * answers { state: 'attune_not_running', say: false } and nothing else happens.
 *
 * App identity: ATTUNE_APP_ID, else a slug of the MCP client's name, else claude-desktop (chatgpt with --chatgpt).
 * Tools: get_attune_status · list_purposes · get_body_context · record_correction · memory_get · memory_append
 * ChatGPT profile (--chatgpt): only the first three, app id chatgpt, strict approvals (every lens needs an explicit entry).
 *
 * Self-contained on purpose (only @modelcontextprotocol/sdk, zod and Node built-ins) so it can be packaged alone.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const TIMEOUT_MS = 3000;
const NOT_RUNNING = Object.freeze({ state: 'attune_not_running', say: false, howToEnable: 'Open Attune and try again.' });
const DEFAULT_PURPOSE = 'companion';
const PURPOSE_HELP = '"companion" (Emotional companion), "yoga" (Yoga & breathwork), "casual" (Casual chat)';

/**
 * ATTUNE_DATA_DIR when it names a folder, else null. Empty or blank values and unsubstituted placeholders such as
 * "${user_config.data_dir}" (a Claude Desktop extension whose optional setting was left empty) count as unset.
 */
function customDataDir(env = process.env) {
  const v = typeof env.ATTUNE_DATA_DIR === 'string' ? env.ATTUNE_DATA_DIR.trim() : '';
  return v && !v.includes('${') ? v : null;
}

/** Same rules as src/paths.js dataDir (kept in sync by a test). */
function dataDir({ demo = false, env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const custom = customDataDir(env);
  let base;
  if (custom) base = path.resolve(custom);
  else if (platform === 'win32') base = p.join(env.APPDATA || p.join(home, 'AppData', 'Roaming'), 'Attune');
  else if (platform === 'darwin') base = p.join(home, 'Library', 'Application Support', 'Attune');
  else base = p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'attune');
  return demo ? (custom ? path : p).join(base, 'demo') : base;
}

/** service.json files to try, in order. */
function serviceFiles({ demoOnly = false, env = process.env } = {}) {
  const real = path.join(dataDir({ env }), 'service.json');
  const demo = path.join(dataDir({ env, demo: true }), 'service.json');
  return demoOnly ? [demo] : [real, demo];
}

/** Parse and validate one service.json, or null. */
function readService(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
    if (!d || d.version !== 1 || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535 || typeof d.token !== 'string' || !TOKEN.test(d.token)) return null;
    return { port: d.port, token: d.token };
  } catch { return null; }
}

function slugAppId(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
  return APP_ID.test(s) ? s : null;
}

/**
 * The connector core: talks to the service, never throws.
 * fetchFn / env are test hooks; clientName() returns the MCP client's name once the handshake is done.
 */
function createConnector({ env = process.env, demoOnly = false, chatgpt = false, clientName = () => null,
  fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const defaultAppId = chatgpt ? 'chatgpt' : 'claude-desktop';

  function currentApp() {
    if (APP_ID.test(String(env.ATTUNE_APP_ID || ''))) return env.ATTUNE_APP_ID;
    let name = null;
    try { name = clientName(); } catch {}
    return slugAppId(name) || defaultAppId;
  }
  function currentAppName() {
    let name = null;
    try { name = clientName(); } catch {}
    return typeof name === 'string' && name.trim() ? name.trim().slice(0, 60) : undefined;
  }

  /** Call the service; returns its JSON, or NOT_RUNNING when no service answers. The token only ever goes to 127.0.0.1. */
  async function call(method, route, payload) {
    const app = currentApp();
    for (const file of serviceFiles({ demoOnly, env })) {
      const svc = readService(file);
      if (!svc) continue;
      let url = `http://127.0.0.1:${svc.port}/connector/v1/${route}`;
      const init = { method, headers: { authorization: `Bearer ${svc.token}`, accept: 'application/json' }, redirect: 'error' };
      if (method === 'GET') url += `?${new URLSearchParams({ app, ...(chatgpt ? { strict: '1' } : {}) })}`;
      else {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify({ ...payload, app, ...(chatgpt ? { strict: true } : {}) });
      }
      try {
        const res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 401 || res.status === 403) continue; // stale file from another run: try the next one
        if (route !== 'status' && res.headers?.get('x-attune-privacy') !== 'guidance-only') {
          await res.body?.cancel();
          return { state: 'update_required', say: false, howToEnable: 'Update the Attune service to use privacy-protected connector guidance.' };
        }
        const json = await res.json();
        if (json && typeof json === 'object') return json;
      } catch { /* not running, timed out, or not Attune: try the next one */ }
    }
    return { ...NOT_RUNNING };
  }

  return {
    appId: currentApp,
    status: () => call('GET', 'status'),
    listPurposes: () => call('GET', 'purposes'),
    getBodyContext: ({ purpose } = {}) => call('POST', 'context', { purpose: purpose == null ? undefined : String(purpose).slice(0, 60), appName: currentAppName() }),
    recordCorrection: ({ wasAccurate }) => call('POST', 'correction', { wasAccurate: wasAccurate === true }),
    memoryGet: () => call('GET', 'memory'),
    memoryAppend: ({ note }) => call('POST', 'memory', { note: String(note == null ? '' : note).slice(0, 500) }),
  };
}

async function main() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = require('zod');

  const chatgpt = process.argv.includes('--chatgpt');
  let server = null;
  const clientName = () => { const v = server && server.server.getClientVersion(); return v && v.name; };
  const core = createConnector({ chatgpt, demoOnly: process.argv.includes('--demo'), clientName });
  const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
  server = new McpServer({ name: 'attune-sense', version: '0.5.0' });

  server.registerTool('get_attune_status',
    { description: 'Read-only: whether Attune is running, whether the user has allowed sensing / AI sharing / memory in Attune, whether the camera is running, and which purposes this app may use.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => text(await core.status()));

  server.registerTool('get_body_context',
    {
      description:
        'Call before a reply. Pass the purpose that matches the task: emotional support → "companion" (default), ' +
        'breathing or yoga practice → "yoga", light conversation → "casual". Returns action cues only. If asked for vitals, explain that measurements are private to Attune. If say=true let directive shape your tone (be tentative, invite correction). If state is "unclear", ' +
        '"starting", "paused", "consent_required", "unavailable" or "attune_not_running", say nothing about the body. You cannot approve a purpose yourself: if state ' +
        'is "purpose_not_approved", tell the user they can allow it in Attune (see howToEnable) and carry on without it; ' +
        'if "unknown_purpose", pick one of availablePurposes. Non-medical; not a diagnosis; not lie-detection.',
      inputSchema: { purpose: z.string().max(60).optional().describe(`Lens id for this task. Known: ${PURPOSE_HELP}. Default "${DEFAULT_PURPOSE}".`) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ purpose } = {}) => text(await core.getBodyContext({ purpose })));

  server.registerTool('list_purposes',
    {
      description:
        'Read-only: the purposes (lenses) Attune offers and whether the user approved each one for this app. ' +
        'Only the user can approve a purpose, in Attune → Connectors; you cannot. If the purpose that fits the task is ' +
        'not approved, tell the user they can allow it there.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(await core.listPurposes()));

  if (!chatgpt) {
    server.registerTool('record_correction',
      { description: 'The user corrected the read (e.g. "I\'m fine"). Pass wasAccurate=false to make it more conservative.', inputSchema: { wasAccurate: z.boolean() } },
      async ({ wasAccurate }) => text(await core.recordCorrection({ wasAccurate })));

    server.registerTool('memory_get',
      { description: 'Compact cross-session summary (interpretations only). Only available if the user enabled memory and AI sharing in Attune.', inputSchema: {} },
      async () => text(await core.memoryGet()));

    server.registerTool('memory_append',
      { description: 'Note what mattered this session (no raw signals). Only works if the user enabled memory in Attune.', inputSchema: { note: z.string().max(500) } },
      async ({ note }) => text(await core.memoryAppend({ note })));
  }

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[attune-sense] MCP connector on stdio${chatgpt ? ' (ChatGPT profile)' : ''} — talks to the running Attune app.\n`);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[attune-sense] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { createConnector, dataDir, customDataDir, serviceFiles, readService, slugAppId, NOT_RUNNING };
