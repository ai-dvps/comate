---
title: SSE stream clean close drops pending approval events
date: 2026-05-22
category: integration-issues
module: chat-sse-subscription
problem_type: integration_issue
component: brief_system
symptoms:
  - Approval indicator shows in workspace tab but approval panel does not appear in chat area
  - SSE stream stops emitting events after tool_input_delta
  - Clicking the session list is required to force reconnect before the panel appears
root_cause: async_timing
resolution_type: code_fix
severity: high
tags:
  - sse
  - streaming
  - reconnect
  - chat-store
  - subscription
  - approval-panel
related_components:
  - session-runtime
  - sse-emitter
---

# SSE stream clean close drops pending approval events

## Problem

The user approval and AskUserQuestion panel in the chat UI would not appear when a new pending item arrived during an active session. The SSE stream connecting the client to the server would close cleanly after `tool_input_delta` events, but the client only retried on thrown errors (the `.catch()` path). The server emitted `pending_approval` and `pending_question` events into a dead response socket, so the panel never received them. The user had to manually click the session list to force a reconnect before the panel would render.

## Symptoms

- The approval indicator in the workspace tab and session list (driven by a 5-second `sessionStatus` poll) correctly showed that a session had pending approvals.
- The approval or question panel in the chat area (driven by SSE events via `approvalQueue`) did not appear.
- The stream consistently stopped shortly after `tool_input_delta` events, before `pending_approval` or `pending_question` could be delivered.
- Clicking the session triggered `setActiveSession`, which called `subscribeToSession`, closed the dead connection, opened a new one, and the server replayed pending approvals on reconnect.

## What Didn't Work

- **Suspected a React rendering bug** in the approval panel component and inspected panel visibility conditions, but the state simply never received the `pending_approval` event.
- **Suspected a server-side subscription wiring issue** and added diagnostic logging to `session-runtime.ts`, `sse-emitter.ts`, and the chat route. However, the logs did not appear in the running server because a stale `dist/server/` build cache was still being executed. The updated server-side code was not running until the cache was cleared.
- **Verified that `pendingApprovals` Map on the server held the correct state**, which explained why the polling endpoint returned `pendingCount > 0` even though the SSE stream was dead.

## Solution

The fix was applied in `src/client/stores/chat-store.ts` inside the `subscribeToSession` function.

### Key changes

1. Added `wasActiveAtCleanClose` tracking to detect when the `for await` loop over `parseSSEStream(res.body)` exits cleanly while the subscription is still the active one for that session.
2. When a clean close is detected, schedule the same exponential-backoff retry that was previously only reachable through the `.catch()` path.
3. Added the `SseGetter` type and passed `get` through to `subscribeToSession` so the retry logic can reference the current state if needed.

### Before

The `for await` loop exited cleanly and the connection was silently dropped with no retry:

```typescript
function subscribeToSession(
  set: SseSetter,
  workspaceId: string,
  sessionId: string,
): void {
  // ... setup ...

  fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/stream`, {
    headers,
    signal: abortController.signal,
  })
    .then(async (res) => {
      // ...
      try {
        for await (const event of parseSSEStream(res.body)) {
          if (event.id) {
            lastEventId.set(sessionId, event.id)
          }
          attempt = 0
          handleSseEvent(set, sessionId, event.event, event.data)
        }
        diagWarn(`[SSE ${sessionId}] stream ended cleanly — no retry will fire`)
      } finally {
        const current = sessionSubscriptions.get(sessionId)
        if (current?.close === thisClose) {
          sessionSubscriptions.delete(sessionId)
          diagLog(`[SSE ${sessionId}] subscription removed (clean close)`)
        }
      }
    })
    .catch((err) => {
      // Retry logic only lived here
      // ...
    })
}
```

### After

Clean close now triggers the same exponential-backoff retry:

```typescript
type SseGetter = () => ChatState

function subscribeToSession(
  set: SseSetter,
  get: SseGetter,
  workspaceId: string,
  sessionId: string,
): void {
  // ... setup ...

  fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/stream`, {
    headers,
    signal: abortController.signal,
  })
    .then(async (res) => {
      // ...
      let wasActiveAtCleanClose = false
      try {
        for await (const event of parseSSEStream(res.body)) {
          if (event.id) {
            lastEventId.set(sessionId, event.id)
          }
          attempt = 0
          handleSseEvent(set, sessionId, event.event, event.data)
        }
        diagWarn(`[SSE ${sessionId}] stream ended cleanly`)
        wasActiveAtCleanClose = sessionSubscriptions.get(sessionId)?.close === thisClose
      } finally {
        const current = sessionSubscriptions.get(sessionId)
        if (current?.close === thisClose) {
          sessionSubscriptions.delete(sessionId)
          diagLog(`[SSE ${sessionId}] subscription removed (clean close)`)
        }
      }

      if (wasActiveAtCleanClose) {
        if (attempt >= maxAttempts) {
          console.error('Subscription max retries exceeded after clean close')
          set((state) =>
            addSystemMessage(
              state,
              sessionId,
              'Connection lost. Please reselect the session to reconnect.',
            ),
          )
          set((state) => ({
            isStreaming: { ...state.isStreaming, [sessionId]: false },
          }))
          return
        }
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay)
        attempt++
        diagLog(`[SSE ${sessionId}] retrying after clean close in ${delay}ms`)
        retryTimer = setTimeout(connect, delay)
      }
    })
    .catch((err) => {
      // Existing retry logic for errors remains unchanged
      // ...
    })
}
```

## Why This Works

The root cause was a mismatch between how the client handled SSE stream termination and how the server emitted events.

When the SDK's `canUseTool` callback is invoked, the server emits `pending_approval` and `pending_question` events asynchronously. If the underlying HTTP response socket closes before that callback fires (which was happening after `tool_input_delta`), the event is written to a dead `Response` object and lost.

On the client side, `parseSSEStream` yields events from a `ReadableStream` using a `reader.read()` loop. When the server closes the connection, `reader.read()` returns `{ done: true }`, the `for await` loop exits normally, and execution falls through to the code after the loop. Because no exception is thrown, the `.catch()` retry handler is never invoked. The client therefore had no mechanism to detect that its active SSE subscription had vanished.

By tracking whether the subscription that just finished was still the active one (`wasActiveAtCleanClose`), the client can now distinguish between an intentional close (e.g., user switched sessions) and an unexpected clean close. In the latter case, it schedules the same exponential-backoff reconnect that errors use. On reconnect, the client sends `Last-Event-ID`, the server replays missed events from the ring buffer, and re-emits any pending approvals from `pendingApprovals`, so the panel appears immediately.

## Prevention

- **Treat all SSE stream terminations as potentially abnormal.** A `for await` loop exiting cleanly is not a guarantee that the client intended to disconnect. Always check whether the subscription is still expected to be active and trigger reconnect logic if so.
- **Ensure server-side diagnostic changes are actually executing** by clearing or rebuilding stale `dist/` caches before relying on log output for debugging.
- **Consider adding a lightweight heartbeat or ping frame** to the SSE protocol so the client can detect a silently dropped connection even when the TCP close is not observed immediately.

## Related Issues

- `docs/plans/2026-05-19-007-fix-approval-panel-sync-plan.md` — Predecessor plan that established auto-reconnect for errors and silent drops; this fix plugs the clean-exit gap.
- `docs/solutions/integration-issues/sse-subscription-race-condition-2026-05-21.md` — Server-side race condition where stale `close` events wipe the active subscriber response.
- `docs/solutions/integration-issues/sse-heartbeat-read-timeout-recovery-2026-05-24.md` — Heartbeat implementation that prevents silent proxy drops and fixes timeout-driven retry.
- `docs/solutions/integration-issues/sse-stream-resume-on-reconnect-2026-05-18.md` — Message state preservation and server-side replay for session switches and page refreshes.
- `docs/plans/2026-05-18-003-fix-auto-trigger-streaming-after-send-plan.md` — Same code surface (`subscribeToSession` loop exit), different defect (stale map entry cleanup).
