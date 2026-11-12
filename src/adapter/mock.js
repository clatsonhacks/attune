'use strict';
/* Mock adapter: replays the synthetic vitals stream so the connector runs with no camera. */
const { mockStream } = require('../mockVitals');

function createMockAdapter({ intervalMs = 200, loop = true } = {}) {
  let timer = null;
  return {
    name: 'mock',
    /** start(onSample): calls onSample(sample) on a cadence until stop(). */
    start(onSample) {
      let it = mockStream();
      timer = setInterval(() => {
        let n = it.next();
        if (n.done) {
          if (!loop) return this.stop();
          it = mockStream();
          n = it.next();
        }
        onSample(n.value);
      }, intervalMs);
      if (timer.unref) timer.unref();
    },
    /** feedAll(onSample): synchronous one-shot replay, for tests. */
    feedAll(onSample) {
      for (const s of mockStream()) onSample(s);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createMockAdapter };
