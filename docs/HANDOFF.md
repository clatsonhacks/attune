# Agent handoff — 20 Nov 2026

## Project
Attune: a private local "sensing layer" for AI apps. Webcam + Presage SmartSpectra (isolated worker) → neutral
snapshot → **lenses** (companion, yoga, casual) → AI apps via a local MCP connector, approved per app by the person.
Repo `clatsonhacks/attune`, branch `main`, Node 26, CommonJS, `npm test` (134 passing at `2c1e8a9`).

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

## In progress (agents stopped by the usage limit — resume, don't restart)
| Worktree | Branch | Done | Left |
|---|---|---|---|
| `C:\Users\clats\VSC\attune-wt-ext` | `agent/extension` | MCPB package + `npm run build:extension` → `dist/attune.mcpb` (3 commits) | `src/claudeRestart.js` (uncommitted), "Install in Claude" button, `GET /downloads/attune.mcpb`, restart route + UI, tests, docs |
| `C:\Users\clats\VSC\attune-wt-desktop` | `agent/desktop` | keyStore + `/api/setup*`, Electron-safe worker env (2 commits) | first-run setup UI (`web/*` uncommitted), `desktop/` Electron shell, electron-builder NSIS, docs |

Both worktrees have their **own** `node_modules` (npm ci). Merge: `git rebase main` in the worktree, then
`git merge --ff-only` on main, `npm test`, push. Before `git worktree remove`, make sure no `node_modules` is a
junction to main (delete the junction with `[System.IO.Directory]::Delete(path, $false)` first).

## Next, in order
1. Finish + merge both branches (expect small conflicts in `web/app.js`, `src/webServer.js`).
2. Restart the live service (`npm run web`, port 3000) and Claude Desktop (ask the owner first; only kill
   processes under `\WindowsApps\Claude_`), then **end-to-end tests**:
   Claude with the live camera, and the `--chatgpt` profile via an MCP client (ChatGPT tunnel needs the owner's account).
3. **Voice to voice (plan M4)** on Groq: `whisper-large-v3` (STT) + `canopylabs/orpheus-v1-english` (TTS), reading
   context through the Context Bridge (`subscribe`), never waiting on sensing.

## Known gaps
Not yet verified with a real face in view: SDK positioning (owner's face was "too low" last run), face-only
fallback, Presage Insights. Presage licensing questions: `docs/PRESAGE_LICENSING.md` (owner to send).
