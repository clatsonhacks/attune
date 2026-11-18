'use strict';
/*
 * Parallel signal "agents". Each runs off the same sample stream but on its own cadence and rules,
 * so the UI can show what's running. Honest about the SDK's limits:
 *   - pulse: 12s rolling average — the primary live read
 *   - expression/blink/talking: live every frame — supports pulse
 *   - breathing: needs ~30s of stillness + silence; PAUSES while talking
 *   - hrv: needs a full 60s low-motion window; gathers in the background
 * Breathing/HRV values are DERIVED from pulse, not measured. They are shown only in mock mode and are
 * labelled simulated; with the real SDK (simulated:false) they report "unavailable" until real SDK
 * breathing/HRV metrics are wired in.
 */
const SAMPLE_MS = 1000; // each mock sample ≈ 1s of logical data
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function createSignals({ simulated = true } = {}) {
  let baseline = null;
  const bSamples = [];
  let pulse = null, pulseConf = 0, expr = 'unknown', exprConf = 0;
  let breathAcc = 0, breathVal = null, breathPaused = false;
  let hrvAcc = 0, hrvVal = null;
  let measuredBreath = null, measuredBreathConf = 0, measuredHrv = null, measuredHrvConf = 0;

  function ingest(s) {
    measuredBreath = typeof s.breathingRate === 'number' && s.breathingRate > 0 ? s.breathingRate : null;
    measuredBreathConf = s.breathingConfidence || 0;
    measuredHrv = typeof s.hrvMs === 'number' && s.hrvMs > 0 ? s.hrvMs : null;
    measuredHrvConf = s.hrvConfidence || 0;
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
    const list = [
      { id: 'pulse', label: 'Pulse', value: pulse ? `${Math.round(pulse)} bpm` : '—', status: pulse ? 'active' : 'idle', confidence: pulseConf,
        detail: '12-second rolling average (valid 40–110 BPM). The primary live signal — it drives the real-time read.' },
      { id: 'face', label: 'Expression', value: expr === 'unknown' ? '—' : expr, status: exprConf >= 0.4 ? 'active' : 'idle', confidence: exprConf,
        detail: 'Facial expression + blink + talking detection, live every frame. Supports and cross-checks the pulse read.' },
      { id: 'breathing', label: 'Breathing', value: breathPaused ? 'paused' : breathVal ? `${breathVal}/min` : `${Math.floor(breathAcc / 1000)}/30s`,
        status: breathPaused ? 'paused' : breathVal ? 'ready' : 'gathering', confidence: breathVal ? 0.8 : breathAcc / 30000,
        detail: 'Simulated in demo mode (derived from pulse, not measured). Needs ~30s of stillness and silence and pauses while you talk.' },
      { id: 'hrv', label: 'HRV', value: hrvVal ? `${hrvVal} ms` : `${Math.floor(hrvAcc / 1000)}/60s`,
        status: hrvVal ? 'ready' : 'gathering', confidence: hrvVal ? 0.8 : hrvAcc / 60000,
        detail: 'Simulated in demo mode (derived from pulse, not measured). Heart-rate variability needs a full 60-second window.' },
    ];
    if (!simulated) {
      // Real mode: only SDK-measured values, never the pulse-derived simulation.
      const measured = { breathing: measuredBreath != null ? { v: `${Math.round(measuredBreath)}/min`, c: measuredBreathConf } : null,
        hrv: measuredHrv != null ? { v: `${Math.round(measuredHrv)} ms`, c: measuredHrvConf } : null };
      for (const sig of list.slice(2)) {
        const m = measured[sig.id];
        if (m) Object.assign(sig, { value: m.v, status: 'ready', confidence: m.c,
          detail: sig.id === 'breathing' ? 'Measured by SmartSpectra (breathing rate). Needs stillness; unreliable while talking.'
            : 'Measured by SmartSpectra (RMSSD over a recent window of pulse data).' });
        else Object.assign(sig, { value: 'waiting', status: 'gathering', confidence: 0,
          detail: 'Waiting for SmartSpectra to report a measured value — nothing is shown rather than a guess.' });
      }
    }
    return list;
  }

  return { ingest, snapshot };
}

module.exports = { createSignals };
