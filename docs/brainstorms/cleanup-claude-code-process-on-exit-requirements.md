---
date: 2026-05-31
topic: cleanup-claude-code-process-on-exit
---

# Cleanup Claude Code Process on Application Exit

## Summary

Update `SessionRuntime.close()` to fully terminate the underlying Claude Code CLI process using the SDK's `query.close()` method, while preserving the existing interrupt-only behavior for active-turn stops. This fixes zombie CLI processes on session idle timeout, provider switch, and application shutdown.

---

## Problem Frame

The application uses `@anthropic-ai/claude-code-agent-sdk` to spawn Claude Code CLI processes for each chat session. When a session ends — whether through idle timeout, provider change, or full application shutdown — the current cleanup path calls `query.interrupt()`, which stops the message stream but leaves the underlying CLI process alive. Over time these orphaned processes accumulate as zombies. The issue is confirmed: Claude Code CLI processes remain in `ps` output after the application exits.

The `SdkClient.fetchInitialization()` method already uses `q.close()` in its `finally` block, confirming the SDK exposes a proper teardown API that the main session runtime is not using.

---

## Key Flows

- F1. Session idle timeout
  - **Trigger:** No message activity for the idle grace period
  - **Steps:** `scheduleIdleClose` fires → `chatService.closeRuntime(sessionId)` → `runtime.close()` → `query.interrupt()` + input cleanup
  - **Outcome:** Session runtime is removed from memory, but the underlying CLI process may survive
  - **Covered by:** R1

- F2. Application quit (tray Quit / Cmd-Q / window close / SIGTERM)
  - **Trigger:** User initiates quit or OS sends termination signal
  - **Steps:** Rust `perform_shutdown()` → kills Node sidecar OR Node receives SIGTERM/SIGINT → `shutdown()` → `chatService.closeAllRuntimes()` → each `runtime.close()` → `server.close()` → `process.exit(0)`
  - **Outcome:** Application exits, but sidecar child processes may be reparented and survive if Node dies before SDK cleanup completes
  - **Covered by:** R3, R4

- F3. Stop active turn
  - **Trigger:** User clicks the stop button and confirms
  - **Steps:** POST `/interrupt` → `runtime.interrupt()` → `query.interrupt()`
  - **Outcome:** Current AI turn stops; session remains active and resumable
  - **Covered by:** R2

---

## Requirements

**Session runtime cleanup**
- R1. `SessionRuntime.close()` must fully terminate the underlying Claude Code CLI process associated with the session.
- R2. `SessionRuntime.interrupt()` must continue to stop only the current turn without terminating the session or its underlying CLI process.

**Application shutdown cleanup**
- R3. During application shutdown, the Node sidecar must close all active session runtimes before the process exits.
- R4. The Rust layer must allow the Node sidecar a grace period to perform graceful cleanup before force-killing it.

**Edge cases and safety**
- R5. If `query.close()` fails or throws, the close path must not crash and should continue with remaining cleanup.
- R6. If a runtime is already closed, calling `close()` again must be safe (idempotent).

---

## Acceptance Examples

- AE1. **Covers R1, R3.** Given an active session with a running Claude Code CLI process, when the user quits the application, the CLI process is terminated and does not appear in `ps` output after the app exits.
- AE2. **Covers R2.** Given an active session with a running turn, when the user clicks the stop button, the turn stops but the session remains resumable and the underlying CLI process stays alive.
- AE3. **Covers R1, R5.** Given a session where `query.close()` throws an error, when `SessionRuntime.close()` is called, the error is caught and logged, and the runtime still completes its remaining cleanup.

---

## Success Criteria

- No Claude Code CLI processes remain alive after the application exits (verified via process inspection).
- Users can still stop an active turn and resume the same session without error.
- The app shuts down cleanly without new crashes or hangs in the shutdown path.

---

## Scope Boundaries

- Changes to the `@anthropic-ai/claude-code-agent-sdk` itself (how it spawns or manages processes).
- A persistent process reaper or daemon for orphaned Claude Code processes outside the application lifecycle.
- Changes to the stop-button UX or interrupt behavior during active turns.

---

## Key Decisions

- `query.close()` replaces or supplements `query.interrupt()` in `SessionRuntime.close()`, while `SessionRuntime.interrupt()` continues to use `query.interrupt()` only. Rationale: closing a session should kill the underlying process; interrupting a turn should not.
- Fix at the `SessionRuntime.close()` level rather than only in the app shutdown path. Rationale: idle timeouts and provider switches also leak processes; fixing the root closes all paths.

---

## Dependencies / Assumptions

- The SDK's `Query.close()` method reliably terminates the underlying Claude Code CLI process.
- `Query.close()` can be called after `Query.interrupt()` without double-teardown issues, or they can be guarded against in our wrapper code.
- The Node sidecar's SIGTERM/SIGINT handler is the primary graceful shutdown path; Rust's `perform_shutdown()` is the fallback.

---

## Outstanding Questions

### Resolve Before Planning

*(none — scope is clear)*

### Deferred to Planning

- [Affects R1][Technical] Confirm the exact behavior of SDK's `Query.close()` vs `Query.interrupt()` — does `close()` also end the async iterator, or is `interrupt()` still needed before `close()`?
- [Affects R4][Technical] Determine the appropriate grace period (in milliseconds) for the Rust layer to wait for Node graceful shutdown before killing the sidecar, or whether Node should signal completion via an explicit mechanism.
- [Affects R1][Needs research] Verify whether `query.close()` is idempotent or if we need to guard against double-close in `SessionRuntime.close()`.
