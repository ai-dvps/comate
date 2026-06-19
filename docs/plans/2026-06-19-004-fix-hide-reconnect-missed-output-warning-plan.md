---
title: Guard reconnect missed-output warning against false positives
type: fix
date: 2026-06-19
origin: docs/brainstorms/2026-06-19-hide-reconnect-warning-requirements.md
---

# Guard reconnect missed-output warning against false positives

## Summary

Change `SessionRuntime.replayFrom` so it emits the "Some output may have been missed due to reconnect." warning only when the client's last event ID is missing from the ring buffer and the buffer actually contains events. When the buffer is empty, the reconnect stays silent.

## Problem Frame

`replayFrom` currently emits the missed-output warning on every reconnect where the anchor event ID is not found in the ring buffer, including when the buffer is empty. That produces false-positive `error_note` events in the chat UI and the WeCom bridge. Because reconnects are now expected after clean closes, the warning degrades trust and adds noise when there is nothing to miss.

## Requirements

- R1. Emit the reconnect missed-output warning only when the client's `lastEventId` is absent from the ring buffer and the ring buffer is non-empty.
- R2. Do not emit the missed-output warning when the ring buffer is empty.
- R3. When the client's `lastEventId` is found in the ring buffer, replay subsequent events without emitting the warning.

## Key Technical Decisions

- **Guard at warning emission, not at call sites.** Both `subscribe` paths (`lastEventId` and `currentMessageStartId`) continue to call `replayFrom` unconditionally. Only the `emitErrorNote` call inside `replayFrom` is gated. This keeps the replay behavior identical and avoids duplicating the guard.
- **Use `ringBuffer.length > 0` as the gate.** A non-empty ring buffer means there is real output that could have been missed. Heartbeats bypass the ring buffer, so they cannot falsely trigger the warning.
- **Keep the warning text unchanged.** When the warning does fire, the existing copy and `error_note` event type remain the same.

## Implementation Units

### U1. Gate the missed-output warning on non-empty ring buffer

**Goal:** Remove false-positive reconnect warnings while preserving real loss-of-output signals.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/server/services/session-runtime.ts`
- Modify: `src/server/services/session-runtime.test.ts`

**Approach:**
- In `replayFrom`, wrap the `emitErrorNote` call in a check for `this.ringBuffer.length > 0`.
- Leave the replay loops unchanged.

**Patterns to follow:**
- The existing `session-runtime.test.ts` uses `node:test`, `node:assert`, `SessionRuntime.open`, `createMockSdkClient`, and `createMockResponse`.
- Capture events through the `botEventHandler` callback passed to `SessionRuntime.open`.

**Test scenarios:**
- **Covers AE2.** Empty ring buffer, reconnect with a `lastEventId`: subscribe with an arbitrary event ID on a fresh runtime and assert no `error_note` event is captured.
- **Covers AE1.** Non-empty ring buffer, stale `lastEventId`: push a few events through `SseEmitter`, then subscribe with an ID older than the buffered events and assert the missed-output `error_note` is captured and the buffered events are replayed.
- **Covers AE3.** `lastEventId` found in ring buffer: push multiple events, subscribe with the ID of the first buffered event, and assert no `error_note` is captured and only events after that ID are replayed.
- **Edge case.** Fresh subscribe with no `lastEventId` but `currentMessageStartId` set while the buffer is empty: assert no `error_note` is captured.

**Verification:**
- Run the server test file: `node --test src/server/services/session-runtime.test.ts`
- Run lint: `npm run lint`
- Run type check/build: `npm run build:server`

## Scope Boundaries

- No change to the warning text or visual styling when it does fire.
- No new reconnect progress indicator or resume UI.
- No persistence or backfill beyond the existing in-memory ring buffer.

## Acceptance Examples

- AE1. **Covers R1.** A client reconnects with a `lastEventId` older than the oldest event still in the ring buffer, and the buffer is not empty. The missed-output warning is emitted and the buffered events are replayed.
- AE2. **Covers R2.** A client reconnects with a `lastEventId`, but the ring buffer is empty. No missed-output warning is emitted and no events are replayed.
- AE3. **Covers R3.** A client reconnects with a `lastEventId` that is still present in the ring buffer. Events after that ID are replayed and no missed-output warning is emitted.

## Risks & Dependencies

- **Risk:** If a client reconnects with a stale `lastEventId` and the buffer is empty because the runtime was recently restarted, no warning is shown. This is accepted per the origin requirements — the server has no buffered output to miss.
- **Dependency:** None beyond the existing `SessionRuntime` replay logic.

## Sources & Research

- `docs/brainstorms/2026-06-19-hide-reconnect-warning-requirements.md` — origin requirements and acceptance examples.
- `src/server/services/session-runtime.ts:490-501` — `replayFrom` and the current warning emission.
- `src/server/services/session-runtime.test.ts` — existing test patterns for `SessionRuntime`.
- `docs/solutions/integration-issues/sse-stream-resume-on-reconnect-2026-05-18.md` — prior learning that introduced `replayFrom` and the missed-output warning.
- `docs/solutions/integration-issues/sse-heartbeat-read-timeout-recovery-2026-05-24.md` — heartbeats do not enter the ring buffer, so a length check is safe.
