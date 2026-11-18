'use strict';
/*
 * Local-first memory. Stores INTERPRETATIONS only (state transitions, corrections,
 * notable moments) — never raw video or raw vitals. Plain JSON for the prototype;
 * encryption-at-rest + user key is planned.
 */
const fs = require('fs');
const path = require('path');

function createMemory(filePath = path.join(process.cwd(), '.attune-memory.json')) {
  function _loadRaw() {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return { version: 1, sessions: [] };
    }
  }
  let data = _loadRaw();
  let muted = false; // "Private" mode: suppress all writes

  function _persist() {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (e) {
      // Non-fatal in the prototype; never crash the connector over a memory write.
      process.stderr.write(`[attune/memory] write failed: ${e.message}\n`);
    }
  }

  return {
    /** Private mode — when muted, nothing is written to local storage. */
    setMuted(b) { muted = !!b; },
    isMuted() { return muted; },

    /** Append an interpretation event to the current/most-recent session bucket. */
    append(event) {
      if (muted) return;
      if (!data.sessions.length) data.sessions.push({ startedAt: Date.now(), events: [] });
      data.sessions[data.sessions.length - 1].events.push({ at: Date.now(), ...event });
      _persist();
    },
    /** Start a fresh session bucket (call at session start). */
    startSession(meta = {}) {
      if (muted) return;
      data.sessions.push({ startedAt: Date.now(), ...meta, events: [] });
      _persist();
    },

    /** Seed a few past-dated sample days so the calendar isn't empty (demo only). */
    /** Remove demo-seeded history (real mode must never show fake days). */
    dropDemo() {
      const before = data.sessions.length;
      data.sessions = data.sessions.filter((s) => !s.demo);
      if (data.sessions.length !== before || data.seeded) { delete data.seeded; _persist(); }
      return before - data.sessions.length;
    },

    seedDemo() {
      if (data.seeded) return;
      const DAY = 86400000, now = Date.now();
      const add = (daysAgo, notes) => data.sessions.unshift({ startedAt: now - daysAgo * DAY, demo: true, events: notes.map((n) => ({ at: now - daysAgo * DAY, type: 'state', note: n })) });
      add(1, ['with you · two calm moments']);
      add(3, ['noticed tension · settled after a breath']);
      add(4, ['calm throughout']);
      add(8, ['elevated during a hard topic · recovered']);
      data.seeded = true; _persist();
    },

    /** Group stored memory by calendar day: { 'YYYY-MM-DD': { count, moments[] } }. */
    calendar() {
      const map = {};
      for (const s of data.sessions) {
        const key = new Date(s.startedAt).toISOString().slice(0, 10);
        if (!map[key]) map[key] = { count: 0, moments: [] };
        map[key].count++;
        for (const e of s.events) if (e.note) map[key].moments.push(e.note);
      }
      return map;
    },
    /** Delete one day's memory. */
    forgetDay(key) {
      data.sessions = data.sessions.filter((s) => new Date(s.startedAt).toISOString().slice(0, 10) !== key);
      _persist();
    },
    /** A compact summary the AI loads at the start of a conversation. */
    summary({ lastN = 3 } = {}) {
      const sessions = data.sessions.slice(-lastN).map((s) => ({
        startedAt: s.startedAt,
        moments: s.events
          .filter((e) => e.type === 'state' || e.type === 'correction')
          .map((e) => e.note || e.state)
          .slice(-6),
      }));
      return { sessionsRemembered: data.sessions.length, recent: sessions };
    },
    getAll() {
      return data;
    },
    /** User-controlled erase (the "delete my memory" control). */
    clear() {
      data = { version: 1, sessions: [] };
      _persist();
    },
    _filePath: filePath,
  };
}

module.exports = { createMemory };
