'use strict';
/* Checks the SmartSpectra mapping against the SDK's real protobuf decoder (no camera or API key needed). */
const assert = require('assert');
const { Metrics } = require('@smartspectra/node-sdk/messages');
const { decodeMetrics } = require('@smartspectra/node-sdk');
const { extractMetrics, createMapper } = require('./src/adapter/smartspectra');

const ts = Date.now() * 1000;
const buf = Metrics.encode(Metrics.create({
  cardio: { pulseRate: [{ value: 71, confidence: 30, timestamp: ts - 1e6 }, { value: 88, confidence: 72, stable: true, timestamp: ts }] },
  face: {
    talking: [{ detected: true, stable: true, timestamp: ts }],
    expression: [{ stable: true, timestamp: ts, scores: [{ type: 6, confidence: 20 }, { type: 7, confidence: 65 }] }],
  },
})).finish();

const decoded = decodeMetrics(Buffer.from(buf));
const x = extractMetrics(decoded);
assert.strictEqual(x.pulseBpm, 88);
assert.ok(Math.abs(x.pulseConfidence - 0.72) < 1e-6);
assert.strictEqual(x.expression, 'sad');
assert.ok(Math.abs(x.expressionConfidence - 0.65) < 1e-6);
assert.strictEqual(x.talking, true);

// partial packets merge; stale signals expire
const map = createMapper();
map(decoded, 1000);
const pulseOnly = decodeMetrics(Buffer.from(Metrics.encode(Metrics.create({ cardio: { pulseRate: [{ value: 90, confidence: 80 }] } })).finish()));
const merged = map(pulseOnly, 2000);
assert.strictEqual(merged.pulseBpm, 90);
assert.strictEqual(merged.expression, 'sad');
const stale = map(pulseOnly, 6000);
assert.strictEqual(stale.expression, 'unknown');
assert.strictEqual(stale.expressionConfidence, 0);

console.log('OK — SmartSpectra mapping matches the SDK protobuf schema');
