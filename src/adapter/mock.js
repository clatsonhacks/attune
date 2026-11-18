'use strict';
/*
 * Mock adapter: replays the synthetic vitals stream so everything runs with no camera.
 *
 * Also simulates Presage Insights so the slow path can be exercised:
 *   insightEverySamples  — fire an automatic insight every N samples (0 = never). Default ≈ every 60 samples.
 *   insightDelayMs       — delay before an insight is delivered (simulates a slow network/LLM)
 *   insightNeverArrives  — requested insights are swallowed (tests that nothing waits on them)
 *   failAfterSamples     — call onError({code:'device_unavailable'}) after N samples (camera unplugged)
 */
const { mockStream } = require('../mockVitals');

const MOCK_TEXT = [
  'Your readings look steady and settled right now, with an even rhythm.',
  'There was a noticeable rise in heart rate (about 96 bpm) compared with earlier; things look a bit more activated.',
  'Readings are easing back toward your earlier calm level.',
];

function createMockAdapter({
  intervalMs = 200, loop = true,
  insightEverySamples = 60, insightDelayMs = 0, insightNeverArrives = false, failAfterSamples = 0,
} = {}) {
  let timer = null;
  let requestSeq = 1000;
  let callbacks = null;
  const timers = new Set();

  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    if (t.unref) t.unref();
    timers.add(t);
  }

  function deliver(insight) {
    if (!callbacks) return;
    const send = () => callbacks && callbacks.onInsight(insight);
    if (insightDelayMs > 0) later(send, insightDelayMs); else send();
  }

  return {
    name: 'mock',
    /** start(onSample, { onInsight, onError }): calls onSample(sample) on a cadence until stop(). */
    start(onSample, { onInsight = () => {}, onError = () => {}, onStatus = () => {} } = {}) {
      callbacks = { onInsight, onError };
      onStatus({ processing: 'running', validationCode: 0, hint: '' });
      let it = mockStream();
      let n = 0, autoIdx = 0;
      timer = setInterval(() => {
        let next = it.next();
        if (next.done) {
          if (!loop) return this.stop();
          it = mockStream();
          next = it.next();
        }
        n++;
        onSample(next.value);
        if (insightEverySamples > 0 && n % insightEverySamples === 0) {
          deliver({ requestId: 0, requested: false, processedAt: new Date().toISOString(), analysis: MOCK_TEXT[autoIdx++ % MOCK_TEXT.length], error: null, type: 'INSIGHT_TYPE_VITALS' });
        }
        if (failAfterSamples > 0 && n === failAfterSamples) {
          clearInterval(timer); timer = null;
          onError({ code: 'device_unavailable', message: 'simulated camera disconnect' });
        }
      }, intervalMs);
      if (timer.unref) timer.unref();
    },
    requestInsight(text) {
      if (!callbacks) return null;
      const id = ++requestSeq;
      if (!insightNeverArrives) {
        deliver({ requestId: id, requested: true, processedAt: new Date().toISOString(), analysis: 'You asked for a check-in: readings look fairly steady right now.', error: null, type: 'INSIGHT_TYPE_VITALS' });
      }
      return id;
    },
    /** feedAll(onSample): synchronous one-shot replay, for tests. */
    feedAll(onSample) {
      for (const s of mockStream()) onSample(s);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      callbacks = null;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

module.exports = { createMockAdapter };
