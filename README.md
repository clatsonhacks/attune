# attune-sense (prototype)

Attune turns contactless vitals (Presage SmartSpectra) into **behavioral nudges for an AI, not numbers**, and
ships as a **local MCP connector** for Claude Desktop, ChatGPT via Secure MCP Tunnel, and other stdio clients.

> Prototype. No secrets committed; use `.env`. Roadmap: [docs/ATTUNE_IMPLEMENTATION_PLAN.md](docs/ATTUNE_IMPLEMENTATION_PLAN.md) ·
> how data moves: [docs/DATA_FLOW.md](docs/DATA_FLOW.md) · threats: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

**Consent once.** The first time, Attune asks for camera sensing and the Presage disclosure (AI sharing and
memory are separate and optional). Your answer is remembered. After that the camera turns on when a chat starts
or when the AI asks for a reading, shows a *Camera on* badge, and turns off after 5 minutes without chatting.
*Pause* stays paused until you resume; *Forget camera permission* deletes the saved choice. An AI cannot grant
any permission. On-screen tips help you position yourself; if your chest isn't visible it falls back to
face-only measurement.

## Run it (real)
```bash
npm install
cp .env.example .env    # set SMARTSPECTRA_API_KEY and GROQ_API_KEY
npm run web             # http://localhost:3000 — real webcam (SmartSpectra) + Groq (openai/gpt-oss-120b)
npm test                # privacy, insights, context-bridge and real-mode tests
```
Open the page, tap *Grant consent to sense*, tick the boxes (tick *Share with the AI* to let the AI use the
signal) and talk. Chat messages go to Groq's API; body guidance is added only when you allowed sharing.
Without `GROQ_API_KEY` the chat says the AI isn't connected — it never makes up replies.

**Demo mode** (no camera, no keys): `npm run web:demo` — synthetic vitals cycling calm→stress→recovery and
scripted replies, with its own memory file.

## Run the MCP connector
```bash
npm run connector       # stdio MCP server — real SDK by default (ATTUNE_ADAPTER=mock for synthetic vitals)
```
Consent comes from **your** config, not from the AI. Without `ATTUNE_CONSENT`, `get_body_context` returns
`consent_required` and the camera never starts. With it, the camera starts on the first `get_body_context`
call and stops after 2 minutes without calls (`ATTUNE_IDLE_MS`).

| `ATTUNE_CONSENT` word | allows |
|---|---|
| `sensing` + `presage-ack` | camera + SmartSpectra (both required) |
| `ai-sharing` | interpreted, number-free context returned to the AI |
| `memory` | interpretations stored locally / `memory_*` tools |

### Connect from the Attune web app

- **Claude Desktop**. Open **Connectors**, select **Connect Claude**, review sharing, and choose **Register in Claude Desktop**. Fully quit and reopen Claude Desktop. Attune adds its own entry and leaves existing entries in place. Remove the Attune entry in Claude Desktop and restart it to revoke the registration.
- **ChatGPT**. Select **Connect ChatGPT** to open ChatGPT Plugins. Follow the **Secure MCP Tunnel setup** on the Attune card to configure the included stdio command in OpenAI's tunnel client. Add a custom MCP server in ChatGPT with **Tunnel** as the connection method. Accept the permission prompts in ChatGPT. The tunnel command exposes only status and interpreted context. Sensing is off until you set ATTUNE_CHATGPT_CONSENT to sensing,presage-ack,ai-sharing in the local tunnel client's environment. Only associate the tunnel with a workspace you intend to share with. Stop the tunnel client to disconnect. [OpenAI Secure MCP Tunnel setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- **Other AI clients**. Expand **Show MCP configuration JSON** and copy the generated configuration into a client that supports local stdio MCP. Merge the attune-sense entry into any existing mcpServers object.

See SKILL.md for tool usage.

## Tools exposed
`get_attune_status` · `get_body_context` · `list_purposes` · `record_correction` · `memory_get` · `memory_append` · `forget_me`
(there is deliberately no consent or approval tool; the ChatGPT profile exposes only the first three)

## Purposes and approvals
One neutral reading, many **lenses** (companion, yoga, casual, …). The AI passes a `purpose` to
`get_body_context` (default `companion`) and can see the options with `list_purposes`, but only **you** decide
which app may use which lens, in **Attune → Connectors**. An app that asks for a lens you have not allowed gets
`purpose_not_approved` (the camera does not start) and its request shows up as pending for you to allow or deny.
Apps you never configured may use `companion` only. Changes apply to the next call, without restarting the client.

- Approvals live in `.attune-apps.json` (demo: `.attune-demo-apps.json`) at the repo root, shared by the web app
  and the connector. Each app is identified by `ATTUNE_APP_ID`, else its MCP client name, else `claude-desktop`
  (`chatgpt` for `--chatgpt`). Registering Claude Desktop from Attune sets `ATTUNE_APP_ID=claude-desktop`.
- Every read is logged — app, lens, time, state, whether guidance was given; never guidance text or numbers —
  in `.attune-activity.jsonl` (demo: `.attune-demo-activity.jsonl`), shown in Attune and clearable there.
- The built-in companion may use every lens; pick which one it reads through with the mode switch.
- Tests point `ATTUNE_APPS_FILE` / `ATTUNE_ACTIVITY_FILE` at temp files.

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
- `tests/**/*.test.js` — `node:test` suite (privacy, insights, context bridge)
- UI libraries (installed with npm, served locally — no CDN calls): **OverlayScrollbars** (scrollbars),
  **Lucide** + **Simple Icons** (icon sprite, rebuilt with `npm run build:icons` into `web/assets/icons.svg`). · `run-demo.js` · `test-connector.js` · `test-adapter.js`.

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
