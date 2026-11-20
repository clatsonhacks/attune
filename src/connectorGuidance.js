'use strict';

// Only reviewed action cues can cross the connector boundary. Lens payloads and
// provider text can contain measurements even inside otherwise ordinary strings.
const CUES = new Map([
  ['companion/elevated', 'Slow your pace, acknowledge the feeling, and invite correction.'],
  ['casual/engaged', 'Keep the conversation light and follow their lead.'],
  ['yoga/faster_than_target', 'Gently invite a longer exhale and let them set a comfortable pace.'],
  ['yoga/on_target', 'Offer quiet encouragement and keep a steady rhythm.'],
  ['yoga/slower_than_target', 'Let them choose a comfortable pace without slowing further.'],
  ['yoga/talking', 'Wait for a quiet moment before offering another cue.'],
  ['yoga/need_breathing', 'Offer a gentle, self-paced practice.'],
]);
const STATES = new Set(['paused', 'starting', 'calibrating', 'unclear', 'stale', 'neutral', 'unavailable']);

function connectorGuidance(lens, state) {
  const directive = CUES.get(lens + '/' + state) || null;
  return { lens, state: directive ? 'guidance' : STATES.has(state) ? state : 'unavailable', say: !!directive, directive };
}

module.exports = { connectorGuidance };
