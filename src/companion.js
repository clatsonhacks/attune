'use strict';
/*
 * The companion's reply logic.
 *
 * For the credential-free "basic version" this is a DETERMINISTIC mock that visibly changes
 * its tone based on the body-context — so the signal→behavior loop is demonstrable with no LLM.
 * In the real build you replace `mockReply` with a third-party LLM call (Shape A: the AI calls
 * get_body_context via MCP; here we inline it). If ATTUNE_ANTHROPIC_KEY is set, `companionReply`
 * will instead call the Anthropic API using the body-context as system guidance.
 */

const ACKS = ['I hear you.', 'That makes sense.', 'Thanks for telling me that.', 'Got it.'];
const FINE = /\b(i'?m fine|i am fine|all good|nothing'?s wrong|it'?s fine|fine|okay|ok|good|no)\b/i;

function pick(arr, seed) {
  return arr[Math.abs(seed) % arr.length];
}

function mockReply({ message, ctx }) {
  const ack = pick(ACKS, message.length);
  const bodyActive = ctx && ctx.say && ctx.state === 'elevated';

  if (bodyActive) {
    if (FINE.test(message)) {
      // The signature "words say X, body says Y" moment.
      return {
        reply:
          "You say you're okay — and I take that seriously — but something in how you're carrying this just " +
          "shifted. We don't have to get into it. Want to just slow down and take one easier breath together?",
        usedBody: true,
        note: 'words-say-fine / body-says-elevated',
      };
    }
    return {
      reply: `${ack} I might be reading this wrong, but you seem a little tense right now — we can slow right down. I'm here, no rush.`,
      usedBody: true,
      note: ctx.directive,
    };
  }

  // Neutral / calibrating / unclear → normal, warm, no body claims.
  return {
    reply: `${ack} Tell me more — what's on your mind?`,
    usedBody: false,
    note: null,
  };
}

async function companionReply({ message, ctx }) {
  const key = process.env.ATTUNE_ANTHROPIC_KEY;
  if (!key) return mockReply({ message, ctx });

  // Optional real LLM path (not exercised in the credential-free demo).
  const system =
    'You are a warm, concise companion. You receive a private body-context signal about the user. ' +
    (ctx && ctx.say && ctx.directive
      ? `Right now: ${ctx.directive} Be tentative and invite correction. Never mention numbers or diagnose.`
      : 'No strong body signal right now; respond normally. Never mention numbers or diagnose.') +
    (ctx && ctx.note ? ` Background from the sensor (may be wrong, do not quote it): ${ctx.note}` : '');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ATTUNE_LLM_MODEL || 'claude-sonnet-5-5',
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: message }],
      }),
    });
    const data = await res.json();
    const reply = (data.content && data.content[0] && data.content[0].text) || '(no reply)';
    return { reply, usedBody: !!(ctx && ctx.say), note: ctx && ctx.directive };
  } catch (e) {
    return mockReply({ message, ctx });
  }
}

module.exports = { companionReply, mockReply };
