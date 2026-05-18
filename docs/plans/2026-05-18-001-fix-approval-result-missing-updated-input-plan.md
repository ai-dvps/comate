---
title: Fix approval result missing updatedInput on plain tool allow
slug: fix-approval-result-missing-updated-input
type: fix
status: active
created: 2026-05-18
origin: none
depth: lightweight
---

# Fix approval result missing `updatedInput` on plain tool allow

## Problem Frame

While manually exercising the approval surface swap shipped in `docs/plans/2026-05-17-015-feat-approval-surface-swap-plan.md`, the user hit two linked failures on the first happy-path approval (AE1, Bash creating an empty file):

- **Bug 2 (root cause).** Clicking **Allow** sends `POST /api/workspaces/:wsId/sessions/:sessionId/approvals/:requestId` with body `{"behavior":"allow"}`. The route resolves the SDK callback with `{ behavior: 'allow', updatedPermissions: undefined }`. The SDK's Zod validator on `PermissionResult` rejects this because the `allow` variant requires `updatedInput: Record<string, unknown>`. The server logs `ZodError: ... "path": [ "updatedInput" ], "message": "Invalid input: expected record, received undefined"`.
- **Bug 1 (cascade).** Because the SDK callback never resolves cleanly, the runtime never emits `approval_resolved`, so the client's `approvalQueue` keeps the entry, so `currentApproval` stays non-null, so `ChatPanel`'s conditional render keeps mounting `ApprovalSurface`. The Allow button stays clickable indefinitely and the surface never gives the prompt back.

Only the plain tool-approval path (Bash, Edit, Write, etc.) is affected. The `AskUserQuestion` allow path at `src/server/routes/chat.ts:153-158` already supplies `updatedInput: { questions, answers }` and works correctly. The deny path also works.

## Scope

**In scope:**
- The `allow` branch of `POST /sessions/:sessionId/approvals/:requestId` for non-`AskUserQuestion` tools must produce an SDK-valid `PermissionResult`.
- Verify Bug 1 dismissal returns once Bug 2 is fixed.

**Out of scope:**
- `AskUserQuestion` answer path (already correct).
- Deny path (already correct).
- Any client-side wire format change. The client should not need to know the SDK's allow-variant shape.
- Refactoring `ApprovalSurface` or the queue model.

## Key Technical Decision

**Fix in the runtime, not the route or client.**

The runtime is the only layer that already holds both the original tool `input` (in the `canUseTool` callback closure) and the resolver. The route just forwards a thin user decision; the client just expresses intent (`allow` / `deny` / `answers`). The SDK contract — that `behavior: 'allow'` requires `updatedInput` — belongs to the runtime that talks to the SDK.

Concretely: extend `SessionRuntime.pendingApprovals` from `Map<string, { resolve }>` to `Map<string, { resolve, input }>`, capture `input` when the callback fires, and in `resolveApproval`, if the caller passes `{ behavior: 'allow' }` without `updatedInput`, fill it in from the cached input before resolving.

**Why not fix in the route?** The route would still need to look up the cached input through a new runtime accessor and remember to splice it in for every allow path. That spreads SDK-contract knowledge into HTTP-handling code. Centralizing in `resolveApproval` keeps the contract behind one boundary.

**Why not fix in the client?** Would require: a new `updatedInput` field on `resolveApproval`'s action type, threading the original tool input through `pendingItem`, updating both `handleAllow` and `handleAllowAlways` in `ChatPanel.tsx`, and changing the HTTP body shape. None of this is in service of any client need — the client doesn't modify tool inputs.

**Auto-fill predicate.** Only fill when `result.behavior === 'allow' && result.updatedInput === undefined`. This preserves the existing `AskUserQuestion` path (where the route already supplies `updatedInput: { questions, answers }`) and leaves a door open for any future caller that wants to legitimately mutate the tool input.

## Implementation Units

### U1: Auto-fill `updatedInput` in `SessionRuntime.resolveApproval`

**Goal:** Make the SDK callback resolve with a valid `PermissionResult` whenever the route asks the runtime to allow a tool call, without requiring the route or client to know the SDK's shape.

**Files:**
- Modify: `src/server/services/session-runtime.ts`

**Approach (directional, not implementation):**

1. Widen the `pendingApprovals` map entry from `{ resolve }` to `{ resolve, input }`, typed as `Record<string, unknown>`.
2. In `buildCanUseToolCallback`, when calling `this.pendingApprovals.set(requestId, ...)`, include the `input` parameter the SDK already passes into the callback.
3. In `resolveApproval(requestId, result)`, after retrieving and deleting the pending entry, before calling `pending.resolve(result)`:
   - If `result.behavior === 'allow'` and `result.updatedInput === undefined`, spread `pending.input` in as `updatedInput`.
   - Otherwise pass `result` through unchanged.
4. Leave the abort path (`options.signal.addEventListener('abort', ...)`) untouched — it resolves with a `deny` result that has no `updatedInput` requirement.

Sketch only (for direction; not literal implementation):

```ts
// pendingApprovals: Map<string, { resolve, input }>

// in canUseTool callback:
this.pendingApprovals.set(requestId, { resolve, input });

// in resolveApproval(requestId, result):
const pending = this.pendingApprovals.get(requestId);
if (!pending) return;
this.pendingApprovals.delete(requestId);
this.emitter.emitApprovalResolved(requestId);

const finalResult =
  result.behavior === 'allow' && result.updatedInput === undefined
    ? { ...result, updatedInput: pending.input }
    : result;

pending.resolve(finalResult);
```

**Patterns to follow:**
- The existing question-resolve branch in `src/server/routes/chat.ts:153-158` is the reference for what a valid `allow` result looks like (`{ behavior: 'allow', updatedInput: <record> }`). This unit makes plain tool approvals reach the same shape without the route having to think about it.
- TypeScript discriminated-union narrowing on `PermissionResult.behavior` is already used inside the file; follow the same style.

**Test scenarios:**
- Manual: AE1 — Bash creating an empty file → click Allow → verify surface dismisses, no `ZodError` in server logs, `approval_resolved` SSE event fires.
- Manual: AE2 — Bash with `Allow always for matching` (carries `updatedPermissions`) → click Allow always → verify surface dismisses, the `updatedPermissions` field reaches the SDK (does not get clobbered by the auto-fill spread), and subsequent matching calls auto-approve.
- Manual: AE3 — Edit/Write tool approval → click Allow → verify dismissal and clean resolution.
- Manual: AE4 — Deny path on any tool → enter a deny message → verify the surface dismisses and the SDK receives `{ behavior: 'deny', message }` unchanged.
- Manual: AE5 — `AskUserQuestion` happy path → answer the question → verify the question-resolve branch still works (no regression; the runtime's auto-fill should not touch this path because the route already supplies `updatedInput`).
- Manual: AE6 — `AskUserQuestion` "Chat about this" → verify the answers carry the sentinel message and the SDK accepts the result.

**Verification:**
- `npx tsc --noEmit` passes.
- `npm run lint` passes.
- Manual AE1 reproduces the dismissal that Bug 1 was missing.
- Server log search for `ZodError` during the manual run returns nothing.
- A second consecutive Allow on a different Bash command works (no stuck state).

## Risks & Dependencies

- **Risk:** The SDK's `allow` variant might also accept other shapes (e.g., `updatedInput: null`) in some versions. The auto-fill predicate `updatedInput === undefined` is intentionally strict — if a future caller passes `null` deliberately, the runtime leaves it alone. We accept that ambiguity rather than guessing.
- **Risk:** Tool input may contain unexpectedly large payloads (e.g., a multi-MB file write). Spreading it into the resolver result is no different from what the SDK already sent into the callback — no new memory hazard.
- **Risk:** Memory leak if `pendingApprovals` accumulates `input` records. Mitigated because the existing `resolveApproval` and the abort handler already `delete` the entry on every terminal transition.
- **Dependency:** None. The change is local to one file.

## Files Touched

- `src/server/services/session-runtime.ts` (modify)

## Notes for Implementer

- Do not touch `src/server/routes/chat.ts`. The route's current allow branch (`result = { behavior: 'allow', updatedPermissions }`) is correct under this fix — the runtime fills the gap.
- Do not touch `src/client/stores/chat-store.ts` or `src/client/components/ChatPanel.tsx`. The current client payload `{ behavior: 'allow' }` is sufficient.
- After the fix, the Bug 1 dismissal behavior is automatic — no separate change required. Treat Bug 1 strictly as a verification step, not a code change.
- The plan in `docs/plans/2026-05-17-015-feat-approval-surface-swap-plan.md` shipped on branch `feat/approval-surface-swap`. This fix can land on the same branch before opening the PR, or on a fresh branch — defer to user preference at execution time.
