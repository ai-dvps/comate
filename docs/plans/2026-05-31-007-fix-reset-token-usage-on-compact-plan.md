---
title: Reset session token usage when compaction completes
type: fix
status: active
date: 2026-05-31
---

# Reset Session Token Usage When Compaction Completes

## Summary

When the server compacts a conversation, the GUI currently continues displaying the pre-compaction cumulative token totals. The `sessionUsage` accumulator is never reset, so the context-fill percentage can approach or exceed 100% even though the actual context window has been reduced. Reset `sessionUsage` and `lastTurnUsage` when the `compact_boundary` SSE event arrives.

## Problem Frame

The chat store accumulates `sessionUsage` monotonically from each `result` event. Compaction reduces the server's actual context consumption, but the client-side accumulator is unaware of this. Users see stale, inflated token counts and a misleadingly high context-fill percentage.

## Requirements

- R1. When `compact_boundary` is received for a session, reset `sessionUsage[sessionId]` to zero-valued counters.
- R2. When `compact_boundary` is received for a session, clear `lastTurnUsage[sessionId]`.

## Scope Boundaries

- No changes to the compaction logic on the server.
- No changes to the `SessionTokenUsage` display component.
- No new visual indicators or messages beyond the existing "Conversation compacted" system message.

## Context & Research

### Relevant Code and Patterns

- `src/client/stores/chat-store.ts` — `compact_boundary` handler (lines 1066–1091) currently only adds a system message and resets `isCompacting` / `compactingStartTime`.
- `src/client/stores/chat-store.ts` — `result` event handler (lines 1286–1343) accumulates tokens into `sessionUsage` and `lastTurnUsage`.
- `src/client/components/SessionTokenUsage.tsx` — reads `sessionUsage[sessionId]` directly; no store changes needed here.

## Key Technical Decisions

- **Zero-valued reset vs. key deletion:** Reset `sessionUsage[sessionId]` to `{ cumulativeInput: 0, cumulativeOutput: 0, cumulativeCacheRead: 0, cumulativeCacheWrite: 0 }` so the status bar shows `in 0 / out 0` and `context: 0%` rather than the missing-data dash (`—`). This gives the user clear feedback that the counter has been refreshed.
- **Also clear `lastTurnUsage`:** Deleting `lastTurnUsage[sessionId]` prevents a stale single-turn snapshot from lingering after compaction.

## Implementation Units

### U1. Reset session usage on compact_boundary

**Goal:** Reset accumulated token usage when compaction completes.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- In the `compact_boundary` event handler, add `sessionUsage` and `lastTurnUsage` resets to both return branches.
- For `sessionUsage`: set `[sessionId]: { cumulativeInput: 0, cumulativeOutput: 0, cumulativeCacheRead: 0, cumulativeCacheWrite: 0 }`.
- For `lastTurnUsage`: delete the `sessionId` key (or set to `undefined`).

**Test scenarios:**
- Test expectation: none — no component test infrastructure exists.

**Verification:**
- After compaction, the status bar shows `in 0 / out 0` and `context: 0%`.
- Subsequent turns after compaction resume accumulating from zero.

## System-Wide Impact

- Only the `compact_boundary` handler in `chat-store.ts` changes.
- `SessionTokenUsage` and any future consumers of `sessionUsage` automatically reflect the reset.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Reset happens before the compacting result event that carries the final pre-compaction usage | The `result` event handler already gates on `isCompacting` and resets compaction flags; in practice the boundary arrives after the last result, so this ordering is safe. |

## Sources & References

- Related code: `src/client/stores/chat-store.ts`
