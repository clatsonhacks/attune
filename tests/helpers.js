'use strict';
/* Shared test fixtures: a fake sensor adapter that records lifecycle calls, and a temp memory store. */
// Pin test settings before any src module loads .env (process.loadEnvFile never overrides set vars).
process.env.ATTUNE_ADAPTER = 'mock';
process.env.SMARTSPECTRA_API_KEY = '';
process.env.ATTUNE_ANTHROPIC_KEY = '';
process.env.GROQ_API_KEY = '';
delete process.env.ATTUNE_APP_ID;
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMemory } = require('../src/memory');

// Safety net: anything that falls back to a default store file (including spawned processes, which inherit
// process.env) writes to a per-run temp data folder, never the real per-user folder or the repo root.
const SHARED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'attune-shared-'));
process.env.ATTUNE_DATA_DIR = path.join(SHARED_DIR, 'data');
process.env.ATTUNE_APPS_FILE = path.join(SHARED_DIR, 'apps.json');
process.env.ATTUNE_ACTIVITY_FILE = path.join(SHARED_DIR, 'activity.jsonl');
process.on('exit', () => { try { fs.rmSync(SHARED_DIR, { recursive: true, force: true }); } catch {} });

/** Fresh approvals store + activity log in their own temp dir. */
function tempApps() {
  const { createAppApprovals } = require('../src/privacy/appApprovals');
  const { createActivityLog } = require('../src/activity');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attune-apps-'));
  const appsFile = path.join(dir, 'apps.json');
  const activityFile = path.join(dir, 'activity.jsonl');
  return { approvals: createAppApprovals(appsFile), activity: createActivityLog(activityFile), appsFile, activityFile, dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

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

function tempConsentStore() {
  const { createConsentStore } = require('../src/privacy/consentStore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attune-consent-'));
  const file = path.join(dir, 'consent.json');
  return { store: createConsentStore(file), file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function tempMemory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attune-test-'));
  const file = path.join(dir, 'memory.json');
  return { memory: createMemory(file), file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { fakeAdapterFactory, SAMPLE, tempMemory, tempConsentStore, tempApps };
