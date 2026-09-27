---
date: 2026-06-17
topic: pending-request-timeout
---

# Pending Tool Approval and AskUserQuestion Timeout

## Summary

Add timeout-aware auto-denial to pending tool approvals and `AskUserQuestion` requests. `SessionRuntime` parses a `timeout` field from the tool input, computes an absolute expiry, and resolves the request with a fixed denial message if the user does not respond in time. The client shows a countdown in the approval/question panel.

## Problem Frame

Today `SessionRuntime` waits indefinitely for user responses to tool approvals and `AskUserQuestion`. If the user steps away or misses the prompt, the agent stalls. Some SDK tools already expose a `timeout` field on their inputs; we need to honor it for interactive requests so the agent can recover gracefully.

## Key Decisions

- **Server-authoritative timer.** The server starts the timer and emits the expiry; the client only renders the countdown. This avoids races when the app is closed, backgrounded, or reconnecting.
- **Absolute expiry timestamp.** SSE events carry `expiresAt` rather than a relative `timeout`. Reconnects and panel re-renders then show the correct remaining time without extra client state.
- **Fixed denial message.** No per-request custom message is supported.
- **No maximum cap.** Any positive finite timeout value is honored. Missing or invalid values fall back to today's indefinite-wait behavior.

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

## Key Flows

- F1. **Timeout fires before user responds**
  - **Trigger:** Tool input includes `timeout: 30000`.
  - **Steps:**
    1. Server parses timeout, computes `expiresAt`, and emits `pending_approval` or `pending_question` with `expiresAt`.
    2. Client starts a countdown in the panel.
    3. User does not respond before `expiresAt`.
    4. Server timer fires and resolves the promise with `behavior: 'deny'` and the fixed timeout message.
    5. Server emits `approval_resolved`.
    6. Client removes the request from the panel.
  - **Outcome:** The model receives a tool result indicating the request timed out.

- F2. **User responds before timeout**
  - **Trigger:** Tool input includes `timeout: 30000`.
  - **Steps:**
    1. Server parses timeout, computes `expiresAt`, and emits the pending event.
    2. Client starts a countdown.
    3. User allows, denies, or answers the question before `expiresAt`.
    4. Server cancels the timer and resolves the promise with the user's response.
    5. Server emits `approval_resolved`.
    6. Client removes the request from the panel.
  - **Outcome:** Normal resolution occurs; the timeout has no effect.

- F3. **Client reconnects during a pending request**
  - **Trigger:** SSE reconnects while a timed request is still pending.
  - **Steps:**
    1. Server replays the pending event with the original `expiresAt`.
    2. Client computes remaining time from `expiresAt` and resumes the countdown.
  - **Outcome:** The countdown shows the correct remaining time, not the original duration.

## Acceptance Examples

- AE1. **Missing timeout.** Given an `AskUserQuestion` input with no `timeout` field, the server does not start a timer and the request waits indefinitely.
- AE2. **Invalid timeout.** Given a tool input with `timeout: "abc"`, the server treats it as no timeout and the request waits indefinitely.
- AE3. **Zero timeout.** Given a tool input with `timeout: 0`, the server treats it as no timeout and the request waits indefinitely.
- AE4. **Positive timeout expires.** Given a tool input with `timeout: 5000`, after 5 seconds with no response the server denies the request with the fixed message "Request timed out waiting for user response."
- AE5. **Client reconnect.** Given a request created 30 seconds ago with `timeout: 60000`, when the client reconnects the panel shows approximately 30 seconds remaining.

## Scope Boundaries

- **Deferred for later:** per-question timeouts inside a single `AskUserQuestion` call, custom timeout messages per request, and global or per-session default timeout settings.
- **Outside this product's identity:** auto-allow on timeout and client-only timeout enforcement.

## Dependencies / Assumptions

- Server and client clocks are reasonably in sync, or the client computes remaining time locally from the server-provided `expiresAt`.
- The SDK `canUseTool` callback's `options.signal` continues to be honored alongside the new timeout timer.

## Sources / Research

- `src/server/services/session-runtime.ts` — current pending approval and `AskUserQuestion` implementation.
- `src/client/stores/chat-store.ts` — client-side SSE handling and approval queue.
- `src/client/components/tool-renderers/renderers/AskUserQuestionRenderer.tsx` — question rendering component.
- `@anthropic-ai/claude-agent-sdk` type definitions — existing `timeout` fields on SDK tool inputs.
