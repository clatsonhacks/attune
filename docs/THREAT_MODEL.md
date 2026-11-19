# Attune — Threat model (v1, plan M0-02)

Goal: no Attune-operated pathway to a user's camera, measurements, transcripts or memory, and no way for an
AI or another app to turn sensing on. Not a claim that nobody can ever access anything.

| Actor | Can try to | Current mitigation | Gap / plan item |
|---|---|---|---|
| Normal user | Misunderstand what is shared | Separate opt-ins, Presage disclosure in the dialog, AI-sharing off by default | Legal review of copy (plan §4) |
| AI model (via chat or MCP) | Grant itself camera access, widen scope | No consent tool; MCP consent comes from the human's config; web consent only via token-protected UI API. The chat AI can *turn the camera on* via `check_in_with_body` only after the person allowed sensing **and** AI sharing, never while paused; it gets interpreted context only | Per-session capability tokens (M6-03); rate-limit tool calls if abused |
| Malicious website | Call the localhost API (CSRF), DNS rebinding | `127.0.0.1` bind, Host allowlist, Origin check, per-boot token only in `index.html`, CSP `frame-ancestors 'none'` | Packaged app should use IPC instead of HTTP (M1-03) |
| Untrusted MCP client | Read context without the user's consent | Returns `consent_required` without `ATTUNE_CONSENT`; context is number-free | Short-lived scoped tokens (M6-03) |
| Other local OS user | Read memory file | None beyond OS file permissions; file is plaintext | Encrypted per-user store, DPAPI (M5-01) |
| Hostile local process (same user) | Read the token/memory, talk to the API | Not defended — same-user code is out of scope. The SDK and its API key now live in a separate worker process with a minimal env | OS sandbox for the worker, encryption (M5) |
| Late SDK callback | Deliver data after revoke | Generation counter drops it; tested | Device-disconnect/crash tests (M1-07) |
| Presage Insight text | Inject instructions or medical claims into the AI | Normalizer drops instruction/medical sentences and numbers; AI gets at most 160 chars, marked as background | Review wording with real Insights (M2-06) |
| Attune writing another app's config | Corrupt Claude Desktop settings, or register without the person knowing | Only after an explicit approval tick + session token; atomic write; never overwrites an existing Attune entry or an unreadable file | Show the exact entry before writing |
| ChatGPT tunnel | Expose context to a shared workspace | Separate consent variable; only status + interpreted context tools | Per-app lens approvals (lenses milestone) |
| Cloud operator (Attune) | Inspect data | No Attune server exists in the flow | Keep it that way; review any relay (M6-06) |
| SDK vendor (Presage) | Receive measurements | Disclosed; out of our control | Network audit (M1-06, M2-06) |
| Hosted AI provider | Receive chat text + approved context | Only approved, number-free context; only with `aiSharing` | Provider disclosure UI (M4-06) |
| Stolen laptop | Read memory | None (plaintext) | M5-01 |
| Compromised update / admin / malware | Anything | Out of scope | Signed releases (M5-04) |
