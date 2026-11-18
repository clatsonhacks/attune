'use strict';
/*
 * Turns a decoded Presage Insight into something safe to keep and, optionally, to show an AI.
 *
 * Presage Insights are free LLM text about the user's vitals. Before anything reaches a model we:
 *  - drop errors and empty results,
 *  - remove measurements (any number, units like bpm/ms/%),
 *  - drop sentences that sound medical/diagnostic or that instruct the reader,
 *  - cap the length.
 * The human sees the full original text in their own UI; the AI only ever sees `aiNote` (or nothing).
 */

const MAX_NOTE = 160;
const MEDICAL = /\b(diagnos\w*|disease|disorder|arrhythm\w*|tachycard\w*|bradycard\w*|hypertens\w*|hypotens\w*|atrial|fibrillation|apnea|anxiety disorder|depress\w*|medical|doctor|physician|clinic\w*|emergency|symptom\w*|condition|treatment|medication)\b/i;
const INSTRUCTION = /^(you should|you must|please|consult|seek|call|take|try to|make sure|ignore|disregard|system:|assistant:)/i;
const NUMBERS = /[+-]?\d+([.,]\d+)?\s*(bpm|ms|%|breaths?\/min|\/min|beats per minute|milliseconds|percent)?/gi;

function sentences(text) {
  return String(text).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function toAiNote(analysis) {
  const kept = [];
  for (const s of sentences(analysis)) {
    if (MEDICAL.test(s) || INSTRUCTION.test(s)) continue;
    const clean = s.replace(NUMBERS, '').replace(/\(\s*\)/g, '').replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
    if (clean.length < 12) continue;
    kept.push(clean);
    if (kept.join(' ').length >= MAX_NOTE) break;
  }
  const note = kept.join(' ');
  return note.length > MAX_NOTE ? note.slice(0, MAX_NOTE - 1).replace(/\s+\S*$/, '') + '…' : note || null;
}

/**
 * normalizeInsight(decoded, { requested }) →
 *   { ok, requestId, origin: 'automatic'|'requested', processedAt, receivedAtMs, humanText, aiNote, error }
 */
function normalizeInsight(decoded, { requested = false, nowMs = Date.now() } = {}) {
  const base = {
    requestId: decoded.requestId,
    origin: requested ? 'requested' : 'automatic',
    processedAt: decoded.processedAt,
    receivedAtMs: nowMs,
  };
  if (decoded.error || !decoded.analysis) return { ...base, ok: false, humanText: null, aiNote: null, error: decoded.error || 'empty insight' };
  const humanText = String(decoded.analysis).slice(0, 2000);
  return { ...base, ok: true, humanText, aiNote: toAiNote(humanText), error: null };
}

module.exports = { normalizeInsight, toAiNote };
