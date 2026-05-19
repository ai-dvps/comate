---
title: 'fix: Approval panel out of sync with tab indicator during streaming'
type: fix
status: active
date: 2026-05-19
origin: none
depth: standard
---

# fix: Approval panel out of sync with tab indicator during streaming

## Summary

Fix the intermittent bug where the session tab shows a pending-approval indicator (from HTTP polling) but the chat panel does not render the approval surface (from SSE events). The fix has two parts: the server re-emits currently pending approvals to every new SSE subscriber so reconnecting clients never miss them, and the client auto-reconnects dropped SSE connections with exponential backoff instead of staying silent.

---

## Problem Frame

During streaming, the session tab displays a "needs approval" indicator driven by `sessionStatus` (populated via background HTTP polling every 5s). The approval surface in the chat panel is driven by `approvalQueue` (populated via SSE `pending_approval` / `pending_question` events). These two data sources can diverge when:

1. The SSE connection drops silently (network hiccup, proxy timeout, browser sleep) and the client does not auto-reconnect — `isStreaming` stays true, but no new events arrive.
2. A client subscribes after the original `pending_approval` event was already emitted. The server's `replayFrom` only replays from `lastEventId` or `currentMessageStartId`; if the pending approval falls outside that window (e.g., ring-buffer overflow or no active assistant message), the client never sees it.

In both cases, the background poll still returns `pendingCount > 0`, so the tab indicator is visible. The user must click the session again (which re-subscribes to SSE and triggers replay) to see the approval panel.

---

## Requirements

- R1. A client that subscribes to a session's SSE stream must receive all currently pending approvals/questions, even if the original `pending_approval`/`pending_question` event was emitted before the subscription started.
- R2. The client must not add duplicate pending items to `approvalQueue` if the same `requestId` is received more than once (e.g., via replay plus re-emit).
- R3. The client must automatically re-establish a dropped SSE connection with exponential backoff, so silent disconnects do not leave the user permanently out of sync.
- R4. Auto-reconnect must not spin indefinitely on unrecoverable errors; it should give up after a bounded number of attempts and surface the failure to the user.

---

## Scope Boundaries

- Adding a new HTTP endpoint to fetch pending approvals. The fix uses SSE re-emit instead.
- Modifying the tab indicator behavior or the poll endpoint. The symptom is in the panel, not the tab.
- Changing `ApprovalSurface` UI/UX. The component itself renders correctly when it receives data.
- Introducing a test framework. The repo has none today; verification is manual.

### Deferred to Follow-Up Work

- General SSE reliability audit (e.g., heartbeat/ping frames, connection health checks).

---

## Context & Research

### Relevant Code and Patterns

- `src/server/services/session-runtime.ts` — `SessionRuntime` manages `pendingApprovals` and the SSE subscription lifecycle. `subscribe(res, lastEventId)` sets the response, emits ack, and replays. `buildCanUseToolCallback` emits `pending_approval`/`pending_question` and stores only `{ resolve, input }`.
- `src/server/services/sse-emitter.ts` — `emitPendingApproval` and `emitPendingQuestion` are the public emitters used by `SessionRuntime`.
- `src/client/stores/chat-store.ts` — `handleSseEvent` processes `pending_approval` / `pending_question` by appending to `approvalQueue` with no deduplication. `subscribeToSession` opens a fetch, handles errors by logging and setting `isStreaming = false`, but does not retry.
- `src/client/components/ChatPanel.tsx` — renders `ApprovalSurface` when `approvalQueue[activeSessionId][0]` exists; otherwise renders `PromptInput`.
- Background polling (`startBackgroundPolling`) fetches `/api/workspaces/:id/sessions/status` every 5s and updates `sessionStatus`.

### Institutional Learnings

- `docs/solutions/` does not exist in this repo. No prior captured learnings on SSE reconnection or approval-state sync.

### External References

- None required. The fix follows standard SSE replay and exponential-backoff retry patterns.

---

## Key Technical Decisions

- **Re-emit current pending state on subscribe, rather than adding a REST endpoint.** The server already has the pending state in `pendingApprovals`. Emitting it over the existing SSE channel keeps the client architecture simple (one subscription, one event stream) and avoids a new API contract.
- **Store full event payload in `pendingApprovals`, not just `{ resolve, input }`.** To re-emit, the runtime needs the original `toolName`, `title`, `description`, `suggestions`, and `questions`. Widening the map entry is a localized change.
- **Client deduplication by `requestId` rather than server-side suppression of duplicates.** The server does not track which clients have already seen which events. Deduplicating on the client is simpler and more robust.
- **Exponential backoff with max retry count, not infinite retry.** Prevents a runaway reconnect loop when the server is permanently down or the session is deleted. A cap of ~5 retries with backoff up to ~30s is a reasonable default.

---

## Open Questions

### Resolved During Planning

- Should re-emit happen before or after `replayFrom`? — After. Order does not matter because client deduplication handles duplicates regardless of source.
- Should auto-reconnect retry on `4xx` errors? — No. `4xx` (e.g., 404 session not found) is unrecoverable; retry only on network/transient failures (fetch throws or non-4xx HTTP errors).
- Exact backoff parameters? — Base 2s, max 30s, max 5 attempts. Tweak at implementation if they feel wrong in practice.

### Deferred to Implementation

- Whether to clear the retry counter on any successful SSE event or only on `subscription_ack`. Default is `subscription_ack` (confirms the server has wired the client into the emitter), but any event is also reasonable.

---

## Implementation Units

### U1. Store full pending payload and re-emit on server subscribe

**Goal:** Ensure every new SSE subscriber receives currently pending approvals/questions regardless of when the original event was emitted.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/server/services/session-runtime.ts`

**Approach:**
1. Widen `pendingApprovals` map entry from `{ resolve, input }` to `{ resolve, input, type, toolName?, toolUseId?, title?, description?, suggestions?, questions? }`.
2. In `buildCanUseToolCallback`, when storing the pending entry, capture the full event payload:
   - For `AskUserQuestion`: `type: 'question'`, `questions`
   - For tool approval: `type: 'approval'`, `toolName`, `toolUseId`, `title`, `description`, `suggestions`
3. In `subscribe(res, lastEventId)`, after `emitSubscriptionAck` and `replayFrom`, iterate over `this.pendingApprovals` and call `this.emitter.emitPendingApproval` / `emitPendingQuestion` for each pending entry.

**Patterns to follow:**
- The existing `pendingApprovals` map insertion and deletion patterns in `session-runtime.ts`.
- TypeScript discriminated union for the two pending entry shapes.

**Test scenarios:**
- Happy path: fresh client subscribes to a session with one pending tool approval → receives `subscription_ack` followed by `pending_approval`.
- Happy path: fresh client subscribes to a session with one pending question → receives `subscription_ack` followed by `pending_question`.
- Edge case: client reconnects with a valid `lastEventId` that already includes the `pending_approval` → replay sends it, re-emit sends it again → client deduplicates (covered in U2).
- Edge case: session has no pending approvals → subscribe completes with only `subscription_ack` and replay; no extra events.
- Error path: `resolveApproval` is called while a re-emit is in progress → the pending entry is deleted; the re-emit iterates over a stale snapshot. Mitigation: iterate over a copy of the entries, or accept that the emitter's `send` will write to a closed response if the client disconnected. The existing code already handles response closure via `setResponse(null)` on unsubscribe.

**Verification:**
- Server compiles (`npx tsc --noEmit` in server context).
- Manual: trigger a tool approval, then open a new browser tab and select the same session → the new tab shows the approval surface without requiring a click.

---

### U2. Deduplicate pending approvals by requestId on the client

**Goal:** Prevent duplicate entries in `approvalQueue` when the same `pending_approval`/`pending_question` is received multiple times (replay + re-emit, or reconnect replay).

**Requirements:** R2

**Dependencies:** None (can land before or after U1; safe to deploy independently)

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
1. In `handleSseEvent`, case `pending_approval`: before appending, check if `state.approvalQueue[sessionId]` already contains an item with the same `requestId`. If yes, skip the append.
2. In `handleSseEvent`, case `pending_question`: same deduplication check by `requestId`.
3. The dedup check should be a small helper to avoid duplication:
   ```ts
   function hasPendingItem(state: ChatState, sessionId: string, requestId: string): boolean {
     return (state.approvalQueue[sessionId] || []).some((item) => item.requestId === requestId)
   }
   ```

**Patterns to follow:**
- Existing `approvalQueue` immutability pattern: spread the record, spread the array.

**Test scenarios:**
- Happy path: first `pending_approval` for `req-1` → appended to queue.
- Edge case: second `pending_approval` for `req-1` (same session) → ignored, queue length stays 1.
- Edge case: `pending_approval` for `req-1` arrives, then `approval_resolved` for `req-1` removes it, then another `pending_approval` for `req-1` arrives (edge case: same requestId reused) → appended, queue length is 1. This is correct because the resolved item is gone.
- Integration: U1's re-emit + U2's dedup → client sees exactly one entry per pending approval.

**Verification:**
- `npx tsc --noEmit` passes.
- Manual: trigger an approval, reconnect (e.g., refresh page), verify the approval surface shows exactly one approval, not duplicated.

---

### U3. Auto-reconnect dropped SSE connections with exponential backoff

**Goal:** Ensure the client recovers from silent SSE disconnects without requiring the user to manually re-select the session.

**Requirements:** R3, R4

**Dependencies:** None

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
1. Introduce a per-session retry counter and timer in `subscribeToSession`:
   - `let attempt = 0`
   - `const baseDelay = 2000`, `const maxDelay = 30000`, `const maxAttempts = 5`
2. Wrap the fetch logic in a `connect()` function that can be called recursively on retry.
3. In the `.catch` handler:
   - If `err.name === 'AbortError'`, do not retry (intentional close).
   - If `attempt >= maxAttempts`, stop retrying, set `isStreaming = false`, and add a system message: "Connection lost. Please reselect the session to reconnect."
   - Otherwise, compute `delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay)`, increment `attempt`, and schedule `setTimeout(connect, delay)`.
4. On successful event processing (or specifically on `subscription_ack`), reset `attempt = 0`.
5. Ensure the retry timer is cleaned up when the subscription is intentionally closed (e.g., session switch, delete). Track the timer ID and clear it in `existing.close()` or before starting a new connection.

**Patterns to follow:**
- The existing `sessionSubscriptions` map already holds `{ close: () => void }`. Extend the value to also hold `timer?: ReturnType<typeof setTimeout>` so `subscribeToSession` can clear pending retries.

**Test scenarios:**
- Happy path: connection drops (simulate by killing server briefly) → client retries, reconnects, and resumes receiving events.
- Edge case: connection drops and server is down for > max retry window → client stops retrying, shows system message, `isStreaming` becomes false.
- Edge case: user switches sessions during a retry backoff → the pending retry timer is cancelled, no stale connection attempt for the old session.
- Edge case: `maxAttempts` reached, then user clicks the same session again → fresh `subscribeToSession` resets `attempt = 0` and tries again.
- Error path: server returns 404 (session deleted) → fetch resolves but `res.ok` is false → treated as error, should retry? No, 404 is unrecoverable. Check `res.status` before entering the SSE loop; if `res.status >= 400 && res.status < 500`, do not retry.

**Verification:**
- `npx tsc --noEmit` passes.
- Manual: start a stream, kill the dev server for 5s, restart it → client reconnects automatically and the stream resumes.
- Manual: start a stream, keep server down for > 2 min → client stops retrying and shows the system message.

---

## System-Wide Impact

- **Interaction graph:** U1 changes `SessionRuntime.subscribe()` which is called on every new SSE connection. U3 changes `subscribeToSession` which is called on session switch and message send. Both are localized to the subscription lifecycle.
- **Error propagation:** U3's retry exhaustion surfaces as a system message and sets `isStreaming = false`. This is the same error-handling pattern already used for subscription errors.
- **State lifecycle risks:** U2's deduplication prevents queue bloat from duplicate events. U3's retry timer cleanup prevents stale connections when switching sessions.
- **API surface parity:** No new HTTP routes or SSE event types. The existing `pending_approval` / `pending_question` events are simply re-emitted.
- **Integration coverage:** The end-to-end fix requires both server (U1) and client (U2 + U3) changes. Deploying U2 alone is safe but does not fix the root cause. Deploying U1 alone without U2 could cause duplicates on reconnect.
- **Unchanged invariants:** The resolve endpoint, interrupt endpoint, approval surface UI, tab indicator logic, and background polling are all untouched.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Re-emitting pending approvals on every subscribe could spam clients that reconnect frequently | Only re-emit current pending items (bounded by the number of active approvals, typically 0–3). Client deduplication (U2) absorbs any duplicates. |
| Exponential backoff retry could hammer a recovering server | Max delay caps at 30s; max 5 attempts means the total retry window is ~1 min. |
| Retry timer leak if user rapidly switches sessions | Timer is tracked in `sessionSubscriptions` and cleared on intentional close. |
| Storing full event payload in `pendingApprovals` increases memory per pending item | Payload is already held by the SDK callback closure; this just extends the reference lifetime to the runtime. Negligible for typical approval sizes. |

---

## Documentation / Operational Notes

- After this work lands, consider a `/ce-compound` capture covering: SSE re-emit pattern for state synchronization, deduplication by event ID in Zustand handlers, and exponential-backoff retry for EventSource-style subscriptions.

---

## Sources & References

- Related code:
  - `src/server/services/session-runtime.ts` (modified in U1)
  - `src/client/stores/chat-store.ts` (modified in U2, U3)
  - `src/client/components/ChatPanel.tsx` (read-only reference for approval surface rendering)
  - `src/server/services/sse-emitter.ts` (read-only reference for emitter API)
