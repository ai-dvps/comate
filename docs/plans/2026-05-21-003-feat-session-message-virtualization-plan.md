---
title: 'feat: Session message virtualization and sliding memory window'
type: feat
status: active
date: 2026-05-21
origin: docs/brainstorms/2026-05-21-session-message-virtualization-requirements.md
---

# feat: Session Message Virtualization and Sliding Memory Window

## Summary

Replace the message list's `.map()` rendering with a virtualized list that mounts only viewport-visible messages to the DOM. Add a client-side sliding memory window (default 200 messages) to the Zustand chat store so that both historical and live-streamed messages are pruned when the cap is exceeded. Scrolling up past the window re-fetches older messages via offset/limit API parameters. Replace `use-stick-to-bottom`'s automatic scroll behavior with manual tracking for compatibility with virtualized prepend operations.

---

## Problem Frame

Opening a session with hundreds of messages causes noticeable UI sluggishness because every message renders to the DOM. During long live streaming sessions, messages accumulate without bound, exacerbating memory and rendering costs. The SDK's `getSessionMessages` reads the full JSONL file internally regardless of limit/offset, so the fix must target client-side rendering and memory rather than server-side I/O. (see origin: docs/brainstorms/2026-05-21-session-message-virtualization-requirements.md)

---

## Requirements

- R1. The message list renders only messages visible within the viewport plus a small buffer. Messages outside this range are not mounted in the DOM.
- R2. The virtualized list preserves existing scroll behavior: auto-scroll to bottom on new content when the user is at the bottom; sticky-bottom behavior pauses when the user has scrolled up.
- R3. Message rendering quality is unchanged by virtualization. Re-mounting a message produces the same visual output.
- R4. The client maintains a configurable maximum number of messages in memory (default: 200). On session open, if history exceeds this cap, only the most recent messages are retained.
- R5. The client tracks total message count to enable offset-based re-fetching.
- R6. Scrolling up past the memory window requests older messages via API offset/limit and prepends them to the window.
- R7. During live streaming, new SSE events append to the memory window. If the window exceeds the cap, oldest messages prune.
- R8. Pruned messages can be re-fetched via the messages API on demand.
- R9. Switching sessions resets the memory window and virtualization state.
- R10. The sliding window cap is configurable with a sensible default.

**Origin actors:** A1 (User)
**Origin flows:** F1 (Open existing session), F2 (Scroll up to load older messages), F3 (Live streaming with sliding window)
**Origin acceptance examples:** AE1 (covers R1, R3), AE2 (covers R4, R5), AE3 (covers R6), AE4 (covers R7, R8), AE5 (covers R2)

---

## Scope Boundaries

- Bypassing the SDK to read JSONL files directly for reduced server-side I/O
- Server-side caching of parsed session messages
- Message search or "jump to message" functionality
- Subagent drawer virtualization
- Scroll position persistence across session switches or page reloads
- Changing the SSE streaming protocol or ring buffer behavior

### Deferred to Follow-Up Work

- Server-side message count API or true server-side pagination (requires SDK enhancement)
- Persisting tool card / reasoning expand/collapse state across re-mount (requires lifting local state to a store)

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/MessageList.tsx` — core message renderer. Builds `resultMap` via `buildResultMap`, filters `isToolResultOnly` messages, pairs CLI meta via `pairCliMeta`, then `.map()` renders `viewItems`.
- `src/client/components/ai-elements/conversation.tsx` — vendored AI Elements wrapper around `use-stick-to-bottom`. `Conversation` sets `overflow-y-auto` and `resize="smooth"`. `ConversationScrollButton` uses `useStickToBottomContext()` for `isAtBottom` and `scrollToBottom`.
- `src/client/stores/chat-store.ts` — Zustand store with `messages: Record<string, ChatMessage[]>`. `loadMessages()` fetches full history. `setActiveSession()` switches subscriptions. `hasStreaming` guard in `loadMessages` skips loading if any message is streaming.
- `src/server/routes/chat.ts` — `GET /sessions/:sessionId/messages` returns `{ messages, tasks }` via `chatService.loadMessages()`. No query params currently.
- No virtualization library is present. No test framework is configured.

### Institutional Learnings

- A prior scroll fix (`docs/plans/2026-05-16-007-fix-session-message-list-scroll-plan.md`) changed `overflow-y-hidden` to `overflow-y-auto` on the `Conversation` wrapper because `use-stick-to-bottom` walks ancestors looking for `overflow: scroll` or `auto` and silently skips `hidden`.
- `use-stick-to-bottom`'s `StickToBottom` normalizes `overflow: visible` to `auto` internally, confirming `auto` is the intended contract.

### External References

- [TanStack Virtual documentation](https://tanstack.com/virtual/latest) — variable-height item virtualization with `measureElement` and `scrollToIndex`

---

## Key Technical Decisions

- **Use `@tanstack/react-virtual` for virtualization.** It supports variable-height items, has good React 18 compatibility, and provides `scrollToIndex` for programmatic scrolling. It requires a scroll container ref, which aligns with replacing manual scroll management. (see origin: R1, deferred question)
- **Replace `use-stick-to-bottom` auto-scroll with manual tracking.** The library's automatic resize handling (`resize="smooth"`) conflicts with virtualized prepend operations — when older messages load above the viewport, the library may fight the user's scroll position or auto-scroll to bottom. Manual `isAtBottom` detection + `scrollToIndex` gives full control. The `StickToBottom` wrapper may be kept as a scroll container or replaced with a plain div; the decision is deferred to implementation. (see origin: R2)
- **Keep tool-use/tool-result pairs together when pruning.** If pruning would split a pair, the pair is kept together even if it temporarily exceeds the window cap. This avoids "Running forever" UI states. (see origin: R3, flow analysis)
- **Client-side offset/limit with server pass-through.** The server reads the full file from the SDK regardless of params, but the API accepts `offset` and `limit` query parameters so the client can express intent. The server returns the full array; the client slices what it needs. This future-proofs the API for true server-side pagination if the SDK ever supports it. (see origin: R6, dependencies)
- **Reset memory window on reconnect.** When the connection drops during live streaming and old messages have been pruned, the client resets to the latest N messages on reconnect rather than attempting a complex merge with the server's 500-event ring buffer. (see origin: Key Decisions — reconnect replay deferred to planning)

---

## Open Questions

### Resolved During Planning

- **Which virtualization library?** `@tanstack/react-virtual` — best fit for variable-height items and React 18.
- **How to handle `use-stick-to-bottom`?** Replace automatic scroll behavior with manual tracking; keep the scroll container wrapper or replace it entirely.
- **Tool pair boundary policy?** Keep pairs together; temporarily exceed cap if needed.

### Deferred to Implementation

- **Exact `ResizeObserver` strategy for dynamic message heights.** Streaming text, collapsed tools, and code blocks all change height after mount. `measureElement` with `ResizeObserver` is the likely path, but exact integration with TanStack Virtual's measurement cycle requires hands-on validation.
- **Whether to keep `StickToBottom` as the scroll container or replace with a plain div.** A plain div is simpler but loses any upstream fixes in the vendored wrapper. The vendored wrapper is thin; replacement is low risk.
- **Reconnect replay edge case handling.** The plan specifies "reset to latest N," but the exact sequence (clear window → re-subscribe → load latest) needs to be validated against the SSE subscription lifecycle in `chat-store.ts`.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
┌─────────────────────────────────────────────────────────────┐
│  Scroll Container (div with overflow-y-auto)                │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Virtual Spacer (top padding = total height of        │  │
│  │   items above viewport)                               │  │
│  │                                                       │  │
│  │  ┌─────────────────┐  ┌─────────────────┐            │  │
│  │  │ Message N+2     │  │ Message N+3     │  ← buffer  │  │
│  │  └─────────────────┘  └─────────────────┘            │  │
│  │  ┌─────────────────┐  ┌─────────────────┐            │  │
│  │  │ Message N       │  │ Message N+1     │  ← visible │  │
│  │  └─────────────────┘  └─────────────────┘            │  │
│  │  ┌─────────────────┐  ┌─────────────────┐            │  │
│  │  │ Message N-2     │  │ Message N-1     │  ← buffer  │  │
│  │  └─────────────────┘  └─────────────────┘            │  │
│  │                                                       │  │
│  │  Virtual Spacer (bottom padding = total height of     │  │
│  │   items below viewport)                               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘

Memory Window (max 200 messages in Zustand)
  ┌──────────┬──────────────────────┬──────────┐
  │ Pruned   │  Loaded in memory    │  Live    │
  │ (re-     │  (rendered via       │  stream  │
  │ fetchable)│  virtualization)    │  append  │
  └──────────┴──────────────────────┴──────────┘
```

**Scroll behavior:**
- Auto-scroll to bottom: When `isAtBottom` is true and new content arrives, call `virtualizer.scrollToIndex(lastIndex, { align: 'end' })`.
- Scroll-to-bottom button: Show when `isAtBottom` is false; click calls `scrollToIndex`.
- Prepend anchoring: Before loading older messages, record the scroll offset of the first visible item. After prepend and re-measure, restore scroll position so the same item stays at the same viewport position.

---

## Implementation Units

### U1. Virtualized message rendering

**Goal:** Add `@tanstack/react-virtual` and replace the `.map()` in `MessageList` with a virtualized list that renders only viewport-visible messages.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `package.json` (add dependency)
- Modify: `src/client/components/MessageList.tsx`
- Create: `src/client/components/VirtualizedMessageList.tsx` (or inline in MessageList)

**Approach:**
- Install `@tanstack/react-virtual`.
- Create a virtualized message list component that accepts the same props as `MessageList`.
- Use `useVirtualizer` with `measureElement` (via `ResizeObserver` fallback) for variable-height messages.
- Render virtual items with `key={item.key}` for React reconciliation stability.
- The `resultMap` must still be built from the full set of visible messages (not just the virtual window), because a visible `tool_use` may reference a `tool_result` that is off-screen but still in the memory window.
- Preserve `pairCliMeta` output — virtual items map over `viewItems`, not raw messages.

**Patterns to follow:**
- `MessageList.tsx` current structure: `buildResultMap` → filter `isToolResultOnly` → `pairCliMeta` → `.map(renderViewItem)`
- Vendored AI Elements components (`Message`, `MessageContent`, `Tool`, etc.) should be reused without change

**Test scenarios:**
- Happy path: Open a session with 500 messages. Only ~15 messages are in the DOM at any time. Scrolling smoothly reveals others.
- Edge case: Messages with varying heights (long text, code blocks, collapsed tools) measure correctly after mount.
- Edge case: Empty session renders `ConversationEmptyState` correctly.
- Edge case: Session with fewer messages than viewport renders all messages without virtualization gaps.

**Verification:**
- DevTools Elements panel shows only ~15 message nodes for a 500-message session.
- Scrolling is smooth at 60fps.
- Message rendering matches pre-virtualization visuals.

---

### U2. Manual scroll management

**Goal:** Replace `use-stick-to-bottom`'s automatic scroll behavior with manual tracking compatible with virtualization.

**Requirements:** R2

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/ai-elements/conversation.tsx`
- Modify: `src/client/components/MessageList.tsx`
- Modify: `src/client/stores/chat-store.ts` (if scroll state is lifted to store)

**Approach:**
- Disable `use-stick-to-bottom`'s automatic resize handling (`resize="none"` or remove the library entirely).
- If keeping `StickToBottom` as the scroll container, use `useStickToBottomContext()` only for `isAtBottom` and `scrollToBottom` utility. If replacing, implement `isAtBottom` as `scrollTop + clientHeight >= scrollHeight - threshold` and `scrollToBottom` as `scrollTop = scrollHeight`.
- On new content arrival (detected in chat store or via effect), if `isAtBottom` is true, call `virtualizer.scrollToIndex(lastIndex, { align: 'end' })`.
- Preserve the floating scroll-to-bottom button behavior.
- Handle prepend scroll anchoring: before loading older messages, record the scroll offset or first visible item key. After prepend, restore position.

**Technical design:**
> The scroll container is the same DOM node that TanStack Virtual uses for scrolling. `isAtBottom` is computed from `scrollTop + clientHeight >= scrollHeight - 50` (50px threshold). On new content, the virtualizer's `scrollToIndex` is called only when `isAtBottom` is true. The scroll-to-bottom button uses the same `isAtBottom` flag.

**Patterns to follow:**
- Existing `ConversationScrollButton` placement and styling
- Existing `use-stick-to-bottom` integration in `conversation.tsx`

**Test scenarios:**
- Happy path: User at bottom → new message streams in → view auto-scrolls to keep latest visible.
- Happy path: User scrolls up mid-stream → auto-scroll pauses → scroll-to-bottom button appears.
- Edge case: User clicks scroll-to-bottom button → view smoothly scrolls to latest message.
- Edge case: Prepend older messages while user is scrolled up → scroll position anchors to the first previously visible message, preventing a jump.

**Verification:**
- Auto-scroll works identically to pre-virtualization.
- Scroll-to-bottom button appears and functions correctly.
- Prepend does not disorient the user's reading position.

---

### U3. Sliding memory window

**Goal:** Add sliding-window state to the Zustand chat store so only the most recent N messages are kept in memory.

**Requirements:** R4, R5, R7, R8, R9

**Dependencies:** None (store changes are independent of rendering)

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- Add `windowCap: number` to store state (default 200, configurable per workspace).
- Add `totalMessageCount: Record<string, number>` to track total counts per session.
- On `loadMessages` success: if loaded messages exceed `windowCap`, slice to the most recent N and set `totalMessageCount[sessionId] = loadedCount`.
- During SSE streaming: append new messages/deltas to the windowed array. If the window exceeds `windowCap`, prune oldest messages, but scan for tool pairs at the boundary — if pruning would split a pair, keep both messages.
- On `setActiveSession`: clear window state for the new session (reset to empty, let `loadMessages` populate).
- Add a `fetchOlderMessages(workspaceId, sessionId, offset, limit)` action that fetches via API and prepends to the window.

**Technical design:**
> The `messages` state shape changes from `Record<string, ChatMessage[]>` to still hold arrays per sessionId, but the arrays are now windowed slices. The full history is never stored in memory for large sessions. `totalMessageCount` is separate and tracks the logical total (including pruned messages). Pruning logic: while `messages[sessionId].length > windowCap`, check if the message at index 0 is a `tool_result` whose paired `tool_use` is still in the array. If so, skip pruning this message and check index 1. Otherwise, shift the message out.

**Patterns to follow:**
- Existing Zustand immutable update patterns in `chat-store.ts`
- Existing `loadMessages` error handling

**Test scenarios:**
- Happy path: Session with 500 messages loads → memory contains only messages 301-500. `totalMessageCount` is 500.
- Happy path: Live stream adds 10 messages to a 200-message window → oldest 10 messages prune, window stays at 200.
- Edge case: Tool pair at boundary — `tool_use` is message 1, `tool_result` is message 2. Window cap is 200 and array has 200 messages. A new message arrives. Pruning should skip message 2 (because its pair is message 1 which would also be pruned, leaving both pruned = no split). Wait — if both are at the boundary, pruning both is fine. The rule is: never prune one half of a pair while keeping the other half.
- Edge case: Session with 50 messages (< cap) → all 50 stay in memory, no pruning.
- Edge case: Session switch → window resets, previous session's pruned messages are gone from memory.

**Verification:**
- Memory array length never exceeds `windowCap` + small tool-pair overflow.
- `totalMessageCount` accurately reflects the total messages for the session.
- Small sessions behave identically to today.

---

### U4. Scroll-up history loading

**Goal:** Detect scroll-up past the memory window, fetch older messages, and prepend them with stable scroll positioning.

**Requirements:** R6

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `src/client/stores/chat-store.ts`
- Modify: `src/client/components/MessageList.tsx` (or VirtualizedMessageList)
- Modify: `src/server/routes/chat.ts`
- Modify: `src/server/services/chat-service.ts`

**Approach:**
- In the virtualized list component, detect when the user scrolls near the top of the virtual range (e.g., `scrollOffset < 500px` or first virtual item index < 3).
- Trigger `fetchOlderMessages` with `offset = totalCount - windowSize - fetchSize` and `limit = fetchSize` (default fetchSize: 50).
- Add `offset` and `limit` query parameters to `GET /api/workspaces/:id/sessions/:sessionId/messages`. The server passes them to `getSessionMessages` but currently they only affect the returned slice after the SDK loads the full file.
- Before the fetch, record the scroll anchor (first visible message ID and its offset from viewport top).
- After fetch and prepend, restore the scroll anchor so the user's reading position is stable.
- Show a loading indicator at the top of the list while fetching.

**Patterns to follow:**
- Existing API fetch patterns in `chat-store.ts`
- Existing route patterns in `chat.ts`

**Test scenarios:**
- Happy path: User scrolls up near top of 200-message window → fetch triggers → 50 older messages prepend → scroll position stays stable.
- Edge case: User scrolls up while assistant is streaming → fetch should still work (fix the `hasStreaming` guard in `loadMessages`).
- Edge case: Already at the top of history (offset = 0) → no fetch triggered, or fetch returns empty and loading indicator disappears.
- Error path: Fetch fails → show error state, allow retry.

**Verification:**
- Scrolling up smoothly loads older messages.
- Scroll position does not jump during prepend.
- History can be fetched during live streaming.

---

### U5. Edge cases, config, and cleanup

**Goal:** Handle small sessions, fix `hasStreaming` guard, add window cap configuration, and ensure clean session switching.

**Requirements:** R9, R10, plus cross-cutting edge cases

**Dependencies:** U1, U2, U3, U4

**Files:**
- Modify: `src/client/stores/chat-store.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/client/components/ChatPanel.tsx` or settings panel

**Approach:**
- Fix the `hasStreaming` guard in `loadMessages` so it only blocks the initial full-history load, not scroll-up fetches. Add a separate `fetchOlderMessages` action that does not check `hasStreaming`.
- For sessions with fewer messages than the window cap, skip virtualization overhead entirely — render the simple list path to avoid unnecessary complexity.
- Add a window cap setting to workspace settings or global app settings. Default 200, min 50, max 1000.
- On session switch, clear virtualization state (scroll position, virtualizer cache) so the new session starts fresh.
- On reconnect after a drop, reset the memory window to the latest N messages.

**Patterns to follow:**
- Existing settings patterns in the app (if any)
- Existing `setActiveSession` cleanup

**Test scenarios:**
- Happy path: Session with 50 messages renders via simple list, no virtualization.
- Happy path: User changes window cap from 200 to 100 → next session open respects new cap.
- Edge case: Session switch A → B → A → A's window resets to latest N, not previous scroll position.
- Edge case: Reconnect during streaming → window resets to latest N, no stale pruned messages.
- Integration: Live stream + scroll-up fetch + new message arrival → all three operations coexist without race conditions.

**Verification:**
- Small sessions have no virtualization overhead.
- `hasStreaming` no longer blocks history fetch.
- Window cap is configurable and persisted.
- Session switching is clean and fast.

---

## System-Wide Impact

- **Interaction graph:** `MessageList` now depends on the virtualizer's scroll container ref and measurement cycle. `chat-store.ts` gains window-management actions that `MessageList` subscribes to. The server messages route gains query parameter parsing.
- **Error propagation:** If the virtualizer fails to measure an element (e.g., a message component throws during render), the virtual item may have zero height and cause scroll glitches. Error boundaries around message rendering should contain these failures.
- **State lifecycle risks:** The `messages` state in Zustand is now a windowed slice, not the full history. Any code that assumes `messages[sessionId]` contains all messages will break. Audit all subscribers to `messages` outside `MessageList`.
- **API surface parity:** The messages endpoint now accepts `offset` and `limit` query parameters. Other consumers of this endpoint (if any) should be unaffected because the parameters are optional.
- **Integration coverage:** Scroll-up fetch during live streaming is the critical integration scenario — it crosses the virtualizer, the store, the API, and the SSE stream.
- **Unchanged invariants:** SSE streaming protocol, message normalization, tool rendering components, workspace/session CRUD, and the vendored AI Elements primitives (`Message`, `Tool`, etc.) are unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `use-stick-to-bottom` replacement introduces scroll regressions | Phase in manual scroll tracking alongside the existing library, then remove the library once verified. Test auto-scroll, scroll-to-bottom button, and prepend anchoring thoroughly. |
| Variable message heights cause measurement errors or layout shifts | Use `measureElement` with `ResizeObserver`. Debounce measurements for streaming text. Accept minor layout shifts during streaming as an acceptable trade-off. |
| Tool pair boundary logic has edge cases | Keep the rule simple: never prune one half of a pair. If pairs are adjacent at the boundary, prune both or keep both. |
| `hasStreaming` guard removal causes message overwrites during stream | The new `fetchOlderMessages` action bypasses the guard only for offset-based fetches. The initial `loadMessages` still respects the guard. |
| Session switch with large history still loads full file from SDK | Accepted — the SDK loads everything internally. The DOM and memory benefits still apply after the API response arrives. |

---

## Documentation / Operational Notes

- The window cap default (200) is a starting point. Monitor user feedback and adjust if sessions commonly exceed this.
- If the SDK adds true reverse pagination or a message count API in the future, the client offset/limit pattern can be promoted to actual server-side pagination without API contract changes.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-21-session-message-virtualization-requirements.md](docs/brainstorms/2026-05-21-session-message-virtualization-requirements.md)
- **Related code:** `src/client/components/MessageList.tsx`, `src/client/components/ai-elements/conversation.tsx`, `src/client/stores/chat-store.ts`, `src/server/routes/chat.ts`
- **Related plan:** `docs/plans/2026-05-16-007-fix-session-message-list-scroll-plan.md` — prior scroll fix with `use-stick-to-bottom` context
- **External docs:** [TanStack Virtual](https://tanstack.com/virtual/latest)
