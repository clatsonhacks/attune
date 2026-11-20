'use strict';
/* Local breath pacing. The connector boundary converts these results to fixed action cues. */

const DEFAULT_TARGET = 6;      // breaths per minute, a common slow-breathing pace
const MIN_TARGET = 4;
const MAX_TARGET = 12;
const TOLERANCE = 1.5;         // ± breaths/min counted as on target
const MIN_CONFIDENCE = 0.4;

const CALM_CUE = ' They seem a little tense — keep your voice soft and unhurried, and remind them there is no rush.';

const round2 = (v) => Math.round((v || 0) * 100) / 100;

function targetFrom(extras) {
  const t = Number(extras && extras.targetBreathsPerMin);
  if (!Number.isFinite(t)) return DEFAULT_TARGET;
  return Math.max(MIN_TARGET, Math.min(MAX_TARGET, t));
}

function paceOf(bpm, target) {
  if (bpm > target + TOLERANCE) return 'faster_than_target';
  if (bpm < target - TOLERANCE) return 'slower_than_target';
  return 'on_target';
}

const GUIDANCE = {
  faster_than_target: {
    say: true,
    directive:
      'Gently guide a slower breath with a longer exhale, e.g. "inhale for 4, exhale for 6". ' +
      'Invite, never push; let them settle into it at their own pace.',
  },
  on_target: {
    say: false,
    directive: 'Their breathing is at the target pace. Offer brief, quiet encouragement and keep the rhythm going.',
  },
  slower_than_target: {
    say: false,
    directive:
      'Their breathing is slower than the target. Let them know any comfortable pace is fine; ' +
      'they do not need to slow down further or hold their breath.',
  },
};

function render(snapshot, extras = {}) {
  const s = snapshot || {};
  const confidence = round2(s.breathingConfidence);
  if (s.talking) {
    return { state: 'talking', say: false, directive: 'Breathing cannot be read while they are speaking. Wait until they are quiet before guiding the breath.', confidence };
  }
  const rate = typeof s.breathingRate === 'number' && Number.isFinite(s.breathingRate) && s.breathingRate > 0 ? s.breathingRate : null;
  if (rate == null || confidence < MIN_CONFIDENCE) {
    return {
      state: 'need_breathing', say: false, confidence,
      directive: 'Breathing is not being measured yet. Ask them to sit so their chest is visible to the camera and to hold still for a moment.',
    };
  }
  const targetBreathsPerMin = targetFrom(extras);
  const pace = paceOf(rate, targetBreathsPerMin);
  const g = GUIDANCE[pace];
  return {
    state: pace,
    say: g.say,
    directive: s.state === 'elevated' ? g.directive + CALM_CUE : g.directive,
    confidence,
    breathsPerMin: Math.round(rate),
    targetBreathsPerMin,
    pace,
  };
}

module.exports = {
  id: 'yoga',
  name: 'Yoga & breathwork',
  description: 'Offers gentle pacing cues during a breathing practice. Measurements stay in Attune.',
  needs: ['breathing'],
  sharesNumbers: false,
  render,
};
