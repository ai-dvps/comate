---
title: Provider Switch Runtime Restart
type: feat
status: active
date: 2026-05-31
origin: docs/brainstorms/2026-05-31-provider-switch-restart-requirements.md
---

# Provider Switch Runtime Restart

## Summary

Close and recreate the session runtime when the user changes providers mid-session, so the new provider takes effect immediately. During the restart, block the prompt input and show a transient spinner beside the provider selector.

## Problem Frame

Provider credentials are baked into `SessionRuntime` at creation time via `buildSdkOptions()`. Because `getOrCreateRuntime()` returns a cached runtime, changing the provider in the UI only updates the DB record — subsequent messages still use the old provider until the session tab is closed and reopened.

## Requirements

- R1. When `updateSession` receives a `providerId` change and an active runtime exists, close the existing runtime before returning.
- R2. The next `getOrCreateRuntime()` call creates a fresh runtime with the new provider.
- R3. Client tracks a per-session `isRestartingRuntime` boolean.
- R4. While restarting, prompt input is disabled (same treatment as streaming).
- R5. While restarting, `ProviderSelector` shows a transient loading indicator.
- R6. Restart state clears when SSE successfully reconnects.
- R7. No restart is attempted for draft sessions without an active runtime.
- R8. Provider changes while streaming remain blocked by existing guard.

## Scope Boundaries

- No persistence of pending tool approvals across restart.
- No re-sending of in-flight messages.
- No model discovery re-trigger after provider change.
- No provider switch confirmation dialog.

## Context & Research

### Relevant Code and Patterns

- `src/server/services/chat-service.ts` — `updateSession()`, `getRuntimeIfExists()`, `closeRuntime()`, `buildSdkOptions()`
- `src/server/routes/chat.ts` — `PUT /sessions/:sessionId` route handler
- `src/client/stores/chat-store.ts` — `setSessionProvider()`, SSE subscription logic, session state
- `src/client/components/PromptInput.tsx` — renders `ProviderSelector`, owns input disabled state
- `src/client/components/ProviderSelector.tsx` — provider dropdown, already reads from `useChatStore`

### Institutional Learnings

- `SessionRuntime.close()` is async and handles cleanup (`input.close()`, `query.interrupt()`, `unsubscribe()`).
- `getOrCreateRuntime()` has a `creatingRuntimes` pending promise map to prevent duplicate creation.
- The SSE retry loop in `chat-store.ts` already handles disconnect → reconnect after server-side close.

## Key Technical Decisions

- **Close runtime inside `updateSession`**, not via a separate endpoint. The server detects the provider change and closes the runtime synchronously with the DB update. This avoids race conditions and keeps the client flow as a single PUT call.
- **Client infers restart completion from SSE reconnect**, not from a dedicated server event. The existing retry loop naturally reconnects when the old runtime closes. `isRestartingRuntime` is set when PUT succeeds and cleared in the SSE `onopen` handler.

## Open Questions

### Deferred to Implementation

- Whether to clear `isRestartingRuntime` in `EventSource.onopen` or on the first `assistant_start` event. `onopen` is earlier but may fire before the runtime is fully ready. Prefer `onopen` for responsiveness; fall back to `assistant_start` if flakiness surfaces.

## Implementation Units

### U1. Backend: Close Runtime on Provider Change

**Goal:** Detect a provider change in `updateSession` and close the existing runtime so the next message creates a fresh one.

**Requirements:** R1, R2, R7, R8

**Dependencies:** None

**Files:**
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/server/routes/chat.ts`

**Approach:**
1. In `ChatService.updateSession()`, after persisting the DB change, check if `input.providerId` is defined and the session has an active runtime (`getRuntimeIfExists`).
2. If both are true, call `this.closeRuntime(id)` before returning.
3. In `chat.ts` route handler, the existing `updateSession` call needs no change — the close happens inside the service.

**Patterns to follow:**
- Existing `closeRuntime()` and `getRuntimeIfExists()` patterns in `chat-service.ts`

**Test scenarios:**
- Happy path: Active session with Provider A → update provider to B → runtime closes → next message creates new runtime with B
- Edge case: Draft session with no runtime → update provider → no close attempted
- Edge case: Session with no provider change (name-only update) → no close attempted

**Verification:**
- After changing provider in UI, the old runtime's `messageLoopPromise` resolves (closed)
- Next `getOrCreateRuntime()` for the same session constructs a new `SessionRuntime`

---

### U2. Client: Track and Display Restart State

**Goal:** Disable input and show a spinner during the provider switch restart.

**Requirements:** R3, R4, R5, R6

**Dependencies:** U1

**Files:**
- Modify: `src/client/stores/chat-store.ts`
- Modify: `src/client/components/ProviderSelector.tsx`
- Modify: `src/client/components/PromptInput.tsx`

**Approach:**
1. **Chat store:** Add `isRestartingRuntime: Record<string, boolean>` to store state. In `setSessionProvider`, after PUT succeeds, set `isRestartingRuntime[sessionId] = true`. In the SSE `EventSource.onopen` handler, set it back to `false`.
2. **ProviderSelector:** Read `isRestartingRuntime` from store for the current session. When true, render a small `Loader2` spinner beside the provider name instead of the chevron.
3. **PromptInput:** Read `isRestartingRuntime` from store. Include it in the `canSend` and `commandsDisabled` checks so the input and toolbar buttons are disabled during restart.

**Patterns to follow:**
- `isStreaming` state pattern in `chat-store.ts` (map by sessionId)
- `Loader2` icon already imported in `PromptInput.tsx`
- ProviderSelector already reads session and providers from store

**Test scenarios:**
- Happy path: Select new provider → input disables → spinner appears → SSE reconnects → input re-enables → spinner disappears
- Edge case: Provider PUT fails → `isRestartingRuntime` is never set (optimistic update is reverted by existing logic)
- Edge case: SSE reconnect fails after timeout → `isRestartingRuntime` stays true until successful reconnect or user switches sessions

**Verification:**
- UI matches the behavior: input disabled + spinner during restart, normal state after reconnect
- No flicker: the spinner replaces the chevron seamlessly

---

## System-Wide Impact

- **Interaction graph:** `updateSession` now has a side effect (closing the runtime). Callers of `updateSession` (only the PUT route) are unaffected because the close is asynchronous and non-blocking from the route's perspective.
- **Error propagation:** If `closeRuntime()` throws, it is caught and logged; the DB update has already succeeded. The user sees the provider change but may need to retry the switch if the close failed.
- **State lifecycle risks:** The `creatingRuntimes` map in `ChatService` prevents duplicate runtime creation if a message is sent while the close is in progress. This is the same safety mechanism that exists today.
- **API surface parity:** The `PUT /sessions/:sessionId` route behavior changes for active sessions — response is still the updated session, but the runtime is now closed. API contract is unchanged.
- **Unchanged invariants:** `getOrCreateRuntime()` behavior is unchanged except that it now creates a new runtime when the old one was closed. `buildSdkOptions()` is not modified. SSE event types are not modified.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Close Runtime races with an in-flight message | `ProviderSelector` already disabled during `isStreaming`; close only fires after PUT, which happens after dropdown selection |
| SSE reconnect takes long, leaving user stuck in restart state | Existing SSE retry logic (exponential backoff, max 5 attempts) applies; worst case user sees "Connection lost" message |
| `closeRuntime` throws and leaves runtime in partial state | `closeRuntime()` catches errors internally; `runtimes.delete()` still runs |

## Documentation / Operational Notes

- No operational monitoring required — this is a UI behavior change with no infrastructure impact.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-31-provider-switch-restart-requirements.md](docs/brainstorms/2026-05-31-provider-switch-restart-requirements.md)
- Related code: `src/server/services/chat-service.ts` `updateSession`, `closeRuntime`, `getRuntimeIfExists`
- Related PR: #30 (provider propagation via flag settings)
