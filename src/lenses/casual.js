'use strict';
/*
 * Casual chat lens — light conversation. Reads only facial expression to notice when the person seems to
 * be enjoying the chat. Never mentions stress, the body or any number.
 */

const ENGAGED = new Set(['smile', 'surprise']);
const UNCLEAR_STATES = new Set(['unclear', 'calibrating', 'starting']);
const MIN_CONFIDENCE = 0.4;

function render(snapshot) {
  const s = snapshot || {};
  const confidence = Math.round((s.expressionConfidence || 0) * 100) / 100;
  if (!s.state || UNCLEAR_STATES.has(s.state) || confidence < MIN_CONFIDENCE) {
    return { state: 'unclear', say: false, directive: null, confidence };
  }
  if (ENGAGED.has(s.expression)) {
    return { state: 'engaged', say: true, directive: 'They seem to be enjoying this — keep the light tone.', confidence };
  }
  return { state: 'neutral', say: false, directive: null, confidence };
}

module.exports = {
  id: 'casual',
  name: 'Casual chat',
  description: 'Notices when you seem to be enjoying a light conversation. Never shares numbers.',
  needs: ['expression'],
  sharesNumbers: false,
  render,
};
