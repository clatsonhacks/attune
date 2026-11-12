# attune-sense (prototype)

Attune turns contactless vitals (Presage SmartSpectra) into **behavioral nudges for an AI, not numbers**, and
ships as a **local MCP connector** that Claude or ChatGPT desktop connects to.

> Prototype. No secrets committed; use `.env`.

## Try it without a camera or API key
```bash
npm install
npm run web             # ⭐ self-contained demo UI at http://localhost:3000 (HUD + companion chat)
npm run demo            # interpreter on synthetic vitals (prints the nudges)
npm run test:connector  # headless test of the connector brain (memory + session + consent loop)
npm run test:adapter    # SmartSpectra mapping vs the SDK's protobuf schema
```
**The web demo** (`npm run web`) is the "basic version": grant consent, watch the state cycle
calm→stress→recovery on the left, then say "I'm fine" while it shows **elevated** — the companion catches the
gap. Runs on mock vitals + a mock companion (no credentials). Set `ATTUNE_ANTHROPIC_KEY` to use a real LLM.

## Run the MCP connector
```bash
npm run connector       # starts the stdio MCP server (mock adapter by default; ATTUNE_ADAPTER=smartspectra for the real SDK)
```
It starts un-consented: `get_body_context` returns `consent_required` until an AI calls `grant_consent({allow:true})`.

### Add it to Claude Desktop
In `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "attune-sense": { "command": "node", "args": ["<abs-path>/attune/src/server.js"] }
  }
}
```
(ChatGPT desktop: add it as a local MCP connector the same way.) Then ask the AI to call `get_body_context`
before replying — see `SKILL.md` for the usage contract.

## Tools exposed
`grant_consent` · `get_body_context` · `record_correction` · `memory_get` · `memory_append` · `forget_me`

## Layout
- `src/interpreter.js` — baseline + pulse-drift/expression thresholds, confidence gate, hysteresis, nudges.
- `src/session.js` — standing body-context for the AI (poll-safe) + memory wiring.
- `src/memory.js` — local-first store (interpretations only; encryption is M5).
- `src/adapter/mock.js` — synthetic stream · `src/adapter/smartspectra.js` — real SDK adapter.
- `src/server.js` — the MCP connector · `SKILL.md` — how an AI uses it.
- `run-demo.js` · `test-connector.js` · `test-adapter.js` — runnable checks.

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
shape (`cardio.pulseRate`, `face.expression`, `face.talking`; confidence 0–100 → 0–1). No live
HRV/breathing. `npm run test:adapter` checks the mapping against the SDK's own protobuf decoder.

## Status
Interpreter ✅ · connector brain ✅ · MCP server ✅ · real SmartSpectra adapter ✅ (live run needs API key + webcam) ·
next: encryption at rest, consent UX polish.
