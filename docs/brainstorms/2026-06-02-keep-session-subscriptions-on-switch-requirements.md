---
date: 2026-06-02
topic: keep-session-subscriptions-on-switch
---

# Keep Session Subscriptions Alive on Switch

## Summary

Allow sessions to remain SSE-subscribed when the user switches to another session, so background sessions continue receiving all streaming content. Replace the subscription-coupled idle-close mechanism with an activity-based one that closes runtimes after 10 minutes of genuine SDK inactivity.

---

## Problem Frame

Today, switching sessions in the UI closes the previous session's SSE subscription (`setActiveSession` calls `sub.close()`). The backend ties idle-close to subscription status: `SessionRuntime.unsubscribe()` triggers a 5-minute idle timer, and if no client reconnects, the runtime closes. This means:

- Background work in non-active sessions is invisible after 5 minutes, even if the session was still processing.
- Context compaction can exceed 5 minutes with zero streamed events, causing the runtime to be killed mid-compaction.
- Users switching back to a session after it idled out must wait for a full runtime reconnect and message reload before seeing current state.

---

## Requirements

**Frontend subscriptions**
- R1. Switching the active session shall not close the previously active session's SSE subscription.
- R2. The client shall maintain concurrent SSE subscriptions for every session the user has opened, subject to workspace cleanup.
- R3. On workspace cleanup (unmount or tab close), the client shall close all subscriptions belonging to that workspace, not only the active one.

**Backend runtime lifecycle**
- R4. `SessionRuntime` shall expose an activity callback (`onActivity`) that is invoked on every SDK message, on user message push, and on client subscribe.
- R5. The activity callback shall reset the idle-close timer, keeping the runtime alive as long as the session is genuinely active.
- R6. The backend shall schedule idle-close immediately when a new runtime is created, so runtimes that never receive activity still close within the idle window.
- R7. Runtime idle-close shall be independent of subscription status: unsubscribing shall not trigger or accelerate idle-close.

**Idle timeout**
- R8. The idle-close grace period shall be increased from 5 minutes to 10 minutes.
- R9. When idle-close fires, the runtime shall close cleanly. The frontend's retry logic will reconnect and create a fresh runtime if needed.

**Background state visibility**
- R10. Session-list status indicators (`needs-me`, `streaming`, `finished-unread`) shall continue to work for background sessions because their store state is updated in real time via the live SSE connection.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R10.** Given Session A is streaming a response, when the user clicks Session B in the sidebar, Session A's SSE connection stays open. New text deltas from Session A continue to update `chat-store` messages. When the user clicks back to Session A, the full streamed content is already present without a reload.
- AE2. **Covers R5, R8.** Given a session enters context compaction (no streamed events), when 8 minutes elapse, the runtime remains alive because the idle window is 10 minutes and compaction is considered active SDK work.
- AE3. **Covers R6, R7, R9.** Given a session runtime has had zero SDK messages, user pushes, or subscribes for 10 minutes, when the idle timer fires, the runtime closes. The frontend sees the clean SSE close, retries, and `getOrCreateRuntime` spins up a fresh runtime.
- AE4. **Covers R3.** Given a workspace has three sessions with open subscriptions, when the user closes the workspace tab, all three subscriptions are closed and no retry loops remain.

---

## Success Criteria

- Users can switch between sessions without losing real-time updates from background sessions.
- Sessions survive context compaction without being idle-closed mid-operation.
- Backend runtime count is still bounded — inactive runtimes close within 10 minutes.
- No regression in workspace cleanup or session deletion behavior.

---

## Scope Boundaries

- New UI notifications or badges for background sessions beyond existing session-list indicators
- A cap or LRU eviction policy on the number of concurrent background subscriptions
- Special modal surfacing of approval requests from non-active sessions
- Changes to the SDK query or compaction behavior itself

---

## Key Decisions

- **Activity-based idle over subscription-based idle:** Tying idle-close to client presence was simple but wrong for background work. Resetting the timer on actual SDK activity keeps runtimes alive during silent operations like compaction.
- **10-minute window over 5-minute:** Context compaction can legitimately exceed 5 minutes with no events. 10 minutes provides headroom without unbounded resource growth.
- **Multiple concurrent subscriptions over polling fallback:** Polling for background session state would add latency and complexity. Native concurrent SSE connections let background sessions update at the same speed as the active one.
- **Clean reconnect on idle close over runtime hibernation:** When a runtime is idle-closed, letting the frontend reconnect and create a fresh runtime is simpler than pausing/resuming the underlying SDK query. The trade-off is a brief reconnect on returning to a very old idle session.

---

## Dependencies / Assumptions

- The SDK emits at least periodic system messages during compaction so the activity callback fires and resets the idle timer. If compaction is entirely silent at the SDK level, the 10-minute window is the only protection.
- The client (Tauri WebView) can sustain a reasonable number of concurrent streaming `fetch` connections without hitting browser connection limits.
- Sessions with no subscribers and no activity are acceptable to close; the reconnect cost on next visit is low.
