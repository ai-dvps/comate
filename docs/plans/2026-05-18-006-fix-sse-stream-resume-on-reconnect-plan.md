---
title: Fix SSE stream resume on session switch and page refresh
type: fix
status: completed
date: 2026-05-18
---

# Fix SSE stream resume on session switch and page refresh

## Summary

When a user switches away from a streaming session and returns, or refreshes the page mid-stream, the in-progress assistant message is invisible. The root cause is two-fold: the client wipes local streaming state on session switch by reloading messages from the server (which only persists completed turns), and the server skips replay entirely for fresh connections with no `Last-Event-ID`.

## Problem Frame

### Symptom
- User sends a prompt, streaming begins
- User switches to another session, then switches back
- No new text appears until an approval request pops up
- After page refresh, the entire in-progress turn is missing

### Root Cause Analysis

**Client side — `loadMessages` overwrites streaming state:**

`ChatPanel.tsx:45-49` triggers `loadMessages` on every `activeSessionId` change. `chat-store.ts:loadMessages` replaces `state.messages[sessionId]` with the server response. The server-side `loadMessages` (`chat-service.ts:126-145`) loads from the SDK, which only persists **completed** messages. An in-progress streaming assistant message has not been persisted, so it is absent from the response. The local message state is overwritten, destroying the message skeleton that replayed `text_delta` events need to patch into.

When replayed `text_delta` events arrive, `updateAssistantPart` (`chat-store.ts:196`) does `msgs.findIndex((m) => m.id === messageId)` — the message no longer exists, so it returns `{}` (no-op). The chunks are silently dropped.

**Server side — no replay for fresh connections:**

`SessionRuntime.subscribe` (`session-runtime.ts:184-190`) only calls `replayFrom` when `lastEventId !== undefined`. On page refresh, the client has no `lastEventId` (module-level Map resets). The server sends `subscription_ack` and then only live events. The client misses everything that happened before the connect.

## Requirements

- **R1.** Switching away from and back to a streaming session must resume rendering without requiring page refresh.
- **R2.** Page refresh during an active stream must reconstruct the in-progress message from replayed events.
- **R3.** Completed messages loaded from the server must not be duplicated by replayed events.
- **R4.** The fix must not break normal message loading for draft sessions or fresh page loads.

## Scope Boundaries

- Does not change the SSE protocol or event vocabulary.
- Does not increase the ring buffer capacity.
- Does not add client-side persistence (localStorage) for `lastEventId`.
- Does not modify the SDK persistence model.

### Deferred to Follow-Up Work
- Client-side persistence of `lastEventId` across page refresh (would eliminate the need for server-side current-message replay in the refresh case).

## Key Technical Decisions

- **Track current message start by event ID rather than buffer index.** The ring buffer is a FIFO queue; indices shift on eviction. Tracking the string event ID of the most recent `assistant_start` allows `replayFrom` to find it (or fall back gracefully if evicted).
- **Skip `loadMessages` overwrite when local streaming is in progress.** Rather than merging server and local messages (which risks duplicates and ordering issues), `loadMessages` simply preserves local state if any message has `isStreaming: true`. The replayed events will continue populating that message.
- **Reuse existing `replayFrom` for fresh-connect replay.** Setting `currentMessageStartId` as the replay anchor leverages the existing fallback logic: if the start event was evicted from the ring buffer, all available events are replayed.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/ChatPanel.tsx` — `useEffect` at lines 45-49 triggers `loadMessages` on every `activeSessionId` change.
- `src/client/stores/chat-store.ts` — `loadMessages` at lines 988-1004 replaces `state.messages[sessionId]` unconditionally. `updateAssistantPart` at lines 196-212 requires the message to exist.
- `src/server/services/session-runtime.ts` — `subscribe` at lines 184-190 skips replay when `lastEventId` is undefined. `ringBuffer` and `replayFrom` at lines 243-260 handle replay logic. `SseEmitter` callback at lines 71-76 pushes all events to the buffer.
- `src/server/services/sse-emitter.ts` — `send` at lines 217-224 increments `eventIndex` and calls `onEvent` unconditionally, ensuring the ring buffer captures events even when no client is connected.

## Implementation Units

### U1. Track current message start ID in SessionRuntime

**Goal:** Know where the current in-progress assistant message began in the ring buffer so fresh clients can replay from that point.

**Requirements:** R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/server/services/session-runtime.ts`

**Approach:**
- Add `private currentMessageStartId?: string` to `SessionRuntime`.
- In the `SseEmitter` `onEvent` callback (constructor), inspect `event.type`:
  - If `assistant_start`, set `currentMessageStartId = String(id)`.
  - If `assistant_done` or `interrupted`, clear it (`undefined`).
- The ring buffer push and eviction logic remains unchanged.

**Patterns to follow:**
- Match the existing `ringBuffer` push/eviction pattern.
- Use `String(id)` to match the ring buffer's string ID format.

**Test scenarios:**
- **Happy path:** Message starts streaming → `currentMessageStartId` is set to the `assistant_start` event ID.
- **Edge case:** Message completes → `assistant_done` clears `currentMessageStartId`.
- **Edge case:** Turn is interrupted → `interrupted` clears `currentMessageStartId`.
- **Edge case:** Buffer overflows and evicts the `assistant_start` event → `currentMessageStartId` still holds the old ID; `replayFrom` will not find it and fall back to replaying all available events.

**Verification:**
- Add a temporary log in `subscribe` to verify `currentMessageStartId` is set/cleared at the right times.

---

### U2. Replay current message on fresh subscription

**Goal:** When a client connects with no `lastEventId` (page refresh), replay the current in-progress message from its start instead of sending nothing.

**Requirements:** R2, R3

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/session-runtime.ts`

**Approach:**
- In `subscribe`, after handling `lastEventId !== undefined`, add an `else if (this.currentMessageStartId !== undefined)` branch.
- Call `this.replayFrom(this.currentMessageStartId, res)`.
- This reuses the existing `replayFrom` method. If the start ID was evicted, `replayFrom` falls back to replaying all buffered events and emits the "some output may have been missed" note.

**Patterns to follow:**
- Reuse `replayFrom` — do not duplicate replay logic.

**Test scenarios:**
- **Happy path:** Fresh client connects mid-stream → receives `assistant_start` and all subsequent deltas, reconstructing the message.
- **Edge case:** Fresh client connects when no message is in progress → `currentMessageStartId` is undefined, no replay (same as before).
- **Edge case:** `currentMessageStartId` points to an evicted event → all available events replayed as fallback.
- **Integration:** Replayed `assistant_start` followed by live `text_delta` → client sees continuous stream.

**Verification:**
- Refresh the page during an active stream; the in-progress message should appear and continue updating.

---

### U3. Preserve local streaming state during message load

**Goal:** Prevent `loadMessages` from wiping the in-progress assistant message when switching back to a streaming session.

**Requirements:** R1, R4

**Dependencies:** None

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- In `loadMessages`, before replacing `state.messages[sessionId]`, check if the existing local messages contain any with `isStreaming === true`.
- If a streaming message exists, skip the overwrite and just set `isLoadingMessages: false`.
- If no streaming message exists (fresh load, completed stream), replace as before.

**Patterns to follow:**
- Match the existing Zustand `set` pattern.
- Do not introduce side effects — this is a pure state decision.

**Test scenarios:**
- **Happy path:** Switch back to a streaming session → local message preserved, replayed deltas continue appending text.
- **Edge case:** Switch back after stream completed → `isStreaming` is false, `loadMessages` overwrites normally.
- **Edge case:** Fresh page load → no local messages, `loadMessages` loads normally.
- **Edge case:** Draft session → `loadMessages` is skipped entirely by existing `!activeSession.isDraft` guard in `ChatPanel`.

**Verification:**
- Start a stream, switch away, switch back → text should resume immediately without requiring approval or stream end.

---

## System-Wide Impact

- **Interaction graph:** `ChatPanel` triggers `loadMessages` on session switch; `SessionRuntime.subscribe` handles replay; `SseEmitter.send` drives both live and buffered events.
- **Error propagation:** If `loadMessages` fails, the local streaming message is still preserved (we skip overwrite only on success).
- **State lifecycle risks:** Replayed `assistant_start` on fresh connect creates the message skeleton; subsequent replayed deltas populate it; live deltas continue. No duplicate risk because the client had no prior state.
- **API surface parity:** No new endpoints or protocol changes.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Replayed `assistant_start` on fresh connect could collide with `loadMessages` if the server already persisted the message (race on completion). | Low likelihood — `currentMessageStartId` is cleared on `assistant_done`. If the race occurs, the user sees a duplicate until next `loadMessages`. |
| `loadMessages` skipping overwrite might leave stale messages if the stream errors and never completes. | Acceptable — the user can reload the session or refresh. The `error_note` event would still arrive via SSE. |
| Ring buffer eviction loses the message start, causing full-buffer replay with potential old events. | Fallback is safe — client reconstructs from all available events. 500 events is large for typical sessions. |

## Sources & References

- `src/client/components/ChatPanel.tsx` — `loadMessages` trigger on session switch
- `src/client/stores/chat-store.ts` — `loadMessages` implementation, `updateAssistantPart`
- `src/server/services/session-runtime.ts` — `subscribe`, `replayFrom`, ring buffer
- `src/server/services/sse-emitter.ts` — `send`, event ID generation
