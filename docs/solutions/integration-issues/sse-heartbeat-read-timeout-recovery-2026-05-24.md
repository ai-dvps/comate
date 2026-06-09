---
title: SSE silent proxy drops cause permanent connection loss
date: 2026-05-24
category: integration-issues
module: chat-sse-subscription
problem_type: integration_issue
component: brief_system
symptoms:
  - SSE subscription permanently lost after idle periods
  - Approval panel never appears during long tool waits
  - Connection drops after 30 seconds of inactivity
  - Read timeout aborts healthy connections and never retries
root_cause: async_timing
resolution_type: code_fix
severity: high
tags:
  - sse
  - heartbeat
  - timeout
  - reconnect
  - keepalive
related_components:
  - sse-emitter
  - session-runtime
---

# SSE silent proxy drops cause permanent connection loss

## Problem

SSE connections can be silently dropped by proxies, load balancers, or OS network stacks when no data flows for an extended period. The client guarded against this with a 30-second read timeout (`readTimeout`) that aborted the `fetch` connection if no events arrived. However, the server never emitted keepalive frames, so the timeout fired during normal idle periods (e.g., waiting for tool approval, long model thinking), causing unnecessary reconnects. Worse, the client's abort handler treated all `AbortError`s as intentional closes and returned without retry. When the read timeout fired, the subscription was permanently lost even though the user never asked to close it.

## Symptoms

- After ~30 seconds of streaming inactivity, the SSE connection drops and never recovers.
- The approval or question panel does not appear during long waits because `pending_approval` events have no alive connection to travel on.
- Browser DevTools shows the `fetch` request ending with `(canceled)` and no retry attempt.
- Manually switching sessions and back forces a reconnect, after which pending events arrive.

## What Didn't Work

- **Lowering the read timeout** made the problem worse — healthy idle connections were aborted even faster.
- **Removing the read timeout entirely** left the client unable to detect silently dropped connections at all.
- **Retrying on every `AbortError`** created a retry storm when the user intentionally switched sessions, because the intentional abort was indistinguishable from the timeout abort.

## Solution

Add server-to-client heartbeat events, raise the read timeout to 35s, and distinguish intentional aborts from timeout-driven aborts in the client's retry logic.

### Server-side heartbeat

**`src/server/services/sse-emitter.ts`**

```typescript
emitHeartbeat(): void {
  if (this.res) {
    try {
      this.res.write('event: heartbeat\ndata: {}\n\n')
    } catch {
      // Ignore write errors on closed connections
    }
  }
}
```

Heartbeats bypass the ring buffer entirely — no `id:` line, no `eventIndex` increment, no `onEvent` callback. They are pure keepalive.

**`src/server/services/session-runtime.ts`**

```typescript
private heartbeatTimer?: NodeJS.Timeout

subscribe(res: Response, lastEventId?: string): void {
  this.activeRes = res
  this.emitter.setResponse(res)
  if (!this.heartbeatTimer) {
    this.heartbeatTimer = setInterval(
      () => this.emitter.emitHeartbeat(),
      15000,
    )
  }
  // ... rest of subscribe
}

unsubscribe(res?: Response): void {
  if (!res || this.activeRes === res) {
    this.activeRes = null
    this.emitter.setResponse(null)
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }
}
```

### Client-side timeout and retry fix

**`src/client/stores/chat-store.ts`**

```typescript
function subscribeToSession(
  set: SseSetter,
  _get: SseGetter,
  workspaceId: string,
  sessionId: string,
): void {
  // ... setup ...
  let abortedIntentionally = false

  const thisClose = () => {
    abortedIntentionally = true
    // ... clear timers, abort controller ...
  }

  const resetReadTimeout = () => {
    if (readTimeout) clearTimeout(readTimeout)
    readTimeout = setTimeout(() => {
      abortController.abort()
    }, 35000)
  }

  fetch(`/api/workspaces/${workspaceId}/sessions/${sessionId}/stream`, {
    // ...
  })
    .then(async (res) => {
      for await (const event of parseSSEStream(res.body)) {
        resetReadTimeout()
        handleSseEvent(set, sessionId, event.event, event.data)
      }
      // ... clean close retry logic ...
    })
    .catch((err) => {
      if (err.name === 'AbortError') {
        if (abortedIntentionally) {
          return // Intentional close — no retry
        }
        // Timeout-driven abort — fall through to retry
      }
      // Exponential backoff retry ...
    })
}
```

## Why This Works

The fix addresses both halves of the compounding failure:

1. **Server heartbeats keep the connection alive.** A 15s heartbeat resets the client's 35s read timeout, so idle-but-healthy connections survive normal wait periods.
2. **Distinguishing abort sources prevents two bad outcomes.** Without the `abortedIntentionally` flag, all `AbortError`s were treated as intentional user closes — so timeout aborts (which need retry) were ignored. With the flag, intentional closes return immediately while timeout aborts fall through to the existing exponential-backoff retry.
3. **Heartbeat bypasses the ring buffer.** Heartbeats carry no `id:` and are not replayed. This prevents `lastEventId` from advancing on keepalive frames, which would cause full-buffer replay on reconnect.

## Prevention

- **Every long-lived SSE stream needs a heartbeat or ping.** Proxies and OS stacks will drop idle TCP connections; heartbeats are the only reliable signal that the connection is healthy.
- **Client read timeout should be > 2x heartbeat interval + jitter.** With a 15s heartbeat, 35s allows two missed heartbeats plus network jitter before declaring the connection dead.
- **Distinguish intentional abort from timeout abort.** A boolean flag set before `abortController.abort()` is the minimal mechanism; without it, you cannot tell whether the user closed the connection or the timeout did.
- **Keepalive events must not carry IDs or enter replay buffers.** If they do, reconnecting clients will replay unnecessary keepalive frames and advance `lastEventId` past real events they need to receive.

## Related Issues

- `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md` — The prior learning explicitly recommended adding a heartbeat/ping frame as prevention.
- `docs/solutions/integration-issues/sse-subscription-race-condition-2026-05-21.md` — The heartbeat timer must respect the same `activeRes` guard in `unsubscribe` to avoid race-condition timer leaks.
