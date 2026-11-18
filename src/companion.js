'use strict';
/*
 * The companion's reply logic.
 *
 * Real mode (default): Claude via the official Anthropic SDK, with conversation history.
 *  - Credentials: ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN / an `ant auth login` profile, resolved by the SDK).
 *    ATTUNE_ANTHROPIC_KEY is still accepted for older .env files.
 *  - Body context, when the user allowed AI sharing, is appended to that turn as a short mid-conversation
 *    system message. The top-level system prompt never changes, so it stays cacheable.
 *  - No fake replies: if the AI can't be reached, the caller gets an error code and says so.
 * Demo mode (ATTUNE_ADAPTER=mock / --demo): the scripted mock below, no network.
 */
const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.ATTUNE_LLM_MODEL || 'claude-opus-5-5';
const MAX_TURNS = 20; // keep the last 20 exchanges

const SYSTEM = [
  'You are Attune, a warm and concise companion. Reply in 1–4 short sentences, plain language, no lists.',
  'Some turns include a system note with an interpreted body signal from the user\'s own camera (for example',
  '"elevated — slow down and check in"). It can be wrong. When a note asks you to adapt, adjust your pace and tone',
  'and check in tentatively, inviting correction ("I might be off, but…"). If there is no note, or the state is',
  'unclear, say nothing about their body.',
  'Never mention numbers, never diagnose, never claim to know emotions or detect lies, and never quote the note.',
  'If the user says the read is wrong, accept it without arguing.',
].join(' ');

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

/* ---------------- real (Claude) ---------------- */
function bodyNote(ctx) {
  if (!ctx || ['off', 'stale', 'not_authorized', 'consent_required', 'starting'].includes(ctx.state)) return null;
  if (ctx.state === 'unclear' || ctx.state === 'calibrating') return 'Body signal: unclear right now. Say nothing about the body.';
  let s = `Body signal (may be wrong): ${ctx.state}.`;
  if (ctx.say && ctx.directive) s += ` Guidance: ${ctx.directive}`;
  if (ctx.note) s += ` Background check-in (do not quote): ${ctx.note}`;
  return s;
}

const ERRORS = {
  not_connected: 'The AI is not connected. Add ANTHROPIC_API_KEY to .env and restart Attune.',
  forbidden: 'The API key does not have access to this model.',
  rate_limited: 'The AI is busy (rate limited). Try again in a moment.',
  offline: "Can't reach the AI service. Check the internet connection.",
  bad_request: 'The AI request was rejected.',
  unavailable: 'The AI service had a problem. Try again in a moment.',
};

function classify(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'not_connected';
  if (e instanceof Anthropic.PermissionDeniedError) return 'forbidden';
  if (e instanceof Anthropic.RateLimitError) return 'rate_limited';
  if (e instanceof Anthropic.BadRequestError) return 'bad_request';
  if (e instanceof Anthropic.APIConnectionError) return 'offline';
  if (e instanceof Anthropic.APIError) return 'unavailable';
  // The SDK throws a plain error before any request when no credentials can be resolved.
  if (/api[_ ]?key|auth/i.test(String(e && e.message))) return 'not_connected';
  return 'unavailable';
}

function createCompanion({ demo = false, client, log = (m) => process.stderr.write(`[attune] ${m}\n`) } = {}) {
  let turns = []; // [{ user, system?, assistant }] — assistant is the full response.content (keeps thinking blocks)
  let lastError = null;
  let everSucceeded = false;
  let api = client || null;
  const hasEnvCredential = () => !!(client || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ATTUNE_ANTHROPIC_KEY);

  function getClient() {
    if (!api) {
      const legacy = process.env.ATTUNE_ANTHROPIC_KEY;
      api = legacy && !process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: legacy }) : new Anthropic();
    }
    return api;
  }

  function status() {
    return demo
      ? { mode: 'demo', provider: 'scripted', model: null, connected: true, error: null }
      : {
        mode: 'real', provider: 'anthropic', model: MODEL, error: lastError,
        // Not "connected" until a key is configured or a call has worked; any auth failure clears it.
        connected: lastError !== 'not_connected' && (everSucceeded || hasEnvCredential()),
      };
  }

  async function reply({ message, ctx }) {
    if (demo) return mockReply({ message, ctx });

    const user = { role: 'user', content: String(message) };
    const note = bodyNote(ctx);
    const system = note ? { role: 'system', content: note } : null;
    const history = turns.flatMap((t) => [t.user, ...(t.system ? [t.system] : []), { role: 'assistant', content: t.assistant }]);

    let res;
    try {
      res = await getClient().beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default', // on a policy decline, the API retries on a suitable fallback model
        output_config: { effort: 'low' }, // short conversational turns
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [...history, user, ...(system ? [system] : [])],
      });
    } catch (e) {
      lastError = classify(e);
      log(`AI request failed (${lastError})`);
      return { reply: null, error: lastError, errorText: ERRORS[lastError], usedBody: false };
    }
    lastError = null;
    everSucceeded = true;

    if (res.stop_reason === 'refusal') {
      return { reply: "I can't help with that one, but I'm still here if you want to talk about something else.", usedBody: false, refused: true };
    }
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    turns.push({ user, system, assistant: res.content });
    if (turns.length > MAX_TURNS) turns = turns.slice(-MAX_TURNS);
    return { reply: text || '…', usedBody: !!(ctx && ctx.say && note), model: res.model };
  }

  function reset() { turns = []; }

  return { reply, reset, status };
}

module.exports = { createCompanion, mockReply, bodyNote, MODEL };
