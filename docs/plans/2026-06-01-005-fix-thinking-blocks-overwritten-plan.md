# fix: Prevent thinking blocks from being overwritten when includePartialMessages is disabled

**Type:** fix
**Created:** 2026-06-01
**Status:** active

---

## Problem Frame

When `includePartialMessages` is disabled, the SDK emits the assistant's response as multiple whole-turn `assistant` messages — one per phase (thinking, text, tool_use). Each phase's `content` array only contains that phase's blocks, and they always start at index 0.

The `SseEmitter.handleAssistant` method passes these local indices directly to `emitDedupRecovery`, which sends `partIndex: 0` for every block. On the client, `updateAssistantPart` simply assigns `parts[partIndex] = newPart`, so each new phase overwrites the previous part at index 0. The thinking block appears briefly, then disappears when the text block arrives, and the text block disappears when the tool_use block arrives.

## Scope

**In scope:**
- Fix `SseEmitter` to emit monotonically increasing `partIndex` values for non-streamed blocks across multiple `assistant` message phases.

**Out of scope:**
- Re-enabling `includePartialMessages`
- Changes to client-side rendering or state management
- Changes to the streaming path (which already receives correct cumulative indices from `content_block_start` events)

---

## Key Technical Decision

**Use a `nextPartIndex` counter in `SseEmitter`.**

When the streaming path is active, `content_block_start` events carry the correct cumulative index from the Anthropic API, so the existing behavior is correct. When streaming is disabled, no `content_block_start` events arrive, and `seenStreamPartIndexes` remains empty. In this case, `handleAssistant`'s fallback path (`emitDedupRecovery`) should use a class-level `nextPartIndex` counter that increments across `assistant` message phases, ensuring each block gets a unique index.

The counter is reset when a new assistant message begins (detected by `messageId` change in `handleAssistant`, or `message_start` stream event when streaming).

---

## Implementation Units

### U1. Add cumulative partIndex tracking to SseEmitter

**Goal:** Ensure non-streamed blocks receive unique, monotonically increasing `partIndex` values across multiple `assistant` message phases.

**Files:**
- `src/server/services/sse-emitter.ts`

**Approach:**
1. Add `private nextPartIndex = 0` to the `SseEmitter` class state.
2. Reset `nextPartIndex` to 0 in the `reset()` method.
3. Reset `nextPartIndex` to 0 in the `message_start` stream event handler (when a new streaming message begins).
4. Reset `nextPartIndex` to 0 in `handleAssistant` when `messageId` changes (when a new non-streaming message begins).
5. In `handleAssistant`'s `content.forEach` loop, for blocks that were NOT seen during streaming (`!this.seenStreamPartIndexes.has(index)`), pass `this.nextPartIndex++` to `emitDedupRecovery` instead of the local `index`.
6. For blocks that WERE seen during streaming, continue using the original `index` (to align with `blockStates` and `seenStreamPartIndexes`).

**Patterns to follow:**
- The existing `seenStreamPartIndexes` / `blockStates` dedup logic for the streaming path must remain untouched.

**Test scenarios:**
- **Happy path (non-streaming, multi-phase):** Simulate an SDK message sequence: `assistant` with thinking at index 0, then `assistant` with text at index 0, then `assistant` with tool_use at index 0. Verify the emitted SSE events carry `partIndex` 0, 1, and 2 respectively.
- **Happy path (streaming + finalizer):** Simulate `content_block_start` for thinking at index 0, `content_block_start` for text at index 1, then `assistant` finalizer. Verify `emitDedupRecovery` is not called (both indices are in `seenStreamPartIndexes`) and `closeStreamedBlock` uses the original indices.
- **Edge case (empty content):** `assistant` message with empty or non-array `content` should not increment `nextPartIndex`.
- **Edge case (mixed streaming and non-streaming):** If a block type arrives only via `assistant` (not streamed), it should use `nextPartIndex` while streamed blocks use their original index. Verify no index collision occurs.

**Verification:**
- Unit test or manual verification: send a chat request with extended thinking enabled and `includePartialMessages: false`. Observe the SSE stream via browser DevTools or `curl -N`. Confirm `thinking_start` has `partIndex: 0`, the subsequent `text_delta` has `partIndex: 1`, and any `tool_use_start` has `partIndex: 2`. Confirm all three blocks remain visible in the UI.

---

## Deferred to Follow-Up Work

- Batching/throttling deltas if CPU usage from frequent state updates remains a concern after this fix.

---

## Risks

| Risk | Mitigation |
|------|-----------|
| `nextPartIndex` drifts out of sync with `seenStreamPartIndexes` in edge cases | Only use `nextPartIndex` for blocks NOT in `seenStreamPartIndexes`; streamed blocks always use their original API-provided index. |
| `assistant` finalizer arrives before all `content_block_stop` events | The existing `closeStreamedBlock` / `seenStreamPartIndexes` logic handles this; `nextPartIndex` is only used for the fallback path. |
