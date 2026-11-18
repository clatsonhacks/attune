'use strict';
/*
 * Real SmartSpectra adapter — maps the Presage Node SDK (@smartspectra/node-sdk 3.5.0) to our
 * start(onSample, { onInsight, onError }) contract.
 *
 * SDK shape (from the package's index.d.ts):
 *   const sdk = new SmartSpectraSDK({ apiKey, requestedMetrics, enableTelemetry });
 *   sdk.on('metrics', (buf, tsUs))  → decodeMetrics(buf) → presage.smartspectra.Metrics
 *   sdk.on('insight', (buf, requestId)) → our decoder (src/insights/decoder.js); the SDK ships none
 *   sdk.useCamera(CameraSelection.default); sdk.start(); … await sdk.stopAsync(); await sdk.destroy();
 *
 * Metrics: breathing + cardio sets (required by Presage for Insights) plus expressions/talking/blinking.
 * Packets are partial, so each signal keeps its last value and expires after STALE_MS. Low-confidence or
 * missing signals pass through as low-confidence samples so the interpreter enters "unclear".
 *
 * Insights: Presage fires them automatically (≈15 s after start, then every 60 s) and on requestInsight().
 * They are never awaited; they arrive later through onInsight. Requested vs automatic is decided by
 * request id, as Presage's docs advise (the `type` field is always VITALS today).
 */
const { decodeInsight } = require('../insights/decoder');

const STALE_MS = 3000;
const INSIGHT_MIN_INTERVAL_MS = 30000; // rate limit for user-requested insights

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
const pct = (c, stable) => (typeof c === 'number' ? c / 100 : stable ? 0.8 : 0.3);

/**
 * Pull the newest readings out of one decoded Metrics packet. Returns only the fields present.
 * Confidence in the SDK is a percentage [0,100]; the interpreter uses [0,1].
 */
function extractMetrics(m) {
  const out = {};
  const pulse = last(m && m.cardio && m.cardio.pulseRate);
  if (pulse && typeof pulse.value === 'number' && pulse.value > 0) {
    out.pulseBpm = pulse.value;
    out.pulseConfidence = pct(pulse.confidence, pulse.stable);
  }
  const breath = last(m && m.breathing && m.breathing.rate);
  if (breath && typeof breath.value === 'number' && breath.value > 0) {
    out.breathingRate = breath.value;
    out.breathingConfidence = pct(breath.confidence, breath.stable);
  }
  const hrv = last(m && m.cardio && m.cardio.hrv);
  if (hrv && typeof hrv.rmssd === 'number' && hrv.rmssd > 0) {
    out.hrvMs = hrv.rmssd;
    out.hrvConfidence = pct(hrv.confidence, hrv.stable);
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
  const state = {};
  const keep = (k, v, conf, t) => { state[k] = { v, conf, t }; };
  return function map(decoded, nowMs = Date.now()) {
    const x = extractMetrics(decoded);
    if (x.pulseBpm != null) keep('pulse', x.pulseBpm, x.pulseConfidence, nowMs);
    if (x.breathingRate != null) keep('breath', x.breathingRate, x.breathingConfidence, nowMs);
    if (x.hrvMs != null) keep('hrv', x.hrvMs, x.hrvConfidence, nowMs);
    if (x.expression != null) keep('expr', x.expression, x.expressionConfidence, nowMs);
    if (x.talking != null) keep('talking', x.talking, 1, nowMs);
    const f = (k) => (state[k] && nowMs - state[k].t <= STALE_MS ? state[k] : null);
    return {
      tMs: nowMs,
      pulseBpm: f('pulse') ? f('pulse').v : null,
      pulseConfidence: f('pulse') ? f('pulse').conf : 0,
      expression: f('expr') ? f('expr').v : 'unknown',
      expressionConfidence: f('expr') ? f('expr').conf : 0,
      talking: f('talking') ? f('talking').v : false,
      speechFast: false, // not provided by the SDK
      // Slow signals keep a longer window: breathing/HRV update every several seconds.
      breathingRate: state.breath && nowMs - state.breath.t <= 20000 ? state.breath.v : null,
      breathingConfidence: state.breath && nowMs - state.breath.t <= 20000 ? state.breath.conf : 0,
      hrvMs: state.hrv && nowMs - state.hrv.t <= 90000 ? state.hrv.v : null,
      hrvConfidence: state.hrv && nowMs - state.hrv.t <= 90000 ? state.hrv.conf : 0,
    };
  };
}

const LOW_CONFIDENCE = () => ({
  tMs: Date.now(), pulseBpm: null, pulseConfidence: 0,
  expression: 'unknown', expressionConfidence: 0, talking: false, speechFast: false,
});

const CHEST_NOT_VISIBLE = 7;          // ValidationCode.kChestNotVisible
const CHEST_FALLBACK_MS = 20000;
const PROCESSING = { 0: 'uninitialized', 1: 'idle', 2: 'starting', 3: 'running', 4: 'stopping', 5: 'error' };

/**
 * full: breathing + cardio (what Presage Insights need; needs face AND chest in view) + face signals.
 * face: pulse + face signals only — works with just a face in view, no breathing/HRV/Insights.
 */
function createSdk({ SmartSpectraSDK, MetricType, breathingMetrics, cardioMetrics }, mode, apiKey) {
  const face = [MetricType.EXPRESSIONS, MetricType.TALKING, MetricType.BLINKING];
  return new SmartSpectraSDK({
    apiKey,
    enableTelemetry: false, // SDK telemetry only; does NOT stop Insights/auth traffic to Presage
    requestedMetrics: mode === 'full' ? [...breathingMetrics, ...cardioMetrics, ...face] : [MetricType.PULSE_RATE, ...face],
  });
}

// SmartSpectraErrorCode values that mean the camera/device went away rather than a transient hiccup.
const DEVICE_LOST = /camera|device|input|unavailable|disconnect/i;

function createSmartSpectraAdapter({ apiKey, log = (m) => process.stderr.write(`[attune] ${m}\n`) } = {}) {
  let sdk = null;
  const pending = new Set(); // request ids we asked for
  let lastRequestAt = 0;

  return {
    name: 'smartspectra',
    extractMetrics, // exported for unit-testing the mapping against real decodeMetrics output

    start(onSample, { onInsight = () => {}, onError = () => {}, onStatus = () => {} } = {}) {
      if (!apiKey) throw new Error('SMARTSPECTRA_API_KEY is required for the smartspectra adapter.');
      let lib;
      try {
        lib = require('@smartspectra/node-sdk');
      } catch (e) {
        throw new Error(`could not load @smartspectra/node-sdk (${e.message}). Run \`npm install\`.`);
      }
      const { CameraSelection, decodeMetrics } = lib;
      const map = createMapper();
      const startedAt = Date.now();
      let everOk = false;
      let mode = process.env.ATTUNE_METRICS === 'face' ? 'face' : 'full';

      const launch = () => {
        sdk = createSdk(lib, mode, apiKey);
        wire(sdk);
        sdk.useCamera(CameraSelection.default);
        sdk.start();
        log(`SmartSpectra capture started on the default camera (${mode === 'full' ? 'face + chest' : 'face only'})`);
        onStatus({ mode });
      };

      // Breathing (and so Presage Insights) needs the chest in view. At a laptop that often isn't possible:
      // if the only thing blocking measurement for 20 s is "chest not visible", restart with face-only metrics.
      const maybeFallBack = async (code) => {
        if (mode !== 'full' || everOk || code !== CHEST_NOT_VISIBLE || Date.now() - startedAt < CHEST_FALLBACK_MS || !sdk) return;
        mode = 'face';
        const old = sdk;
        sdk = null;
        log('chest not visible for 20 s — continuing with face-only metrics (no breathing / Presage check-ins)');
        try { await old.stopAsync(); } catch {}
        try { await old.destroy(); } catch {}
        launch();
      };

      function wire(s) {
      s.on('metrics', (buf) => {
        try {
          onSample(map(decodeMetrics(buf), Date.now()));
        } catch (err) {
          onSample(LOW_CONFIDENCE()); // decode failure → interpreter goes "unclear"
        }
      });
      s.on('insight', (buf, requestId) => {
        try {
          const insight = decodeInsight(buf);
          const id = typeof requestId === 'number' ? requestId : insight.requestId;
          const requested = pending.delete(id);
          onInsight({ ...insight, requestId: id, requested });
        } catch (e) {
          log(`could not decode an Insight (${e.message})`);
        }
      });
      // A non-zero validation code (e.g. "No face found") means no metrics will arrive, so feed the
      // interpreter low-confidence samples → state "unclear". Log only when the status changes.
      // The hint ("Move up…") is passed to the UI so the person can fix their position.
      let lastValidation = -1;
      s.on('validationStatus', (code, _ts, hint) => {
        if (code !== lastValidation) {
          log(code ? `validation ${code}: ${hint}` : 'validation ok: face found');
          onStatus({ validationCode: code, hint: code ? String(hint || '') : '' });
        }
        lastValidation = code;
        if (!code) everOk = true;
        if (code) { onSample(LOW_CONFIDENCE()); maybeFallBack(code); }
      });
      s.on('processingStatus', (status) => {
        log(`processing status ${status}`);
        onStatus({ processing: PROCESSING[status] || String(status) });
      });
      s.on('error', (code, message, retryable) => {
        log(`SmartSpectra error ${code}: ${message}${retryable ? ' (retryable)' : ''}`);
        onSample(LOW_CONFIDENCE());
        if (!retryable) onError({ code: DEVICE_LOST.test(String(message)) ? 'device_unavailable' : 'sdk_error', message: String(message) });
      });
      }

      launch();
    },

    /** User-initiated on-demand Insight. Returns the request id, or null if rate-limited/not running. */
    requestInsight(text) {
      if (!sdk) return null;
      const now = Date.now();
      if (now - lastRequestAt < INSIGHT_MIN_INTERVAL_MS) return null;
      lastRequestAt = now;
      const id = sdk.requestInsight(String(text).slice(0, 500));
      pending.add(id);
      return id;
    },

    async stop() {
      if (!sdk) return;
      const s = sdk;
      sdk = null;
      pending.clear();
      try { await s.stopAsync(); } catch {}
      try { await s.destroy(); } catch {}
    },
  };
}

module.exports = { createSmartSpectraAdapter, extractMetrics, createMapper };
