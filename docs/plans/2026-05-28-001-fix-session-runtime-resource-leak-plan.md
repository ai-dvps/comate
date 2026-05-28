---
title: Fix Session Runtime Resource Leak with Idle Grace Period
type: fix
status: completed
date: 2026-05-28
---

# Fix Session Runtime Resource Leak with Idle Grace Period

## Summary

Add an idle grace period to `SessionRuntime` so that Claude Code SDK processes are automatically cleaned up after a configurable timeout once no client remains subscribed. Wire the existing but orphaned `SessionRuntime.close()` and `ChatService.closeRuntime()` paths into the server shutdown handler and a new idle-timeout manager.

---

## Problem Frame

`ChatService` caches every `SessionRuntime` in a `Map<string, SessionRuntime>` forever. The runtime holds an active SDK `Query` that spawns a Claude Code process. `SessionRuntime.close()` (which interrupts the query and releases resources) and `ChatService.closeRuntime()` (which evicts from the cache) exist but are never invoked by any client action, server route, or shutdown handler.

When a user closes a workspace tab or switches sessions, the client-side SSE subscription is closed, but the server-side runtime and its underlying process continue running indefinitely. Over time this exhausts system resources.

---

## Requirements

- R1. A `SessionRuntime` with no active SSE subscriber must be automatically closed after a grace period.
- R2. Re-subscribing to a runtime within the grace period must cancel the timeout and reuse the existing runtime.
- R3. Server shutdown must immediately close all active runtimes without waiting for the grace period.
- R4. The grace period duration must be configurable via a single constant.
- R5. Runtime lifecycle events (schedule idle, cancel idle, close idle, forced close on shutdown) must be logged via `sidecarLog` for observability.

---

## Scope Boundaries

- No client-side changes — the fix is entirely server-side, driven by SSE subscribe/unsubscribe events.
- No explicit "force close" HTTP endpoint — the grace period is the only automatic cleanup mechanism.
- No idle timeout for client-side SSE subscriptions or polling intervals (those are already cleaned up by `cleanupWorkspace`).
- No changes to the SDK itself or to how the SDK spawns processes.

### Deferred to Follow-Up Work

- Explicit client-initiated runtime kill endpoint (e.g., `DELETE /api/sessions/:id/runtime`) for immediate cleanup when a user confirms closing a live session.
- Per-workspace or per-session configurable grace period (currently a single global constant).

---

## Context & Research

### Relevant Code and Patterns

- `src/server/services/session-runtime.ts` — `SessionRuntime` class with `subscribe(res)`, `unsubscribe(res)`, and `close()` methods. `activeRes` tracks the single current SSE subscriber.
- `src/server/services/chat-service.ts` — `ChatService` singleton with `runtimes` Map, `getOrCreateRuntime()`, and `closeRuntime()` (never called).
- `src/server/routes/chat.ts` — SSE route calls `runtime.subscribe(res)` on connect and `runtime.unsubscribe(res)` on `req.on('close')`.
- `src/server/index.ts` — `shutdown()` handler disconnects WeCom bots and closes the HTTP server but does not iterate `chatService.runtimes`.
- `src/server/services/file-search.ts` — Demonstrates proper child-process cleanup with `child.kill('SIGTERM')` and `child.once('close', ...)`.
- `src/server/services/chat-service.ts:52` — `testClaudeBinary` uses a `finish()` guard to prevent double-cleanup on timeout.

### Institutional Learnings

- `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md` — Client-side SSE retry logic means the client may reconnect shortly after a disconnect. A grace period prevents destroying a runtime that the client is about to re-subscribe to.

---

## Key Technical Decisions

- **Grace period driven by SSE subscriber presence, not by workspace tab state:** The server cannot reliably observe workspace tab state without new client-side APIs. Using `subscribe`/`unsubscribe` as the signal is simpler, client-agnostic, and correctly handles both tab closes and session switches.
- **Callback pattern for idle signaling:** `SessionRuntime` accepts `onSubscribed` and `onUnsubscribed` callbacks at construction time. This avoids adding event-emitter machinery or a circular dependency between `SessionRuntime` and `ChatService`.
- **ChatService owns the timeout:** The idle timeout is stored and managed in `ChatService` (not `SessionRuntime`) so that `closeRuntime()` can cancel pending timeouts before closing, and `closeAllRuntimes()` can clear everything on shutdown.
- **5-minute default grace period:** Long enough to survive a typical SSE clean-close retry cycle and a quick tab re-open or session re-switch; short enough to prevent meaningful resource exhaustion.

---

## Open Questions

### Resolved During Planning

- **Should the grace period start on every unsubscribe or only when the runtime is truly idle?** Start on every unsubscribe when `activeRes` becomes null. If the runtime is still processing a turn but has no listener, it is still consuming resources and should be eligible for cleanup.
- **Should we add a reference count for multiple concurrent subscribers?** Not needed. `SessionRuntime` currently supports only one `activeRes` at a time, enforced by `subscribe(res)` overwriting the previous response.

### Deferred to Implementation

- **Exact log message wording and level:** Use `sidecarLog` with a consistent prefix pattern; exact strings can be refined during implementation.

---

## Implementation Units

### U1. Add subscription lifecycle callbacks to SessionRuntime

**Goal:** Allow `SessionRuntime` to notify its owner when it gains or loses an active subscriber.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/server/services/session-runtime.ts`

**Approach:**
- Extend the `SessionRuntime` constructor and `SessionRuntime.open()` factory to accept two optional callbacks: `onSubscribed` and `onUnsubscribed`.
- Invoke `onSubscribed()` at the end of `subscribe()` after `activeRes` is set.
- Invoke `onUnsubscribed()` at the end of `unsubscribe()` when `activeRes` becomes null (guard with `hadRes` to ensure it only fires on a matched unsubscribe).
- Ensure callbacks are idempotent-safe: `ChatService` will manage timeout state, so duplicate calls must be harmless.

**Patterns to follow:**
- Existing callback pattern in `sse-emitter.ts` (`(id, event) => void` passed to constructor).

**Test scenarios:**
- Happy path: `subscribe()` calls `onSubscribed`; `unsubscribe()` calls `onUnsubscribed` when `activeRes` is cleared.
- Edge case: `unsubscribe()` with a mismatched `res` does not call `onUnsubscribed`.
- Edge case: Multiple `subscribe()` calls in sequence invoke `onSubscribed` each time (downstream `ChatService` must handle this gracefully).

**Verification:**
- `subscribe` followed by `unsubscribe` triggers both callbacks in order.
- `unsubscribe` with a non-matching response object does not trigger `onUnsubscribed`.

---

### U2. Add idle grace period management to ChatService

**Goal:** Schedule automatic cleanup of runtimes that have no subscriber, and cancel that cleanup if the runtime is re-subscribed.

**Requirements:** R1, R2, R5

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/chat-service.ts`

**Approach:**
- Add a private `idleTimeouts` Map keyed by `sessionId` to track pending `NodeJS.Timeout` values.
- Add a constant `RUNTIME_IDLE_GRACE_PERIOD_MS = 5 * 60 * 1000` (5 minutes).
- In `getOrCreateRuntime`, when returning an existing runtime, call `cancelIdleClose(sessionId)` to reset any pending timeout.
- Add `scheduleIdleClose(sessionId)`:
  - If an idle timeout already exists for this session, clear it first.
  - Set a new timeout that calls `this.closeRuntime(sessionId)` when it fires.
  - Log via `sidecarLog` that the idle close was scheduled.
- Add `cancelIdleClose(sessionId)`:
  - Look up and clear any timeout for the session.
  - Delete the entry from `idleTimeouts`.
  - Log via `sidecarLog` that the idle close was cancelled.
- Modify `closeRuntime(sessionId)`:
  - Call `cancelIdleClose(sessionId)` before closing to prevent a stale timeout from firing after the runtime is already removed.
  - Log via `sidecarLog` that the runtime is being closed.
- Pass the callbacks when constructing `SessionRuntime` in `getOrCreateRuntime`:
  - `onSubscribed: () => this.cancelIdleClose(sessionId)`
  - `onUnsubscribed: () => this.scheduleIdleClose(sessionId)`

**Patterns to follow:**
- `finish()` guard pattern from `testClaudeBinary` to prevent double-cleanup if a timeout fires concurrently with explicit close.
- Map-based timeout tracking from existing `workspacePollIntervals` / `sessionSubscriptions` patterns on the client.

**Test scenarios:**
- Happy path: Client disconnects; after 5 minutes of no re-subscribe, `closeRuntime` is invoked and the process is interrupted.
- Happy path: Client disconnects and reconnects within 5 minutes; the timeout is cancelled and the original runtime is reused.
- Edge case: `closeRuntime` is called explicitly while an idle timeout is pending; the timeout is cancelled and the runtime closes cleanly.
- Edge case: Two rapid subscribe/unsubscribe cycles do not leak multiple timeouts.

**Verification:**
- Server logs show `[ChatService] idle close scheduled for {sessionId}` after disconnect.
- Server logs show `[ChatService] idle close cancelled for {sessionId}` on reconnect.
- After the grace period expires, `getActiveSessionCount()` decrements.
- Reconnecting before expiry reuses the same runtime instance (observable via reference equality or server nonce).

---

### U3. Close all runtimes on server shutdown

**Goal:** Ensure no Claude Code processes outlive the server process during a graceful shutdown.

**Requirements:** R3, R5

**Dependencies:** U2

**Files:**
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/server/index.ts`

**Approach:**
- Add `closeAllRuntimes(): Promise<void>` to `ChatService`:
  - Iterate `this.runtimes` entries.
  - For each entry, call `cancelIdleClose(sessionId)` to prevent any pending timeout from firing.
  - Call `runtime.close()` for each runtime.
  - Use `Promise.all` to close runtimes concurrently.
  - Log the count of runtimes being closed.
  - After closing, clear both `this.runtimes` and `this.idleTimeouts`.
- In `src/server/index.ts`, modify `shutdown(signal)` to await `chatService.closeAllRuntimes()` before closing the HTTP server.

**Patterns to follow:**
- Existing shutdown sequence: `wecomBotService.disconnectAll()` then `wecomUserResolver.shutdown()` then `server.close()`.

**Test scenarios:**
- Happy path: Server receives SIGTERM with 3 active runtimes; all 3 are closed before the process exits.
- Edge case: Server receives SIGTERM while an idle timeout is pending for one runtime; the timeout is cancelled and the runtime is closed immediately.
- Error path: One runtime's `close()` throws; the others are still closed (do not short-circuit `Promise.all` — or handle with `Promise.allSettled` if needed).

**Verification:**
- Server logs show `[ChatService] closing N runtimes on shutdown` during SIGTERM.
- Process monitor (Activity Monitor, `ps`, `htop`) shows no lingering `claude` child processes after the server exits.

---

## System-Wide Impact

- **Interaction graph:** `ChatService` now holds a second Map (`idleTimeouts`) alongside `runtimes`. Both maps are keyed by `sessionId` and must stay in sync.
- **Error propagation:** If `scheduleIdleClose` fires after the runtime was already explicitly closed (race), the `closeRuntime` guard checks `this.runtimes.get(sessionId)` and returns early if absent.
- **State lifecycle risks:** A runtime that is idle-timed out but then referenced by `getSessionsStatus` will no longer appear in `this.runtimes`, so its pending approval count is lost. This is acceptable because an idle runtime has no connected client to display approvals to, and the SDK itself still persists the session state.
- **Unchanged invariants:** Client-side SSE retry logic, session CRUD routes, message history loading, and approval resolution are unaffected. The only visible behavioral change is that a re-subscribe after a long disconnect (>5 min) will create a new runtime instead of reusing the old one.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Race between idle timeout firing and explicit `closeRuntime` | `closeRuntime` removes from `runtimes` first; a stale timeout that fires later finds no entry and exits early. |
| Long-running background turn is interrupted mid-thought because user switched tabs | Accepted — the user explicitly switched away; the grace period gives 5 minutes to return. The SDK persists session state, so returning creates a new runtime that resumes the same session. |
| `closeAllRuntimes` is slow because it awaits each `runtime.close()` sequentially | Use `Promise.all` to close concurrently. |

---

## Documentation / Operational Notes

- Add a note to `development.md` or README about the 5-minute idle grace period so developers understand why a `claude` process may linger briefly after closing a tab.
- Monitor `sse-diag.log` for `[ChatService] idle close scheduled/cancelled/closed` messages when debugging resource issues.

---

## Sources & References

- Related code: `src/server/services/session-runtime.ts`, `src/server/services/chat-service.ts`, `src/server/routes/chat.ts`, `src/server/index.ts`
- Related plan: `docs/plans/2026-05-27-001-feat-keep-alive-workspace-tabs-plan.md` (background tab SSE behavior)
- Related learning: `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md`
