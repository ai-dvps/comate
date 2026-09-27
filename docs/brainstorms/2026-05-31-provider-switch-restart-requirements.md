---
date: 2026-05-31
topic: provider-switch-restart
---

# Provider Switch Runtime Restart

## Summary

When a user changes the LLM provider for an active session, automatically close and recreate the session's runtime so the new provider takes effect immediately. During the restart, block message sending and show a transient indicator beside the provider selector.

---

## Problem Frame

Currently, selecting a different provider in an active session only updates the session record in the database. The existing `SessionRuntime` was created with the old provider's credentials and is cached in `ChatService.runtimes`. Because `getOrCreateRuntime()` returns the cached runtime, subsequent messages continue using the old provider. Users must close and reopen the session tab to actually switch providers, which is non-obvious and breaks the mental model of "I just changed the provider."

---

## Key Flows

- F1. **Provider switch during active session**
  - **Trigger:** User selects a different provider from the `ProviderSelector` dropdown
  - **Actors:** End user
  - **Steps:**
    1. Client sends PUT `/api/workspaces/:id/sessions/:sessionId` with new `providerId`
    2. Server persists the new `providerId` to the session record
    3. Server detects that a runtime exists for this session and that the provider has changed
    4. Server closes the existing runtime and creates a new one with the new provider's credentials
    5. Client's SSE connection drops; client enters restart-waiting state
    6. Client reconnects SSE to the new runtime
    7. Client exits restart-waiting state and allows sending again
  - **Outcome:** The next message sent uses the newly selected provider
  - **Covered by:** R1, R2, R3, R4, R5

---

## Requirements

**Backend runtime restart**
- R1. When `updateSession` receives a `providerId` change and an active runtime exists for that session, close the existing runtime before returning.
- R2. The next `getOrCreateRuntime()` call for that session must create a fresh runtime using the new provider credentials via `buildSdkOptions()`.
- R3. Pending tool approvals in the old runtime are discarded on close; this is acceptable because the user explicitly initiated a provider switch.

**Client restart state**
- R4. The client must track a per-session `isRestartingRuntime` boolean state.
- R5. While `isRestartingRuntime` is true for the active session, the prompt input must be disabled (same visual treatment as `isStreaming`).
- R6. While `isRestartingRuntime` is true, the `ProviderSelector` must display a transient loading indicator (e.g., a small spinner) beside the provider name.
- R7. `isRestartingRuntime` transitions to false when the SSE subscription successfully reconnects after the restart.

**Edge cases**
- R8. If the session is not active (no runtime exists), only the provider record is updated — no restart state is entered.
- R9. Provider changes while streaming are already blocked by the existing `disabled={isStreaming}` guard on `ProviderSelector`.
- R10. If the runtime fails to recreate after close, surface the error to the user via the existing SSE error-note mechanism.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R4, R5, R6, R7.** Given an active session using Provider A, when the user selects Provider B from the dropdown, the prompt input disables, a spinner appears beside the provider name, the old runtime closes, a new runtime starts with Provider B, the SSE reconnects, the spinner disappears, and the input re-enables.
- AE2. **Covers R8.** Given a draft session with no active runtime, when the user selects Provider B, the dropdown updates immediately with no loading state and no restart is attempted.
- AE3. **Covers R9.** Given an active session that is currently streaming, when the user tries to open the provider dropdown, it is disabled and no provider change can occur until streaming stops.

---

## Success Criteria

- A user can switch providers mid-session without manually closing and reopening the session tab.
- The restart feels instantaneous (<2s visible delay) for local providers.
- The UI clearly communicates that something is happening during the switch so the user does not think the app is frozen.

---

## Scope Boundaries

- No persistence of pending tool approvals across the restart.
- No re-sending of in-flight messages after restart.
- No automatic re-triggering of model discovery after provider change.
- No provider switch confirmation dialog — the switch is immediate.

---

## Key Decisions

- **Server-side detection over explicit restart endpoint:** The server detects the provider change inside `updateSession` and initiates the close. This keeps the client flow simple (one PUT call) and avoids race conditions between DB update and runtime state.
- **Client infers restart from SSE disconnect, not from a dedicated event:** The client already handles SSE reconnect on close. Adding a dedicated `runtime_restarting` event is unnecessary because the disconnect + reconnect pattern naturally signals the restart. `isRestartingRuntime` is set when the PUT succeeds and cleared when the SSE reconnects.

---

## Dependencies / Assumptions

- Assumes `ChatService.closeRuntime()` and `ChatService.getOrCreateRuntime()` are idempotent and safe to call in sequence.
- Assumes the SSE reconnect logic in `chat-store.ts` handles a clean runtime close correctly (it already does for idle timeout and server restart).
