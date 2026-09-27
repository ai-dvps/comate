---
date: 2026-05-28
topic: session-dom-caching
---

# Session DOM Caching for Instant Switching

## Summary

Eliminate the loading delay when switching between recently-viewed chat sessions by keeping both message data and rendered DOM alive. Skip redundant message fetches when the client already has a session's messages in store, and maintain a small LRU DOM cache so the most recent sessions switch instantly without remounting.

---

## Problem Frame

Today, every time a user selects a session the app calls `loadMessages`, which reads the full message history from the server via the SDK's JSONL transcript. For sessions with many messages this causes a multi-second pause before the conversation appears. The `MessageList` component also remounts on every switch because it is keyed to `activeSessionId`, so even if the data were instant the DOM reconstruction adds perceptible lag. The result feels unlike a desktop app where switching tabs is immediate.

The client already retains session messages indefinitely in the Zustand store — `clearMessages` exists but is never invoked. The reload is purely a defensive "ensure freshness" choice, not a technical necessity. Messages are only added via the live SSE stream while subscribed, and the server runtime's replay buffer catches up reconnecting clients. This means the client can safely reuse what it already has for sessions it has previously viewed.

---

## Requirements

**Message data caching**
- R1. When switching to a session that already has messages in the client store, skip the `loadMessages` API call. Render directly from cached data.
- R2. On first visit to a session (no cached messages), load messages normally via the existing `loadMessages` flow.
- R3. When reconnecting to a cached session, start the SSE subscription and allow the runtime's replay buffer to deliver any missed events. Append those events to the cached message list.

**DOM retention**
- R4. Maintain a per-workspace LRU DOM cache of the most recently viewed sessions. The default cache size is 3–5 sessions.
- R5. Render a `MessageList` for each cached session even when inactive, hiding inactive sessions with CSS (`display: none` or equivalent) rather than unmounting them.
- R6. When the active session changes to a session already in the DOM cache, make it visible immediately without remounting.
- R7. When the cache exceeds its size limit, unmount the least-recently-viewed session's `MessageList` to free DOM and React tree memory.
- R8. When a session is evicted from the DOM cache and later revisited, mount a fresh `MessageList` and render from the data cache (still skipping `loadMessages` per R1).

**Subscription behavior**
- R9. Only the active session maintains an open SSE subscription. When switching away, close the previous session's subscription as today.
- R10. When switching to a session (whether from DOM cache or fresh), open a new SSE subscription. The runtime replays missed events from its ring buffer.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R4.** Given the user has previously viewed Session A and its messages are in the store, when the user switches from Session B back to Session A, no `/messages` API request is made, no loading spinner appears, and Session A's conversation is visible within ~100 ms.

- AE2. **Covers R4, R5, R6, R7.** Given the DOM cache limit is 3 and the user has viewed Sessions A, B, and C in that order, when the user switches to Session D, Session A's `MessageList` is unmounted. Sessions B, C, and D remain rendered in the DOM with only Session D visible.

- AE3. **Covers R3, R9, R10.** Given the user is actively subscribed to Session A and 10 new SSE events arrive, when the user switches to Session B and back to Session A, the 10 events are replayed from the runtime's ring buffer and appended to Session A's cached message list without triggering a full reload.

---

## Success Criteria

- Switching between sessions that are in the DOM cache is perceived as instant (no loading spinner, no perceptible render delay).
- The browser's Network tab shows no `/messages` API calls when revisiting a session that already has cached data.
- Memory usage remains bounded: the number of mounted `MessageList` instances never exceeds the configured cache limit + 1 (the active session).

---

## Scope Boundaries

- Server-side caching of SDK transcript reads or message normalization — this is a client-side-only change.
- Background polling or keeping SSE subscriptions alive for hidden sessions — hidden sessions rely on replay on reactivation.
- Persisting the cache across browser restarts (e.g., localStorage, IndexedDB) — the cache lives only in the current page session.
- Replacing or redesigning the message virtualization strategy — `VirtualizedMessageList` continues to work as-is.
- Memory-size-based eviction heuristics — eviction is strictly count-based because browsers cannot reliably measure DOM memory.

---

## Key Decisions

- **Client-side only, no server changes:** The server already retains runtimes with replay buffers and exposes the message API. The fix is entirely in how the client manages its existing state.
- **Count-based LRU for DOM cache:** Browsers lack an API to measure DOM tree memory. A fixed session-count limit (3–5) is the practical proxy.
- **SSE only for active session:** Keeping subscriptions open for hidden sessions would increase server load and runtime lifetime. The replay buffer is sufficient for catch-up during normal session switching.

---

## Dependencies / Assumptions

- Messages are only appended via SSE while the client is subscribed, or via replay on reconnect. There are no background processes that mutate the transcript without emitting events.
- `react-virtual` correctly recalculates measurements when a hidden virtualized list becomes visible again.
- The Zustand store's `messages` state is never cleared during normal use (confirmed: `clearMessages` is exported but never called in the current codebase).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Technical] What is the exact default cache limit — 3, 5, or should it be user-configurable?
- [Affects R5][Technical] Should the DOM cache be managed inside `chat-store.ts` or in a dedicated hook/component layer?
- [Affects R1][Technical] Should `loadMessages` be skipped unconditionally when data exists, or should there be a lightweight staleness signal (e.g., server nonce mismatch, explicit user refresh action)?
