'use strict';
/*
 * Sensor worker — runs in a child process (see isolated.js). Holds the only handle to the camera/SDK.
 *
 * IPC protocol (parent → worker):  {type:'start'} · {type:'requestInsight', ref, text} · {type:'stop'}
 *              (worker → parent):  {type:'sample', sample} · {type:'insight', insight} · {type:'error', error}
 *                                  {type:'status', status}  (camera positioning hint / processing state)
 *                                  {type:'insightRequested', ref, id} · {type:'started'} · {type:'stopped'}
 * Nothing else is accepted. If the parent goes away, the worker stops the sensor and exits.
 */
const kind = (process.env.ATTUNE_WORKER_ADAPTER || 'mock').toLowerCase();

function makeInner() {
  if (kind === 'smartspectra') {
    const { createSmartSpectraAdapter } = require('./smartspectra');
    return createSmartSpectraAdapter({ apiKey: process.env.SMARTSPECTRA_API_KEY });
  }
  const { createMockAdapter } = require('./mock');
  const opt = (k) => (process.env[k] != null ? Number(process.env[k]) : undefined);
  return createMockAdapter({
    intervalMs: opt('ATTUNE_TICK_MS') || 250,
    failAfterSamples: opt('ATTUNE_MOCK_FAIL_AFTER') || 0,
  });
}

let inner = null;
const send = (m) => { if (process.connected) process.send(m); };

async function stop() {
  if (inner) { const a = inner; inner = null; try { await a.stop(); } catch {} }
  send({ type: 'stopped' });
}

process.on('message', async (m) => {
  if (!m || typeof m.type !== 'string') return;
  if (m.type === 'start' && !inner) {
    try {
      inner = makeInner();
      inner.start(
        (sample) => send({ type: 'sample', sample }),
        {
          onInsight: (insight) => send({ type: 'insight', insight }),
          onStatus: (status) => send({ type: 'status', status }),
          onError: (error) => send({ type: 'error', error: { code: String(error.code || 'sdk_error'), message: String(error.message || '') } }),
        },
      );
      send({ type: 'started' });
    } catch (e) {
      inner = null;
      send({ type: 'error', error: { code: 'start_failed', message: e.message } });
    }
  } else if (m.type === 'requestInsight') {
    const id = inner && inner.requestInsight ? inner.requestInsight(String(m.text || '')) : null;
    send({ type: 'insightRequested', ref: m.ref, id: id == null ? null : id });
  } else if (m.type === 'stop') {
    await stop();
    process.exit(0);
  }
});

process.on('disconnect', async () => { await stop(); process.exit(0); });
