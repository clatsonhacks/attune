'use strict';
/*
 * SenseSession ties the live sample stream to the interpreter and exposes the
 * "standing" body-context an AI reads before each reply. Unlike the raw interpreter
 * (which fires a nudge only on the transition tick), getBodyContext() returns sensible
 * guidance whenever it is polled, derived from the CURRENT state.
 */
const { createInterpreter } = require('./interpreter');
const { createSignals } = require('./signals');

const STANDING = {
  elevated: {
    say: true,
    directive:
      'De-escalate: slow your pace, lower your energy, acknowledge the feeling before advising. ' +
      'Check in TENTATIVELY and invite correction. Never state numbers.',
    suggestedUtterance:
      "I might be reading this wrong, but you seem a bit tense — want to slow down for a second?",
  },
  neutral: { say: false, directive: null, suggestedUtterance: null },
  calibrating: { say: false, directive: null, suggestedUtterance: null },
  unclear: { say: false, directive: null, suggestedUtterance: null },
};

// Memory stores interpretations, never measurements: "pulse +14 over baseline" → "pulse above baseline".
function numberFree(evidence = []) {
  return evidence.map((e) => String(e).replace(/pulse [+-]?\d+(\.\d+)? over baseline/i, 'pulse above baseline').replace(/[+-]?\d+(\.\d+)?/g, '').replace(/\s{2,}/g, ' ').trim());
}

function createSession({ interpreter, memory, simulatedSignals = true } = {}) {
  const interp = interpreter || createInterpreter();
  const signals = createSignals({ simulated: simulatedSignals });
  let current = null;         // latest interpreter result
  let lastStandingState = null;
  if (memory) memory.startSession({ note: 'session start' });

  function ingest(sample) {
    signals.ingest(sample);
    const r = interp.ingest(sample);
    current = r;
    // Record a memory moment when the interpreter emits a transition nudge.
    if (r.say && memory) {
      memory.append({ type: 'state', state: r.state, note: `${r.state}: ${numberFree(r.evidence).join(', ')}` });
    }
    return r;
  }

  function getBodyContext() {
    const state = current ? current.state : 'starting';
    const base = STANDING[state] || { say: false, directive: null, suggestedUtterance: null };
    lastStandingState = state;
    return {
      state,
      say: base.say,
      directive: base.directive,
      suggestedUtterance: base.suggestedUtterance,
      evidence: current ? current.evidence || [] : [],
      confidence: current ? current.confidence || 0 : 0,
    };
  }

  /**
   * The only context an AI may receive: interpreted guidance, no evidence strings (they contain
   * numbers like "pulse +14 over baseline") and no measurements. Callers must still check the
   * aiSharing consent scope before handing this to a model.
   */
  function getApprovedContext() {
    const c = getBodyContext();
    return {
      state: c.state,
      say: c.say,
      directive: c.directive,
      suggestedUtterance: c.suggestedUtterance,
      confidence: Math.round(c.confidence * 100) / 100,
    };
  }

  function recordCorrection({ wasAccurate } = {}) {
    const adj = interp.recordCorrection({ wasAccurate });
    if (memory) memory.append({ type: 'correction', state: lastStandingState, note: `correction wasAccurate=${wasAccurate}` });
    return adj;
  }

  function endSession() {
    if (memory) memory.append({ type: 'state', state: 'end', note: 'session end' });
    return interp.snapshot();
  }

  function getSignals() { return signals.snapshot(); }

  return { ingest, getBodyContext, getApprovedContext, getSignals, recordCorrection, endSession, snapshot: interp.snapshot };
}

module.exports = { createSession };
