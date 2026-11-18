'use strict';
/* Shared test fixtures: a fake sensor adapter that records lifecycle calls, and a temp memory store. */
// Pin test settings before any src module loads .env (process.loadEnvFile never overrides set vars).
process.env.ATTUNE_ADAPTER = 'mock';
process.env.SMARTSPECTRA_API_KEY = '';
process.env.ATTUNE_ANTHROPIC_KEY = '';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMemory } = require('../src/memory');

function fakeAdapterFactory({ failWith } = {}) {
  const calls = { created: 0, started: 0, stopped: 0, callbacks: [] };
  const factory = () => {
    calls.created++;
    return {
      name: 'fake',
      start(cb) {
        if (failWith) throw new Error(failWith);
        calls.started++;
        calls.callbacks.push(cb);
      },
      async stop() { calls.stopped++; },
    };
  };
  return { factory, calls };
}

const SAMPLE = { tMs: 0, pulseBpm: 72, pulseConfidence: 0.9, expression: 'neutral', expressionConfidence: 0.8, talking: false, speechFast: false };

function tempMemory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attune-test-'));
  const file = path.join(dir, 'memory.json');
  return { memory: createMemory(file), file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { fakeAdapterFactory, SAMPLE, tempMemory };
