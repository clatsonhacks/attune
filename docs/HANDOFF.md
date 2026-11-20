# Agent handoff — 20 Nov 2026

## Project
Attune: a private local "sensing layer" for AI apps. Webcam + Presage SmartSpectra (isolated worker) → neutral
snapshot → **lenses** (companion, yoga, casual) → AI apps via a local MCP connector, approved per app by the person.
Repo `clatsonhacks/attune`, branch `main`, Node 26, CommonJS, `npm test` (153 passing with desktop key management).

## Rules from the owner
- Small commits, author `clatsonhacks`, **no Co-Authored-By / trailer lines**, push to `main`.
- Never mention where the code originally came from.
- Never turn on the webcam without the owner asking; tests/demos use `ATTUNE_ADAPTER=mock` or `--demo`.
- Don't read `.env` values (it holds `SMARTSPECTRA_API_KEY`, `GROQ_API_KEY`). Companion AI = Groq (`openai/gpt-oss-120b`).

## Done on main
- Consent once (remembered); camera starts on chat start / AI request, stops after 5 min idle; pause; forget.
- Lenses + per-app approvals + activity log + mode icons in the chat header (same mascot card in every mode).
- **Phase 1 (M9-01):** one Attune service owns the camera, consent, approvals, activity and memory. Data lives in
  `%APPDATA%\Attune` (`service.json` = port + connector token). `src/server.js` is now a thin MCP client of
  `/connector/v1/*`. `ATTUNE_CONSENT` is gone.
- Claude Desktop is the **Microsoft Store** build: its config is at
  `%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc\claude_desktop_config.json` (an `attune-sense` entry exists;
  its old `ATTUNE_CONSENT` env is now ignored).
- Packaging research: `C:\Users\clats\AppData\Local\Temp\claude\…\scratchpad\research\findings.md`
  (MCPB 0.3 format, Electron 45, safeStorage async, Claude restart).

## Desktop and extension integration

Both feature branches have been merged into the local checkout. The first-run screens and restart helper are integrated. The desktop app includes a Windows tray, an API Keys page with OS-encrypted SmartSpectra and Groq storage, camera check, and the Claude extension download. The restart control requires an explicit confirmation and targets the Microsoft Store installation.

From a clone, run `npm ci` and `npm start` for the desktop setup, or `npm run desktop:demo` for the key-free walkthrough. Use `npm run build:desktop` for the Windows x64 installer and the standalone extension. See the README for the development commands and installation flow. The desktop and web service both use port 3000 by default.

## Remaining verification and later work

- Install the extension in the owner's Claude Desktop and verify the first connector request and last-seen time. A real-camera check and restarting the live service or Claude need the owner's participation.
- The test suite exercises the ChatGPT profile through an MCP stdio client. Testing the hosted ChatGPT tunnel requires the owner's account.
- Voice-to-voice on Groq is the next milestone (M4). Read context through the Context Bridge without blocking audio on sensing.

## Known gaps
Not yet verified with a real face in view: SDK positioning (owner's face was "too low" last run), face-only
fallback, Presage Insights. Presage licensing questions: `docs/PRESAGE_LICENSING.md` (owner to send).
