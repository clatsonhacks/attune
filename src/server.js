'use strict';
/*
 * Attune MCP connector — a local stdio MCP server for desktop clients and the ChatGPT tunnel client.
 *
 * Consent is NOT an AI tool. The human grants it in the connector's own config (which an AI cannot
 * edit through these tools), e.g. in claude_desktop_config.json:
 *   "env": { "ATTUNE_CONSENT": "sensing,presage-ack,ai-sharing" }
 *     sensing      — camera + SmartSpectra may run
 *     presage-ack  — you have read the Presage processing disclosure (required for sensing)
 *     ai-sharing   — interpreted, number-free context may be returned to the AI
 *     memory       — interpretations may be stored locally and read back
 *
 * The camera starts lazily on the first get_body_context call and stops after ATTUNE_IDLE_MS
 * (default 2 min) without calls, so it never runs just because the host app is open.
 *
 * Purposes (lenses): get_body_context takes a purpose (companion, yoga, casual, …). The AI may only SUGGEST one;
 * the person approves which app may use which lens in Attune → Connectors (src/privacy/appApprovals.js, shared
 * with the web server through one absolute file and re-read on every call). An app with no approvals entry may
 * use the companion lens only. Every get_body_context call is recorded in the number-free activity log.
 * App identity: ATTUNE_APP_ID, else the MCP client's name, else claude-desktop (or chatgpt with --chatgpt).
 *
 * Tools: get_attune_status · get_body_context · list_purposes · record_correction · memory_get · memory_append · forget_me
 * Uses the real SmartSpectra SDK by default; ATTUNE_ADAPTER=mock (or --demo) runs on synthetic vitals.
 */
const path = require('path');

// Desktop apps and tunnel clients can launch this script from a different working directory.
if (require.main === module) {
  try { process.loadEnvFile(); } catch {
    try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch {}
  }
}
const { createSession } = require('./session');
const { createMemory } = require('./memory');
const { createAdapter, isDemo } = require('./adapter');
const { createConsent, parseConsentString } = require('./privacy/consent');
const { createSensing } = require('./sensing');
const { createCapabilities } = require('./privacy/capabilities');
const { createContextBridge } = require('./contextBridge');
const { normalizeInsight } = require('./insights/normalizer');
const { getLens, listLenses, DEFAULT_LENS } = require('./lenses');
const { createAppApprovals, defaultAppsFile, slugAppId, isAppId, labelFor } = require('./privacy/appApprovals');
const { createActivityLog, defaultActivityFile } = require('./activity');

function createConnectorCore({
  consentString = process.env.ATTUNE_CONSENT,
  adapterFactory = () => createAdapter(),
  memory = createMemory(),
  idleMs = Number(process.env.ATTUNE_IDLE_MS) || 120000,
  log = (m) => process.stderr.write(`[attune-sense] ${m}\n`),
  consentHint = 'Set ATTUNE_CONSENT="sensing,presage-ack,ai-sharing" in the MCP client configuration.',
  appId = process.env.ATTUNE_APP_ID, // fixed identity (if valid); otherwise clientName, then defaultAppId
  clientName = () => null,           // MCP client's clientInfo.name, once known
  defaultAppId = 'claude-desktop',
  approvals = createAppApprovals(defaultAppsFile(isDemo())),
  activity = createActivityLog(defaultActivityFile(isDemo())),
} = {}) {
  const requested = parseConsentString(consentString);
  const simulated = isDemo();
  const consent = createConsent();
  const capabilities = createCapabilities({ consent });
  const bridge = createContextBridge({ capabilities });
  consent.onChange(() => bridge.onConsentChange());
  memory.setMuted(!requested.memory);
  // Sharing/memory scopes come from the human's config; sensing is granted lazily on first request.
  consent.grant({ aiSharing: requested.aiSharing, memory: requested.memory });

  /** Which app is asking. Resolved per call: the client name is only known after the MCP handshake. */
  function currentApp() {
    if (isAppId(appId)) return appId;
    let name = null;
    try { name = clientName(); } catch {}
    return slugAppId(name) || defaultAppId;
  }
  const appName = (id) => { try { const a = approvals.get(id); if (a) return a.name; } catch {} return labelFor(id); };
  function record(event) { try { activity.append(event); } catch {} }

  let session = createSession({ simulatedSignals: simulated });
  const sensing = createSensing({
    adapterFactory,
    consent,
    log,
    onStart: (gen) => {
      session = createSession({ memory: requested.memory ? memory : null, simulatedSignals: simulated });
      bridge.openSession(gen);
    },
    onSample: (sample, gen) => { session.ingest(sample); bridge.update(session.getApprovedContext(), gen); bridge.updateSnapshot(session.getNeutralSnapshot(), gen); },
    onInsight: (insight, gen) => bridge.addInsight(normalizeInsight(insight, { requested: insight.requested }), gen),
    onStop: () => bridge.closeSession(),
  });

  let idleTimer = null;
  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { consent.revoke(['sensing']); }, idleMs);
    if (idleTimer.unref) idleTimer.unref();
  }

  const canSense = () => requested.sensing && requested.presageAck;
  const canShare = () => requested.aiSharing;

  function status() {
    const s = sensing.status();
    return {
      sensingAllowed: canSense(),
      aiSharingAllowed: canShare(),
      memoryAllowed: requested.memory,
      sensing: s.state,
      ...(s.error ? { error: s.error } : {}),
      howToEnable: canSense() && canShare() ? undefined
        : consentHint,
    };
  }

  /**
   * get_body_context({ purpose }) — purpose is a lens id (default companion). The lens must be approved for
   * this app by the person; the camera never starts for an unknown or unapproved purpose.
   */
  async function getBodyContext({ purpose } = {}) {
    const app = currentApp();
    const lens = getLens(purpose == null || purpose === '' ? DEFAULT_LENS : String(purpose).slice(0, 60));
    if (!canSense() || !canShare()) {
      record({ kind: 'context', app, lens: lens ? lens.id : null, state: 'consent_required', say: false });
      return { state: 'consent_required', say: false, ...status() };
    }
    if (!lens) {
      record({ kind: 'unknown', app, lens: null, state: 'unknown_purpose', say: false });
      return { state: 'unknown_purpose', say: false, availablePurposes: listLenses().map((l) => l.id) };
    }
    if (!approvals.isApproved(app, lens.id)) {
      let wasPending = false;
      try {
        wasPending = approvals.pending().some((p) => p.app === app && p.lens === lens.id);
        approvals.recordRequest(app, lens.id);
      } catch {}
      record({ kind: wasPending ? 'denied' : 'request', app, lens: lens.id, state: 'purpose_not_approved', say: false });
      return { state: 'purpose_not_approved', lens: lens.id, say: false,
        howToEnable: `Open Attune → Connectors and allow ${appName(app)} to use ${lens.name}.` };
    }
    if (sensing.status().state !== 'active') {
      consent.grant({ sensing: true, presageAck: true });
      await sensing.settled();
    }
    touch();
    if (sensing.status().state !== 'active') {
      record({ kind: 'context', app, lens: lens.id, state: 'unavailable', say: false });
      return { state: 'unavailable', say: false, error: sensing.status().error };
    }
    // A capability limited to the app's CURRENT approvals (re-read now), used for this one read only.
    const cap = capabilities.issue({ scope: 'aiSharing', purpose: `mcp:${app}`, lenses: approvals.approvedLenses(app) });
    let ctx;
    try { ctx = bridge.getLensContext(cap, lens.id); } finally { capabilities.revoke(cap); } // immediate cache read
    if (ctx.state === 'off') ctx = { ...ctx, state: 'starting' };
    record({ kind: ctx.state === 'purpose_not_approved' ? 'denied' : 'context', app, lens: lens.id, state: ctx.state, say: !!ctx.say });
    return ctx;
  }

  /** Read-only: the purposes this connector knows and whether the person approved each one for this app. */
  function listPurposes() {
    const app = currentApp();
    let approved = [];
    try { approved = approvals.approvedLenses(app); } catch {}
    return { app, purposes: listLenses().map(({ id, name, description, sharesNumbers }) => ({ id, name, description, sharesNumbers, approved: approved.includes(id) })) };
  }

  function recordCorrection({ wasAccurate }) {
    if (sensing.status().state !== 'active') return { ok: false, reason: 'sensing is not active' };
    return session.recordCorrection({ wasAccurate });
  }

  function memoryGet() {
    if (!requested.memory || !canShare()) return { memory: 'disabled', reason: 'memory and ai-sharing consent are both required' };
    return memory.summary();
  }

  function memoryAppend({ note }) {
    if (!requested.memory) return { ok: false, reason: 'memory consent is off' };
    memory.append({ type: 'note', note: String(note).slice(0, 500) });
    return { ok: true };
  }

  async function shutdown() {
    clearTimeout(idleTimer);
    await sensing.shutdown();
  }

  return { bridge, status, getBodyContext, listPurposes, appId: currentApp, recordCorrection, memoryGet, memoryAppend, forget: () => { memory.clear(); return { cleared: true }; }, shutdown, sensing };
}

async function main() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = require('zod');

  const chatgpt = process.argv.includes('--chatgpt');
  let server = null;
  const clientName = () => { const v = server && server.server.getClientVersion(); return v && v.name; };
  const core = chatgpt ? createConnectorCore({
    consentString: process.env.ATTUNE_CHATGPT_CONSENT === 'sensing,presage-ack,ai-sharing' ? process.env.ATTUNE_CHATGPT_CONSENT : '',
    consentHint: 'Set ATTUNE_CHATGPT_CONSENT in the local tunnel client environment and restart the client.',
    clientName, defaultAppId: 'chatgpt',
  }) : createConnectorCore({ clientName });
  const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
  server = new McpServer({ name: 'attune-sense', version: '0.3.0' });
  const purposeHelp = listLenses().map((l) => `"${l.id}" (${l.name})`).join(', ');

  server.registerTool('get_attune_status',
    { description: 'Read-only: whether the user has allowed sensing / AI sharing / memory, and whether sensing is running.', inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => text(core.status()));

  server.registerTool('get_body_context',
    {
      description:
        'Call before a reply. Pass the purpose that matches the task: emotional support → "companion" (default), ' +
        'breathing or yoga practice → "yoga", light conversation → "casual". Returns {lens, state, say, directive, ' +
        'suggestedUtterance, confidence} — interpreted guidance, never measurements unless that purpose explicitly ' +
        'shares them. If say=true let directive shape your tone (be tentative, invite correction). If state is "unclear", ' +
        '"consent_required" or "unavailable", say nothing about the body. You cannot approve a purpose yourself: if state ' +
        'is "purpose_not_approved", tell the user they can allow it in Attune (see howToEnable) and carry on without it; ' +
        'if "unknown_purpose", pick one of availablePurposes. Non-medical; not a diagnosis; not lie-detection.',
      inputSchema: { purpose: z.string().max(60).optional().describe(`Lens id for this task. Known: ${purposeHelp}. Default "${DEFAULT_LENS}".`) },
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
    async () => text(core.listPurposes()));

  if (!chatgpt) {
    server.registerTool('record_correction',
      { description: 'The user corrected the read (e.g. "I\'m fine"). Pass wasAccurate=false to make it more conservative.', inputSchema: { wasAccurate: z.boolean() } },
      async ({ wasAccurate }) => text(core.recordCorrection({ wasAccurate })));

    server.registerTool('memory_get',
      { description: 'Compact cross-session summary (interpretations only). Only available if the user enabled memory.', inputSchema: {} },
      async () => text(core.memoryGet()));

    server.registerTool('memory_append',
      { description: 'Note what mattered this session (no raw signals). Only works if the user enabled memory.', inputSchema: { note: z.string() } },
      async ({ note }) => text(core.memoryAppend({ note })));

    server.registerTool('forget_me',
      { description: 'Delete all local Attune memory for this user.', inputSchema: {} },
      async () => text(core.forget()));
  }

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await core.shutdown(); process.exit(0); });
  await server.connect(new StdioServerTransport());
  const st = core.status();
  process.stderr.write(`[attune-sense] MCP connector on stdio — sensing ${st.sensingAllowed ? 'allowed (starts on first request)' : 'not allowed'}, AI sharing ${st.aiSharingAllowed ? 'on' : 'off'}.\n`);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[attune-sense] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { createConnectorCore };
