---
title: Fix SSE connection pool exhaustion with background session status polling
type: fix
status: completed
date: 2026-05-18
---

# Fix SSE connection pool exhaustion with background session status polling

## Summary

Close inactive session SSE subscriptions to prevent browser connection pool exhaustion, and add lightweight server-side status polling so users still discover pending approvals and streaming state in background sessions.

---

## Problem Frame

When a user selects a session, the client opens a long-lived SSE connection to `/stream`. Rapidly switching between ~5 sessions causes all subsequent API calls to hang in "pending" because the browser's per-domain HTTP/1.1 connection limit (~6) is exhausted. The root cause is that `setActiveSession` never closes the previous session's subscription.

However, simply closing all inactive subscriptions creates a secondary problem: if a background session reaches a pending approval or question, the user has no way to discover it without manually switching back to every session. This is a real workflow requirement — background tasks must surface when they need user attention.

---

## Requirements

- R1. Switching from session A to session B must close session A's SSE subscription before opening session B's.
- R2. The fix must not break the existing re-subscription behavior for the same session (e.g. `sendMessage` re-subscribe guard).
- R3. Users must be able to discover pending approvals or questions in background sessions without keeping a full SSE connection open for every session.
- R4. Reconnecting to a session must still replay missed events from the server ring buffer.

---

## Scope Boundaries

- Does not change the underlying SSE event protocol or runtime emitter behavior.
- Does not add browser push notifications or sound alerts.
- Does not refactor the broader subscription management architecture.
- Does not add client-side tests (project has no test infrastructure).

### Deferred to Follow-Up Work

- Browser/desktop notification API integration for pending approvals.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/stores/chat-store.ts` — `sessionSubscriptions` Map tracks active SSE connections by `sessionId`. `subscribeToSession()` closes only same-session subscriptions. `setActiveSession()` updates `activeSessionIds` but never cleans up the prior session's connection.
- `src/server/services/session-runtime.ts` — `pendingApprovals` Map holds unresolved approvals. `subscribe()` replays ring-buffer events on reconnect. `unsubscribe()` only detaches the response writer; the runtime continues.
- `src/server/services/chat-service.ts` — `runtimes` Map holds active `SessionRuntime` instances keyed by `sessionId`.
- `src/server/routes/chat.ts` — `/stream` route wires `runtime.subscribe(res)`. No status inspection endpoint exists.
- `src/client/components/SessionList.tsx` — renders session list with name, preview, timestamp, and draft badge. No approval indicator.

### Institutional Learnings

- A prior fix (commit `218df45`) cleaned up dead SSE subscriptions on stream completion. This plan addresses the complementary problem (abandoned subscriptions during switching) and adds the missing background-discovery piece.

---

## Key Technical Decisions

- **Hybrid SSE + polling architecture:** One full SSE subscription for the active session (real-time streaming) plus lightweight batch polling every 5s for all background sessions (status discovery). This avoids connection pool exhaustion while preserving approval visibility.
- **Batch status endpoint rather than per-session polling:** A single `GET /sessions/status` returning all active runtime statuses is more efficient than N parallel polls and keeps client logic simple.
- **Status endpoint returns counts, not full approval payloads:** The full approval details are retrieved via SSE ring-buffer replay when the user switches back. The poll only needs to answer "does this session need attention?"
- **Cleanup in `setActiveSession` rather than `subscribeToSession`:** `subscribeToSession` is also called from `sendMessage` to re-establish a missing subscription. Moving cross-session cleanup into `setActiveSession` avoids side effects in `sendMessage`.

---

## Open Questions

### Deferred to Implementation

- Optimal polling interval (5s chosen as reasonable default; may need tuning based on perceived latency). Deferred because it can be adjusted after manual testing without structural changes.

---

## Implementation Units

### U1. Close previous session subscription on workspace session switch

**Goal:** Prevent connection pool exhaustion by closing the old subscription when switching sessions.

**Requirements:** R1, R2, R4

**Dependencies:** None

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- In `setActiveSession`, read `activeSessionIds[workspaceId]` before updating state.
- If the previous session differs from the new one, call `sessionSubscriptions.get(prev)?.close()`, then delete from `sessionSubscriptions` and `lastEventId`.
- Proceed with existing state update and `subscribeToSession`.

**Patterns to follow:**
- Match the subscription cleanup in `deleteSession`.

**Test scenarios:**
- **Happy path:** Switch from session A to B → DevTools shows A's `/stream` closes before B's opens.
- **Edge case:** Rapidly click 5+ sessions → all `/stream` and `/messages` resolve, none hang.
- **Edge case:** Click already-active session → re-subscribes cleanly (same-session close/reopen preserved).
- **Integration:** Send message after switching away and back → `sendMessage` re-subscribe guard still works.

**Verification:**
- Rapidly switch between 6+ sessions; confirm no pending API calls.

---

### U2. Expose runtime status from SessionRuntime and ChatService

**Goal:** Allow the server to report whether a session has pending approvals and whether it is actively streaming.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/server/services/session-runtime.ts`
- Modify: `src/server/services/chat-service.ts`

**Approach:**
- Add a `getStatus()` method to `SessionRuntime` that returns `{ pendingCount: number }`. Derive `pendingCount` from `this.pendingApprovals.size`. `isStreaming` can be inferred from runtime existence (any open runtime is by definition active).
- Add `getSessionsStatus(workspaceId: string)` to `ChatService` that iterates `this.runtimes`, filters by workspace via session lookup, and returns a map of `sessionId → { pendingCount }`.

**Test scenarios:**
- **Happy path:** Runtime with 2 pending approvals → status reports `pendingCount: 2`.
- **Edge case:** No runtime for session → status entry omitted (client interprets as idle).

**Verification:**
- Call endpoint manually for a workspace with active sessions; verify counts match actual pending approvals.

---

### U3. Add batch session status HTTP endpoint

**Goal:** Provide a lightweight client polling target for background session discovery.

**Requirements:** R3

**Dependencies:** U2

**Files:**
- Modify: `src/server/routes/chat.ts`

**Approach:**
- Add `GET /api/workspaces/:id/sessions/status` route.
- Call `chatService.getSessionsStatus(workspaceId)` and return `{ statuses: Record<string, { pendingCount: number }> }`.
- Keep response minimal — no message content, no full approval payloads.

**Test scenarios:**
- **Happy path:** Workspace with 3 sessions, 1 has pending approval → returns correct `pendingCount` map.
- **Edge case:** Workspace with no active runtimes → returns empty `statuses` object.

**Verification:**
- `curl` the endpoint and confirm response shape and counts.

---

### U4. Poll background session status in client store

**Goal:** Surface background session activity without maintaining full SSE connections.

**Requirements:** R3

**Dependencies:** U1, U3

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- Add `sessionStatus: Record<string, { pendingCount: number }>` to `ChatState`.
- Add a `startBackgroundPolling(workspaceId)` helper that sets a `setInterval` (5s) to `fetch` the batch status endpoint.
- On each poll, merge results into `sessionStatus` state.
- Start polling when `fetchSessions` succeeds (so we have the session list).
- Stop polling when the workspace is switched away or on logout/unmount.
- When the user switches to a session, the existing `setActiveSession` logic opens the SSE; the poll continues for other sessions.

**Test scenarios:**
- **Happy path:** Session A has pending approval while session B is active → poll updates `sessionStatus[A]` with `pendingCount > 0`.
- **Edge case:** Switch to session A → SSE opens, poll still reports status for other sessions.
- **Error path:** Status endpoint 500s → poll logs error silently, retries next interval.

**Verification:**
- Open DevTools Network tab; confirm one lightweight `/sessions/status` poll every 5s.
- Trigger a pending approval in a background session; confirm poll reflects it within one interval.

---

### U5. Show pending approval badges in SessionList

**Goal:** Give users a visual cue that a background session needs attention.

**Requirements:** R3

**Dependencies:** U4

**Files:**
- Modify: `src/client/components/SessionList.tsx`

**Approach:**
- Read `sessionStatus` from `chat-store`.
- For each session item, if `sessionStatus[session.id]?.pendingCount > 0`, render a small attention indicator (e.g., an orange dot or "Needs approval" badge) next to the session name.
- Keep the indicator subtle — a dot or short pill so it doesn't overwhelm the list.

**Test scenarios:**
- **Happy path:** Background session gets pending approval → orange dot appears on its list item.
- **Edge case:** User switches to the session → dot disappears (SSE takes over, `pendingCount` will drop when resolved).

**Verification:**
- Visually confirm badge appears when background session needs approval and disappears after resolution.

---

## System-Wide Impact

- **Interaction graph:** `setActiveSession` closes old SSE; `SessionList` reads new `sessionStatus`; background poll loop runs independently.
- **Error propagation:** Poll failures are silently retried; SSE errors still surface as system messages.
- **State lifecycle risks:** `lastEventId` for inactive sessions is cleared on switch, but the server ring buffer retains recent events. Reconnecting replays missed events.
- **API surface parity:** The new `/sessions/status` endpoint is read-only and additive.
- **Unchanged invariants:** `sendMessage`'s re-subscribe guard, `deleteSession`'s cleanup, and server `req.on('close')` are untouched.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Clearing `lastEventId` on switch could drop very old pending approvals if ring buffer rolled past 500 events. | Low likelihood — 500 events is large for typical sessions. If hit, user sees reconnect note and approval badge still draws them back to the session. |
| Polling every 5s adds server load. | Endpoint is a cheap Map lookup; load is negligible for local/small-team use. Interval can be tuned. |
| Users may miss approvals if they don't look at the session list. | Badge on the session item is the MVP. Browser notifications deferred to follow-up. |

---

## Sources & References

- Related code: `src/client/stores/chat-store.ts` (`setActiveSession`, `subscribeToSession`, `sessionSubscriptions`)
- Related code: `src/server/services/session-runtime.ts` (`pendingApprovals`, `ringBuffer`, `subscribe`/`unsubscribe`)
- Related prior fix: commit `218df45` — clean up dead SSE subscriptions on stream completion
