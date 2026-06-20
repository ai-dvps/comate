---
date: 2026-06-20
topic: live-context-usage
---

# Live, Server-Pushed Context Usage

## Summary

Replace the fetch-on-open `ContextUsagePanel` with a server-pushed `context_usage` SSE event emitted on streaming lifecycle boundaries. The client stores one `contextUsage` value per session, and `SessionTokenUsage` becomes the always-visible, accurate context-fill indicator.

## Problem Frame

The GUI currently has two context-usage surfaces that disagree after auto-compaction:

- `ContextUsagePanel` fetches `query.getContextUsage()` only when opened. During streaming it stays stale, and after compaction it may show the pre-compaction value until the user reopens it.
- `SessionTokenUsage` computes a "Context: X%" estimate from `sessionUsage.cumulativeInput`. After `compact_boundary` resets `sessionUsage` to zero, the status bar shows "Context: 0%" throughout the next streaming turn and only updates at the next `result` event.

Users see a misleadingly low context-fill number during streaming. The real source of truth is `query.getContextUsage()`, but it is not wired into the streaming lifecycle.

## Key Decisions

- **Server push over client polling.** The server calls `query.getContextUsage()` and emits a `context_usage` SSE event. This avoids client-side polling and keeps the HTTP connection count flat.
- **Lifecycle events, not every delta.** The event fires on `assistant_start`, `tool_result`, `assistant_done`, `result`, and `compact_boundary`. This covers the moments when context meaningfully changes without an SDK round-trip per `text_delta`.
- **One indicator instead of two.** Remove `ContextUsagePanel` and make `SessionTokenUsage` display the accurate percentage from `contextUsage`. The detailed category breakdown is deferred.

## Requirements

### Server-side emission

- R1. The server emits a new `context_usage` SSE event after each lifecycle event in the streaming path: `assistant_start`, `tool_result`, `assistant_done`, `result`, and `compact_boundary`.
- R2. The `context_usage` event payload includes at least `totalTokens`, `maxTokens`, `percentage`, and `categories`.
- R3. The server fetches the current value via `query.getContextUsage()` before emitting the event.
- R4. Emission must not block or reorder the existing SSE stream; context-usage fetches are asynchronous relative to the lifecycle event they follow.

### Client-side handling

- R5. The client stores the latest `contextUsage` per session and updates it on each `context_usage` event.
- R6. The client clears or overwrites stale `contextUsage` when `compact_boundary` arrives.
- R7. `SessionTokenUsage` renders the accurate `contextUsage.percentage` when available.
- R8. `SessionTokenUsage` falls back to the existing `sessionUsage.cumulativeInput` estimate when no `contextUsage` data exists for the session.
- R9. The client does not poll the context-usage REST endpoint.

### UI cleanup

- R10. Remove the `ContextUsagePanel` component and its status-bar trigger.
- R11. Update any imports, tests, and i18n keys that reference `ContextUsagePanel`.

## Key Flows

- F1. **Assistant turn with streaming**
  - **Trigger:** User sends a message.
  - **Steps:**
    1. Server emits `assistant_start`.
    2. Server fetches context usage and emits `context_usage`.
    3. Server streams `text_delta` / `tool_use_start` / `tool_input_delta` / `tool_use_done`.
    4. Server emits `assistant_done`.
    5. Server fetches context usage and emits `context_usage`.
    6. Server emits `result`.
    7. Server fetches context usage and emits `context_usage`.
  - **Outcome:** The status bar updates at each lifecycle boundary without polling.

- F2. **Auto-compaction mid-session**
  - **Trigger:** SDK compacts the conversation.
  - **Steps:**
    1. Server emits `compact_boundary`.
    2. Server fetches context usage and emits `context_usage` with the compacted window.
  - **Outcome:** The status bar shows the reduced, accurate percentage immediately after compaction.

## Acceptance Examples

- AE1. **After compaction.** Given a session with `contextUsage.percentage = 80%`, when `compact_boundary` arrives followed by `context_usage` with `percentage = 5%`, then `SessionTokenUsage` displays "Context: 5%".
- AE2. **During streaming.** Given an active streaming turn where the assistant generates a long reply, when `assistant_done` arrives followed by `context_usage` with a higher `totalTokens`, then `SessionTokenUsage` updates from the previous percentage to the new one without waiting for `result`.
- AE3. **Fallback.** Given a session with no runtime active and no `context_usage` event received, then `SessionTokenUsage` continues to derive the percentage from `sessionUsage.cumulativeInput`.

## Scope Boundaries

### Deferred for later

- Detailed category breakdown UI. The `context_usage` event still carries `categories`, but no panel renders them in v1.
- Client-side polling for context usage.
- Changes to `sessionUsage` accounting logic.
- Pushing `context_usage` on every `text_delta`.

### Outside this product's identity

- Exposing context usage as a public API or analytics metric.

## Dependencies / Assumptions

- `query.getContextUsage()` returns a reliable value while a streaming turn is active.
- Lifecycle events are sufficient proxies for meaningful context-window changes.
- The existing `sessionUsage` fallback remains acceptable for sessions without an active runtime.

## Sources / Research

- `docs/plans/2026-06-19-007-feat-claude-agent-sdk-0-3-183-upgrade-plan.md` — original context-usage panel plan.
- `src/server/services/session-runtime.ts` — runtime access to `query.getContextUsage()`.
- `src/server/services/sse-emitter.ts` — SSE event emission.
- `src/client/stores/chat-store.ts` — store handling of SSE events.
- `src/client/components/SessionTokenUsage.tsx` — status-bar context-fill display.
