---
title: Stale SSE connection close wipes active subscriber response
date: 2026-05-21
category: integration-issues
module: chat-sse-subscription
problem_type: integration_issue
component: brief_system
symptoms:
  - Approval panel missing after auto-reconnect or session re-click
  - "pending_approval events arrive at server but never reach client"
  - Tab approval indicator visible while chat panel shows only PromptInput
  - User must manually re-click session to force approval surface to appear
root_cause: async_timing
resolution_type: code_fix
severity: high
tags:
  - sse
  - race-condition
  - subscription
  - pending-approval
  - session-runtime
related_components:
  - sse-emitter
  - session-runtime
---

# Stale SSE connection close wipes active subscriber response

## Problem

When a client auto-reconnects or the user re-clicks an already-selected session, the old SSE connection's `close` event can fire asynchronously after the new connection's `subscribe()` call has already replaced the active `Response`. `SessionRuntime.unsubscribe()` unconditionally called `this.emitter.setResponse(null)`, which wiped out the new connection's response pointer. When `canUseTool` subsequently emitted `pending_approval`, `SseEmitter.send()` found `this.res` was null and silently dropped the event. The client never received it, so `approvalQueue` stayed empty and `ChatPanel` rendered `PromptInput` instead of `ApprovalSurface`.

## Symptoms

- After auto-reconnect or session re-click, the approval or question panel never appears.
- Background polling (`sessionStatus` every 5s) still shows `pendingCount > 0`, so the workspace tab indicator is visible.
- The chat area shows the normal `PromptInput` instead of `ApprovalSurface`.
- Clicking the session again (forcing another re-subscription) eventually surfaces the panel because the new subscriber receives the re-emitted pending approvals.

## What Didn't Work

- **Client-side deduplication of pending approvals** (implemented in a prior fix) did not help because the event never reached the client at all.
- **Retrying the SSE connection on the client** did not help because the retry opened a new subscription successfully; the race happened server-side between the old connection's teardown and the new connection's events.
- **Adding more logging** confirmed that `SseEmitter.send` was being called with a valid event payload, but `this.res` was `null` at the moment of emission.

## Solution

Guard `unsubscribe` by response identity so a stale close cannot clear a newer active subscriber.

### Server-side changes

**`src/server/services/session-runtime.ts`**

```typescript
private activeRes: Response | null = null

subscribe(res: Response, lastEventId?: string): void {
  this.activeRes = res
  this.emitter.setResponse(res)
  // ... rest of subscribe
}

unsubscribe(res?: Response): void {
  // Only clear the emitter if the closed response is still the active one
  if (!res || this.activeRes === res) {
    this.activeRes = null
    this.emitter.setResponse(null)
  }
}
```

**`src/server/routes/chat.ts`**

Pass the captured `res` through to `unsubscribe` in the route's `close` handler:

```typescript
req.on('close', () => {
  runtime.unsubscribe(res)
})
```

### Key design points

- `activeRes` tracks the currently active `Response` object.
- `unsubscribe(res)` only clears the emitter when `res` matches `activeRes`.
- If a stale connection's `close` fires after a new `subscribe(resB)`, `unsubscribe(resA)` is a no-op because `activeRes === resB`.
- The parameter is optional for backward compatibility; calls without an argument still unconditionally clear.

## Why This Works

The root cause was an unguarded state mutation in a multi-step async lifecycle. The sequence that produced the bug:

1. Client subscribes → `subscribe(resA)` → `activeRes = resA`, emitter wired to resA.
2. Client reconnects → `subscribe(resB)` → `activeRes = resB`, emitter wired to resB.
3. Old TCP close arrives → `req.on('close')` → `unsubscribe(resA)`.
4. **Before fix:** `emitter.setResponse(null)` → emitter now has no response.
5. Server emits `pending_approval` → `send()` sees `this.res === null` → event lost.

**After fix:** Step 4 checks `this.activeRes === resA` → false (activeRes is resB) → no-op. The emitter stays wired to resB, and the pending approval reaches the client.

## Prevention

- **Never unconditionally null shared state in async teardown handlers.** A `close`/`disconnect`/`cleanup` handler that fires asynchronously must verify that the resource being torn down is still the one the system considers active.
- **Pass identity through event handlers.** The Express `req.on('close')` closure must pass the specific `res` it owns to `unsubscribe`, not call a parameterless cleanup method.
- **Treat `setResponse(null)` as a destructive operation.** Guard it the same way you would guard a database `DELETE` — confirm the identity before acting.

## Related Issues

- `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md` — Client-side clean-close retry (complementary fix for the same approval-panel-sync symptom).
- `docs/plans/2026-05-19-007-fix-approval-panel-sync-plan.md` — Parent plan that scoped the server re-emit of pending approvals and client auto-reconnect.
