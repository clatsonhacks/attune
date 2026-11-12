'use strict';
/*
 * Adapter factory. Default = mock (runs anywhere). Set ATTUNE_ADAPTER=smartspectra to use the real
 * SDK (needs `npm i @smartspectra/node-sdk`, SMARTSPECTRA_API_KEY, and a webcam).
 */
const { createMockAdapter } = require('./mock');

// Pick up SMARTSPECTRA_API_KEY / ATTUNE_ADAPTER from a local .env if present (never committed).
try { process.loadEnvFile(); } catch {}

function createAdapter(opts = {}) {
  if ((process.env.ATTUNE_ADAPTER || 'mock').toLowerCase() === 'smartspectra') {
    const { createSmartSpectraAdapter } = require('./smartspectra');
    return createSmartSpectraAdapter({ apiKey: process.env.SMARTSPECTRA_API_KEY, ...opts });
  }
  return createMockAdapter(opts);
}

module.exports = { createAdapter };
