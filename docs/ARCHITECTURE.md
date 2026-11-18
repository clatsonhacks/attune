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
          src/sensing.js  ── starts/stops ──►  src/adapter/{mock,smartspectra}.js  ◄── camera
                 │ samples (current generation only)
                 ▼
          src/session.js  ──►  src/interpreter.js  (baseline, confidence gate, hysteresis)
             │      │
             │      └── getApprovedContext()  → AI (companion or MCP), only with aiSharing
             └── getBodyContext()/getSignals()  → human UI (/api/state), only while sensing is active
```

| Module | Role |
|---|---|
| `src/privacy/consent.js` | Scopes `sensing` (needs `presageAck`), `aiSharing`, `memory`, `diagnostics`; all off by default. |
| `src/sensing.js` | Sensor lifecycle `idle → starting → active → stopped` / `error`. Generation counter drops late callbacks. |
| `src/privacy/localGuard.js` | Web backend guard: Host allowlist (DNS rebinding), Origin check, per-boot session token. |
| `src/webServer.js` | Local demo backend, `127.0.0.1` only. `createApp()` is importable for tests. |
| `src/server.js` | Stdio MCP connector. `createConnectorCore()` holds the logic; no AI-callable consent tool. Lazy sensor start, idle stop. |
| `src/session.js` | Interpreter + signal tiles + memory wiring. `getApprovedContext()` strips evidence/measurements. |
| `src/memory.js` | Local JSON store of interpretations (plaintext for now; encryption is plan M5). Writes only with `memory` scope. |
| `src/companion.js` | Demo reply logic (scripted), optional Anthropic API path via `ATTUNE_ANTHROPIC_KEY`. |

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
- `on('insight', (buf, requestId))` / `requestInsight(text)` — **not used yet** (plan M2).

## Platform decision (plan M0-05)
Windows x64 first. Verified on Windows 11: SDK native runtime loads, camera opens, *No face found* path handled.
A live run with a face in view has not been recorded yet.

## Baseline (plan M0-04), 18 Nov 2026, before the M1 changes
`npm install` ✓ · `npm run demo` ✓ · `test-connector.js` ✓ · `test-adapter.js` ✓. After M1: `npm test` runs
28 `node:test` cases plus both legacy checks, all passing.
