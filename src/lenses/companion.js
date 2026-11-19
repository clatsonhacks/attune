'use strict';
/*
 * Companion lens — emotional companion / supportive conversation. This is Attune's original behaviour:
 * number-free guidance that changes the AI's tone and pacing, tentative and correctable.
 */

const STANDING = {
  elevated: {
    say: true,
    directive:
      'De-escalate: slow your pace, lower your energy, acknowledge the feeling before advising. ' +
      'Check in TENTATIVELY and invite correction. Never state numbers.',
    suggestedUtterance: "I might be reading this wrong, but you seem a bit tense — want to slow down for a second?",
  },
  neutral: { say: false, directive: null, suggestedUtterance: null },
  calibrating: { say: false, directive: null, suggestedUtterance: null },
  unclear: { say: false, directive: null, suggestedUtterance: null },
};

module.exports = {
  id: 'companion',
  name: 'Emotional companion',
  description: 'Gently adapts tone and pacing when you seem tense. Never shares numbers.',
  needs: ['pulse', 'expression', 'talking'],
  sharesNumbers: false,
  render(snapshot, extras = {}) {
    const state = snapshot && snapshot.state ? snapshot.state : 'starting';
    const base = STANDING[state] || { say: false, directive: null, suggestedUtterance: null };
    const out = {
      state,
      say: base.say,
      directive: base.directive,
      suggestedUtterance: base.suggestedUtterance,
      confidence: Math.round(((snapshot && snapshot.confidence) || 0) * 100) / 100,
    };
    if (extras.note) out.note = extras.note;
    return out;
  },
};
