---
title: Fix SSE subscription race condition losing pending_approval events
type: fix
status: completed
date: 2026-05-21
---

# Fix SSE subscription race condition losing pending_approval events

## Summary

Fix a server-side race condition where a stale connection's `close` event nullifies the active SSE response after a newer subscriber has already replaced it. This causes `pending_approval` events to be silently dropped while background polling still shows indicators, leaving the approval panel unrendered until the user re-clicks the session.

## Problem Frame

When a client auto-reconnects or the user re-clicks an already-selected session, the old SSE connection's `close` event can fire asynchronously after the new connection's `subscribe()` call. `SessionRuntime.unsubscribe()` unconditionally calls `this.emitter.setResponse(null)`, wiping out the new connection's response pointer. When `canUseTool` subsequently emits `pending_approval`, `SseEmitter.send()` finds `this.res` is null and silently drops the event. The client never receives it, so `approvalQueue` stays empty and `ChatPanel` renders `PromptInput` instead of `ApprovalSurface`.

## Requirements

- R1. `pending_approval` and `pending_question` SSE events must reliably reach the active subscriber.
- R2. A stale connection's teardown must not interfere with a newer active subscription.
- R3. Re-subscription (auto-reconnect or user re-click) must correctly re-establish the response pointer.

## Scope Boundaries

- Out of scope: Client-side auto-reconnect logic (already implemented and working).
- Out of scope: Background polling mechanism (works correctly).
- Out of scope: Ring buffer replay or re-emit of pending approvals on subscribe (works correctly).
- Out of scope: Changes to `ApprovalSurface` or `ChatPanel` UI components.

### Deferred to Follow-Up Work

- Server-side SSE keepalive/ping messages to prevent proxy idle timeouts: separate enhancement.

## Context & Research

### Relevant Code and Patterns

- `src/server/services/session-runtime.ts:227-256` — `subscribe()` and `unsubscribe()` methods.
- `src/server/services/sse-emitter.ts:57-59` — `setResponse()` unconditionally overwrites `this.res`.
- `src/server/routes/chat.ts:111-115` — Route wires `subscribe()` on connect and `unsubscribe()` on `req.close`.
- `src/client/stores/chat-store.ts:887-932` — Client handlers for `pending_approval` and `pending_question`.

### Institutional Learnings

- Previous fix (2026-05-20) added server-side re-emit of pending approvals on new subscriptions and client-side dedup, but did not address the `subscribe`/`unsubscribe` race.

## Key Technical Decisions

- **Guard `unsubscribe` by response identity**: `SessionRuntime` tracks the currently active `Response` object. `unsubscribe(res)` only clears the emitter's response if `res` is still the active one. This is the minimal fix and avoids changing `SseEmitter`'s simple API.
- **Pass response through route close handler**: The Express route captures `res` in the closure and passes it to `runtime.unsubscribe(res)`, ensuring the close handler identifies which connection it is tearing down.

## Implementation Units

### U1. Guard unsubscribe against stale close events

**Goal:** Prevent a stale connection's `close` event from wiping out a newer active SSE response.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/server/services/session-runtime.ts`
- Modify: `src/server/routes/chat.ts`

**Approach:**
- Add `private activeRes: Response | null = null` to `SessionRuntime`.
- In `subscribe(res)`, set `this.activeRes = res` before calling `this.emitter.setResponse(res)`.
- Change `unsubscribe()` signature to accept optional `res?: Response`.
- In `unsubscribe(res)`, only call `this.emitter.setResponse(null)` if `!res || this.activeRes === res`.
- In `chat.ts`, update `req.on('close')` to call `runtime.unsubscribe(res)`.

**Patterns to follow:**
- Existing `subscribe`/`unsubscribe` pattern in `SessionRuntime`.

**Test scenarios:**
- **Happy path**: Single subscribe → event emitted → unsubscribe with matching res → emitter.res is null.
- **Edge case (the bug)**: Subscribe with res A → subscribe with res B → unsubscribe with res A → emitter.res remains B.
- **Edge case**: Unsubscribe with no res argument (backward compat) → emitter.res is null regardless.

**Verification:**
- After fix, starting a session, sending a message that triggers tool approval, and the approval panel renders without requiring a session re-click.

## System-Wide Impact

- **Unchanged invariants**: The client-side SSE subscription, parsing, and event handling are untouched. Background polling is untouched. The re-emit of pending approvals on new subscriptions continues to work as before.
- **Error propagation**: If `unsubscribe` is called with a mismatched response, it is now a no-op instead of a destructive clear. This is safer.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Other callers of `unsubscribe()` without the response argument | The parameter is optional; existing calls without an argument continue to work (unconditionally clear). |
| Multiple simultaneous subscribers intended | The runtime is designed for single subscriber; this fix preserves that invariant. |

## Sources & References

- Related code: `src/server/services/session-runtime.ts`, `src/server/services/sse-emitter.ts`, `src/server/routes/chat.ts`
- Related plan: `docs/plans/2026-05-19-007-fix-approval-panel-sync-plan.md` (prior sync fix)
