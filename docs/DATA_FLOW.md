# Attune — Data flow (current build)

What leaves where, when, and under which consent. Update this table whenever a flow changes.

| Data | Produced by | Goes to | When | Consent needed |
|---|---|---|---|---|
| Camera frames | Webcam | SmartSpectra SDK in the sensor worker process on this device | Only while sensing is active | `sensing` + `presageAck` |
| SDK service traffic (sign-in, automatic Insights; may include physiological measurements) | Presage SDK | Presage services | While the SDK runs | `sensing` + `presageAck` (disclosed in the consent dialog) |
| SDK telemetry | Presage SDK | Presage | Never — `enableTelemetry: false` | `diagnostics` (not wired yet) |
| Automatic Insights (buffered pulse, HRV, breathing → LLM text) | Presage SDK ↔ Presage | Presage, then back to the worker | ≈15 s after start, then every 60 s; no documented way to disable | `sensing` + `presageAck` |
| On-demand Insight prompt | Human clicks *Ask for a check-in* | Presage | At most 1 per 30 s | `sensing` + `presageAck` |
| Insight text (full) | Worker → Context Bridge | Human UI only | When it arrives | `sensing` |
| Insight AI note (numbers, medical and instruction sentences removed, ≤160 chars) | `src/insights/normalizer.js` | Companion / MCP as `note` | While < 90 s old | `aiSharing` |
| Decoded metrics (pulse, expression, talking) | SDK → adapter | Interpreter, in memory only | While sensing is active | `sensing` |
| Pulse BPM + signal tiles | Session | Human UI via `/api/state` (localhost, token) | While sensing is active | `sensing` |
| Approved context `{state, say, directive, suggestedUtterance, confidence}` | Session | Companion reply / MCP `get_body_context` | Per chat turn / per tool call | `aiSharing` (web) · `ai-sharing` in `ATTUNE_CONSENT` (MCP) |
| Chat message text | User | Anthropic API, only if `ATTUNE_ANTHROPIC_KEY` is set | Per chat turn | Using the chat (provider disclosure for hosted AI is plan M4-06) |
| Memory notes (state transitions, corrections; number-free) | Session | `.attune-memory.json` in the working directory (plaintext) | On transitions/corrections | `memory` |
| Demo memory history | `memory.seedDemo()` | Same file | Mock mode only | — (not in real mode) |

## Never sent to the AI
Pulse BPM, evidence strings (e.g. "pulse +14 over baseline"), raw metrics, video. Memory notes are stored
number-free ("pulse above baseline").

## Not yet verified
- Actual Presage network traffic has not been observed (plan M1-06 / M2-06).
- Whether automatic Insights can be disabled without disabling metrics (plan §9: unverified).
- Revocation cannot recall data already sent to Presage or to a hosted model.
