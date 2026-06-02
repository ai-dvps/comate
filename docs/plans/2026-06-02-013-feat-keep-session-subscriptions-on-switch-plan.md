---
title: Keep Session Subscriptions Alive on Switch
type: feat
status: active
date: 2026-06-02
origin: docs/brainstorms/2026-06-02-keep-session-subscriptions-on-switch-requirements.md
---

# Keep Session Subscriptions Alive on Switch

## Summary

Stop closing SSE subscriptions when the user switches to another session, so background sessions continue streaming all content into the client store. Decouple backend runtime idle-close from subscription status: replace the "unsubscribe triggers 5-minute idle" mechanism with an activity-based timer that resets on every SDK message, user message push, or client subscribe, and extend the idle window to 10 minutes.

---

## Problem Frame

Switching sessions currently tears down the previous SSE subscription and starts a 5-minute idle countdown on the backend runtime. Background work becomes invisible after that window, and context compaction can exceed 5 minutes with zero events — causing the runtime to be killed mid-compaction. Users returning to an idled-out session must wait for reconnect and full message reload. (see origin: docs/brainstorms/2026-06-02-keep-session-subscriptions-on-switch-requirements.md)

---

## Requirements

- R1. Switching the active session shall not close the previously active session's SSE subscription.
- R2. The client shall maintain concurrent SSE subscriptions for every session the user has opened, subject to workspace cleanup.
- R3. On workspace cleanup (unmount or tab close), the client shall close all subscriptions belonging to that workspace, not only the active one.
- R4. `SessionRuntime` shall expose an activity callback (`onActivity`) that is invoked on every SDK message, on user message push, and on client subscribe.
- R5. The activity callback shall reset the idle-close timer, keeping the runtime alive as long as the session is genuinely active.
- R6. The backend shall schedule idle-close immediately when a new runtime is created, so runtimes that never receive activity still close within the idle window.
- R7. Runtime idle-close shall be independent of subscription status: unsubscribing shall not trigger or accelerate idle-close.
- R8. The idle-close grace period shall be increased from 5 minutes to 10 minutes.
- R9. When idle-close fires, the runtime shall close cleanly. The frontend's retry logic will reconnect and create a fresh runtime if needed.
- R10. Session-list status indicators (`needs-me`, `streaming`, `finished-unread`) shall continue to work for background sessions because their store state is updated in real time via the live SSE connection.

**Origin actors:** End user (primary actor)

**Origin acceptance examples:** AE1 (streaming survives switch), AE2 (compaction outlasts 5 min), AE3 (idle-close after 10 min inactivity), AE4 (workspace cleanup closes all)

---

## Scope Boundaries

- New UI notifications or badges for background sessions beyond existing session-list indicators
- A cap or LRU eviction policy on the number of concurrent background subscriptions
- Special modal surfacing of approval requests from non-active sessions
- Changes to the SDK query or compaction behavior itself
- Session deletion subscription cleanup (pre-existing behavior; no regression required)

### Deferred to Follow-Up Work

- Session deletion should close the corresponding subscription to prevent orphaned retry loops (minor cleanup, pre-existing issue)

---

## Context & Research

### Relevant Code and Patterns

- `src/client/stores/chat-store.ts` — Module-level `Map`s (`sessionSubscriptions`, `lastEventId`) track SSE state outside Zustand. `setActiveSession` currently closes the previous subscription; `cleanupWorkspace` only closes the active one.
- `src/server/services/chat-service.ts` — `ChatService` manages `Map<string, SessionRuntime>` and idle timeouts. `RUNTIME_IDLE_GRACE_PERIOD_MS = 5 * 60 * 1000`. `getOrCreateRuntime` wires `onSubscribed` → `cancelIdleClose` and `onUnsubscribed` → `scheduleIdleClose`.
- `src/server/services/session-runtime.ts` — `SessionRuntime.open()` accepts lifecycle callbacks. `subscribe(res)` wires SSE and calls `onSubscribed`. `unsubscribe(res)` calls `onUnsubscribed` only when the closed response matches `activeRes` (race-condition guard from prior fix).
- `src/server/services/sse-emitter.ts` — `SseEmitter` translates SDK messages to typed SSE events and supports `setResponse(null)` for subscriberless emission into the ring buffer.
- `src/client/components/SessionList.tsx` — `deriveSessionState` already reads per-session `isStreaming`, `pendingCount`, and `unread` to show indicators; no UI changes required.

### Institutional Learnings

- SSE clean-close retry (2026-05-22): clean SSE close must trigger exponential-backoff retry, not silent drop. Background subscriptions inherit this behavior.
- Heartbeat recovery (2026-05-24): 15s server heartbeats + 35s client read timeout. Heartbeat timer starts in `subscribe()` and stops in `unsubscribe()`; background sessions keep heartbeats alive.
- SSE race condition (2026-05-21): `unsubscribe(res)` guards by response identity (`activeRes === res`). This guard remains valid because each session still has at most one concurrent frontend connection.
- lastEventId deletion (2026-05-18): a prior regression deleted `lastEventId` on switch, breaking replay. With subscriptions staying alive, `lastEventId` is preserved naturally.

---

## Key Technical Decisions

- **Reset idle timer on activity rather than cancel-only:** Calling `scheduleIdleClose` from `onActivity` both cancels any pending timer and schedules a fresh 10-minute timeout. This is simpler than a separate cancel/reschedule pair and matches the existing `scheduleIdleClose` implementation.
- **Keep `onSubscribed` as `cancelIdleClose`:** A client subscribing is a form of activity, so canceling the idle timer on subscribe is correct. The change is removing idle-close from `onUnsubscribed`, not from `onSubscribed`.
- **Store workspaceId in `sessionSubscriptions` Map entries:** `cleanupWorkspace` must close every subscription for a workspace. Adding `workspaceId` to the subscription value is the minimal change; no new Map is needed.
- **Preserve existing retry/heartbeat/replay machinery:** The clean-close retry loop, heartbeat intervals, and ring-buffer replay are battle-tested. Background subscriptions use them unchanged; only the "intentional abort on session switch" semantics change.

---

## Open Questions

### Resolved During Planning

- **Where should `onActivity` fire?** On every SDK message in `runMessageLoop`, on `pushMessage`, and on `subscribe`. Not on `unsubscribe` or `resolveApproval` (the SDK message loop covers result messages).
- **What happens when idle-close fires while a client is still subscribed?** The SSE stream ends cleanly, the client retries, and `getOrCreateRuntime` creates a fresh runtime. This is acceptable because truly idle sessions have no in-flight work to lose.

### Deferred to Implementation

- **Exact mock strategy for frontend `fetch` + ReadableStream tests:** Depends on Node version support and test harness capabilities. If mocking is too complex, backend tests plus manual frontend verification is acceptable.

---

## Implementation Units

### U1. Backend: Activity-based idle-close

**Goal:** Decouple runtime idle-close from subscription status, add an `onActivity` callback that resets the idle timer, extend the timeout to 10 minutes, and schedule idle-close immediately on new runtime creation.

**Requirements:** R4, R5, R6, R7, R8, R9

**Dependencies:** None

**Files:**
- Modify: `src/server/services/session-runtime.ts`
- Modify: `src/server/services/chat-service.ts`
- Test: `src/server/services/chat-service.test.ts` (create)

**Approach:**
1. Add `onActivity?: () => void` to `SessionRuntime.open()` and the private constructor. Store it as an instance property.
2. Invoke `this.onActivity?.()` inside `subscribe()`, inside `pushMessage()`, and inside `runMessageLoop` for each SDK message received.
3. In `ChatService.getOrCreateRuntime`, wire `onActivity` to `() => this.scheduleIdleClose(sessionId)`. This reuses the existing `scheduleIdleClose` behavior (cancel + schedule).
4. After creating a new runtime in `getOrCreateRuntime`, call `this.scheduleIdleClose(sessionId)` so the timer starts immediately.
5. Change `onUnsubscribed` callback in `getOrCreateRuntime` from `() => this.scheduleIdleClose(sessionId)` to a no-op (`() => {}`). Keep `onSubscribed` as `() => this.cancelIdleClose(sessionId)`.
6. Change `RUNTIME_IDLE_GRACE_PERIOD_MS` from `5 * 60 * 1000` to `10 * 60 * 1000`.

**Patterns to follow:**
- `SessionRuntime` callback pattern (existing `onSubscribed` / `onUnsubscribed`)
- `ChatService` timer management (`scheduleIdleClose`, `cancelIdleClose`)

**Test scenarios:**
- Happy path: `onActivity` resets the idle timer (verify timer is rescheduled)
- Happy path: new runtime schedules idle-close immediately after creation
- Happy path: idle-close fires after 10 minutes of inactivity and closes the runtime
- Edge case: `unsubscribe` does not reschedule or affect the idle timer
- Edge case: rapid successive `onActivity` calls do not leak timers
- Error path: `closeRuntime` cancels any pending idle timer before closing
- Integration: `onActivity` is invoked on SDK message, `pushMessage`, and `subscribe`

**Verification:**
- `SessionRuntime` constructor accepts and stores `onActivity`
- `ChatService` wires `onActivity` to reset idle timer
- `onUnsubscribed` is a no-op
- Idle timeout constant is 10 minutes
- Backend tests pass

---

### U2. Frontend: Subscription lifecycle changes

**Goal:** Keep SSE subscriptions open when switching sessions and close all workspace subscriptions on workspace cleanup.

**Requirements:** R1, R2, R3, R10

**Dependencies:** U1

**Files:**
- Modify: `src/client/stores/chat-store.ts`
- Test: `src/client/stores/chat-store.test.ts` (create, if mocking is feasible)

**Approach:**
1. In `subscribeToSession`, store `workspaceId` alongside each subscription entry so `cleanupWorkspace` can filter by workspace later.
2. In `setActiveSession`, remove the code that closes the previous session's subscription (`sub.close()` and `sessionSubscriptions.delete(prevSessionId)`). Keep the `lastEventId` preservation (do not delete `lastEventId` entries on switch).
3. In `cleanupWorkspace`, iterate all `sessionSubscriptions` entries and close every subscription whose `workspaceId` matches the closing workspace, not only the active session.
4. Verify that `lastEventId` is never deleted on session switch or workspace cleanup (it is only used for reconnect replay).
5. Ensure `isStreaming`, `approvalQueue`, and other per-session state in `chat-store` already update via `handleSseEvent` for all sessions regardless of active status — no additional code changes needed for R10.

**Patterns to follow:**
- Module-level `Map` pattern for subscription tracking
- Identity-check cleanup (`current?.close === thisClose`) in `subscribeToSession`

**Test scenarios:**
- Happy path: switching active session leaves the previous subscription open and its `lastEventId` intact
- Happy path: workspace cleanup closes every subscription belonging to that workspace
- Happy path: creating a new session while background sessions exist does not disrupt them
- Edge case: rapid session switching does not create duplicate subscriptions for the same session
- Error path: intentional abort via workspace cleanup does not trigger retry loops
- Integration: background session receives SSE events and updates store state (messages, isStreaming, approvalQueue)

**Verification:**
- `setActiveSession` no longer closes previous subscriptions
- `cleanupWorkspace` closes all workspace subscriptions
- `sessionSubscriptions` entries include workspaceId
- Session list shows correct indicators for background sessions
- Frontend tests pass (or manual verification documented if tests are deferred)

---

### U3. Integration verification and edge-case hardening

**Goal:** Validate that background sessions work correctly end-to-end, including reconnect after idle-close, heartbeat behavior, and state consistency.

**Requirements:** R9, R10

**Dependencies:** U1, U2

**Files:**
- Verify: `src/client/stores/chat-store.ts`
- Verify: `src/server/services/session-runtime.ts`
- Verify: `src/client/components/SessionList.tsx`

**Approach:**
1. Verify that a background session which hits an approval request correctly updates `approvalQueue` in the store and shows `needs-me` in the session list (existing behavior via `handleSseEvent` and background polling).
2. Verify that when a runtime is idle-closed after 10 minutes, the frontend's clean-close retry fires, reconnects, and `getOrCreateRuntime` creates a fresh runtime. Confirm the session list indicator returns to `idle`.
3. Verify that `lastEventId` replay works on reconnect: create a session, let it stream, switch away, wait for idle-close, switch back — the reconnect should use `Last-Event-ID` and the server ring buffer should replay missed events.
4. Verify heartbeat continuity: background sessions should continue receiving 15s heartbeats; the client read timeout (35s) should not fire under normal conditions.
5. Verify no duplicate messages on reconnect: `handleSseEvent` deduplicates `assistant_start` and `tool_result` by checking existing state.

**Test expectation:** none — this unit is manual verification and code review. Automated coverage of full SSE reconnect cycles is deferred.

**Verification:**
- Manual test: stream in Session A, switch to Session B, observe Session A continues updating in store
- Manual test: let Session A idle for 10+ minutes, observe runtime close and frontend reconnect
- Manual test: trigger approval in background session, observe `needs-me` indicator
- Code review: confirm `lastEventId` is preserved and replay path is exercised

---

## System-Wide Impact

- **Interaction graph:** `setActiveSession` no longer calls `sub.close()` — downstream code that relied on subscription teardown on switch (none found) is unaffected. `cleanupWorkspace` now traverses all subscriptions.
- **Error propagation:** Idle-close errors (`closeRuntime` failures) are already logged and swallowed; no change. Frontend retry on clean close uses existing backoff logic.
- **State lifecycle risks:** Multiple concurrent `fetch` connections increase client-side connection count, but each is bounded by the 10-minute idle cycle on the backend. No shared mutable state changes except the `sessionSubscriptions` Map, which already uses identity checks for safe cleanup.
- **API surface parity:** The stream endpoint (`GET /sessions/:sessionId/stream`) and all SSE event types are unchanged.
- **Integration coverage:** Cross-layer behavior (frontend retry → backend `getOrCreateRuntime` → ring buffer replay) must be verified manually; unit tests cover individual layers.
- **Unchanged invariants:**
  - Each session still has at most one `SessionRuntime` and one frontend SSE connection at a time
  - Heartbeat interval (15s), read timeout (35s), and retry backoff (2s base, 30s max, 5 attempts) are unchanged
  - Ring buffer capacity (500 events) and replay logic are unchanged
  - Approval mode, provider switching, and interrupt behavior are unchanged

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SDK compaction takes >10 min with zero events, causing idle-close mid-compaction | 10-minute window is a best-effort extension; if compaction routinely exceeds this, a future follow-up could add explicit compaction-state idle suppression |
| Browser connection limits with many background sessions | Deferred per scope boundaries; desktop WebView typically supports 100+ concurrent HTTP connections, which is well above expected session counts |
| Frontend `fetch` mock complexity blocks automated tests | Backend tests provide core behavioral coverage; frontend verification can be manual if mocking is too complex |
| Orphaned subscriptions if workspace cleanup misses an entry | Identity-check cleanup and `cleanupWorkspace` iteration reduce likelihood; session-level retry max (5 attempts) bounds total retry lifetime |

---

## Documentation / Operational Notes

- No user-facing documentation changes required; the behavior is a quality-of-life improvement
- Diagnostic logs (`sidecarLog`) already emit idle schedule/cancel events; verify log verbosity is appropriate for the new 10-minute window

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-02-keep-session-subscriptions-on-switch-requirements.md](../brainstorms/2026-06-02-keep-session-subscriptions-on-switch-requirements.md)
- Related code: `src/client/stores/chat-store.ts`, `src/server/services/chat-service.ts`, `src/server/services/session-runtime.ts`
- Related plans: `docs/plans/2026-05-24-002-fix-sse-heartbeat-recovery-plan.md`, `docs/plans/2026-05-28-001-fix-session-runtime-resource-leak-plan.md`, `docs/plans/2026-05-21-001-fix-sse-subscription-race-condition-plan.md`
