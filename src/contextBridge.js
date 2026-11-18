'use strict';
/*
 * Context Bridge (plan M3) — the single place an AI consumer reads body context from.
 *
 * Fast path: interpreter results → update(); slow path: Presage Insights → addInsight(). Both run
 * independently of any conversation. Readers get an immediate cache read; nothing here waits on the SDK
 * or on an Insight.
 *
 * Rules:
 *  - Every accepted update gets a monotonic sequence number, observedAt and expiresAt (TTL).
 *  - Updates/insights from a closed or different sensing session are rejected (late callbacks).
 *  - Identical consecutive context is de-duplicated (refreshes the timestamp, no new sequence).
 *  - Older insights never overwrite a newer one.
 *  - Reads require a valid capability (src/privacy/capabilities.js); revoked scope → denied.
 *  - Stale context (past TTL) is never returned as current.
 *  - Subscribers get coalesced pushes on meaningful change, at most once per minPushIntervalMs;
 *    invalidation (session closed / consent revoked) is pushed immediately as null.
 *  - Stats are counters only — no context values are recorded.
 */

const STATES = new Set(['calibrating', 'neutral', 'elevated', 'unclear', 'starting']);
const NO_CONTEXT = Object.freeze({ state: 'off', say: false, directive: null, suggestedUtterance: null, confidence: 0 });

function createContextBridge({
  capabilities,
  ttlMs = 5000,
  insightTtlMs = 90000,
  minPushIntervalMs = 15000,
  minConfidence = 0.4,
  now = Date.now,
} = {}) {
  let sessionGen = null;
  let seq = 0;
  let latest = null;   // { state, say, directive, suggestedUtterance, confidence, seq, observedAtMs, expiresAtMs }
  let insight = null;  // normalized insight + { seq }
  const subs = new Map(); // fn → { cap, lastPushAt, lastKey, timer }
  const stats = { accepted: 0, deduped: 0, rejectedSession: 0, rejectedInvalid: 0, insightsAccepted: 0, insightsRejected: 0, pushes: 0, denied: 0 };

  const key = (c) => (c ? `${c.state}|${c.say}|${c.directive || ''}` : 'null');

  function openSession(gen) {
    sessionGen = gen;
    latest = null;
    insight = null;
  }

  function closeSession() {
    sessionGen = null;
    latest = null;
    insight = null;
    for (const [fn, s] of subs) { clearTimeout(s.timer); s.timer = null; s.lastKey = 'null'; safeCall(fn, null); }
  }

  function update(ctx, gen) {
    if (gen !== sessionGen || sessionGen == null) { stats.rejectedSession++; return false; }
    if (!ctx || !STATES.has(ctx.state) || typeof ctx.confidence !== 'number' || !Number.isFinite(ctx.confidence)) { stats.rejectedInvalid++; return false; }
    const t = now();
    const lowConf = ctx.confidence < minConfidence && ctx.state !== 'unclear' && ctx.state !== 'calibrating';
    const next = {
      state: lowConf ? 'unclear' : ctx.state,
      say: lowConf ? false : !!ctx.say,
      directive: lowConf ? null : ctx.directive || null,
      suggestedUtterance: lowConf ? null : ctx.suggestedUtterance || null,
      confidence: Math.max(0, Math.min(1, ctx.confidence)),
    };
    if (latest && key(latest) === key(next)) {
      latest.observedAtMs = t;
      latest.expiresAtMs = t + ttlMs;
      latest.confidence = next.confidence;
      stats.deduped++;
      return true;
    }
    latest = { ...next, seq: ++seq, observedAtMs: t, expiresAtMs: t + ttlMs };
    stats.accepted++;
    for (const [fn] of subs) schedulePush(fn);
    return true;
  }

  function addInsight(normalized, gen) {
    if (gen !== sessionGen || sessionGen == null || !normalized) { stats.insightsRejected++; return false; }
    if (!normalized.ok) { stats.insightsRejected++; return false; }
    const ts = (n) => Date.parse(n.processedAt || '') || n.receivedAtMs || 0;
    if (insight && ts(normalized) < ts(insight)) { stats.insightsRejected++; return false; } // out of order
    insight = { ...normalized, seq: ++seq };
    stats.insightsAccepted++;
    return true;
  }

  function freshInsightNote(t) {
    return insight && insight.aiNote && t - insight.receivedAtMs <= insightTtlMs ? insight.aiNote : null;
  }

  /** Immediate cache read for an AI consumer. Never blocks. */
  function getApprovedContext(cap) {
    if (!capabilities.valid(cap)) { stats.denied++; return { ...NO_CONTEXT, state: 'not_authorized' }; }
    const t = now();
    if (!latest || sessionGen == null) return { ...NO_CONTEXT };
    if (t > latest.expiresAtMs) return { ...NO_CONTEXT, state: 'stale' };
    const out = { state: latest.state, say: latest.say, directive: latest.directive, suggestedUtterance: latest.suggestedUtterance, confidence: Math.round(latest.confidence * 100) / 100 };
    const note = freshInsightNote(t);
    if (note) out.note = note;
    return out;
  }

  /** What the consenting human may see in their own UI (includes the full Insight text). */
  function getHumanView() {
    const t = now();
    return {
      seq: latest ? latest.seq : 0,
      fresh: !!(latest && t <= latest.expiresAtMs),
      insight: insight ? { text: insight.humanText, origin: insight.origin, receivedAtMs: insight.receivedAtMs, aiNote: insight.aiNote } : null,
    };
  }

  function safeCall(fn, v) { try { fn(v); } catch {} }

  function schedulePush(fn) {
    const s = subs.get(fn);
    if (!s) return;
    if (!capabilities.valid(s.cap)) { safeCall(fn, null); unsubscribe(fn); return; }
    const deliver = () => {
      s.timer = null;
      if (!capabilities.valid(s.cap)) { safeCall(fn, null); unsubscribe(fn); return; }
      const ctx = getApprovedContext(s.cap);
      const k = key(ctx.state === 'off' || ctx.state === 'stale' ? null : ctx);
      if (k === s.lastKey) return;
      s.lastKey = k;
      s.lastPushAt = now();
      stats.pushes++;
      safeCall(fn, ctx);
    };
    if (s.timer) return; // a coalesced push is already queued; it will read the latest value
    const wait = s.lastPushAt == null ? 0 : Math.max(0, s.lastPushAt + minPushIntervalMs - now());
    if (wait === 0) deliver();
    else { s.timer = setTimeout(deliver, wait); if (s.timer.unref) s.timer.unref(); }
  }

  /** subscribe(cap, fn) → unsubscribe. fn(ctx) on meaningful change; fn(null) on invalidation. */
  function subscribe(cap, fn) {
    if (!capabilities.valid(cap)) { stats.denied++; return () => {}; }
    subs.set(fn, { cap, lastPushAt: null, lastKey: 'null', timer: null });
    if (latest) schedulePush(fn);
    return () => unsubscribe(fn);
  }

  function unsubscribe(fn) {
    const s = subs.get(fn);
    if (s) clearTimeout(s.timer);
    subs.delete(fn);
  }

  /** Call when consent changes so revoked consumers are cut off immediately. */
  function onConsentChange() {
    for (const [fn, s] of subs) if (!capabilities.valid(s.cap)) { safeCall(fn, null); unsubscribe(fn); }
  }

  return { openSession, closeSession, update, addInsight, getApprovedContext, getHumanView, subscribe, onConsentChange, stats: () => ({ ...stats }) };
}

module.exports = { createContextBridge, NO_CONTEXT };
