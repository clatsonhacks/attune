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

function createSession({ interpreter, memory } = {}) {
  const interp = interpreter || createInterpreter();
  const signals = createSignals();
  let current = null;         // latest interpreter result
  let lastStandingState = null;
  if (memory) memory.startSession({ note: 'session start' });

  function ingest(sample) {
    signals.ingest(sample);
    const r = interp.ingest(sample);
    current = r;
    // Record a memory moment when the interpreter emits a transition nudge.
    if (r.say && memory) {
      memory.append({ type: 'state', state: r.state, note: `${r.state}: ${(r.evidence || []).join(', ')}` });
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

  return { ingest, getBodyContext, getSignals, recordCorrection, endSession, snapshot: interp.snapshot };
}

module.exports = { createSession };
