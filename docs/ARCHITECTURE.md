# Attune — Architecture (current)

Describes what is in the repo today. The target design and milestones are in
[ATTUNE_IMPLEMENTATION_PLAN.md](ATTUNE_IMPLEMENTATION_PLAN.md).

## Components

```text
            human (web UI)                         human (connector config: ATTUNE_CONSENT)
                 │ grant / revoke                                   │
                 ▼                                                  ▼
        src/privacy/consent.js  ◄── the only consent authority ──►  (parsed at connector start)
                 │ onChange
                 ▼
          src/sensing.js ── starts/stops ──► src/adapter/isolated.js ═IPC═► worker.js ► smartspectra.js ◄── camera
                 │ samples, insights (current generation only)                  (separate process)
                 ▼
          src/session.js ──► src/interpreter.js          src/insights/{decoder,normalizer}.js
                 │ approved context                              │ normalized insight
                 ▼                                               ▼
          src/contextBridge.js  (seq, TTL, dedupe, coalescing; reads need a capability)
                 │ getApprovedContext(cap) / subscribe(cap)
                 ▼
          AI consumers: companion (web), MCP connector, (M4) voice — only with aiSharing
          Human UI (/api/state): measurements + full Insight text, only while sensing is active
```

| Module | Role |
|---|---|
| `src/privacy/consent.js` | Scopes `sensing` (needs `presageAck`), `aiSharing`, `memory`, `diagnostics`; all off by default. |
| `src/sensing.js` | Sensor lifecycle `idle → starting → active → stopped` / `error`. Generation counter drops late callbacks. |
| `src/privacy/localGuard.js` | Web backend guard: Host allowlist (DNS rebinding), Origin check, per-boot session token. |
| `src/webServer.js` | Local demo backend, `127.0.0.1` only. `createApp()` is importable for tests. |
| `src/server.js` | Stdio MCP connector. `createConnectorCore()` holds the logic; no AI-callable consent tool. Lazy sensor start, idle stop. |
| `src/adapter/isolated.js` + `worker.js` | Real SDK runs in a child process; allowlisted IPC, minimal env, crash → `error`. |
| `src/insights/decoder.js` | Presage `Insight` protobuf (schema from Presage docs; the SDK ships no decoder). |
| `src/insights/normalizer.js` | Full text for the human; number-free, non-medical ≤160-char note for the AI. |
| `src/contextBridge.js` | Latest context with sequence/TTL; rejects other-session and out-of-order updates; coalesced pushes. |
| `src/privacy/capabilities.js` | Per-consumer read handles, revoked together with their consent scope. |
| `src/session.js` | Interpreter + signal tiles + memory wiring. `getApprovedContext()` strips evidence/measurements. |
| `src/memory.js` | Local JSON store of interpretations (plaintext for now; encryption is plan M5). Writes only with `memory` scope. |
| `src/companion.js` | Demo reply logic (scripted), real mode: Groq chat completions (`GROQ_API_KEY`, default `openai/gpt-oss-120b`) with conversation history. |

## Runtime and SDK versions (pinned, plan M0-03)

| Item | Version | Notes |
|---|---|---|
| Node.js | 26.13.0 (dev), `>=20` required | SmartSpectra Node SDK needs ≥ 20. |
| `@smartspectra/node-sdk` | 3.5.0 (exact) | FFI binding via koffi; ships native runtimes for win32-x64, darwin-arm64, linux-x64/arm64. |
| `@modelcontextprotocol/sdk` | 1.32.2 (exact) | `McpServer.registerTool`, stdio transport. |
| `zod` | 3.25.76 (exact) | Tool input schemas. npm audit flags zod < 4 (GHSA-mrhx-c7xc-m3w5); upgrade tracked separately. |

### SmartSpectra contracts used (from the package's `index.d.ts`)
- `new SmartSpectraSDK({ apiKey, requestedMetrics, enableTelemetry })`
- `on('metrics', (buf, tsUs))` → `decodeMetrics(buf)` → `presage.smartspectra.Metrics` (`cardio.pulseRate[]`, `face.expression[]`, `face.talking[]`)
- `on('validationStatus', (code, tsUs, hint))` — non-zero code (e.g. *No face found*) → interpreter goes `unclear`
- `on('error', (code, message, retryable))`, `useCamera(CameraSelection.default)`, `start()`, `stopAsync()`, `destroy()`
- `on('insight', (buf, requestId))` / `requestInsight(text)` — decoded with our own `Insight` type; never awaited.
- `requestedMetrics: [...breathingMetrics, ...cardioMetrics, EXPRESSIONS, TALKING, BLINKING]` — **not yet verified on a live camera** with this set.

## Platform decision (plan M0-05)
Windows x64 first. Verified on Windows 11: SDK native runtime loads, camera opens, *No face found* path handled.
A live run with a face in view has not been recorded yet.

## Baseline (plan M0-04), 18 Nov 2026, before the M1 changes
`npm install` ✓ · `npm run demo` ✓ · `test-connector.js` ✓ · `test-adapter.js` ✓. After M1: `npm test` runs
54 `node:test` cases plus both legacy checks, all passing (as of M3).
