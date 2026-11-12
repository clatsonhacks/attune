'use strict';
/*
 * Synthetic vitals stream so the interpreter runs with no camera / API key.
 * Scenario (1 Hz samples):
 *   0-20s   calm baseline (pulse ~72, neutral)
 *   20-30s  user starts talking, still calm
 *   30-50s  stress: pulse climbs 72 -> ~92 and holds, expression tense, speech fast
 *   50-62s  low confidence (user moves / poor light) -> degraded "unclear"
 *   62-85s  recovery: pulse back ~74, neutral
 */

function jitter(n, amt) {
  return n + (Math.random() * 2 - 1) * amt;
}

function* mockStream() {
  const sec = (n) => n * 1000;
  for (let t = 0; t <= 85; t++) {
    const tMs = sec(t);
    let sample;
    if (t < 20) {
      sample = { tMs, pulseBpm: jitter(72, 1), pulseConfidence: 0.92, expression: 'neutral', expressionConfidence: 0.9, talking: false };
    } else if (t < 30) {
      sample = { tMs, pulseBpm: jitter(73, 1), pulseConfidence: 0.9, expression: 'neutral', expressionConfidence: 0.85, talking: true };
    } else if (t < 50) {
      const ramp = Math.min(1, (t - 30) / 12);           // climb over ~12s then hold
      const pulse = 72 + ramp * 20;                       // 72 -> ~92
      sample = { tMs, pulseBpm: jitter(pulse, 1), pulseConfidence: 0.86, expression: 'tense', expressionConfidence: 0.8, talking: true, speechFast: true };
    } else if (t < 62) {
      sample = { tMs, pulseBpm: null, pulseConfidence: 0.2, expression: 'unknown', expressionConfidence: 0.2, talking: true };
    } else {
      sample = { tMs, pulseBpm: jitter(74, 1), pulseConfidence: 0.91, expression: 'neutral', expressionConfidence: 0.9, talking: false };
    }
    yield sample;
  }
}

module.exports = { mockStream };
