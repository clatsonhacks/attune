'use strict';
/*
 * Attune MCP connector — a local stdio MCP server that Claude/ChatGPT desktop connects to.
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
 * Tools: get_attune_status · get_body_context · record_correction · memory_get · memory_append · forget_me
 * Uses the real SmartSpectra SDK by default; ATTUNE_ADAPTER=mock (or --demo) runs on synthetic vitals.
 */
const { createSession } = require('./session');
const { createMemory } = require('./memory');
const { createAdapter, isDemo } = require('./adapter');
const { createConsent, parseConsentString } = require('./privacy/consent');
const { createSensing } = require('./sensing');
const { createCapabilities } = require('./privacy/capabilities');
const { createContextBridge } = require('./contextBridge');
const { normalizeInsight } = require('./insights/normalizer');

function createConnectorCore({
  consentString = process.env.ATTUNE_CONSENT,
  adapterFactory = () => createAdapter(),
  memory = createMemory(),
  idleMs = Number(process.env.ATTUNE_IDLE_MS) || 120000,
  log = (m) => process.stderr.write(`[attune-sense] ${m}\n`),
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
  const cap = capabilities.issue({ scope: 'aiSharing', purpose: 'mcp-connector' });

  let session = createSession({ simulatedSignals: simulated });
  const sensing = createSensing({
    adapterFactory,
    consent,
    log,
    onStart: (gen) => {
      session = createSession({ memory: requested.memory ? memory : null, simulatedSignals: simulated });
      bridge.openSession(gen);
    },
    onSample: (sample, gen) => { session.ingest(sample); bridge.update(session.getApprovedContext(), gen); },
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
        : 'Consent is set by the user, not the AI: add ATTUNE_CONSENT="sensing,presage-ack,ai-sharing" to this connector\'s env in the host config.',
    };
  }

  async function getBodyContext() {
    if (!canSense() || !canShare()) return { state: 'consent_required', say: false, ...status() };
    if (sensing.status().state !== 'active') {
      consent.grant({ sensing: true, presageAck: true });
      await sensing.settled();
    }
    touch();
    if (sensing.status().state !== 'active') return { state: 'unavailable', say: false, error: sensing.status().error };
    const ctx = bridge.getApprovedContext(cap); // immediate cache read
    return ctx.state === 'off' ? { ...ctx, state: 'starting' } : ctx;
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

  return { bridge, status, getBodyContext, recordCorrection, memoryGet, memoryAppend, forget: () => { memory.clear(); return { cleared: true }; }, shutdown, sensing };
}

async function main() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = require('zod');

  const core = createConnectorCore();
  const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });
  const server = new McpServer({ name: 'attune-sense', version: '0.2.0' });

  server.registerTool('get_attune_status',
    { description: 'Read-only: whether the user has allowed sensing / AI sharing / memory, and whether sensing is running.', inputSchema: {} },
    async () => text(core.status()));

  server.registerTool('get_body_context',
    {
      description:
        'Call before a reply. Returns {state, say, directive, suggestedUtterance, confidence} — interpreted guidance, ' +
        'never measurements. If say=true let directive shape your tone (be tentative, invite correction). If state is ' +
        '"unclear", "consent_required" or "unavailable", say nothing about the body. Non-medical; not a diagnosis; not lie-detection.',
      inputSchema: {},
    },
    async () => text(await core.getBodyContext()));

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
