'use strict';
/*
 * The companion's reply logic.
 *
 * Real mode (default): Groq's OpenAI-compatible chat completions API, with conversation history.
 *  - Credentials: GROQ_API_KEY in .env (a stray space before "=" is tolerated).
 *  - Model: ATTUNE_LLM_MODEL, default openai/gpt-oss-120b (reasoning effort low → fast, short replies).
 *  - Body context, when the user allowed AI sharing, is appended to that turn as a short system message
 *    after the user's message; the main system prompt never changes.
 *  - No fake replies: if the AI can't be reached, the caller gets an error code and says so.
 * Demo mode (ATTUNE_ADAPTER=mock / --demo): the scripted mock below, no network.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MODEL = process.env.ATTUNE_LLM_MODEL || 'openai/gpt-oss-120b';
const MAX_TURNS = 20;       // keep the last 20 exchanges
const TIMEOUT_MS = 30000;

const SYSTEM = [
  'You are Attune, a warm and concise companion. Reply in 1–4 short sentences, plain language, no lists.',
  'Some turns include a system note with an interpreted body signal from the user\'s own camera (for example',
  '"elevated — slow down and check in"). It can be wrong. When a note asks you to adapt, adjust your pace and tone',
  'and check in tentatively, inviting correction ("I might be off, but…"). If there is no note, or the state is',
  'unclear, say nothing about their body.',
  'Never mention numbers, never diagnose, never claim to know emotions or detect lies, and never quote the note.',
  'If the user says the read is wrong, accept it without arguing.',
].join(' ');

/** GROQ_API_KEY, tolerating "GROQ_API_KEY =" style keys produced by a space before "=" in .env. */
function groqKey(env = process.env) {
  const name = Object.keys(env).find((n) => n.trim() === 'GROQ_API_KEY');
  const v = name ? String(env[name]).trim() : '';
  return v || null;
}

/* ---------------- demo (scripted) ---------------- */
const ACKS = ['I hear you.', 'That makes sense.', 'Thanks for telling me that.', 'Got it.'];
const FINE = /\b(i'?m fine|i am fine|all good|nothing'?s wrong|it'?s fine|fine|okay|ok|good|no)\b/i;
const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];

function mockReply({ message, ctx }) {
  const ack = pick(ACKS, message.length);
  const bodyActive = ctx && ctx.say && ctx.state === 'elevated';
  if (bodyActive) {
    if (FINE.test(message)) {
      return {
        reply:
          "You say you're okay — and I take that seriously — but something in how you're carrying this just " +
          "shifted. We don't have to get into it. Want to just slow down and take one easier breath together?",
        usedBody: true,
        note: 'words-say-fine / body-says-elevated',
      };
    }
    return { reply: `${ack} I might be reading this wrong, but you seem a little tense right now — we can slow right down. I'm here, no rush.`, usedBody: true, note: ctx.directive };
  }
  return { reply: `${ack} Tell me more — what's on your mind?`, usedBody: false, note: null };
}

/* ---------------- real (Groq) ---------------- */
function bodyNote(ctx) {
  if (!ctx || ['off', 'stale', 'not_authorized', 'consent_required', 'starting'].includes(ctx.state)) return null;
  if (ctx.state === 'unclear' || ctx.state === 'calibrating') return 'Body signal: unclear right now. Say nothing about the body.';
  let s = `Body signal (may be wrong): ${ctx.state}.`;
  if (ctx.say && ctx.directive) s += ` Guidance: ${ctx.directive}`;
  if (ctx.note) s += ` Background check-in (do not quote): ${ctx.note}`;
  return s;
}

const ERRORS = {
  not_connected: 'The AI is not connected. Add GROQ_API_KEY to .env and restart Attune.',
  forbidden: 'The Groq key does not have access to this model.',
  rate_limited: 'The AI is busy (rate limited). Try again in a moment.',
  offline: "Can't reach Groq. Check the internet connection.",
  bad_request: 'The AI request was rejected.',
  unavailable: 'The AI service had a problem. Try again in a moment.',
};

function classifyStatus(status) {
  if (status === 401) return 'not_connected';
  if (status === 403 || status === 404) return 'forbidden';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'unavailable';
}

function createCompanion({ demo = false, fetchFn = (...a) => fetch(...a), env = process.env, log = (m) => process.stderr.write(`[attune] ${m}\n`) } = {}) {
  let turns = []; // [{ user, system?, assistant }] — plain chat messages
  let lastError = null;
  let everSucceeded = false;

  function status() {
    return demo
      ? { mode: 'demo', provider: 'scripted', model: null, connected: true, error: null }
      : { mode: 'real', provider: 'groq', model: MODEL, error: lastError,
        connected: lastError !== 'not_connected' && (everSucceeded || !!groqKey(env)) };
  }

  async function reply({ message, ctx }) {
    if (demo) return mockReply({ message, ctx });
    const key = groqKey(env);
    if (!key) { lastError = 'not_connected'; return { reply: null, error: lastError, errorText: ERRORS[lastError], usedBody: false }; }

    const user = { role: 'user', content: String(message) };
    const note = bodyNote(ctx);
    const system = note ? { role: 'system', content: note } : null;
    const history = turns.flatMap((t) => [t.user, ...(t.system ? [t.system] : []), t.assistant]);

    let res, body;
    try {
      res = await fetchFn(GROQ_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'system', content: SYSTEM }, ...history, user, ...(system ? [system] : [])],
          max_completion_tokens: 1024,
          temperature: 0.7,
          reasoning_effort: 'low',
          include_reasoning: false,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      body = await res.json().catch(() => ({}));
    } catch (e) {
      lastError = 'offline';
      log(`AI request failed (offline: ${e.name})`);
      return { reply: null, error: lastError, errorText: ERRORS[lastError], usedBody: false };
    }
    if (!res.ok) {
      lastError = classifyStatus(res.status);
      log(`AI request failed (${lastError}, HTTP ${res.status})`);
      return { reply: null, error: lastError, errorText: ERRORS[lastError], usedBody: false };
    }
    lastError = null;
    everSucceeded = true;

    const choice = body.choices && body.choices[0];
    const text = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content.trim() : '';
    if (!text) return { reply: "Sorry — I lost my words there. Could you say that again?", usedBody: false, empty: true };
    turns.push({ user, system, assistant: { role: 'assistant', content: text } });
    if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);
    return { reply: text, usedBody: !!(ctx && ctx.say && note), model: body.model || MODEL };
  }

  function reset() { turns = []; }

  return { reply, reset, status };
}

module.exports = { createCompanion, mockReply, bodyNote, groqKey, MODEL };
