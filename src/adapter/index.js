'use strict';
/*
 * Adapter factory. Real by default: the SmartSpectra SDK (needs SMARTSPECTRA_API_KEY and a webcam), run in a
 * separate worker process (plan M1-04). Demo mode — synthetic vitals, no camera — only when asked for:
 * ATTUNE_ADAPTER=mock or the --demo flag. ATTUNE_ISOLATE=0 runs the SDK in-process; =1 also isolates the mock.
 */
const { createMockAdapter } = require('./mock');

// Pick up SMARTSPECTRA_API_KEY / ATTUNE_ADAPTER / GROQ_API_KEY from a local .env (never committed).
try { process.loadEnvFile(); } catch {}

/** 'smartspectra' (real, default) or 'mock' (demo). */
function adapterKind() {
  if (process.argv.includes('--demo')) return 'mock';
  return (process.env.ATTUNE_ADAPTER || 'smartspectra').toLowerCase() === 'mock' ? 'mock' : 'smartspectra';
}

const isDemo = () => adapterKind() === 'mock';

function createAdapter(opts = {}) {
  const kind = adapterKind();
  const iso = process.env.ATTUNE_ISOLATE;
  const isolate = kind === 'smartspectra' ? iso !== '0' : iso === '1';
  if (isolate) {
    const { createIsolatedAdapter } = require('./isolated');
    return createIsolatedAdapter({ kind, env: opts.intervalMs ? { ATTUNE_TICK_MS: String(opts.intervalMs) } : {} });
  }
  if (kind === 'smartspectra') {
    const { createSmartSpectraAdapter } = require('./smartspectra');
    return createSmartSpectraAdapter({ apiKey: process.env.SMARTSPECTRA_API_KEY, ...opts });
  }
  return createMockAdapter(opts);
}

module.exports = { createAdapter, adapterKind, isDemo };
