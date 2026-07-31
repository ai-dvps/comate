---
title: SDK sandbox blocks direct loopback — local CLIs must egress through the sandbox HTTP proxy
date: 2026-08-01
last_updated: 2026-08-01
category: docs/solutions/integration-issues
module: bot-permission-sandbox
problem_type: integration_issue
component: service_object
symptoms:
  - Sandboxed `curl http://127.0.0.1:<port>/...` fails with exit 7 (connection refused) even when 127.0.0.1/localhost are in sandbox.network.allowedDomains with strictAllowlist
  - A local CLI using node:http (no proxy awareness) cannot reach the sidecar from inside a sandboxed session at all
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [sandbox, loopback, http-proxy, no_proxy, wecom-cli, ktd-28, v10, seatbelt]
---

# SDK sandbox network egress: loopback works ONLY through the sandbox proxy

## Problem

Inside the SDK execution sandbox (macOS seatbelt / Linux bubblewrap), the
sidecar's loopback API (`http://127.0.0.1:<port>/api/...`) is unreachable from
sandboxed commands even though `127.0.0.1` and `localhost` are in
`sandbox.network.allowedDomains` with `strictAllowlist: true`. `curl` fails
with exit 7; `node:http` clients fail the same way. This was the U12 "V10"
empirical item.

## Root cause (measured, not guessed)

The sandbox network layer has two independent walls:

1. **OS wall**: all direct outbound connections are denied; egress is only
   possible through the sandbox's own HTTP proxy, injected into the sandboxed
   env as `http_proxy`/`HTTP_PROXY=http://srt:<per-session-secret>@localhost:<port>`.
2. **Allowlist wall**: the proxy (running OUTSIDE the sandbox) enforces
   `allowedDomains` by request hostname.

The trap: the sandbox ALSO injects
`NO_PROXY=localhost,127.0.0.1,::1,169.254.0.0/16,10.0.0.0/8,…`, so any
proxy-honoring client (curl, language HTTP stacks) **bypasses** the proxy for
loopback targets and hits the OS wall. `node:http` never honors proxy env at
all, so it always hits the OS wall.

Empirically pinned (macOS seatbelt, SDK 0.3.220, CLI 2.1.x):

| Probe | Result |
|---|---|
| `curl http://127.0.0.1:<port>/x` | exit 7 (OS wall, NO_PROXY bypass) |
| `curl http://localhost:<port>/x` | exit 7 (same) |
| `curl --noproxy '' http://127.0.0.1:<port>/x` | **200** (proxy relays to loopback; IP literal matches the allowlist) |
| `curl --noproxy '' http://localhost:<port>/x` | **200** (hostname matches too) |
| `curl https://example.com` (not allowlisted) | exit 56 (proxy rejects) |

## Resolution

A local CLI that must call a loopback API from inside a sandboxed session
must implement the forward-proxy request form itself when the sandbox env is
present:

- Read `http_proxy`/`HTTP_PROXY` (lowercase first). Absent → direct connect
  (unsandboxed/degraded hosts keep working unchanged).
- For plain-`http:` targets, connect to the proxy and send the ABSOLUTE-URI
  request line (`GET http://127.0.0.1:<port>/api/... HTTP/1.1`) with a normal
  `Host` header, plus `Proxy-Authorization: Basic base64(user:pass)` decoded
  from the proxy URL userinfo (the per-session `srt:<secret>` credentials).
- Do NOT honor `NO_PROXY` for your own loopback API — the proxy is the
  sanctioned egress, not a detour.
- The destination hostname/IP must be in `sandbox.network.allowedDomains`
  (the bot-access-policy derivation pre-allows `127.0.0.1` + `localhost`).

Implemented in `packages/wecom-cli/src/lib/http.ts` (`transportFor`). Proven
end-to-end by `src/server/services/loopback-auth-contract.test.ts`, which
runs the real bundled CLI inside a real sandboxed CLI session against the
production loopback-auth middleware.

## Security notes

- The session capability token transits the sandbox proxy in plaintext HTTP.
  Acceptable: the proxy is the session's own sandbox infrastructure (same
  trust domain — it already sees all sandboxed egress including WeCom API
  traffic), and the token is visible in the session env by design.
- Port granularity is NOT expressible in `allowedDomains`: allowlisting
  `127.0.0.1`/`localhost` opens ALL loopback ports through the proxy. The
  default-deny auth middleware (U12) is the compensating control — every
  reachable route requires a credential.
- `excludedCommands` would bypass the sandbox for the CLI but is an unmanaged
  widening hatch; keep it empty and use the proxy path instead.
