---
date: 2026-05-28
status: active
---

# feat: Session DOM Caching for Instant Switching

## Summary

Eliminate perceptible lag when switching between recently-viewed chat sessions by keeping both message data and rendered DOM alive. Skip redundant `loadMessages` API calls when a session's messages already exist in the Zustand store, and maintain a small LRU DOM cache (last 3–5 sessions) within the active workspace so switching is instant.

---

## Problem Frame

Today, every session switch triggers a full `loadMessages` fetch from the server SDK transcript, which can take multiple seconds for long conversations. The `MessageList` component also remounts on every switch because `ChatPanel` keys it to `activeSessionId`, adding DOM reconstruction overhead. The result feels slow and unlike a desktop app.

The client already retains session messages indefinitely in Zustand (`clearMessages` exists but is never invoked). Within a workspace, only the active session maintains an SSE subscription; when switching back, the server runtime's replay buffer catches up missed events. This means the client can safely render from cache and only needs to reconnect to SSE.

---

## Requirements Traceability

This plan implements the requirements from `docs/brainstorms/session-dom-caching-requirements.md`:

- R1, R2, R3 — Message data caching and SSE catch-up
- R4, R5, R6, R7, R8 — DOM retention and LRU eviction
- R9, R10 — Subscription behavior

---

## Key Technical Decisions

- **Client-side only.** No server changes. The server already exposes the message API and runtime replay buffer.
- **Skip `loadMessages` when cached.** If `state.messages[sessionId]` exists and is non-empty, the API call is skipped. Rely on SSE replay for catch-up.
- **DOM cache is count-based LRU.** Browsers cannot measure DOM memory. Keep the last 3 recently-viewed sessions rendered but hidden; evict the oldest when adding a fourth.
- **Per-active-workspace only.** Background workspaces already stay mounted at the `App` level. Session DOM caching applies only within the currently visible workspace to avoid compounding memory usage.
- **Remove `key={activeSessionId}` from `MessageList`.** React's `key` forces remount, which defeats DOM caching. `MessageList` and `VirtualizedMessageList` already receive `sessionId` as a prop and derive all data from the store.

---

## Implementation Units

### U1. Skip redundant message loading

**Goal:** Eliminate the API delay on session revisits by skipping `loadMessages` when the store already holds messages.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- `src/client/stores/chat-store.ts`
- `src/client/components/ChatPanel.tsx`

**Approach:**
Add an early return in `loadMessages` before the `fetch` when `state.messages[sessionId]` exists and has content. The function still sets `isLoadingMessages` to `false` so any spinner state resolves. Update `ChatPanel`'s `useEffect` to only call `loadMessages` when the session has no cached messages, preserving the existing draft-session guard (`!activeSession.isDraft`).

**Patterns to follow:**
- The existing `hasStreaming` guard inside `loadMessages` (post-fetch) shows the pattern for conditional load skipping.
- `commands-store.ts` uses an `inflight` deduplication pattern; here we want a cache-hit short-circuit instead.

**Test scenarios:**
- Happy path: Switch from Session A to Session B, then back to Session A. No `/messages` network request is issued for the return to A.
- Edge case: Open a brand-new session (no cached messages). `loadMessages` fires normally and populates the store.
- Edge case: A session exists in store but has an empty message array (should not happen in practice, but guard against infinite skip). `loadMessages` should still fetch.

**Verification:**
- Network tab shows zero `/messages` requests when switching between sessions that have already been viewed.
- Loading spinner does not appear on session revisit.

---

### U2. Add session DOM cache to chat-store

**Goal:** Track which sessions keep their `MessageList` DOM mounted within the active workspace.

**Requirements:** R4, R7, R8

**Dependencies:** U1

**Files:**
- `src/client/stores/chat-store.ts`

**Approach:**
Add `domCache: Record<string, string[]>` keyed by `workspaceId`. The array order is LRU — most recent at the end. Add two actions:
- `touchDomCache(workspaceId, sessionId)` — moves `sessionId` to the end (most recent), or appends it if absent. If the array exceeds the limit (default 3), evict the first element (oldest).
- `getDomCache(workspaceId)` — returns the current cache array.

The eviction action returns the evicted `sessionId` so `ChatPanel` can unmount it.

Keep the cache limit as a module-level constant (e.g., `DOM_CACHE_LIMIT = 3`).

**Patterns to follow:**
- `Record<string, T>` is the established pattern for per-workspace/per-session state in the store.
- Functional setState with immutable spread.

**Test scenarios:**
- Happy path: View sessions A, B, C in order. Cache is `[A, B, C]`. Switch to D; cache becomes `[B, C, D]` and A is evicted.
- Edge case: Switch back to B. Cache becomes `[C, D, B]` — B is moved to most-recent.
- Edge case: `touchDomCache` called with the same sessionId already at the end. No change, no eviction.

**Verification:**
- Zustand devtools or console logging shows the cache array updating correctly on each session switch.

---

### U3. Render cached session MessageLists in ChatPanel

**Goal:** Keep multiple session DOM trees alive and toggle visibility instead of remounting.

**Requirements:** R5, R6, R7

**Dependencies:** U2

**Files:**
- `src/client/components/ChatPanel.tsx`
- `src/client/components/MessageList.tsx`
- `src/client/components/VirtualizedMessageList.tsx`

**Approach:**
In `ChatPanel`, replace the single conditional `MessageList` render with a loop over the workspace's DOM cache. For each cached `sessionId`, render a `MessageList` wrapped in a container whose visibility is toggled via CSS (`display: none` for inactive, `display: flex` or block for active). The active session's list is the only one visible and interactive.

Remove `key={activeSessionId}` from the `MessageList` invocation so React does not force remount on session switch. Pass `sessionId` as a regular prop instead.

Use a stable container key (e.g., `sessionId` itself) for the wrapper so React can diff correctly, but the inner `MessageList` must not be remounted.

**Patterns to follow:**
- `App.tsx` already uses `visible` / `invisible pointer-events-none` with `aria-hidden` and `inert` for workspace keep-alive. Use the same accessibility attributes for inactive session containers.

**Test scenarios:**
- Happy path: Switch between sessions A and B. Both DOM trees remain in the document; only the active one is visible.
- Edge case: A session is evicted from the DOM cache. Its `MessageList` unmounts and is removed from the DOM.
- Edge case: Rapid switching between 4 sessions. The oldest is evicted and remounted when revisited; the other three stay mounted.

**Verification:**
- React DevTools Profiler shows no unmount/mount cycle when switching between cached sessions.
- Browser DevTools Elements panel shows multiple `MessageList` container nodes, with only the active one having `display` !== `none`.

---

### U4. Handle SSE subscriptions and virtualizer state on switch

**Goal:** Ensure correct SSE reconnection and virtualizer behavior when switching between cached sessions.

**Requirements:** R3, R9, R10

**Dependencies:** U1, U3

**Files:**
- `src/client/stores/chat-store.ts`
- `src/client/components/VirtualizedMessageList.tsx`

**Approach:**
SSE subscriptions are already managed correctly: `setActiveSession` closes the previous session's subscription and opens a new one. No change needed to the subscription logic itself.

For the virtualizer: when a `VirtualizedMessageList` becomes visible after being hidden, `@tanstack/react-virtual` may need to recalculate measurements because `getBoundingClientRect` returns zeros for hidden elements. Add a `useEffect` in `VirtualizedMessageList` that watches visibility (e.g., via an `isVisible` prop or IntersectionObserver) and calls `virtualizer.measure()` when transitioning from hidden to visible.

For `MessageList` (non-virtualized path), no special handling is needed — React re-renders from the store automatically.

**Patterns to follow:**
- The existing `useEffect` patterns in `VirtualizedMessageList` for scroll detection and auto-scroll.
- The workspace keep-alive plan uses `requestAnimationFrame` for scroll restoration; a similar pattern can trigger `measure()`.

**Test scenarios:**
- Happy path: Switch to a cached session with a virtualized message list. The list renders correctly without collapsed items or incorrect scroll position.
- Edge case: Switch to a cached session while it is actively streaming. SSE reconnects, replay buffer catches up, and new messages append correctly.
- Edge case: Scroll position in a virtualized cached session is preserved when switching away and back.

**Verification:**
- Virtualized sessions show correct item heights immediately on reactivation.
- No console errors from `@tanstack/react-virtual` about zero-size containers.

---

### U5. Sync totalMessageCount for cached sessions

**Goal:** Ensure `VirtualizedMessageList` can still fetch older messages correctly when `loadMessages` is skipped.

**Requirements:** R3 (implied by pagination correctness)

**Dependencies:** U1

**Files:**
- `src/client/stores/chat-store.ts`

**Approach:**
`totalMessageCount` is used by `VirtualizedMessageList` to determine whether older messages exist (`hasOlder = totalMessageCount > currentWindowSize`). It is currently set only by `loadMessages` and by SSE events (`assistant_start`, `tool_result`).

When `loadMessages` is skipped, `totalMessageCount` may be stale if messages arrived while the session was inactive. To fix this:
- When `loadMessages` is skipped, still fetch the message count (or do a lightweight version of `loadMessages` that only gets the count and tasks, not the full messages).

Alternatively, since the server does not expose a lightweight count endpoint, accept the small staleness risk and rely on the scroll-up behavior: if `hasOlder` is wrong, the user may see a brief "no older messages" state, which self-corrects on the next full load. Given the user's tolerance for replay-buffer limits, this is acceptable.

**Preferred approach:** Add a lightweight `fetchMessageCount` or simply keep `totalMessageCount` as a best-effort value. When `loadMessages` is skipped, do not update `totalMessageCount`. The virtualizer's existing logic will still work for the messages that are present; only the "load older" hint may be slightly off.

**Test scenarios:**
- Happy path: User scrolls up in a cached session. `fetchOlderMessages` loads the correct offset based on the current window size.
- Edge case: `totalMessageCount` is slightly stale. The user may not see the "load older" spinner when there are actually more messages. This is acceptable.

**Verification:**
- `fetchOlderMessages` still works correctly for cached sessions.

---

## Scope Boundaries

### Deferred to Follow-Up Work

- Background freshness check (e.g., polling message count or a HEAD request) for sessions that have been inactive for a long time.
- Persisting scroll position across LRU eviction and remount.
- Making the DOM cache limit user-configurable.
- Global session LRU across workspaces (currently scoped to active workspace only).

### Out of Scope

- Server-side transcript caching.
- Keeping SSE subscriptions alive for inactive sessions.
- Persisting cache across browser restarts.
- Changing the message virtualization strategy or replacing `@tanstack/react-virtual`.
- Memory-size-based eviction heuristics.

---

## System-Wide Impact

- **Memory:** Up to 3 additional session DOM trees are kept alive in the active workspace. Each tree contains a virtualized or non-virtualized message list. This is bounded and acceptable given the LRU limit.
- **Network:** Eliminates redundant `/messages` API calls, reducing server load and improving perceived performance.
- **Accessibility:** Inactive session containers use `aria-hidden` and `inert` to prevent keyboard focus and screen-reader traversal, matching the workspace keep-alive pattern.

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stale messages if >500 events occur while inactive | Low | Medium | Acceptable per user confirmation; SSE replay buffer covers normal switching |
| Virtualizer measurement corruption on visibility change | Medium | Medium | Call `virtualizer.measure()` on show; test with large sessions |
| `MessageList` child components not handling prop-only session changes | Low | High | Verify `MessageList` and children read `sessionId` from props/store, not closure state |
| Memory growth from unbounded Zustand message store | Low | Low | Existing `windowCap` (200) already limits per-session messages; `clearMessages` can be wired later if needed |

---

## Deferred Questions

### Deferred to Implementation

- [Technical] Exact mechanism for virtualizer remeasure on visibility change — `IntersectionObserver` vs. a prop-driven `useEffect`?
- [Technical] Should `ChatPanel` render cached sessions as siblings of the active `MessageList`, or nest them in a single container with CSS toggles?
- [Needs research] Does `display: none` on the container prevent `ResizeObserver` from firing for the virtualizer, or do we need `visibility: hidden`?
