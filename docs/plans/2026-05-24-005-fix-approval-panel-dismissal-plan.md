---
title: 'fix: Approval panel not dismissed after user choice'
type: fix
status: completed
date: 2026-05-24
origin: none
depth: lightweight
---

# fix: Approval panel not dismissed after user choice

## Summary

Wire up the existing `isResolving` prop in `ChatPanel` and add optimistic queue removal in the chat store so the approval panel dismisses immediately after the user clicks Allow, Deny, or Confirm, without waiting for the SSE round-trip.

## Problem Frame

When a user makes a choice on the approval panel, the client POSTs the decision to the server and then waits for an SSE `approval_resolved` event before removing the item from `approvalQueue`. If that SSE event is delayed or lost (e.g., connection hiccup, ring-buffer wrap on reconnect), the panel stays visible indefinitely, making it appear as if the click did not register. Additionally, `ChatPanel` never passes `isResolving` to `ApprovalSurface`, so buttons are never disabled and no visual feedback is shown during the HTTP round-trip.

## Requirements

- R1. The approval panel must dismiss immediately after the resolution POST succeeds, regardless of SSE event delivery.
- R2. While the resolution POST is in flight, the approval panel must disable its action buttons and show a loading spinner.
- R3. If the POST fails, the panel must remain visible with buttons re-enabled so the user can retry.

## Scope Boundaries

- Server-side approval resolution logic (already correct after prior fixes).
- SSE reconnection and replay logic (already addressed in `docs/plans/2026-05-19-007-fix-approval-panel-sync-plan.md`).
- Clearing stale approvals on session switch (pre-existing behavior, not the reported symptom).

## Context & Research

### Relevant Code and Patterns

- `src/client/stores/chat-store.ts` — `resolveApproval` POSTs to the server but does not touch `approvalQueue` on success. `sendMessage` already demonstrates optimistic updates (adds the user message to the store before server confirmation).
- `src/client/components/ChatPanel.tsx` — renders `ApprovalSurface` when `approvalQueue[0]` exists. Never passes `isResolving`.
- `src/client/components/ApprovalSurface.tsx` — already accepts `isResolving` and disables buttons / shows spinners accordingly.

### Institutional Learnings

- `docs/plans/2026-05-18-001-fix-approval-result-missing-updated-input-plan.md` fixed the server-side root cause where `updatedInput` was missing, which prevented `approval_resolved` from firing.
- `docs/plans/2026-05-19-007-fix-approval-panel-sync-plan.md` added SSE re-emit of pending approvals on reconnect and client deduplication, but did not address the lack of optimistic dismissal or `isResolving` wiring.

## Key Technical Decisions

- **Optimistic removal in the store, not the component.** Centralizing the queue mutation in `chat-store.ts` keeps state logic in one place and follows the existing `sendMessage` optimistic-update pattern. The component only tracks the transient `isResolving` flag.
- **Local `isResolving` state in `ChatPanel`, not the store.** The resolving flag is transient UI state tied to a specific request ID. Keeping it in component state avoids bloating the store with short-lived flags.

## Implementation Units

### U1. Optimistic approval dismissal in chat store

**Goal:** Remove the resolved approval from `approvalQueue` immediately after the HTTP POST succeeds.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
1. In `resolveApproval`, after `fetch` returns and `res.ok` is true, call `set` to filter the resolved `requestId` out of `approvalQueue[sessionId]`.
2. If `res.ok` is false or the fetch throws, do not remove from the queue (the error path already adds a system message).

**Patterns to follow:**
- The existing `sendMessage` optimistic update in the same file.
- Existing immutability pattern: spread the `approvalQueue` record and the per-session array.

**Test scenarios:**
- Happy path: click Allow → POST returns 200 → approval immediately removed from queue → panel dismisses.
- Error path: click Allow → POST fails (network error or 500) → approval stays in queue → system error message shown → user can retry.
- Edge case: `approval_resolved` SSE event arrives after optimistic removal → `filter` is a no-op, queue stays empty.

**Verification:**
- `npx tsc --noEmit` passes.
- Manual: trigger a tool approval, click Allow, verify the panel dismisses within one animation frame (no SSE latency).

### U2. Wire up `isResolving` in ChatPanel

**Goal:** Pass `isResolving` to `ApprovalSurface` so buttons disable and show a spinner while the resolution POST is in flight.

**Requirements:** R2, R3

**Dependencies:** U1 (can land independently, but both together deliver the complete fix)

**Files:**
- Modify: `src/client/components/ChatPanel.tsx`

**Approach:**
1. Add a local state `resolvingRequestId: string | null` to `ChatPanel`.
2. Wrap each handler (`handleAllow`, `handleAllowAlways`, `handleDeny`, `handleAnswerQuestion`, `handleChatAbout`) in an async wrapper that:
   - Sets `resolvingRequestId` to `currentApproval.requestId` before calling `resolveApproval`.
   - Clears `resolvingRequestId` to `null` in a `finally` block.
3. Pass `isResolving={resolvingRequestId === currentApproval?.requestId}` to `ApprovalSurface`.

**Patterns to follow:**
- The existing `isInterrupting` / `setIsInterrupting` pattern in the same file for the stop button.

**Test scenarios:**
- Happy path: click Allow → button text changes to spinner + "…" → POST succeeds → panel dismisses.
- Error path: click Deny → button shows spinner → POST fails → spinner disappears → buttons re-enable → panel still visible.
- Edge case: rapid double-click on Allow → first click sets `resolvingRequestId`, second click sees `currentApproval.requestId === resolvingRequestId` and the handler early-returns or proceeds with the same ID (the button is disabled, so the second click cannot fire).

**Verification:**
- `npx tsc --noEmit` passes.
- Manual: trigger an approval, click each action button, verify spinner appears and buttons are disabled during the round-trip.

## System-Wide Impact

- **Interaction graph:** `ChatPanel` wraps `resolveApproval` calls; `ApprovalSurface` receives the new `isResolving` prop. No other components are affected.
- **Error propagation:** HTTP errors in `resolveApproval` already surface as system messages. The new `finally` block ensures `resolvingRequestId` is always cleared, preventing stuck UI state.
- **State lifecycle risks:** None — optimistic removal happens only on HTTP success, and the SSE `approval_resolved` handler's `filter` is idempotent.
- **Unchanged invariants:** The server-side approval resolution, SSE event vocabulary, and `ApprovalSurface` rendering logic are untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|-----------|
| Optimistic removal races with a subsequent `pending_approval` for the same requestId (e.g., server re-emits on reconnect) | Client deduplication (`hasPendingItem`) already prevents duplicate queue entries. |
| `resolvingRequestId` state lost on component unmount (session switch) | The HTTP request completes independently; the store's optimistic removal still applies. The user can switch back to see the updated state. |

## Sources & References

- Related plans:
  - `docs/plans/2026-05-18-001-fix-approval-result-missing-updated-input-plan.md`
  - `docs/plans/2026-05-19-007-fix-approval-panel-sync-plan.md`
- Related code:
  - `src/client/stores/chat-store.ts`
  - `src/client/components/ChatPanel.tsx`
  - `src/client/components/ApprovalSurface.tsx`
