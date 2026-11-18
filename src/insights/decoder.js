'use strict';
/*
 * Decoder for the Presage `presage.smartspectra.Insight` protobuf delivered by the SDK's 'insight' event.
 * The Node SDK does not ship this decoder; the schema below is copied from Presage's Data Types docs
 * (smartspectra.presagetech.com/docs/data-types.md, "Insight"), pinned to SDK 3.5.0:
 *
 *   message Insight {
 *     int32 request_id = 1;
 *     string processed_at = 2;
 *     oneof result { string analysis = 3; string error = 4; }
 *     InsightType type = 5;     // always INSIGHT_TYPE_VITALS today
 *   }
 *   enum InsightType { INSIGHT_TYPE_VITALS = 0; INSIGHT_TYPE_SPEECH = 1; INSIGHT_TYPE_COMBINED = 2; }
 */
const protobuf = require('protobufjs');

const root = protobuf.Root.fromJSON({
  nested: {
    presage: { nested: { smartspectra: { nested: {
      InsightType: { values: { INSIGHT_TYPE_VITALS: 0, INSIGHT_TYPE_SPEECH: 1, INSIGHT_TYPE_COMBINED: 2 } },
      Insight: {
        oneofs: { result: { oneof: ['analysis', 'error'] } },
        fields: {
          requestId: { type: 'int32', id: 1 },
          processedAt: { type: 'string', id: 2 },
          analysis: { type: 'string', id: 3 },
          error: { type: 'string', id: 4 },
          type: { type: 'InsightType', id: 5 },
        },
      },
    } } } },
  },
});

const Insight = root.lookupType('presage.smartspectra.Insight');

/**
 * decodeInsight(buf) → { requestId, processedAt, analysis, error, type } or throws on a malformed buffer.
 * Exactly one of analysis/error is set on a valid message.
 */
function decodeInsight(buf) {
  const msg = Insight.decode(buf instanceof Uint8Array ? buf : Buffer.from(buf));
  const o = Insight.toObject(msg, { enums: String, defaults: false, oneofs: true });
  return {
    requestId: typeof o.requestId === 'number' ? o.requestId : 0,
    processedAt: o.processedAt || null,
    analysis: o.analysis || null,
    error: o.error || null,
    type: o.type || 'INSIGHT_TYPE_VITALS',
  };
}

/** Encode helper for tests and the mock adapter. */
function encodeInsight(obj) {
  return Buffer.from(Insight.encode(Insight.create(obj)).finish());
}

module.exports = { decodeInsight, encodeInsight };
