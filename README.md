# attune-sense (prototype)

Attune turns contactless vitals (Presage SmartSpectra) into **behavioral nudges for an AI, not numbers**, and
ships as a **local MCP connector** that Claude or ChatGPT desktop connects to.

> Prototype. No secrets committed; use `.env`. Roadmap: [docs/ATTUNE_IMPLEMENTATION_PLAN.md](docs/ATTUNE_IMPLEMENTATION_PLAN.md) ·
> how data moves: [docs/DATA_FLOW.md](docs/DATA_FLOW.md) · threats: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

**Consent first.** The camera/SDK never starts at boot. In the web UI it starts only after you tick *Camera
sensing* and *I understand Presage processing*; sharing with the AI and local memory are separate, optional,
and off by default. An AI cannot grant any of this.

## Try it without a camera or API key
```bash
npm install
npm run web             # ⭐ self-contained demo UI at http://localhost:3000 (HUD + companion chat)
npm run demo            # interpreter on synthetic vitals (prints the nudges)
npm test                # privacy tests (consent, revoke, late callbacks, token/origin guard, MCP) + checks
```
**The web demo** (`npm run web`, local only on `127.0.0.1`): tap *Grant consent to sense*, tick the boxes (tick
*Share with the AI* to let the companion use the signal), watch the state cycle calm→stress→recovery, then say
"I'm fine" while it shows **elevated** — the companion catches the gap. Runs on mock vitals + a mock companion (no credentials). Set `ATTUNE_ANTHROPIC_KEY` to use a real LLM.

## Run the MCP connector
```bash
npm run connector       # starts the stdio MCP server (mock adapter by default; ATTUNE_ADAPTER=smartspectra for the real SDK)
```
Consent comes from **your** config, not from the AI. Without `ATTUNE_CONSENT`, `get_body_context` returns
`consent_required` and the camera never starts. With it, the camera starts on the first `get_body_context`
call and stops after 2 minutes without calls (`ATTUNE_IDLE_MS`).

| `ATTUNE_CONSENT` word | allows |
|---|---|
| `sensing` + `presage-ack` | camera + SmartSpectra (both required) |
| `ai-sharing` | interpreted, number-free context returned to the AI |
| `memory` | interpretations stored locally / `memory_*` tools |

### Add it to Claude Desktop
In `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "attune-sense": {
      "command": "node",
      "args": ["<abs-path>/attune/src/server.js"],
      "env": { "ATTUNE_CONSENT": "sensing,presage-ack,ai-sharing" }
    }
  }
}
```
(ChatGPT desktop: add it as a local MCP connector the same way.) Then ask the AI to call `get_body_context`
before replying — see `SKILL.md` for the usage contract.

## Tools exposed
`get_attune_status` · `get_body_context` · `record_correction` · `memory_get` · `memory_append` · `forget_me`
(there is deliberately no consent tool)

## Layout
- `src/interpreter.js` — baseline + pulse-drift/expression thresholds, confidence gate, hysteresis, nudges.
- `src/session.js` — standing body-context for the AI (poll-safe) + memory wiring.
- `src/privacy/consent.js` — trusted consent scopes · `src/privacy/localGuard.js` — localhost/token/origin guard.
- `src/sensing.js` — the only place the sensor starts/stops; drops late callbacks after revoke.
- `src/adapter/isolated.js` + `worker.js` — the real SDK runs in its own process (`ATTUNE_ISOLATE=0` to disable).
- `src/contextBridge.js` — what any AI reads: fresh, sequenced, never blocked on Insights · `src/insights/` — Presage Insight decoder + normalizer.
- `src/memory.js` — local-first store (interpretations only; encryption is M5).
- `src/adapter/mock.js` — synthetic stream · `src/adapter/smartspectra.js` — real SDK adapter.
- `src/server.js` — the MCP connector · `SKILL.md` — how an AI uses it.
- `tests/**/*.test.js` — `node:test` suite (privacy, insights, context bridge) · `run-demo.js` · `test-connector.js` · `test-adapter.js`.

## Use the real SmartSpectra SDK
`@smartspectra/node-sdk` is already a dependency (prebuilt native runtime for win32-x64, darwin-arm64,
linux-x64/arm64; Node >= 20). Switch adapters with one env var, no code change:
```bash
cp .env.example .env          # then set SMARTSPECTRA_API_KEY (from physiology.presagetech.com)
                              # and ATTUNE_ADAPTER=smartspectra
npm run web                   # or: npm run connector
```
`src/adapter/smartspectra.js` creates a `SmartSpectraSDK` on the default webcam, requests pulse rate,
expressions, talking and blinking (telemetry off), and maps each decoded `Metrics` packet to our sample
shape (`cardio.pulseRate`, `cardio.hrv`, `breathing.rate`, `face.expression`, `face.talking`; confidence 0–100 →
0–1). It requests the breathing + cardio sets Presage needs for **Insights**: Presage sends automatic check-ins
(about 15 s after start, then every 60 s) and you can ask for one (*Ask for a check-in*, max 1 per 30 s). You see
the full text; the AI only gets a short number-free note. `npm run test:adapter` checks the mapping against the SDK's own protobuf decoder.

## Status
Plan M0 ✅ · M1 consent + local boundary + worker isolation ✅ · M2 Insights ✅ (live-webcam validation pending) ·
M3 Context Bridge ✅ · next: M4 Attune Live voice.
