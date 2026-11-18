'use strict';
/*
 * Sensing controller — the only place the sensor adapter is started or stopped.
 *
 * The adapter (camera + SDK) runs only while consent has the `sensing` scope. Revoking it stops the
 * adapter and bumps a generation counter, so any sample or callback from a previous run that arrives
 * late is dropped instead of reaching the session.
 *
 * States: idle → starting → active → stopped, or error (start failed). Restart is allowed from
 * stopped/error only through a fresh consent grant.
 */

function createSensing({ adapterFactory, consent, onSample, onStart, onStop, log = () => {} }) {
  let adapter = null;
  let state = 'idle';
  let error = null;
  let generation = 0;
  let pending = Promise.resolve();

  function status() {
    return { state, error, adapter: adapter ? adapter.name : null, generation };
  }

  async function start() {
    if (state === 'starting' || state === 'active') return status();
    const gen = ++generation;
    state = 'starting';
    error = null;
    try {
      adapter = adapterFactory();
      if (onStart) onStart(gen);
      adapter.start((sample) => {
        if (gen !== generation || state !== 'active') return; // late or post-revoke sample
        onSample(sample, gen);
      });
      if (gen === generation) state = 'active';
      log(`sensing started (${adapter.name})`);
    } catch (e) {
      if (gen === generation) {
        state = 'error';
        error = e.message;
        adapter = null;
      }
      log(`sensing could not start: ${e.message}`);
    }
    return status();
  }

  async function stop(reason = 'revoked') {
    generation++; // invalidate callbacks from the run being stopped
    const a = adapter;
    adapter = null;
    if (state !== 'error') state = 'stopped';
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
    if (want && !had) pending = pending.then(start);
    else if (!want && had) pending = pending.then(() => stop('revoked'));
  });

  async function shutdown() {
    unsubscribe();
    await pending;
    await stop('shutdown');
  }

  /** Resolves once queued start/stop transitions have finished (used by tests and shutdown). */
  function settled() {
    return pending.then(status);
  }

  return { status, settled, shutdown };
}

module.exports = { createSensing };
