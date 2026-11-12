'use strict';
/*
 * Real SmartSpectra adapter — maps the Presage Node SDK (@smartspectra/node-sdk v3.x) to our
 * onSample(sample) contract.
 *
 * SDK shape (from the package's index.d.ts):
 *   const sdk = new SmartSpectraSDK({ apiKey, requestedMetrics, enableTelemetry });
 *   sdk.on('metrics', (buf, tsUs) => decodeMetrics(buf));   // protobuf presage.smartspectra.Metrics
 *   sdk.useCamera(CameraSelection.default); sdk.start();  …  await sdk.stopAsync(); await sdk.destroy();
 *
 * Signals used (per the model cards): pulse rate + facial expression + talking (+ blinking).
 * Live HRV/breathing are NOT used (30-60s windows; breathing fails while talking). Metric packets
 * are partial, so we keep the last-known value of each signal and drop it once stale. Low-confidence
 * or missing signals pass through as low-confidence samples so the interpreter enters "unclear".
 */

const STALE_MS = 3000;

// presage.smartspectra.ExpressionType → interpreter vocabulary
const EXPRESSION_NAMES = {
  1: 'anger',    // ANGRY
  2: 'tense',    // CONTEMPT
  3: 'tense',    // DISGUST
  4: 'fear',     // FEAR
  5: 'smile',    // HAPPY
  6: 'neutral',  // NEUTRAL
  7: 'sad',      // SAD
  8: 'surprise', // SURPRISE
};

const last = (arr) => (Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null);

/**
 * Pull the newest readings out of one decoded Metrics packet. Returns only the fields present.
 * Confidence in the SDK is a percentage [0,100]; the interpreter uses [0,1].
 */
function extractMetrics(m) {
  const out = {};
  const pulse = last(m && m.cardio && m.cardio.pulseRate);
  if (pulse && typeof pulse.value === 'number' && pulse.value > 0) {
    out.pulseBpm = pulse.value;
    out.pulseConfidence = typeof pulse.confidence === 'number' ? pulse.confidence / 100 : (pulse.stable ? 0.8 : 0.3);
  }
  const expr = last(m && m.face && m.face.expression);
  if (expr && Array.isArray(expr.scores) && expr.scores.length) {
    const top = expr.scores.reduce((a, b) => ((b.confidence || 0) > (a.confidence || 0) ? b : a));
    out.expression = EXPRESSION_NAMES[top.type] || 'unknown';
    out.expressionConfidence = (top.confidence || 0) / 100;
  }
  const talking = last(m && m.face && m.face.talking);
  if (talking) out.talking = !!talking.detected;
  return out;
}

/** Stateful mapper: merges partial packets into full samples, expiring stale signals. */
function createMapper() {
  const state = { pulse: null, expr: null, talking: null };
  return function map(decoded, nowMs = Date.now()) {
    const x = extractMetrics(decoded);
    if (x.pulseBpm != null) state.pulse = { bpm: x.pulseBpm, conf: x.pulseConfidence, t: nowMs };
    if (x.expression != null) state.expr = { name: x.expression, conf: x.expressionConfidence, t: nowMs };
    if (x.talking != null) state.talking = { on: x.talking, t: nowMs };
    const fresh = (v) => v && nowMs - v.t <= STALE_MS;
    return {
      tMs: nowMs,
      pulseBpm: fresh(state.pulse) ? state.pulse.bpm : null,
      pulseConfidence: fresh(state.pulse) ? state.pulse.conf : 0,
      expression: fresh(state.expr) ? state.expr.name : 'unknown',
      expressionConfidence: fresh(state.expr) ? state.expr.conf : 0,
      talking: fresh(state.talking) ? state.talking.on : false,
      speechFast: false, // not provided by the SDK
    };
  };
}

const LOW_CONFIDENCE = () => ({
  tMs: Date.now(), pulseBpm: null, pulseConfidence: 0,
  expression: 'unknown', expressionConfidence: 0, talking: false, speechFast: false,
});

function createSmartSpectraAdapter({ apiKey, log = (m) => process.stderr.write(`[attune] ${m}\n`) } = {}) {
  let sdk = null;

  return {
    name: 'smartspectra',
    extractMetrics, // exported for unit-testing the mapping against real decodeMetrics output

    start(onSample) {
      if (!apiKey) throw new Error('SMARTSPECTRA_API_KEY is required for the smartspectra adapter.');
      let lib;
      try {
        lib = require('@smartspectra/node-sdk');
      } catch (e) {
        throw new Error(`could not load @smartspectra/node-sdk (${e.message}). Run \`npm install\`.`);
      }
      const { SmartSpectraSDK, CameraSelection, MetricType, decodeMetrics } = lib;
      const map = createMapper();

      sdk = new SmartSpectraSDK({
        apiKey,
        enableTelemetry: false,
        requestedMetrics: [MetricType.PULSE_RATE, MetricType.EXPRESSIONS, MetricType.TALKING, MetricType.BLINKING],
      });
      sdk.on('metrics', (buf) => {
        try {
          onSample(map(decodeMetrics(buf), Date.now()));
        } catch (err) {
          onSample(LOW_CONFIDENCE()); // decode failure → interpreter goes "unclear"
        }
      });
      sdk.on('validationStatus', (code, _ts, hint) => { if (code) log(`validation ${code}: ${hint}`); });
      sdk.on('processingStatus', (status) => log(`processing status ${status}`));
      sdk.on('error', (code, message, retryable) => {
        log(`SmartSpectra error ${code}: ${message}${retryable ? ' (retryable)' : ''}`);
        onSample(LOW_CONFIDENCE());
      });

      sdk.useCamera(CameraSelection.default);
      sdk.start();
      log('SmartSpectra capture started on the default camera');
    },

    async stop() {
      if (!sdk) return;
      const s = sdk;
      sdk = null;
      try { await s.stopAsync(); } catch {}
      try { await s.destroy(); } catch {}
    },
  };
}

module.exports = { createSmartSpectraAdapter, extractMetrics, createMapper };
