'use strict';
/* Activity log: whitelisted fields only, newest-first tail, trimming, malformed lines. */
require('../helpers');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createActivityLog, defaultActivityFile } = require('../../src/activity');

function tempLog(t, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attune-activity-'));
  const file = path.join(dir, 'activity.jsonl');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { log: createActivityLog(file, opts), file };
}

test('stores only whitelisted fields — never directive text, notes or numbers', (t) => {
  const { log, file } = tempLog(t);
  log.append({ kind: 'context', app: 'claude-desktop', lens: 'companion', state: 'elevated', say: true,
    directive: 'De-escalate: slow your pace', suggestedUtterance: 'you seem tense', note: 'pulse 96 bpm', pulseBpm: 96, confidence: 0.87 });
  const raw = fs.readFileSync(file, 'utf8').replace(/"at":"[^"]*"/g, ''); // timestamps may contain any digits
  assert.ok(!/De-escalate|tense|bpm|96|0\.87|pulse/.test(raw), raw);
  const [e] = log.recent(10);
  assert.deepStrictEqual(Object.keys(e).sort(), ['app', 'at', 'kind', 'lens', 'say', 'state']);
  assert.strictEqual(e.say, true);
  assert.ok(!Number.isNaN(Date.parse(e.at)));
});

test('types are coerced and unknown kinds or bad app ids are rejected', (t) => {
  const { log } = tempLog(t);
  assert.strictEqual(log.append({ kind: 'telemetry', app: 'x' }), null);
  assert.strictEqual(log.append({ kind: 'context', app: 'Bad App' }), null);
  assert.strictEqual(log.append(null), null);
  const e = log.append({ kind: 'denied', app: 'x', lens: 'Not A Lens!', state: 'pulse is 72', say: 'yes', at: 'whenever' });
  assert.strictEqual(e.lens, null);
  assert.strictEqual(e.state, null);
  assert.strictEqual(e.say, false);
  assert.deepStrictEqual(log.recent().map((x) => x.kind), ['denied']);
});

test('recent is newest first, honours the limit and skips malformed lines', (t) => {
  const { log, file } = tempLog(t);
  log.append({ kind: 'context', app: 'a', lens: 'companion', state: 'neutral' });
  fs.appendFileSync(file, 'not json\n{"kind":"context","app":"x","directive":"leak"\n{"kind":"bogus","app":"x"}\n');
  log.append({ kind: 'request', app: 'b', lens: 'companion', state: 'purpose_not_approved' });
  log.append({ kind: 'unknown', app: 'c', state: 'unknown_purpose' });
  assert.deepStrictEqual(log.recent(10).map((e) => e.app), ['c', 'b', 'a']);
  assert.deepStrictEqual(log.recent(2).map((e) => e.app), ['c', 'b']);
  log.clear();
  assert.deepStrictEqual(log.recent(), []);
  assert.ok(!fs.existsSync(file));
});

test('the file is trimmed to max lines once it exceeds twice max', (t) => {
  const { log, file } = tempLog(t, { max: 5 });
  for (let i = 0; i < 10; i++) log.append({ kind: 'context', app: `app-${i}` });
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 10);
  log.append({ kind: 'context', app: 'app-10' });
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim().split('\n').length, 5);
  assert.deepStrictEqual(log.recent(100).map((e) => e.app), ['app-10', 'app-9', 'app-8', 'app-7', 'app-6']);
});

test('two writers append to the same file', (t) => {
  const { log, file } = tempLog(t);
  const other = createActivityLog(file);
  log.append({ kind: 'context', app: 'attune' });
  other.append({ kind: 'context', app: 'chatgpt' });
  assert.deepStrictEqual(log.recent().map((e) => e.app), ['chatgpt', 'attune']);
});

test('default file is in the data folder, with an env override', () => {
  const dir = process.env.ATTUNE_DATA_DIR;
  assert.strictEqual(defaultActivityFile(false, { ATTUNE_DATA_DIR: dir }), path.join(dir, 'activity.jsonl'));
  assert.strictEqual(defaultActivityFile(true, { ATTUNE_DATA_DIR: dir }), path.join(dir, 'demo', 'activity.jsonl'));
  assert.ok(path.isAbsolute(defaultActivityFile(false, { ATTUNE_ACTIVITY_FILE: 'a.jsonl' })));
});
