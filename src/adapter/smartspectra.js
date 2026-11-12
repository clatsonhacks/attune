'use strict';
/*
 * Real SmartSpectra adapter — maps the Presage Node SDK to our onSample(sample) contract.
 *
 * ⚠️ VERIFY ON YOUR MACHINE. Written from the SDK's documented shape:
 * `@smartspectra/node-sdk`, config with API key + enableTelemetry, `start()`, a metrics callback
 * delivering buffers decoded by `decodeMetrics(buf)` (µs timestamps), `requestInsight()` for LLM
 * insights. The EXACT method/field names must be confirmed against your installed version
 * (`npm ls @smartspectra/node-sdk` + its README) — the SDK is native and could not be installed/run
 * in a sandbox. The sample-mapping below is the stable part; adjust the wiring to match.
 *
 * Signals used (per the model cards): pulse (12s avg, 40-110 BPM) + facial expression + blink/talking.
 * Live HRV/breathing are NOT used (30-60s windows; breathing fails while talking). Low-confidence
 * frames pass through as low-confidence samples so the interpreter enters "unclear" (degraded mode).
 */

// Map an SDK metrics object to our sample. Field names are best-effort — confirm against decodeMetrics output.
function mapMetrics(m, nowMs) {
  const g = (obj, ...keys) => { for (const k of keys) if (obj && obj[k] != null) return obj[k]; return undefined; };
  const pulse = g(m, 'pulseRate', 'pulse', 'heartRate', 'hr');
  const pulseConf = g(m, 'pulseConfidence', 'pulseRateConfidence', 'hrConfidence');
  const expression = g(m, 'expression', 'facialExpression', 'emotion');
  const exprConf = g(m, 'expressionConfidence', 'faceConfidence');
  const talking = g(m, 'talking', 'isTalking', 'speaking');
  return {
    tMs: typeof nowMs === 'number' ? nowMs : Date.now(),
    pulseBpm: typeof pulse === 'number' ? pulse : null,
    pulseConfidence: typeof pulseConf === 'number' ? pulseConf : (pulse != null ? 0.8 : 0),
    expression: expression || 'unknown',
    expressionConfidence: typeof exprConf === 'number' ? exprConf : (expression ? 0.7 : 0),
    talking: !!talking,
    speechFast: !!g(m, 'speechFast', 'fastSpeech'),
  };
}

function createSmartSpectraAdapter({ apiKey } = {}) {
  let sdk = null;
  let running = false;

  return {
    name: 'smartspectra',
    mapMetrics, // exported for unit-testing the mapping against real decodeMetrics output

    async start(onSample) {
      if (!apiKey) throw new Error('[attune] SMARTSPECTRA_API_KEY is required for the smartspectra adapter.');
      try {
        sdk = require('@smartspectra/node-sdk'); // confirm package name/exports on your machine
      } catch (e) {
        throw new Error('[attune] `@smartspectra/node-sdk` not installed. Run `npm i @smartspectra/node-sdk` (needs a webcam + the Presage host reachable).');
      }

      // --- Configure (CONFIRM the exact API against your installed version) ---
      // Use pulse + facial-expression/blink/talking only; disable telemetry; keep insights out of the hot loop.
      const config = {
        apiKey,
        enableTelemetry: false,
        requestedMetrics: ['pulse', 'face', 'expression', 'blink', 'talking'],
        // capture defaults to 1280x720@30fps per the SDK docs
      };
      if (typeof sdk.configure === 'function') await sdk.configure(config);
      else if (typeof sdk.init === 'function') await sdk.init(config);

      // --- Subscribe to metrics (CONFIRM the callback API) ---
      const handle = (buf) => {
        try {
          const decoded = typeof sdk.decodeMetrics === 'function' ? sdk.decodeMetrics(buf) : buf;
          onSample(mapMetrics(decoded, Date.now()));
        } catch (err) {
          // On a decode/validation failure, emit a low-confidence sample so the interpreter goes "unclear".
          onSample({ tMs: Date.now(), pulseBpm: null, pulseConfidence: 0, expression: 'unknown', expressionConfidence: 0, talking: false });
        }
      };
      if (typeof sdk.onMetrics === 'function') sdk.onMetrics(handle);
      else if (typeof sdk.on === 'function') sdk.on('metrics', handle);

      if (typeof sdk.start === 'function') await sdk.start();
      running = true;
    },

    stop() {
      try { if (running && sdk && typeof sdk.stop === 'function') sdk.stop(); } catch {}
      running = false;
    },
  };
}

module.exports = { createSmartSpectraAdapter, mapMetrics };
