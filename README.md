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
npm run web             # the Attune app must be running — it is the only thing that opens the camera
npm run connector       # stdio MCP server for Claude Desktop & co. (normally your MCP client starts it)
```
The connector (`src/server.js`) is a thin client: it has no camera, SDK or consent code. It finds the running
Attune app through `service.json` in your Attune data folder (port + a random connector token, re-read on every
call) and calls Attune's local connector API on `127.0.0.1`. If Attune isn't open, every tool answers
`attune_not_running` ("Open Attune and try again").

**Consent lives in Attune**, not in the MCP client config and never with the AI: camera sensing, AI sharing and
memory are the same choices you make in the Attune window, and they apply to every connected app. Without them
`get_body_context` returns `consent_required`. When an approved app asks, Attune turns the camera on with the same
rules as a chat (never while paused; off again after 5 minutes idle). `ATTUNE_CONSENT` / `ATTUNE_CHATGPT_CONSENT`
are no longer used and can be removed from old configs.

**Data folder** (consent, memory, approvals, activity, `service.json`): `%APPDATA%\Attune` on Windows,
`~/Library/Application Support/Attune` on macOS, `$XDG_CONFIG_HOME/attune` (or `~/.config/attune`) on Linux;
`ATTUNE_DATA_DIR` overrides it, demo mode uses a `demo` subfolder. Files from older builds at the repo root
(`.attune-*` files) are copied there once on first start and left in place.

### Connect from the Attune web app

- **Claude Desktop**. Open **Connectors**, select **Connect Claude**, review sharing, and choose **Register in Claude Desktop**. Fully quit and reopen Claude Desktop. Attune adds its own entry and leaves existing entries in place. Remove the Attune entry in Claude Desktop and restart it to revoke the registration.
- **ChatGPT**. Select **Connect ChatGPT** to open ChatGPT Plugins. Follow the **Secure MCP Tunnel setup** on the Attune card to configure the included stdio command in OpenAI's tunnel client. Add a custom MCP server in ChatGPT with **Tunnel** as the connection method. Accept the permission prompts in ChatGPT. The tunnel command exposes only status and interpreted context, and only while Attune is open. ChatGPT gets nothing until you allow a purpose for it in Attune → Connectors (even companion needs an explicit approval for ChatGPT), and only while camera sensing and AI sharing are on in Attune. Only associate the tunnel with a workspace you intend to share with. Stop the tunnel client to disconnect. [OpenAI Secure MCP Tunnel setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
- **Other AI clients**. Expand **Show MCP configuration JSON** and copy the generated configuration into a client that supports local stdio MCP. Merge the attune-sense entry into any existing mcpServers object.

See SKILL.md for tool usage.

## Tools exposed
`get_attune_status` · `get_body_context` · `list_purposes` · `record_correction` · `memory_get` · `memory_append`
(there is deliberately no consent, approval or forget tool — forget memory in Attune; the ChatGPT profile exposes only
the first three)

## Purposes and approvals
One neutral reading, many **lenses** (companion, yoga, casual, …). The AI passes a `purpose` to
`get_body_context` (default `companion`) and can see the options with `list_purposes`, but only **you** decide
which app may use which lens, in **Attune → Connectors**. An app that asks for a lens you have not allowed gets
`purpose_not_approved` (the camera does not start) and its request shows up as pending for you to allow or deny.
Apps you never configured may use `companion` only (ChatGPT: nothing until you allow it). Changes apply to the next
call, without restarting the client. The Connectors page shows when each app last reached Attune.

- Approvals live in `apps.json` in the data folder. Each app is identified by `ATTUNE_APP_ID`, else its MCP client
  name, else `claude-desktop` (`chatgpt` for `--chatgpt`). Registering Claude Desktop from Attune sets
  `ATTUNE_APP_ID=claude-desktop`.
- Every read is logged — app, lens, time, state, whether guidance was given; never guidance text or numbers —
  in `activity.jsonl` in the data folder, shown in Attune and clearable there.
- The built-in companion may use every lens; pick which one it reads through with the mode switch.
- Tests set `ATTUNE_DATA_DIR` (and `ATTUNE_APPS_FILE` / `ATTUNE_ACTIVITY_FILE`) to temp folders.

## Layout
- `src/interpreter.js` — baseline + pulse-drift/expression thresholds, confidence gate, hysteresis, nudges.
- `src/session.js` — standing body-context for the AI (poll-safe) + memory wiring.
- `src/privacy/consent.js` — trusted consent scopes · `src/privacy/localGuard.js` — localhost/token/origin guard.
- `src/sensing.js` — the only place the sensor starts/stops; drops late callbacks after revoke.
- `src/adapter/isolated.js` + `worker.js` — the real SDK runs in its own process (`ATTUNE_ISOLATE=0` to disable).
- `src/contextBridge.js` — what any AI reads: fresh, sequenced, never blocked on Insights · `src/insights/` — Presage Insight decoder + normalizer.
- `src/memory.js` — local-first store (interpretations only; encryption is M5).
- `src/adapter/mock.js` — synthetic stream · `src/adapter/smartspectra.js` — real SDK adapter.
- `src/server.js` — the thin MCP connector (talks to the running app) · `src/paths.js` — the per-user data folder · `SKILL.md` — how an AI uses it.
- `tests/**/*.test.js` — `node:test` suite (privacy, insights, context bridge)
- UI libraries (installed with npm, served locally — no CDN calls): **OverlayScrollbars** (scrollbars),
  **Lucide** + **Simple Icons** (icon sprite, rebuilt with `npm run build:icons` into `web/assets/icons.svg`). · `run-demo.js` · `test-connector.js` · `test-adapter.js`.

## Use the real SmartSpectra SDK
`@smartspectra/node-sdk` is already a dependency (prebuilt native runtime for win32-x64, darwin-arm64,
linux-x64/arm64; Node >= 20). Switch adapters with one env var, no code change:
```bash
cp .env.example .env          # then set SMARTSPECTRA_API_KEY (from physiology.presagetech.com)
                              # and ATTUNE_ADAPTER=smartspectra
npm run web                   # connectors reach the camera only through this app
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
