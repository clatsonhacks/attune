'use strict';
/*
 * Parallel signal "agents". Each runs off the same sample stream but on its own cadence and rules,
 * so the UI can show what's running. Honest about the SDK's limits:
 *   - pulse: 12s rolling average — the primary live read
 *   - expression/blink/talking: live every frame — supports pulse
 *   - breathing: needs ~30s of stillness + silence; PAUSES while talking
 *   - hrv: needs a full 60s low-motion window; gathers in the background
 * Breathing/HRV values here are derived (mock); with the real SDK they come from decodeMetrics.
 */
const SAMPLE_MS = 1000; // each mock sample ≈ 1s of logical data
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function createSignals() {
  let baseline = null;
  const bSamples = [];
  let pulse = null, pulseConf = 0, expr = 'unknown', exprConf = 0;
  let breathAcc = 0, breathVal = null, breathPaused = false;
  let hrvAcc = 0, hrvVal = null;

  function ingest(s) {
    const pOk = typeof s.pulseBpm === 'number' && s.pulseBpm >= 40 && s.pulseBpm <= 110 && (s.pulseConfidence == null || s.pulseConfidence >= 0.4);
    pulse = pOk ? s.pulseBpm : null;
    pulseConf = s.pulseConfidence == null ? (pOk ? 0.85 : 0) : s.pulseConfidence;
    expr = s.expression || 'unknown';
    exprConf = s.expressionConfidence == null ? (expr !== 'unknown' ? 0.7 : 0) : s.expressionConfidence;

    if (pOk && bSamples.length < 20) bSamples.push(s.pulseBpm);
    if (baseline === null && bSamples.length >= 8) baseline = bSamples.reduce((a, b) => a + b, 0) / bSamples.length;
    const delta = pOk && baseline ? s.pulseBpm - baseline : 0;

    // breathing — only accrues when still (good pulse) AND silent
    if (s.talking || !pOk) { breathPaused = !!s.talking; breathAcc = 0; breathVal = null; }
    else { breathPaused = false; breathAcc += SAMPLE_MS; if (breathAcc >= 30000) breathVal = Math.round(clamp(13 + delta * 0.45, 8, 26)); }

    // hrv — needs a long low-motion window
    if (!pOk) { hrvAcc = 0; hrvVal = null; }
    else { hrvAcc += SAMPLE_MS; if (hrvAcc >= 60000) hrvVal = Math.round(clamp(58 - delta * 1.2, 18, 75)); }
  }

  function snapshot() {
    return [
      { id: 'pulse', label: 'Pulse', value: pulse ? `${Math.round(pulse)} bpm` : '—', status: pulse ? 'active' : 'idle', confidence: pulseConf,
        detail: '12-second rolling average (valid 40–110 BPM). The primary live signal — it drives the real-time read.' },
      { id: 'face', label: 'Expression', value: expr === 'unknown' ? '—' : expr, status: exprConf >= 0.4 ? 'active' : 'idle', confidence: exprConf,
        detail: 'Facial expression + blink + talking detection, live every frame. Supports and cross-checks the pulse read.' },
      { id: 'breathing', label: 'Breathing', value: breathPaused ? 'paused' : breathVal ? `${breathVal}/min` : `${Math.floor(breathAcc / 1000)}/30s`,
        status: breathPaused ? 'paused' : breathVal ? 'ready' : 'gathering', confidence: breathVal ? 0.8 : breathAcc / 30000,
        detail: 'Needs ~30s of stillness and silence. Runs in parallel and pauses while you talk — talking invalidates it, so it never guesses.' },
      { id: 'hrv', label: 'HRV', value: hrvVal ? `${hrvVal} ms` : `${Math.floor(hrvAcc / 1000)}/60s`,
        status: hrvVal ? 'ready' : 'gathering', confidence: hrvVal ? 0.8 : hrvAcc / 60000,
        detail: 'Heart-rate variability needs a full 60-second window. Gathers quietly in the background and reports once ready.' },
    ];
  }

  return { ingest, snapshot };
}

module.exports = { createSignals };
