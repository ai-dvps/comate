---
title: In-progress message lost on session switch or page refresh
date: 2026-05-18
category: integration-issues
module: chat-sse-subscription
problem_type: integration_issue
component: brief_system
symptoms:
  - Streaming text disappears after switching away and back
  - Page refresh during streaming loses the in-progress assistant message
  - text_delta events arrive but no text appears in the chat panel
  - Approval surface pops up but no prior streaming text is visible
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - sse
  - replay
  - stream-resume
  - message-state
  - ring-buffer
related_components:
  - session-runtime
  - chat-store
---

# In-progress message lost on session switch or page refresh

## Problem

When a user switched away from a streaming session and returned, or refreshed the page mid-stream, the in-progress assistant message was invisible. The root cause was two-fold:

1. **Client-side:** `ChatPanel` triggered `loadMessages` on every `activeSessionId` change. `loadMessages` replaced `state.messages[sessionId]` with the server response, but the server only persisted **completed** messages. An in-progress streaming assistant message had not been persisted, so it was absent from the response. The local message state was overwritten, destroying the message skeleton that replayed `text_delta` events needed to patch into.

2. **Server-side:** `SessionRuntime.subscribe` only called `replayFrom` when `lastEventId !== undefined`. On page refresh, the client had no `lastEventId` (module-level Map resets). The server sent `subscription_ack` and then only live events. The client missed everything that happened before the connect.

When replayed `text_delta` events arrived, `updateAssistantPart` did `msgs.findIndex((m) => m.id === messageId)` — the message no longer existed, so the chunks were silently dropped.

## Symptoms

- User sends a prompt, streaming begins, text appears.
- User switches to another session, then switches back.
- No new text appears until an approval request pops up (if one arrives).
- After page refresh, the entire in-progress turn is missing — only earlier completed turns are visible.
- Browser DevTools shows SSE `text_delta` events arriving after reconnect, but the UI does not update.

## What Didn't Work

- **Increasing the ring buffer capacity** did not help because the problem was not buffer eviction — it was that fresh connections with no `lastEventId` received no replay at all.
- **Merging server and local messages on load** was considered but rejected because it risked duplicates, ordering issues, and complex merge logic for every message load.
- **Client-side `localStorage` persistence of `lastEventId`** was deferred; while it would help the page-refresh case, it does not solve the session-switch case where the client is still running but `loadMessages` overwrites state.

## Solution

Track the current message start event ID on the server, replay from it on fresh subscriptions, and skip `loadMessages` overwrite when local streaming is in progress.

### Server-side: track current message start

**`src/server/services/session-runtime.ts`**

```typescript
private currentMessageStartId?: string

// In the SseEmitter onEvent callback (constructor):
if (event.type === 'assistant_start') {
  this.currentMessageStartId = String(id)
} else if (
  event.type === 'assistant_done' ||
  event.type === 'interrupted'
) {
  this.currentMessageStartId = undefined
}
```

### Server-side: replay on fresh subscription

```typescript
subscribe(res: Response, lastEventId?: string): void {
  // ... set activeRes, emit subscription_ack ...
  if (lastEventId !== undefined) {
    this.replayFrom(lastEventId, res)
  } else if (this.currentMessageStartId !== undefined) {
    this.replayFrom(this.currentMessageStartId, res)
  }
  // ... emit pending approvals ...
}
```

### Client-side: preserve streaming state

**`src/client/stores/chat-store.ts`**

```typescript
loadMessages: async (workspaceId: string, sessionId: string) => {
  // Skip fetch if messages are already cached
  const existing = get().messages[sessionId] || []
  if (existing.length > 0) {
    set((state) => ({
      isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
    }))
    return
  }

  const res = await fetch(
    `/api/workspaces/${workspaceId}/sessions/${sessionId}/messages`,
  )
  const data = await res.json()
  const mappedMessages = sanitizeMessages(data.messages)

  set((state) => {
    const existing = state.messages[sessionId] || []
    const hasStreaming = existing.some((m) => m.isStreaming)
    if (hasStreaming) {
      // Preserve local streaming state; replayed events will continue it
      return {
        isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
      }
    }
    // Normal load for completed sessions
    return {
      messages: { ...state.messages, [sessionId]: mappedMessages },
      isLoadingMessages: { ...state.isLoadingMessages, [sessionId]: false },
    }
  })
}
```

## Why This Works

The fix closes both gaps in the resume pipeline:

1. **Server knows where the current message began.** By tracking `currentMessageStartId` (the event ID of the most recent `assistant_start`), the server can replay from that point even when the client has no `lastEventId`. The ring buffer's existing `replayFrom` method handles fallback gracefully: if the start ID was evicted, it replays all available events.

2. **Client preserves the message skeleton.** Instead of merging server and local messages (complex), `loadMessages` simply skips the overwrite when any local message has `isStreaming === true`. The existing `assistant_start` message skeleton stays in state, and replayed `text_delta` events continue appending to it.

3. **No duplicate risk on fresh connect.** A page-refresh client has no prior state, so replayed `assistant_start` creates the skeleton for the first time. A session-switch client still has the skeleton, and the replayed `assistant_start` is idempotent because the message ID matches.

## Prevention

- **Never unconditionally overwrite local state with server-fetched state when a local process is in flight.** Streaming, uploading, or any in-progress operation creates local state that the server does not yet know about. Load-from-server must guard against clobbering it.
- **Track replay anchors by stable identifier, not buffer index.** Ring buffers are FIFO queues; indices shift on eviction. Event IDs are stable strings that survive buffer churn.
- **Always replay for fresh connections, not just reconnecting ones.** A client with no `lastEventId` is the most vulnerable — it has zero context. Treat fresh subscriptions the same as reconnects by providing a default replay anchor (`currentMessageStartId`).
- **Make `assistant_start` idempotent on the client.** The client should gracefully handle receiving an `assistant_start` for a message that already exists in local state (same `messageId`). This makes replay safe for both fresh connects and session switches.

## Related Issues

- `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md` — Client-side subscription resilience; the same `subscribeToSession` function is involved in establishing connections that later need replay.
- `docs/solutions/integration-issues/sse-heartbeat-read-timeout-recovery-2026-05-24.md` — Heartbeat recovery ensures connections stay alive long enough for replay to matter.
