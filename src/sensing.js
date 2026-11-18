'use strict';
/*
 * Sensing controller — the only place the sensor adapter is started or stopped.
 *
 * The adapter (camera + SDK) runs only while consent has the `sensing` scope. Revoking it stops the
 * adapter and bumps a generation counter, so any sample, insight or error from a previous run that
 * arrives late is dropped instead of reaching the session.
 *
 * States: idle → starting → active → stopped, or error (start failed / device lost / worker crashed).
 * Leaving error requires a fresh consent grant (revoke + grant), never a silent restart.
 */

/**
 * autoStart: true  — the camera runs whenever the `sensing` scope is granted (MCP connector behaviour).
 * autoStart: false — permission only: the camera starts when request() is called (chat started, AI asked),
 *                    and pause()/idle stop it without touching consent. Revoking consent always stops it.
 */
function createSensing({ adapterFactory, consent, onSample, onInsight = () => {}, onStart, onStop, log = () => {}, insightMinIntervalMs = 30000, autoStart = true }) {
  let lastInsightRequestAt = -Infinity;
  let adapter = null;
  let state = 'idle';
  let error = null;      // human-readable message
  let errorCode = null;  // machine code: start_failed | device_unavailable | worker_crashed | sdk_error
  let camera = {};       // latest camera status: { validationCode, hint, processing, mode }
  let generation = 0;
  let pending = Promise.resolve();

  function status() {
    return { state, error, errorCode, adapter: adapter ? adapter.name : null, generation, camera: { ...camera } };
  }

  function fail(gen, code, message) {
    if (gen !== generation) return; // stale run
    state = 'error';
    errorCode = code;
    error = message;
    log(`sensing error (${code}): ${message}`);
    const a = adapter;
    adapter = null;
    if (a) Promise.resolve().then(() => a.stop()).catch(() => {});
    if (onStop) onStop('error');
  }

  async function start() {
    if (state === 'starting' || state === 'active') return status();
    const gen = ++generation;
    state = 'starting';
    error = null; errorCode = null; camera = {};
    try {
      adapter = adapterFactory();
      if (onStart) onStart(gen);
      adapter.start(
        (sample) => { if (gen === generation && state === 'active') onSample(sample, gen); },
        {
          onInsight: (insight) => { if (gen === generation && state === 'active') onInsight(insight, gen); },
          onError: (e) => fail(gen, (e && e.code) || 'sdk_error', (e && e.message) || 'sensor error'),
          onStatus: (st) => { if (gen === generation && st) camera = { ...camera, ...st }; },
        },
      );
      if (gen === generation && state === 'starting') state = 'active';
      if (state === 'active') log(`sensing started (${adapter.name})`);
    } catch (e) {
      fail(gen, 'start_failed', e.message);
    }
    return status();
  }

  async function stop(reason = 'revoked') {
    generation++; // invalidate callbacks from the run being stopped
    const a = adapter;
    adapter = null;
    if (state !== 'error') state = 'stopped';
    camera = {};
    if (a) {
      try { await a.stop(); } catch {}
      log(`sensing stopped (${reason})`);
    }
    if (onStop) onStop(reason);
    return status();
  }

  // Follow consent: serialize transitions so a fast grant→revoke can't leave the camera running.
  const unsubscribe = consent.onChange((next, prev) => {
    const want = next.sensing && next.presageAck;
    const had = prev.sensing && prev.presageAck;
    if (want && !had && autoStart) pending = pending.then(start);
    else if (!want && had) pending = pending.then(() => stop('revoked'));
  });

  /** Start the camera now if permission allows. Resolves to status(); never throws. */
  function request(reason = 'requested') {
    if (!consent.has('sensing')) return Promise.resolve(status());
    pending = pending.then(async () => {
      if (state === 'active' || state === 'starting' || !consent.has('sensing')) return;
      log(`camera requested (${reason})`);
      await start();
    });
    return pending.then(status);
  }

  /** Stop the camera but keep permission (pause, idle timeout). */
  function release(reason = 'paused') {
    pending = pending.then(() => (state === 'active' || state === 'starting' ? stop(reason) : null));
    return pending.then(status);
  }

  /** User-initiated Insight. Never awaited on a conversation path. Resolves to request id or null. */
  async function requestInsight(text) {
    if (state !== 'active' || !adapter || !adapter.requestInsight) return null;
    const t = Date.now();
    if (t - lastInsightRequestAt < insightMinIntervalMs) return null; // each request sends data to Presage
    lastInsightRequestAt = t;
    try { return (await adapter.requestInsight(text)) ?? null; } catch { return null; }
  }

  async function shutdown() {
    unsubscribe();
    await pending;
    await stop('shutdown');
  }

  /** Resolves once queued start/stop transitions have finished (used by tests and shutdown). */
  function settled() {
    return pending.then(status);
  }

  return { status, settled, shutdown, requestInsight, request, release };
}

module.exports = { createSensing };
