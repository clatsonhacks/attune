'use strict';
/*
 * Attune interpreter demo — feeds the synthetic vitals stream through the
 * interpreter and prints the body-context the AI would receive each second.
 * No camera, no API key, no network. Run: `npm run demo` (or `node run-demo.js`).
 */

const { createInterpreter } = require('./src/interpreter');
const { mockStream } = require('./src/mockVitals');

const interp = createInterpreter();
let correctionDone = false;

function fmt(tMs) {
  return `t=${String(tMs / 1000).padStart(2, ' ')}s`;
}

console.log('── Attune interpreter demo (synthetic vitals) ──\n');

for (const sample of mockStream()) {
  const r = interp.ingest(sample);

  if (r.say) {
    console.log(`${fmt(sample.tMs)}  🔔 NUDGE [${r.state}]  (confidence ${r.confidence.toFixed(2)})`);
    console.log(`         evidence : ${r.evidence.join(', ') || '—'}`);
    console.log(`         directive: ${r.directive}`);
    console.log(`         AI might say: "${r.suggestedUtterance}"`);

    // Simulate the user correcting a (hypothetical) false read once, to show the memory loop.
    if (r.state === 'elevated' && !correctionDone) {
      correctionDone = true;
      // Here the user actually WAS stressed, so the read was accurate:
      const adj = interp.recordCorrection({ wasAccurate: true, tMs: sample.tMs, note: 'user confirmed' });
      console.log(`         ↳ user confirmed read accurate → thresholds now pulseΔ≥${adj.pulseDeltaBpm}bpm, sustain ${adj.sustainMs / 1000}s`);
    }
    console.log('');
  } else {
    // Quiet ticks: one compact line so you can see the state evolve.
    const tag = r.state.padEnd(11);
    const ev = r.evidence.length ? `  (${r.evidence.join(', ')})` : '';
    console.log(`${fmt(sample.tMs)}  ${tag}${ev}`);
  }
}

console.log('\n── session end ──');
console.log('snapshot:', JSON.stringify(interp.snapshot()));
console.log('\nNote: in the real build this body-context is exposed over MCP (get_body_context)');
console.log('so any connected AI reads it before replying. Raw numbers are never surfaced to the AI.');
