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
| Approved context `{state, say, directive, suggestedUtterance, confidence}` | Session | Built-in companion reply | Per chat turn / per tool call | `aiSharing` (one setting in Attune for the companion and every connector) |
| Approved action cue | Connector API | MCP client | Per approved context request | Only predefined cues and operational states leave this boundary. Measurements and free-text check-ins are excluded. |
| Continuous microphone and spoken response audio | User microphone and OpenAI Realtime | Direct WebRTC audio connection | While live voice is active | Start live voice disclosure, microphone permission, and the user's OpenAI API key. Ending the call releases the microphone. |
| Live transcripts and approved pacing cue | OpenAI Realtime and Attune | Transcripts in the local conversation, pacing cue via the call data channel | During a live call | Camera is optional. Attune sends a cue only when camera sensing and AI sharing permit it. |
| Chat message text + conversation history (last 20 turns, in memory only) | User | Groq API (`openai/gpt-oss-120b`), when `GROQ_API_KEY` is set | Per chat turn | Using the chat; disclosed under the chat box (demo mode: nothing leaves the device) |
| Memory notes (state transitions, corrections; number-free) | Session | `memory.json` in the data folder (plaintext) | On transitions/corrections | `memory` |
| Demo memory history | `memory.seedDemo()` | `demo/memory.json` (separate file) | Demo mode only | — (real mode removes any demo entries from its file) |

## When the camera runs (decided 19 Nov 2026)
Consent is asked **once** and saved in `consent.json` in the data folder (deleted by *Forget camera permission*).
Saved consent is permission only. The camera turns on when:
- the person allows it in the dialog (starts at once), or taps *turn on now* / *resume*;
- a conversation starts (its first message);
- the AI calls `check_in_with_body` — only offered when AI sharing is allowed; it answers immediately
  ("camera starting" / current reading) and never waits for the camera;
- a connected app (Claude Desktop, ChatGPT, …) calls `get_body_context` for a purpose the person approved for it —
  same rules: never while paused, answers at once ("starting" while the camera warms up), idle timer restarts.

It turns off after `ATTUNE_SENSE_IDLE_MS` (default 5 min) without chat activity, on *pause* (sticky until
*resume*, also across restarts) and when permission is forgotten. A *Camera on* badge shows whenever it runs.
If breathing can't be measured because the chest isn't in view for 20 s, it continues with face-only metrics
(no breathing, HRV or Presage check-ins); `ATTUNE_METRICS=face` starts that way.

## Connecting other AI apps
The Attune service (`npm run web`) is the only process that opens the camera and holds consent, approvals, activity
and memory. MCP connectors (`src/server.js`, started by the AI app) are thin clients of its **connector API**:

- On listen the service writes `service.json` to the data folder — `{ version: 1, port, token, pid, startedAt }`,
  atomic, user-only permissions — and removes it on a clean shutdown if it still describes this run. The token is
  32 random bytes (hex), reused if a previous run left the file behind. The connector re-reads the file on every call
  and sends the token only to `127.0.0.1:<port>`; it is never logged.
- `/connector/v1/*` needs `Authorization: Bearer <token>`, the same Host check as the UI, and refuses any request
  carrying an `Origin` (or `Sec-Fetch-Site`) header, so web pages can never call it. Routes: `GET status`,
  `GET purposes`, `POST context`, `POST correction`, `GET|POST memory`. There is no consent, approval or forget
  route — those stay in the person's UI.
- What a connector receives is exactly what `get_body_context` returns: a reviewed action cue without measurements, or a state such as `consent_required`, `purpose_not_approved`,
  `paused`, `starting`. If the service isn't running the connector answers `attune_not_running`.

- **Claude Desktop:** after the person ticks an approval box on the Connectors page, Attune adds one `attune-sense`
  entry to `claude_desktop_config.json` (atomic write; existing entries untouched; refuses if an Attune entry already
  exists or the file can't be read). The entry carries only `ATTUNE_APP_ID=claude-desktop` — no consent. Removing
  the entry in Claude Desktop revokes it.
- **ChatGPT (tunnel profile, `server.js --chatgpt`):** only status, purposes and interpreted context are exposed, and
  approvals are strict: ChatGPT gets no lens (not even companion) until the person allows it in Attune. Context then
  travels through OpenAI's tunnel to the ChatGPT workspace the tunnel is associated with.
- **Lenses:** each app asks with a purpose (`get_body_context({ purpose })`) and reads through that lens only if the
  person approved it for that app. Every connector receives guidance only, including during yoga practice. Unknown or unapproved purposes never start the camera.

| Data | Where | Contents |
|---|---|---|
| App approvals | `apps.json` in the data folder (demo: `demo/apps.json`) | app id → approved lenses; pending purpose requests (app, lens, time) |
| Activity log | `activity.jsonl` in the data folder (demo: `demo/activity.jsonl`) | time, app, lens, kind, state, say — never directives, notes or numbers |
| Running service | `service.json` in the data folder, only while Attune runs | port, connector token, pid, start time |
| App presence | Service memory only | when each app's connector last called the service ("Connected — seen 2 min ago") |

**Data folder:** `ATTUNE_DATA_DIR`, else `%APPDATA%\Attune` (Windows), `~/Library/Application Support/Attune` (macOS),
`$XDG_CONFIG_HOME/attune` or `~/.config/attune` (Linux); demo mode uses `demo/`. Legacy repo-root files
(`.attune-consent.json`, `.attune-memory.json`, `.attune-apps.json`, `.attune-activity.jsonl` and their `-demo-`
variants) are copied in once when the new file is missing; the old files are never deleted.

## Never sent to the AI
Pulse BPM, evidence strings (e.g. "pulse +14 over baseline"), raw metrics, video. Memory notes are stored
number-free ("pulse above baseline").

## Not yet verified
- Actual Presage network traffic has not been observed (plan M1-06 / M2-06).
- Whether automatic Insights can be disabled without disabling metrics (plan §9: unverified).
- Revocation cannot recall data already sent to Presage or to a hosted model.
