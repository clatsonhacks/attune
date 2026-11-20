# attune-sense (prototype)

Attune turns contactless vitals (Presage SmartSpectra) into **behavioral nudges for an AI, not numbers**, and
ships as a **local MCP connector** for Claude Desktop, ChatGPT via Secure MCP Tunnel, and other stdio clients.

> Prototype. Desktop API keys are stored encrypted on your computer. Roadmap: [docs/ATTUNE_IMPLEMENTATION_PLAN.md](docs/ATTUNE_IMPLEMENTATION_PLAN.md) ·
> how data moves: [docs/DATA_FLOW.md](docs/DATA_FLOW.md) · threats: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Try Attune from GitHub

Install Git and Node.js 26 (with npm), then run these commands in a terminal:

```sh
git clone https://github.com/clatsonhacks/attune.git
cd attune
npm ci
npm start
```

On first launch, **API Keys** asks which features you want to enable. Add your own **Groq** key for the built-in chat companion and a **Presage SmartSpectra** key for camera sensing. Either can be skipped. Reopen **API Keys** at any time to save, replace, or remove a key. Changes apply immediately. ChatGPT and Claude use their own connections and do not need a Groq key. Camera access still requires consent.

For a judge walkthrough with synthetic readings and scripted replies, run `npm run desktop:demo` instead of `npm start`. Demo uses a separate data folder and needs no accounts or keys. Quit any running Attune instance from the tray before switching modes. To try Claude installation from a fresh checkout, run `npm run build:extension`, then open **Connectors** in Attune. The Windows installer already includes the extension.

### Show the vitals instruction in a demo

Run `npm run desktop:demo`. In Companion, allow simulated sensing and select **Share with the AI**. The panel above the conversation shows the current vitals instruction for the next reply. Watch it change as the simulated readings change, or switch modes to show another lens. Send a message and expand **Vitals instruction for this reply** beneath the response to inspect the instruction captured for that turn. Demo replies are scripted and stay local.

## Hands-free conversation with Claude Desktop

Open **Claude voice** in Attune for connector setup. Once connected, open a new chat in Claude Desktop and choose its sound-wave icon. Speak normally and interrupt by talking again. Claude handles microphone input and playback with your Claude account. This flow requires no Groq key. [Claude voice mode](https://support.claude.com/en/articles/11101966-use-voice-mode)

To add sensing, allow camera sensing and AI sharing in Attune and enable the companion purpose for Claude. Say "Use Attune companion guidance before your replies. Keep talking while sensing warms up." Opening a Claude chat alone sends no event to Attune. An approved context request can start sensing after consent. SmartSpectra keeps sampling across turns and each request reads the latest cached guidance. Pause or revoke in Attune to stop sensing. The usual idle timeout applies after connector activity stops.

## Talk to the built-in Groq companion

In real mode, add your Groq key under **API Keys**. Open **Companion**, select **Groq voice**, and accept the microphone disclosure. Speak, then pause for about a second or choose **Send now**. Attune shows the transcript, speaks its reply, and listens again. Use **Interrupt** to take the next turn during a reply. Select **End voice** to stop. Leaving the companion or hiding the window also ends the session.

Voice sends recorded turns to Groq for [Whisper transcription](https://console.groq.com/docs/speech-to-text), sends the transcript to the companion model, and sends reply text to Groq for [Orpheus English speech](https://console.groq.com/docs/text-to-speech). Your Groq account needs access to all three models. Attune keeps the audio in memory during processing. Camera sensing is optional. Voice uses fresh context only when sensing is already active and AI sharing is allowed. Voice works with the camera off or paused. If audio fails, you can keep using text chat.

**Consent once.** The first time, Attune asks for camera sensing and the Presage disclosure (AI sharing and
memory are separate and optional). Your answer is remembered. After that the camera turns on when a chat starts
or when the AI asks for a reading, shows a *Camera on* badge, and turns off after 5 minutes without chatting.
*Pause* stays paused until you resume; *Forget camera permission* deletes the saved choice. An AI cannot grant
any permission. On-screen tips help you position yourself; if your chest isn't visible it falls back to
face-only measurement.

## Run the web-only service (optional)
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
Every connector receives action cues only. Pulse, breathing rate, HRV, confidence scores and raw Insight text stay out of connector responses, including approved yoga requests.
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
M3 Context Bridge ✅ · M4 turn-based Groq voice available. Live-device evaluation is pending.

## Windows desktop and Claude extension

Run `npm ci` and `npm run build:desktop` on Windows x64. The build places the NSIS installer in `dist/desktop/` and the standalone Claude Desktop extension in `dist/attune.mcpb`. For development, run `npm run desktop:demo` for synthetic readings or `npm run desktop` for the setup flow. The desktop app uses port 3000 by default. Quit any existing Attune web service on that port before launching it.

On first launch, API Keys offers separate fields for SmartSpectra and Groq. Both are optional and encrypted for the current Windows user. Camera consent is a separate step. Closing the window leaves the service in the system tray. Choose **Quit Attune** there to shut it down.

In **Connectors**, select **Install in Claude**, open the downloaded extension in Claude Desktop and confirm installation. The connector uses the running Attune service. Set its allowed purposes in Attune and ask Claude to check Attune's status. The last-seen time records when Claude reaches the service. On Windows, **Restart Claude Desktop** reopens the Microsoft Store build after confirmation. Save drafts and finish active sessions first.
