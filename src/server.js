'use strict';
/*
 * Attune MCP connector (Shape A) — a local stdio MCP server that Claude/ChatGPT desktop connects to.
 * Tools:
 *   grant_consent({ allow })      — consent gate; body-context is withheld until allow=true
 *   get_body_context()            — the interpreted nudge the AI reads before replying (never raw numbers)
 *   record_correction({ wasAccurate }) — user corrected the read; makes it more conservative + remembers
 *   memory_get()                  — compact cross-session summary (interpretations only)
 *   memory_append({ note })       — note what mattered (no raw signals)
 *   forget_me()                   — delete local memory
 *
 * Uses the mock adapter by default; set ATTUNE_ADAPTER=smartspectra to use the real SDK.
 * The @modelcontextprotocol/sdk is ESM, so it is loaded via dynamic import from this CommonJS file.
 * NOTE: confirm the SDK tool API against the installed version (`npm ls @modelcontextprotocol/sdk`).
 */
const { createSession } = require('./session');
const { createMemory } = require('./memory');
const { createAdapter } = require('./adapter');

async function main() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = require('zod');

  const memory = createMemory();
  const session = createSession({ memory });
  const adapter = createAdapter(); // mock by default; ATTUNE_ADAPTER=smartspectra for the real SDK
  adapter.start((sample) => session.ingest(sample)); // throws with a clear message if the SDK can't start

  let consented = false;
  const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

  const server = new McpServer({ name: 'attune-sense', version: '0.1.0' });

  server.registerTool(
    'grant_consent',
    {
      description:
        'Consent gate. Attune shares INTERPRETED body-signals (never raw video/vitals) with this AI. ' +
        'Call with allow=true to enable, allow=false to revoke.',
      inputSchema: { allow: z.boolean() },
    },
    async ({ allow }) => {
      consented = !!allow;
      return text({ consent: consented });
    },
  );

  server.registerTool(
    'get_body_context',
    {
      description:
        'Call before each reply. Returns {state, say, directive, suggestedUtterance, evidence, confidence}. ' +
        'If say=true let directive shape your tone (be tentative, invite correction). If state="unclear", say ' +
        'nothing about the body. Never read raw numbers aloud. Non-medical; not a diagnosis; not lie-detection.',
      inputSchema: {},
    },
    async () => {
      if (!consented) return text({ state: 'consent_required', say: false });
      return text(session.getBodyContext());
    },
  );

  server.registerTool(
    'record_correction',
    {
      description: 'The user corrected the read (e.g. "I\'m fine"). Pass wasAccurate=false to make it more conservative.',
      inputSchema: { wasAccurate: z.boolean() },
    },
    async ({ wasAccurate }) => text(session.recordCorrection({ wasAccurate })),
  );

  server.registerTool(
    'memory_get',
    { description: 'Compact cross-session summary (interpretations only). Load at conversation start.', inputSchema: {} },
    async () => text(memory.summary()),
  );

  server.registerTool(
    'memory_append',
    { description: 'Note what mattered this session (no raw signals).', inputSchema: { note: z.string() } },
    async ({ note }) => {
      memory.append({ type: 'note', note });
      return text({ ok: true });
    },
  );

  server.registerTool(
    'forget_me',
    { description: 'Delete all local Attune memory for this user.', inputSchema: {} },
    async () => {
      memory.clear();
      return text({ cleared: true });
    },
  );

  await server.connect(new StdioServerTransport());
  process.stderr.write(`[attune-sense] MCP connector running on stdio (adapter: ${adapter.name}). Consent required before body-context is shared.\n`);
}

main().catch((e) => {
  process.stderr.write(`[attune-sense] fatal: ${e.stack || e.message}\n`);
  process.exit(1);
});
