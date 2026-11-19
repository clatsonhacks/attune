'use strict';
/*
 * Session capabilities: short-lived handles that let one consumer (the companion, an MCP connector, a
 * voice session) read approved context. A capability is valid only while its consent scope is still on;
 * revoking the scope invalidates every capability issued for it at once. Consumers cannot mint their own.
 */
const crypto = require('crypto');

function createCapabilities({ consent, defaultTtlMs = 60 * 60 * 1000, now = Date.now }) {
  const live = new Map(); // id → { scope, purpose, expiresAt }

  /** lenses: optional list of lens ids this consumer may read (see contextBridge.getLensContext). */
  function issue({ scope = 'aiSharing', purpose, lenses, ttlMs = defaultTtlMs } = {}) {
    if (!consent.has(scope)) return null;
    const cap = { id: crypto.randomBytes(16).toString('hex'), scope, purpose: String(purpose || 'unspecified'), expiresAt: now() + ttlMs,
      ...(Array.isArray(lenses) ? { lenses: Object.freeze(lenses.map(String)) } : {}) };
    live.set(cap.id, cap);
    return cap;
  }

  function valid(cap) {
    if (!cap || !live.has(cap.id)) return false;
    const c = live.get(cap.id);
    if (now() > c.expiresAt || !consent.has(c.scope)) { live.delete(cap.id); return false; }
    return true;
  }

  function revokeScope(scope) {
    for (const [id, c] of live) if (c.scope === scope) live.delete(id);
  }

  consent.onChange((next) => {
    if (!next.aiSharing) revokeScope('aiSharing');
    if (!next.memory) revokeScope('memory');
  });

  /** Allowed lenses as recorded at issue time (never trust the caller's copy). */
  function lensesOf(cap) { const c = cap && live.get(cap.id); return c && c.lenses ? c.lenses : null; }

  return { issue, valid, lensesOf, revoke: (cap) => cap && live.delete(cap.id), count: () => live.size };
}

module.exports = { createCapabilities };
