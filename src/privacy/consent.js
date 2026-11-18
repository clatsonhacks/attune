'use strict';
/*
 * Trusted consent state. Only the local human-facing UI (or a config file the human wrote) may call
 * grant()/revoke(); nothing an AI can call reaches this module.
 *
 * Scopes are separate and all off by default:
 *   sensing     — camera + SmartSpectra may run. Requires presageAck (the Presage-processing disclosure).
 *   aiSharing   — a short interpreted hint may be given to the selected AI.
 *   memory      — interpretations/corrections may be stored locally.
 *   diagnostics — optional SDK telemetry (kept off unless explicitly chosen).
 */

const SCOPES = ['sensing', 'aiSharing', 'memory', 'diagnostics'];

function createConsent() {
  let scopes = { sensing: false, aiSharing: false, memory: false, diagnostics: false };
  let presageAck = false;
  let version = 0; // bumps on every change so stale consumers can detect revocation
  const listeners = new Set();

  function snapshot() {
    return { ...scopes, presageAck, version };
  }

  function emit(prev) {
    const next = snapshot();
    for (const fn of listeners) {
      try { fn(next, prev); } catch {}
    }
  }

  /**
   * grant({ sensing, presageAck, aiSharing, memory, diagnostics }) — any omitted scope keeps its value.
   * Throws if sensing is requested without the Presage disclosure being acknowledged.
   */
  function grant(req = {}) {
    const ack = req.presageAck != null ? !!req.presageAck : presageAck;
    if (req.sensing && !ack) {
      const err = new Error('Sensing needs the Presage processing disclosure to be acknowledged first.');
      err.code = 'presage_ack_required';
      throw err;
    }
    const prev = snapshot();
    presageAck = ack;
    for (const k of SCOPES) if (req[k] != null) scopes[k] = !!req[k];
    if (!presageAck) scopes.sensing = false;
    version++;
    emit(prev);
    return snapshot();
  }

  /** revoke(scopes?) — revoke the named scopes, or everything when called with no argument. */
  function revoke(names) {
    const prev = snapshot();
    const list = names && names.length ? names : SCOPES;
    for (const k of list) if (SCOPES.includes(k)) scopes[k] = false;
    version++;
    emit(prev);
    return snapshot();
  }

  function has(scope) {
    return !!scopes[scope] && (scope !== 'sensing' || presageAck);
  }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { grant, revoke, has, snapshot, onChange };
}

/**
 * Parse a human-written consent string, e.g. ATTUNE_CONSENT="sensing,presage-ack,ai-sharing".
 * Used by the stdio MCP connector, where the human's config file is the trusted surface.
 */
function parseConsentString(str) {
  const parts = String(str || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const set = new Set(parts);
  return {
    sensing: set.has('sensing'),
    presageAck: set.has('presage-ack'),
    aiSharing: set.has('ai-sharing'),
    memory: set.has('memory'),
    diagnostics: set.has('diagnostics'),
  };
}

module.exports = { createConsent, parseConsentString, SCOPES };
