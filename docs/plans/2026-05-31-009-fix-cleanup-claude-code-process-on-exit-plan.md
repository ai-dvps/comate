---
title: Fix zombie Claude Code CLI process cleanup on session close and app exit
type: fix
status: completed
date: 2026-05-31
origin: docs/brainstorms/cleanup-claude-code-process-on-exit-requirements.md
---

# Fix zombie Claude Code CLI process cleanup on session close and app exit

## Summary

Update `SessionRuntime.close()` to fully terminate the underlying Claude Code CLI process via `query.close()`, add an HTTP graceful-shutdown endpoint to the Node sidecar, and sequence the Rust `perform_shutdown()` to request graceful cleanup before force-killing the sidecar after a short grace period.

---

## Problem Frame

The application leaks Claude Code CLI processes on every session close (idle timeout, provider switch, app shutdown) because `SessionRuntime.close()` only calls `query.interrupt()`, which stops the message stream but leaves the underlying OS process alive. Over time these accumulate as zombies. The Rust layer currently force-kills the Node sidecar immediately, preventing Node's own `SIGTERM` shutdown handler from running and cleaning up its children.

(See origin document for full problem frame and acceptance examples.)

---

## Requirements

- R1. `SessionRuntime.close()` must fully terminate the underlying Claude Code CLI process associated with the session.
- R2. `SessionRuntime.interrupt()` must continue to stop only the current turn without terminating the session or its underlying CLI process.
- R3. During application shutdown, the Node sidecar must close all active session runtimes before the process exits.
- R4. The Rust layer must allow the Node sidecar a grace period to perform graceful cleanup before force-killing it.
- R5. If `query.close()` fails or throws, the close path must not crash and should continue with remaining cleanup.
- R6. If a runtime is already closed, calling `close()` again must be safe (idempotent).

**Origin actors:** (none — system-level fix)

**Origin flows:** F1 (session idle timeout), F2 (application quit), F3 (stop active turn)

**Origin acceptance examples:** AE1 (covers R1, R3), AE2 (covers R2), AE3 (covers R1, R5)

---

## Scope Boundaries

- Changes to the `@anthropic-ai/claude-code-agent-sdk` itself.
- A persistent process reaper or daemon for orphaned Claude Code processes.
- Changes to the stop-button UX or interrupt behavior during active turns.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/services/session-runtime.ts` — `SessionRuntime.close()` calls `query.interrupt()`; `SessionRuntime.interrupt()` also calls `query.interrupt()`. The `query` object is stored as a property.
- `src/server/services/sdk-client.ts` — `fetchInitialization()` already calls `q.close()` in a `finally` block, confirming the SDK exposes this API.
- `src/server/services/chat-service.ts` — `closeAllRuntimes()` and `closeRuntime()` orchestrate session cleanup on shutdown and idle timeout.
- `src/server/index.ts` — `shutdown()` is the Node `SIGTERM/SIGINT` handler; it calls `chatService.closeAllRuntimes()` then `server.close()` then `process.exit(0)`.
- `src-tauri/src/lib.rs` — `perform_shutdown()` kills the sidecar child with `child.kill()` and immediately calls `app_handle.exit(0)`. The `CommandChild` type exposes `pid()` and `kill()`.
- `src-tauri/Cargo.toml` — `reqwest` is already a dependency (async-only, no `blocking` feature).

### External References

- `tauri-plugin-shell` v2 `CommandChild` API: `pid()`, `kill()`, `write()` (source verified).

---

## Key Technical Decisions

- **HTTP shutdown endpoint over PID+signals:** The Rust layer will trigger Node graceful shutdown via a localhost HTTP request rather than platform-specific signals. This is cross-platform, reuses the existing Node `shutdown()` logic, and avoids adding platform-specific signal crates to the Rust build.
- **Async HTTP spawn + blocking sleep in Rust:** `perform_shutdown()` will spawn the shutdown request in `tauri::async_runtime` and then block the main thread for a grace period. This avoids adding the `blocking` feature to `reqwest` or pulling in another HTTP client. The quit delay is acceptable (confirmed).
- **Fix at `SessionRuntime.close()` root:** Rather than only patching the app-shutdown path, `SessionRuntime.close()` itself will call `query.close()`. This fixes idle timeouts and provider switches in addition to app shutdown.

---

## Open Questions

### Resolved During Planning

- **How does Rust send a graceful signal without platform-specific code?** → Add a localhost HTTP `/shutdown` endpoint to Node; Rust calls it via `reqwest` in an async task.
- **Does `query.close()` require `interrupt()` first?** → Deferred to implementation: try `close()` alone, fall back to `interrupt()` then `close()` if the async iterator hangs.

### Deferred to Implementation

- **Exact grace period duration:** Start with 2 seconds; adjust if Node cleanup takes longer on loaded systems.
- **`query.close()` idempotency:** Verify at implementation time whether the SDK tolerates double-close; wrap in a guard if not.

---

## Implementation Units

### U1. Update `SessionRuntime.close()` to terminate the underlying CLI process

**Goal:** Ensure every session close path (idle timeout, provider switch, app shutdown) kills the underlying Claude Code CLI process.

**Requirements:** R1, R2, R5, R6

**Dependencies:** None

**Files:**
- Modify: `src/server/services/session-runtime.ts`
- Test: (manual verification; add `src/server/services/session-runtime.test.ts` if feasible)

**Approach:**
- In `SessionRuntime.close()`, after `this.query.interrupt()` and after `this.input.close()`, add a call to `this.query.close()`.
- Wrap the `close()` call in a `try/catch` that logs and swallows errors, matching the existing pattern for `interrupt()`.
- The existing `this.closed` guard already provides idempotency (R6).
- Leave `SessionRuntime.interrupt()` untouched so active-turn stops remain resumable (R2).

**Patterns to follow:**
- `SdkClient.fetchInitialization()` uses `q.close()` in a `finally` block with error swallowing.

**Test scenarios:**
- Happy path: After `SessionRuntime.close()`, the underlying CLI process is no longer visible in `ps` / `Get-Process`.
- Edge case: Calling `close()` twice on the same runtime does not throw.
- Error path: If `query.close()` throws, the runtime still completes its remaining cleanup and the Node process does not crash.
- Integration: After an idle timeout fires, the session's CLI process is terminated.

**Verification:**
- Start a session, note the CLI PID, trigger a close (idle timeout or manual), and confirm the PID is gone.

---

### U2. Add graceful shutdown endpoint to Node sidecar

**Goal:** Give the Rust layer a cross-platform way to trigger Node's existing graceful shutdown sequence.

**Requirements:** R3, R4

**Dependencies:** None (can land in parallel with U1)

**Files:**
- Modify: `src/server/index.ts`, `src/server/routes/chat.ts`

**Approach:**
- Extract or export the existing `shutdown()` function from `src/server/index.ts` so it can be invoked programmatically (not just via signal handlers).
- Add a new `POST /shutdown` route in `src/server/routes/chat.ts` that calls the shared shutdown logic and returns `{ ok: true }` before the process exits.
- Restrict the endpoint to localhost (`req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1`) to prevent remote shutdown.
- The endpoint should be fire-and-forget from the caller's perspective: respond immediately, then trigger shutdown asynchronously so the HTTP response has time to complete.

**Patterns to follow:**
- Existing route patterns in `src/server/routes/chat.ts`.
- Existing `shutdown()` logic in `src/server/index.ts`.

**Test scenarios:**
- Happy path: `POST /shutdown` triggers `chatService.closeAllRuntimes()` and the Node process exits with code 0.
- Edge case: Request from non-localhost IP is rejected with 403.
- Integration: After U1 is landed, calling `/shutdown` with an active session results in zero remaining CLI processes.

**Verification:**
- Start the sidecar, call `curl -X POST http://localhost:<port>/shutdown`, and verify the Node process exits cleanly.

---

### U3. Update Rust `perform_shutdown()` for graceful sidecar termination

**Goal:** Allow the Node sidecar a grace period to clean up before Rust force-kills it.

**Requirements:** R3, R4

**Dependencies:** U2 (the `/shutdown` endpoint must exist)

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Approach:**
- In `perform_shutdown()`, after setting the `is_shutting_down` flag and before killing the child:
  1. If `api_port` is known, spawn an async `reqwest::get` to `http://127.0.0.1:{port}/shutdown` using `tauri::async_runtime::spawn`. Use a 1-second request timeout to avoid hanging if Node is unresponsive.
  2. Sleep the current thread for a grace period (start with 2 seconds) to give Node time to run its shutdown handlers.
  3. After the sleep, proceed to `child.kill()` (which is now a force-kill fallback) and then `app_handle.exit(0)`.
- If `api_port` is unknown or the HTTP request fails, fall through to the existing immediate-kill behavior (no grace period).
- The `is_shutting_down` atomic flag already guards against double-entry if `app_handle.exit(0)` raises another `WindowEvent::Destroyed`.

**Patterns to follow:**
- Existing `reqwest::Client::builder().timeout(...)` usage in `run_tray_status_poller`.
- Existing `perform_shutdown()` kill-and-exit sequence.

**Test scenarios:**
- Happy path: App quit triggers HTTP shutdown, Node cleans up, then Rust exits. No Node or CLI child processes remain.
- Edge case: Node is already dead when `perform_shutdown()` runs; Rust proceeds to `child.kill()` (no-op) and exits cleanly.
- Error path: Shutdown endpoint is unreachable; Rust sleeps the grace period, then force-kills the sidecar and exits.
- Integration: With U1 landed, quitting the app with an active session leaves zero zombie CLI processes.

**Verification:**
- Start the app, create a session, trigger quit (tray Quit, Cmd-Q, or window close). Verify via OS process monitor that no `node` sidecar or `claude` CLI processes remain after the app exits.

---

## System-Wide Impact

- **Interaction graph:** The Rust `perform_shutdown()` path now has an additional network hop to localhost before killing the sidecar. Tray Quit, Cmd-Q, window close, and SIGTERM all flow through this path.
- **Error propagation:** If the `/shutdown` endpoint throws, Node's existing `shutdown()` error handling in `index.ts` applies. If Rust's HTTP request fails, the fallback force-kill ensures the app still exits.
- **State lifecycle risks:** The grace period means `perform_shutdown()` blocks for ~2 seconds. The `is_shutting_down` flag prevents concurrent shutdown attempts during this window.
- **Unchanged invariants:** `SessionRuntime.interrupt()`, the stop-button flow, and SSE streaming behavior are explicitly untouched. The Node `SIGTERM/SIGINT` handler continues to work as before.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SDK `query.close()` behavior is not fully documented and may have side effects (e.g., throwing on double-close, not ending the async iterator). | Wrap in `try/catch`, test manually, and add a guard if double-close is unsafe. |
| Rust shutdown blocks the main thread for 2 seconds, which could trigger OS "not responding" warnings on slow systems. | Keep the grace period short; if issues arise, reduce to 1 second or make it configurable. |
| The `/shutdown` endpoint could be hit by unauthorized localhost processes. | Restrict to 127.0.0.1/::1; the endpoint is harmless beyond triggering app exit. |
| If Node hangs during cleanup, the Rust force-kill fallback may still leave zombie CLI children if U1 is not working. | Verify end-to-end that U1 properly terminates children; the force-kill is a last resort, not the primary cleanup mechanism. |

---

## Sources & References

- **Origin document:** [docs/brainstorms/cleanup-claude-code-process-on-exit-requirements.md](docs/brainstorms/cleanup-claude-code-process-on-exit-requirements.md)
- Related code: `src/server/services/session-runtime.ts`, `src/server/index.ts`, `src-tauri/src/lib.rs`
- External docs: [tauri-plugin-shell process API](https://v2.tauri.app/plugin/shell/)
