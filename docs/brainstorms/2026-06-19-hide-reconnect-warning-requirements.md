---
date: 2026-06-19
topic: hide-reconnect-warning
---

## Summary

Stop emitting the reconnect missed-output warning unless the server can tell that streamed output was actually lost. When a client reconnects and the runtime cannot find the client's last event ID in the replay buffer, the warning should only appear if the buffer also contains events. If the buffer is empty, the reconnect should stay silent.

## Problem Frame

The runtime currently emits `Some output may have been missed due to reconnect.` whenever a reconnect's `lastEventId` is not found in the ring buffer, even when the buffer is empty. That produces false-positive warnings in the chat UI and in other consumers such as the WeCom bridge, alarming users without any actionable loss of output.

## Requirements

- R1. Emit the reconnect missed-output warning only when the client's `lastEventId` is absent from the ring buffer **and** the ring buffer contains at least one event.
- R2. When the ring buffer is empty, do not emit the missed-output warning during reconnect.
- R3. When the client's `lastEventId` is found in the ring buffer, replay subsequent events without emitting the missed-output warning.

## Key Decisions

- **Guard at emission instead of filtering in the UI.** Fixing the condition server-side removes false positives for every consumer (web UI, WeCom bridge, future surfaces) and keeps the warning meaningful when data was actually lost.
- **Silent empty-buffer reconnects are acceptable.** If the runtime has no buffered events, there is no resumable output to warn the user about.

## Scope Boundaries

- No change to the warning text or visual styling when it does fire.
- No new reconnect progress indicator or resume UI.
- No persistence or backfill beyond the existing in-memory ring buffer.

## Acceptance Examples

- AE1. **Covers R1.** A client reconnects with a `lastEventId` older than the oldest event still in the ring buffer, and the buffer is not empty. The missed-output warning is emitted and the buffered events are replayed.
- AE2. **Covers R2.** A client reconnects with a `lastEventId`, but the ring buffer is empty. No missed-output warning is emitted and no events are replayed.
- AE3. **Covers R3.** A client reconnects with a `lastEventId` that is still present in the ring buffer. Events after that ID are replayed and no missed-output warning is emitted.

## Sources / Research

- `src/server/services/session-runtime.ts:499` emits the warning inside `replayFrom` when `startIndex < 0`.
- `src/server/services/sse-emitter.ts:267` defines `emitErrorNote`, which sends an `error_note` event to all subscribers.
- `src/client/stores/chat-store.ts:1331` and `src/server/services/wecom-stream-reply.ts:167` render `error_note` to users.
