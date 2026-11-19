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
| Chat message text + conversation history (last 20 turns, in memory only) | User | Groq API (`openai/gpt-oss-120b`), when `GROQ_API_KEY` is set | Per chat turn | Using the chat; disclosed under the chat box (demo mode: nothing leaves the device) |
| Memory notes (state transitions, corrections; number-free) | Session | `.attune-memory.json` in the working directory (plaintext) | On transitions/corrections | `memory` |
| Demo memory history | `memory.seedDemo()` | `.attune-demo-memory.json` (separate file) | Demo mode only | — (real mode removes any demo entries from its file) |

## When the camera runs (decided 19 Nov 2026)
Consent is asked **once** and saved in `.attune-consent.json` (gitignored; deleted by *Forget camera permission*).
Saved consent is permission only. The camera turns on when:
- the person allows it in the dialog (starts at once), or taps *turn on now* / *resume*;
- a conversation starts (its first message);
- the AI calls `check_in_with_body` — only offered when AI sharing is allowed; it answers immediately
  ("camera starting" / current reading) and never waits for the camera.

It turns off after `ATTUNE_SENSE_IDLE_MS` (default 5 min) without chat activity, on *pause* (sticky until
*resume*, also across restarts) and when permission is forgotten. A *Camera on* badge shows whenever it runs.
If breathing can't be measured because the chest isn't in view for 20 s, it continues with face-only metrics
(no breathing, HRV or Presage check-ins); `ATTUNE_METRICS=face` starts that way.

## Connecting other AI apps
- **Claude Desktop:** after the person ticks an approval box on the Connectors page, Attune adds one `attune-sense`
  entry to `claude_desktop_config.json` (atomic write; existing entries untouched; refuses if an Attune entry already
  exists or the file can't be read). The entry carries `ATTUNE_CONSENT=sensing,presage-ack,ai-sharing`. Removing
  the entry in Claude Desktop revokes it.
- **ChatGPT (tunnel profile, `server.js --chatgpt`):** only status and interpreted context are exposed; sensing stays
  off unless `ATTUNE_CHATGPT_CONSENT` is set in the local tunnel client. Context then travels through OpenAI's tunnel
  to the ChatGPT workspace the tunnel is associated with.
- **Lenses:** each app asks with a purpose (`get_body_context({ purpose })`) and reads through that lens only if the
  person approved it for that app. Companion and casual share no numbers; yoga shares breathing rate and target pace
  only (never heart numbers). Unknown or unapproved purposes never start the camera.

| Data | Where | Contents |
|---|---|---|
| App approvals | `.attune-apps.json` (repo root, gitignored; demo: `.attune-demo-apps.json`) | app id → approved lenses; pending purpose requests (app, lens, time) |
| Activity log | `.attune-activity.jsonl` (gitignored; demo: `.attune-demo-activity.jsonl`) | time, app, lens, kind, state, say — never directives, notes or numbers |

## Never sent to the AI
Pulse BPM, evidence strings (e.g. "pulse +14 over baseline"), raw metrics, video. Memory notes are stored
number-free ("pulse above baseline").

## Not yet verified
- Actual Presage network traffic has not been observed (plan M1-06 / M2-06).
- Whether automatic Insights can be disabled without disabling metrics (plan §9: unverified).
- Revocation cannot recall data already sent to Presage or to a hosted model.
