---
title: "feat: Timeout-aware auto-denial for pending approvals and AskUserQuestion"
type: feat
status: pending
date: 2026-06-17
---

# feat: Timeout-aware auto-denial for pending approvals and AskUserQuestion

## Summary

Add timeout-aware auto-denial to pending tool approvals and `AskUserQuestion` requests. `SessionRuntime` parses a top-level `timeout` field from the tool input, computes an absolute expiry timestamp, and resolves the request with a fixed denial message if the user does not respond in time. The client renders a countdown in the approval/question panel and resumes correctly on reconnect.

## Requirements

- R1. `SessionRuntime` SHALL parse a top-level `timeout` field from the tool input for both regular tool approvals and `AskUserQuestion`.
- R2. If `timeout` is missing, `null`, or not a positive finite number, the request SHALL wait indefinitely.
- R3. When a valid timeout is present, `SessionRuntime` SHALL compute an absolute expiry timestamp (`expiresAt`) from the current server time.
- R4. The server SHALL include `expiresAt` in `pending_approval` and `pending_question` SSE events.
- R5. The server SHALL start a timer when the request is created and resolve the pending promise with `behavior: 'deny'` and a fixed timeout message when `expiresAt` is reached.
- R6. The server SHALL cancel the timer when the user resolves the request, the SDK abort signal fires, or the session closes.
- R7. The client SHALL render a countdown in the approval/question panel based on `expiresAt`.
- R8. The client SHALL stop the countdown and remove the request from the panel when `approval_resolved` is received.
- R9. On reconnect, the server SHALL re-emit pending requests with their original `expiresAt`, and the client SHALL resume the countdown at the correct remaining time.

## Scope Boundaries

- **In scope:** Regular tool approvals and the top-level `AskUserQuestion` invocation.
- **Out of scope / deferred:** Per-question timeouts inside a single `AskUserQuestion` call, custom timeout messages per request, and global or per-session default timeout settings.
- **Outside this product's identity:** Auto-allow on timeout and client-only timeout enforcement.

## Context & Research

### Relevant Code and Patterns

- `docs/brainstorms/2026-06-17-pending-request-timeout-requirements.md` — origin requirements document with key decisions, flows, and acceptance examples.
- `src/server/services/session-runtime.ts` — owns `buildCanUseToolCallback()`, the `pendingApprovals` map, request creation, and `resolveApproval()`. Currently only listens to `options.signal` for abort; it needs to also start and clean up a timeout timer.
- `src/server/services/sse-emitter.ts` — owns `emitPendingApproval()` and `emitPendingQuestion()`. These methods must accept and forward an optional `expiresAt` timestamp.
- `src/client/types/message.ts` and `src/server/types/message.ts` — duplicate, byte-identical `SseEvent` unions. The `pending_approval` and `pending_question` variants need an optional `expiresAt?: number` field. CI verifies the two files stay identical via `diff`.
- `src/client/stores/chat-store.ts` — consumes `pending_approval` / `pending_question` / `approval_resolved` events and stores them in `approvalQueue[sessionId]`. The `PendingApproval` / `PendingQuestion` types and event handlers need to carry `expiresAt`.
- `src/client/components/ApprovalSurface.tsx` — renders the active pending item. The `PendingItem` type, header, or button area should display the remaining time and update each second.
- `src/client/components/ChatPanel.tsx` — pulls the active pending item from `approvalQueue` and renders `ApprovalSurface`; no API change is required if the type is extended.
- `src/server/services/session-runtime.test.ts` — existing tests use `node:test` and mock `SdkClient`. New tests should cover timeout parsing, timer firing, timer cancellation on resolve/abort, and reconnect replay.
- `src/client/i18n/en/chat.json` and `src/client/i18n/zh-CN/chat.json` — translation namespaces; a new `approval.timeout` key (or similar) will be needed for the countdown label.

### External References

- `@anthropic-ai/claude-agent-sdk` — already exposes a `timeout` field on some tool inputs; we honor it only for interactive requests (`canUseTool` callback).

## Key Technical Decisions

- **Server-authoritative timer.** The server starts the timer and emits the expiry; the client only renders the countdown. This avoids races when the app is closed, backgrounded, or reconnecting (see origin: `docs/brainstorms/2026-06-17-pending-request-timeout-requirements.md`).
- **Absolute expiry timestamp.** SSE events carry `expiresAt` (Unix epoch ms) rather than a relative `timeout`. Reconnects and panel re-renders then show the correct remaining time without extra client state.
- **Fixed denial message.** No per-request custom message is supported. The deny result uses the literal string `Request timed out waiting for user response.`
- **No maximum cap.** Any positive finite timeout value is honored. Missing or invalid values fall back to today's indefinite-wait behavior.
- **Timer identity stored with the pending record.** Each pending entry gets an optional `expiresAt` and an optional `timer` handle so `resolveApproval()`, the abort handler, and `close()` can cancel it deterministically.
- **Countdown computed from `expiresAt`.** The client uses `Math.max(0, expiresAt - Date.now())` and updates once per second via `setInterval`; drift is acceptable because the server is the source of truth for the actual denial.

## Implementation Units

### U1. Extend shared `SseEvent` types with `expiresAt`

**Goal:** Allow `pending_approval` and `pending_question` events to carry an absolute expiry timestamp.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `src/client/types/message.ts`
- Modify: `src/server/types/message.ts`

**Approach:**
- Add `expiresAt?: number` to the `pending_approval` variant, after `suggestions?: PermissionUpdate[]`.
- Add `expiresAt?: number` to the `pending_question` variant, after `questions: QuestionPayload[]`.
- Keep both files byte-identical; run `diff src/client/types/message.ts src/server/types/message.ts` to verify.

**Patterns to follow:**
- The existing `input` field on `pending_approval` is typed as `unknown`; mirror that optional-scalar style.

**Test scenarios:**
- Type check: `SseEvent` discriminated narrowing still works for `pending_approval` and `pending_question`.
- CI check: The two duplicated type files remain identical.

**Verification:**
- `npm run typecheck` (or equivalent) passes for both client and server projects.
- `diff src/client/types/message.ts src/server/types/message.ts` returns no output.

---

### U2. Parse timeout and manage expiry timers in `SessionRuntime`

**Goal:** Honor a top-level `timeout` field on tool inputs by starting a server-side timer that auto-denies the request at expiry.

**Requirements:** R1, R2, R3, R5, R6, R9

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/session-runtime.ts`
- Modify: `src/server/services/session-runtime.test.ts`

**Approach:**
- Extend the `pendingApprovals` value type with:
  - `expiresAt?: number`
  - `timer?: NodeJS.Timeout`
- Add a private helper `parseTimeout(input: Record<string, unknown>): number | undefined` that returns a positive finite number in milliseconds, or `undefined` for missing / invalid values (R2).
- In `buildCanUseToolCallback()`:
  - For both the `AskUserQuestion` branch and the regular approval branch, call `parseTimeout(input)`.
  - If a valid timeout is returned, compute `const expiresAt = Date.now() + timeout` and store it in the pending record (R3).
  - Start `setTimeout(() => this.timeoutDeny(requestId), timeout)` and store the handle (R5).
- Add a private `timeoutDeny(requestId: string)` method that:
  - Looks up the pending record.
  - If it exists, deletes it, emits `approval_resolved`, and resolves the promise with `{ behavior: 'deny', message: 'Request timed out waiting for user response.' }`.
- Ensure the timer is canceled and removed:
  - In `resolveApproval()` before resolving (R6).
  - In the SDK `options.signal` abort handler (R6).
  - In `close()` when resolving dangling approvals (R6).
- In `subscribe()`, when replaying pending items, pass the stored `expiresAt` to the emitter so reconnecting clients receive the original timestamp (R9).

**Patterns to follow:**
- Existing `resolveApproval()` already normalizes allow results by adding `updatedInput` from the cached input; reuse `pending.input` for timeout parsing rather than trusting the event payload.
- Existing abort handler already deletes the record, emits `approval_resolved`, and resolves with a deny message; extend it to also clear the timer.

**Test scenarios:**
- Missing `timeout` → no timer is started, request waits until manually resolved.
- Invalid `timeout` (`"abc"`, `0`, `-100`, `NaN`, `Infinity`, `null`) → treated as no timeout.
- Valid `timeout: 50` → after ~50 ms the pending promise resolves with `behavior: 'deny'` and the fixed message.
- Valid `timeout: 5000` resolved by user before expiry → timer is canceled and promise resolves with the user's result.
- SDK abort before expiry → timer is canceled and promise resolves with the SDK abort message.
- `close()` with a pending timed request → timer is canceled and promise resolves with the session-close message (not the timeout message).
- Reconnect replay: a pending record with `expiresAt` is re-emitted via `emitPendingApproval` / `emitPendingQuestion` including the same `expiresAt`.

**Verification:**
- New unit tests in `src/server/services/session-runtime.test.ts` pass.
- Existing activity and idle-state tests continue to pass.

---

### U3. Forward `expiresAt` through `SseEmitter`

**Goal:** Include the absolute expiry timestamp in outgoing `pending_approval` and `pending_question` SSE events.

**Requirements:** R4, R9

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/sse-emitter.ts`

**Approach:**
- Update `emitPendingApproval()` signature to accept an optional `expiresAt?: number` after `suggestions`.
- Update the `pending_approval` event object to include `...(expiresAt !== undefined && { expiresAt })`.
- Update `emitPendingQuestion()` signature to accept an optional `expiresAt?: number` after `questions`.
- Update the `pending_question` event object to include `...(expiresAt !== undefined && { expiresAt })`.

**Patterns to follow:**
- The existing `emitAutoApproval()` and `emitApprovalResolved()` methods remain unchanged.

**Test scenarios:**
- `emitPendingApproval(...)` with `expiresAt` produces an SSE frame whose JSON data contains `expiresAt`.
- `emitPendingApproval(...)` without `expiresAt` omits the field (not `null`).
- Same for `emitPendingQuestion(...)`.

**Verification:**
- Server typecheck passes.
- A manual or unit-test parse of `SseEmitter.formatSsePayload(id, event)` confirms the field serialization.

---

### U4. Store `expiresAt` in the client approval queue

**Goal:** Make the absolute expiry timestamp available to the rendering layer and preserve it across reconnects.

**Requirements:** R7, R8, R9

**Dependencies:** U1

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- Extend the local `PendingApproval` type with `expiresAt?: number`.
- Extend the local `PendingQuestion` type with `expiresAt?: number`.
- In the `pending_approval` handler, read `data.expiresAt` if it is a finite number and include it in the queued item.
- In the `pending_question` handler, read `data.expiresAt` if it is a finite number and include it in the queued item.
- The existing `approval_resolved` handler already removes the item from the queue (R8); no change needed there.

**Patterns to follow:**
- The store already guards incoming fields (e.g., `typeof data.requestId === 'string'`); validate `expiresAt` with `typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt)`.

**Test scenarios:**
- `pending_approval` event with `expiresAt: 1234567890` → queued item includes the same `expiresAt`.
- `pending_approval` event without `expiresAt` → queued item has no `expiresAt` field.
- `approval_resolved` removes the item and any client-side countdown stops.

**Verification:**
- Client typecheck passes.
- Store unit tests (if any) pass; otherwise verify via runtime inspection of `approvalQueue`.

---

### U5. Render a countdown in `ApprovalSurface`

**Goal:** Show the user how much time remains before the request is auto-denied.

**Requirements:** R7, R8, R9

**Dependencies:** U4

**Files:**
- Modify: `src/client/components/ApprovalSurface.tsx`
- Modify: `src/client/i18n/en/chat.json`
- Modify: `src/client/i18n/zh-CN/chat.json`

**Approach:**
- Extend the local `PendingApproval` and `PendingQuestion` types with `expiresAt?: number`.
- Add a small `Countdown` component (or inline hook) that:
  - Accepts `expiresAt?: number`.
  - If `expiresAt` is missing, renders nothing.
  - Otherwise computes `remaining = Math.max(0, expiresAt - Date.now())` each second with `setInterval`.
  - Formats remaining seconds (e.g., `0:05`, `1:23`) using `Math.ceil(remaining / 1000)`.
  - Stops the interval when the component unmounts or `approval_resolved` removes the panel.
- Place the countdown near the header (e.g., next to `positionLabel` or inside the action row), styled with `text-xs text-text-tertiary`.
- Add a new i18n key under `approval.timeout` for the label, e.g. `"Timeout in {{time}}"` or just render the formatted time with an accessible `aria-label` using the translation key.

**Patterns to follow:**
- Use `useEffect` with cleanup (`clearInterval`) to avoid leaking timers.
- Use `useTranslation('chat')` for the label, matching the existing component.
- Keep the countdown purely presentational; do not trigger local denial logic from the client.

**Test scenarios:**
- Pending item without `expiresAt` → no countdown shown.
- Pending item with `expiresAt` 30 seconds in the future → countdown starts at ~30 and decrements each second.
- Panel dismissed (item removed from queue) → interval is cleaned up.
- Reconnect with a stale `expiresAt` in the past → countdown shows `0:00` (or clamps to zero).

**Verification:**
- UI renders correctly for both approvals and questions.
- No memory leak warnings from React StrictMode regarding the interval.

---

### U6. Add server unit tests for timeout behavior

**Goal:** Lock in the timeout parsing, timer firing, and cleanup behavior.

**Requirements:** R1, R2, R3, R5, R6, R9

**Dependencies:** U2

**Files:**
- Modify: `src/server/services/session-runtime.test.ts`

**Approach:**
- Add a new `describe('session-runtime timeout handling')` block.
- Use the existing `createMockSdkClient()` and `createMockResponse()` helpers.
- For each test, open a runtime, manually invoke the internal `canUseTool` callback by retrieving it from `runtime['buildCanUseToolCallback']()` or by constructing a scenario that causes it to fire. If direct access is awkward, inject a pending record directly and assert on `resolve()` behavior and emitted events.
- Verify emitted events by attaching a bot event handler (`botEventHandler`) to capture `pending_approval` / `pending_question` / `approval_resolved` events and their `expiresAt` values.

**Test scenarios:**
- Parses valid timeout and emits `expiresAt` in the pending event.
- Ignores missing/invalid timeouts (no `expiresAt`, no timer).
- Fires timeout and resolves with the fixed deny message.
- User resolution before expiry cancels the timer.
- SDK abort before expiry cancels the timer.
- `close()` cancels timers and resolves dangling requests.
- `subscribe()` replay preserves `expiresAt`.

**Verification:**
- `npm test` (or the project's server test command) passes.

## System-Wide Impact

- **Unchanged invariants:**
  - Requests without a valid `timeout` continue to wait indefinitely.
  - The SDK `options.signal` abort path continues to work exactly as before; the timeout timer is an additional cleanup trigger.
  - Auto-approval modes (`auto`, `readonly`) bypass the pending flow entirely and are unaffected by timeout parsing.
- **API surface parity:** Both `pending_approval` and `pending_question` gain an optional `expiresAt` field. Older clients that ignore the field continue to work; they simply will not show a countdown.
- **SSE replay:** Reconnect replay now includes `expiresAt` for any pending timed request, which older clients will ignore.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Timer leaks if cleanup paths are missed | Store the timer on the pending record and clear it in `resolveApproval()`, the abort handler, and `close()`. Add tests for each path. |
| Client/server clock skew makes the countdown misleading | Document the assumption that clocks are reasonably in sync; the server remains authoritative for the actual denial. |
| Large `timeout` values overflow `setTimeout` max delay (~24.8 days) | The requirements say no cap; `setTimeout` clamps values above its max, which effectively limits the feature. Document this as a known Node.js limit or consider using a `setInterval` / scheduler fallback if timeouts longer than ~24 days are expected. |
| Duplicated type files drift | Add `expiresAt` to both `src/client/types/message.ts` and `src/server/types/message.ts` and verify with `diff`. |

## Sources & References

- Origin requirements: `docs/brainstorms/2026-06-17-pending-request-timeout-requirements.md`
- Related code: `src/server/services/session-runtime.ts`
- Related code: `src/server/services/sse-emitter.ts`
- Related code: `src/server/services/session-runtime.test.ts`
- Related code: `src/client/stores/chat-store.ts`
- Related code: `src/client/components/ApprovalSurface.tsx`
- Related code: `src/client/types/message.ts`
- Related code: `src/server/types/message.ts`
