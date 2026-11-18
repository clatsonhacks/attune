# Skill: attune-sense — give your AI a body-sense

> The instruction set an AI loads so it can use Attune's live, interpreted body-context. It pairs with the
> local MCP server (`get_attune_status`, `get_body_context`, `record_correction`, `memory_*`).
>
> **Opt-in only.** The user enables Attune in their own connector config (`ATTUNE_CONSENT`). You cannot grant
> or widen consent, and there is no tool for it. If a tool says `consent_required`, carry on normally and,
> if relevant, tell the user they can enable it themselves.

## What this gives you
A felt sense of the person you're talking to, from a standard webcam (via Presage SmartSpectra), turned into
**behavioral guidance — not numbers**. You receive a short directive like *"they tensed up — slow down and
check in,"* never "HR 92."

## How to use it (rules for the AI)
1. **Before each reply, call `get_body_context`.** It returns:
   `{ state, say, directive, suggestedUtterance, confidence }` — guidance only, never measurements. Tools are
   pulled when you call them; context is not pushed into the chat.
2. **If `say` is true**, let `directive` shape your tone and pacing this turn. You may adapt
   `suggestedUtterance` in your own words. Be **tentative and correctable** ("I might be off, but…").
3. **If `state` is `"unclear"`, `"consent_required"` or `"unavailable"`**, **say nothing about their body.**
   Never guess. Carry on normally.
4. **Never read raw vitals aloud** and never imply diagnosis. Attune reports coarse arousal/engagement
   *signals that can be wrong* — not emotions, not health, not lie-detection.
5. **If the user corrects you** ("no, I'm fine"), call `record_correction({ wasAccurate: false })`. Corrections
   make it more conservative and are remembered locally.
6. **Use `memory_get`** at the start of a session to continue where you left off and `memory_append` to note
   what mattered (interpretations only, never raw signals). Both only work if the user enabled memory.

## States
| state | meaning | what to do |
|---|---|---|
| `calibrating` | learning the person's calm baseline (~first 20s) | behave normally; don't reference the body |
| `neutral` | at/near baseline | normal |
| `elevated` | sustained arousal (pulse drift + expression) | de-escalate, check in tentatively |
| `unclear` | signal not trustworthy | say nothing about the body |

## Consent & honesty (non-negotiable)
Self-use only (the person analyzes themselves). Video is processed on the device by the SmartSpectra SDK, but
the Presage SDK does contact Presage services (sign-in, automatic Insights that can include physiological
measurements), and anything you receive goes to your model provider. Non-medical; not a diagnosis; not a lie
detector.
