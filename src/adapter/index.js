'use strict';
/*
 * Adapter factory. Default = mock (runs anywhere). Set ATTUNE_ADAPTER=smartspectra to use the real
 * SDK (needs SMARTSPECTRA_API_KEY and a webcam). The real SDK runs in a separate worker process by
 * default (plan M1-04); ATTUNE_ISOLATE=0 runs it in-process, ATTUNE_ISOLATE=1 also isolates the mock.
 */
const { createMockAdapter } = require('./mock');

// Pick up SMARTSPECTRA_API_KEY / ATTUNE_ADAPTER from a local .env if present (never committed).
try { process.loadEnvFile(); } catch {}

function createAdapter(opts = {}) {
  const kind = (process.env.ATTUNE_ADAPTER || 'mock').toLowerCase() === 'smartspectra' ? 'smartspectra' : 'mock';
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

module.exports = { createAdapter };
