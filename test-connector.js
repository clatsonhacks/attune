'use strict';
/*
 * Headless connector test — no camera, no MCP client, no deps.
 * Exercises memory + session + mock adapter exactly as the MCP tools will, and asserts behavior.
 * Run: `npm run test:connector`
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createSession } = require('./src/session');
const { createMemory } = require('./src/memory');
const { createMockAdapter } = require('./src/adapter/mock');

const memFile = path.join(os.tmpdir(), `attune-test-${Date.now()}.json`);
const memory = createMemory(memFile);
const session = createSession({ memory });
const adapter = createMockAdapter();

let sawElevated = false;
let sawUnclear = false;
let correctedOnce = false;

// Feed the whole synthetic arc synchronously, polling get_body_context like the AI would.
adapter.feedAll((sample) => {
  session.ingest(sample);
  const ctx = session.getBodyContext();
  if (ctx.state === 'elevated' && ctx.say) {
    sawElevated = true;
    if (!correctedOnce) {
      correctedOnce = true;
      session.recordCorrection({ wasAccurate: true });
    }
  }
  if (ctx.state === 'unclear') sawUnclear = true;
});

const finalCtx = session.getBodyContext();
const snap = session.endSession();
const summary = memory.summary();

function assert(name, cond) {
  console.log(`${cond ? '✅' : '❌'} ${name}`);
  if (!cond) process.exitCode = 1;
}

console.log('── connector headless test ──');
assert('reached elevated state with say=true', sawElevated);
assert('entered unclear/degraded on low signal', sawUnclear);
assert('baseline learned', typeof snap.baselinePulse === 'number');
assert('settled back to neutral by end', finalCtx.state === 'neutral');
assert('memory recorded ≥1 moment', summary.recent.some((s) => s.moments.length > 0));

console.log('\nfinal body-context:', JSON.stringify(finalCtx));
console.log('memory summary   :', JSON.stringify(summary));

// Clean up the temp memory file.
try { fs.unlinkSync(memFile); } catch {}
console.log(process.exitCode ? '\nFAILED' : '\nOK — connector brain works end-to-end');
