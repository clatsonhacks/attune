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
```
**The web demo** (`npm run web`) is the "basic version": grant consent, watch the state cycle
calm→stress→recovery on the left, then say "I'm fine" while it shows **elevated** — the companion catches the
gap. Runs on mock vitals + a mock companion (no credentials). Set `ATTUNE_ANTHROPIC_KEY` to use a real LLM.

## Run the MCP connector
```bash
npm run connector       # starts the stdio MCP server (mock adapter by default)
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
- `run-demo.js` · `test-connector.js` — runnable checks.

## Wire the real SmartSpectra SDK
The mock is swapped via one env var; no code change to the app:
```bash
npm i @smartspectra/node-sdk          # native SDK; needs a webcam + smartspectra.presagetech.com reachable
export SMARTSPECTRA_API_KEY=...        # dev registration (keep in .env, never commit)
export ATTUNE_ADAPTER=smartspectra
npm run web                           # or: npm run connector
```
`src/adapter/smartspectra.js` maps SDK metrics → our sample shape (pulse + expression + talking; no live
HRV/breathing; `enableTelemetry=false`). ⚠️ It's written from the docs and **marked to verify on your machine** —
confirm the exact `configure/onMetrics/decodeMetrics` names against your installed version (the mapping is the
stable part). Unit-test the mapping with real `decodeMetrics` output via the exported `mapMetrics`.

## Status
Interpreter ✅ · connector brain ✅ · MCP server ✅ · real SmartSpectra adapter (needs API key + webcam) ·
next: encryption at rest, consent UX polish.
