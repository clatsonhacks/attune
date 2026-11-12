'use strict';
/*
 * Attune interpreter — turns a stream of contactless-vitals samples into a
 * behavioral *nudge* for an AI, not raw numbers.
 *
 * Honest design constraints (from the SDK model cards):
 *  - Live signals are PULSE DRIFT (12s avg, valid 40-110 BPM) + facial EXPRESSION + talking.
 *    HRV/breathing need 30-60s stationary windows and are NOT used per-turn.
 *  - Everything is relative to a PER-PERSON baseline (not absolute thresholds) → robust to webcam noise.
 *  - Confidence-gated: low confidence → state "unclear" → the AI says nothing about the body (degraded mode).
 *  - Sustained + hysteresis: a nudge needs the signal to hold, and to clear, before flipping state.
 *  - Output is a directive the AI acts on; it is tentative and correctable.
 *
 * Sample shape (all fields optional except tMs):
 *   { tMs, pulseBpm, pulseConfidence, expression, expressionConfidence, talking, speechFast }
 *     expression ∈ 'neutral' | 'tense' | 'sad' | 'smile' | 'surprise' | 'unknown'
 */

const TENSE_EXPRESSIONS = new Set(['tense', 'sad', 'fear', 'anger']);

const DEFAULTS = {
  baselineMs: 20000,       // calm calibration window
  minBaselineSamples: 5,
  pulseValid: [40, 110],   // SDK valid range
  minConfidence: 0.4,      // below this a signal is unusable
  pulseDeltaBpm: 6,        // sustained rise over baseline that flags arousal
  sustainMs: 8000,         // how long "elevated" must hold before we nudge
  clearFactor: 0.5,        // clear when delta < pulseDeltaBpm * clearFactor
  clearMs: 6000,           // how long "calm" must hold before we settle
  maxPulseDeltaBpm: 14,    // cap for correction-driven threshold raises
};

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function createInterpreter(userConfig = {}) {
  const cfg = { ...DEFAULTS, ...userConfig };

  let startMs = null;
  let baselinePulse = null;
  const baselineSamples = [];
  let arousalState = 'calibrating'; // calibrating | neutral | elevated  (persists across "unclear")
  let elevatedSinceMs = null;
  let calmSinceMs = null;
  const corrections = [];           // feeds "memory" / adaptation

  function pulseUsable(s) {
    return (
      typeof s.pulseBpm === 'number' &&
      s.pulseBpm >= cfg.pulseValid[0] &&
      s.pulseBpm <= cfg.pulseValid[1] &&
      (s.pulseConfidence == null || s.pulseConfidence >= cfg.minConfidence)
    );
  }
  function expressionKnown(s) {
    return (
      s.expression &&
      s.expression !== 'unknown' &&
      (s.expressionConfidence == null || s.expressionConfidence >= cfg.minConfidence)
    );
  }

  function out(partial) {
    return {
      state: arousalState,
      say: false,
      directive: null,
      suggestedUtterance: null,
      evidence: [],
      confidence: 0,
      baselinePulse,
      ...partial,
    };
  }

  function ingest(s) {
    if (startMs === null) startMs = s.tMs;
    const pUsable = pulseUsable(s);
    const eKnown = expressionKnown(s);

    // --- Degraded mode: nothing trustworthy to say about the body ---
    if (!pUsable && !eKnown) {
      // Transient overlay: report "unclear" but KEEP the underlying arousal state so we can resume.
      elevatedSinceMs = null;
      calmSinceMs = null;
      return out({ state: 'unclear', say: false, evidence: ['low signal confidence'] });
    }

    // --- Calibration: learn the person's calm baseline ---
    if (baselinePulse === null) {
      if (pUsable && (!eKnown || s.expression === 'neutral')) baselineSamples.push(s.pulseBpm);
      const windowDone = s.tMs - startMs >= cfg.baselineMs;
      if (windowDone && baselineSamples.length >= cfg.minBaselineSamples) {
        baselinePulse = median(baselineSamples);
        arousalState = 'neutral';
      } else {
        return out({ state: 'calibrating', evidence: [`baseline ${baselineSamples.length}/${cfg.minBaselineSamples}`] });
      }
    }

    // --- Interpret: build evidence relative to baseline ---
    const evidence = [];
    const delta = pUsable ? s.pulseBpm - baselinePulse : null;
    const pulseElevated = delta != null && delta >= cfg.pulseDeltaBpm;
    const expressionTense = eKnown && TENSE_EXPRESSIONS.has(s.expression);
    if (pulseElevated) evidence.push(`pulse +${Math.round(delta)} over baseline`);
    if (expressionTense) evidence.push(`${s.expression} expression`);
    if (s.speechFast) evidence.push('speech sped up');

    const elevatedNow = pulseElevated || expressionTense;
    const clearlyCalm = delta != null && delta < cfg.pulseDeltaBpm * cfg.clearFactor && !expressionTense;

    if (elevatedNow) {
      elevatedSinceMs = elevatedSinceMs ?? s.tMs;
      calmSinceMs = null;
    } else if (clearlyCalm) {
      calmSinceMs = calmSinceMs ?? s.tMs;
      elevatedSinceMs = null;
    }

    const conf = Math.min(
      pUsable ? (s.pulseConfidence ?? 1) : 1,
      eKnown ? (s.expressionConfidence ?? 1) : 1,
    );

    // --- State machine with hysteresis ---
    if (arousalState !== 'elevated' && elevatedSinceMs && s.tMs - elevatedSinceMs >= cfg.sustainMs) {
      arousalState = 'elevated';
      return out({
        state: arousalState,
        say: true,
        confidence: conf,
        evidence,
        directive:
          'De-escalate: slow your pace, lower your energy, and acknowledge the feeling before advising. ' +
          'Check in TENTATIVELY and invite correction. Do not state numbers.',
        suggestedUtterance:
          "I might be reading this wrong, but you seem to have tensed up a little — want to slow down for a second?",
      });
    }

    if (arousalState === 'elevated' && calmSinceMs && s.tMs - calmSinceMs >= cfg.clearMs) {
      arousalState = 'neutral';
      return out({
        state: arousalState,
        say: true,
        confidence: conf,
        evidence: ['returned toward baseline'],
        directive: 'They have settled. Gently acknowledge the shift if natural; return to normal energy.',
        suggestedUtterance: "You seem a bit more settled now — want to keep going?",
      });
    }

    // Steady: no new nudge this tick.
    return out({ state: arousalState, say: false, confidence: conf, evidence });
  }

  /*
   * The AI (or user) tells us whether the last read was accurate.
   * A false positive raises the bar (and is remembered); feeds the local memory loop.
   */
  function recordCorrection({ wasAccurate, tMs = Date.now(), note = '' } = {}) {
    corrections.push({ tMs, wasAccurate, note });
    if (wasAccurate === false) {
      cfg.pulseDeltaBpm = Math.min(cfg.maxPulseDeltaBpm, cfg.pulseDeltaBpm + 1);
      cfg.sustainMs += 2000;
    } else if (wasAccurate === true) {
      cfg.pulseDeltaBpm = Math.max(DEFAULTS.pulseDeltaBpm, cfg.pulseDeltaBpm - 1);
    }
    return { pulseDeltaBpm: cfg.pulseDeltaBpm, sustainMs: cfg.sustainMs };
  }

  function snapshot() {
    return {
      baselinePulse,
      state: arousalState,
      thresholds: { pulseDeltaBpm: cfg.pulseDeltaBpm, sustainMs: cfg.sustainMs },
      corrections: corrections.length,
    };
  }

  return { ingest, recordCorrection, snapshot };
}

module.exports = { createInterpreter, DEFAULTS };
