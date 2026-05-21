---
date: 2026-05-21
topic: session-message-virtualization
---

# Session Message Virtualization and Sliding Memory Window

## Summary

Virtualized rendering with a sliding memory window for session message histories. Sessions load fully from disk on open, but the client retains only the most recent N messages in memory and renders only viewport-visible messages. Scrolling up past the memory window re-fetches older messages. During live streaming, new messages append and oldest ones prune automatically to keep memory bounded.

---

## Problem Frame

Opening a session with hundreds of messages causes noticeable UI sluggishness and, in extreme cases, application instability. The current implementation loads all messages from the SDK and renders every message to the DOM via a simple `.map()`, causing both memory and rendering costs to scale linearly with message count. During long live streaming sessions, messages accumulate without bound, exacerbating the problem. The SDK's `getSessionMessages` reads the full JSONL transcript internally regardless of limit/offset parameters, so reducing initial I/O requires working within SDK constraints rather than against them.

---

## Actors

- A1. User: Opens sessions, scrolls through message history, and sends prompts during live streaming.

---

## Key Flows

- F1. Open existing session
  - **Trigger:** User clicks a session in the sidebar
  - **Actors:** A1
  - **Steps:**
    1. Client requests full message history via API
    2. Server loads all messages from SDK
    3. Client receives messages, applies sliding window: keeps only most recent N
    4. Virtualized list renders only visible messages from the window
  - **Outcome:** Chat panel shows recent messages quickly, memory bounded
  - **Covered by:** R1, R2, R3, R4

- F2. Scroll up to load older messages
  - **Trigger:** User scrolls up past the top of the current memory window
  - **Actors:** A1
  - **Steps:**
    1. Client detects scroll approaching top of rendered list
    2. Client computes offset from tracked message count
    3. Client requests older messages via API with offset/limit
    4. Server reads full file, returns requested slice
    5. Client prepends messages to memory window
    6. Virtualized list renders newly loaded visible messages
  - **Outcome:** User sees older messages without loading entire history into memory
  - **Covered by:** R4, R5, R6

- F3. Live streaming with sliding window
  - **Trigger:** User sends a prompt and assistant streams a response
  - **Actors:** A1
  - **Steps:**
    1. New SSE events arrive and are parsed
    2. New messages/deltas append to memory window
    3. If window exceeds cap, oldest messages prune from memory
    4. Virtualized list renders visible messages including new content
  - **Outcome:** Live stream continues smoothly regardless of total message count
  - **Covered by:** R7, R8

---

## Requirements

**Message rendering**

- R1. The message list renders only messages visible within the viewport plus a small buffer (e.g., 3-5 messages above and below). Messages outside this range are not mounted in the DOM.
- R2. The virtualized list preserves the existing scroll behavior: auto-scroll to bottom on new content when the user is at the bottom; sticky-bottom behavior pauses when the user has scrolled up.
- R3. Message rendering quality (styling, spacing, meta message handling, tool cards) is unchanged by virtualization. Re-mounting a message into the viewport produces the same visual output as if it had never left.

**Memory sliding window**

- R4. The client maintains a configurable maximum number of messages in memory (default: 200). On session open, if the loaded history exceeds this cap, only the most recent messages are retained; older ones are discarded from client memory.
- R5. The client tracks the total message count for the active session to enable offset-based re-fetching. This count is updated when messages load, stream in, or are pruned.
- R6. When the user scrolls up and approaches the top of the current memory window, the client requests older messages via the existing messages API, computing `offset = totalCount - windowSize - fetchSize` and `limit = fetchSize`. The fetched messages are prepended to the memory window.
- R7. During live streaming, new SSE events append messages/deltas to the memory window. If the window exceeds the configured cap, the oldest messages are pruned to maintain the cap.
- R8. Pruning removes messages from client memory only. Pruned messages can be re-fetched via the messages API on demand.

**Session lifecycle**

- R9. Switching to a different session resets the memory window and virtualization state. Returning to a previously viewed session starts fresh with a new window.
- R10. The sliding window cap is configurable per workspace or globally, with a sensible default.

---

## Acceptance Examples

- AE1. **Covers R1, R3.** Given a session with 500 messages and a window cap of 200, when the user opens the session, the chat panel renders the most recent 200 messages with only ~15 messages in the DOM at any time. Scrolling up smoothly reveals older messages without rendering all 200.
- AE2. **Covers R4, R5.** Given a session with 500 messages, when the user opens it, the client retains only messages 301-500 in memory. The tracked total count is 500. Messages 1-300 are not in client memory.
- AE3. **Covers R6.** Given the user is viewing messages 301-500 and scrolls up near the top, when the scroll trigger fires, the client requests `offset=250, limit=50` and prepends messages 251-300 to the memory window. The user can now scroll to see messages 251-500.
- AE4. **Covers R7, R8.** Given a live stream that has reached 200 messages in the window, when a new assistant message arrives, the oldest message is pruned from memory. The total count increments to 201. The user can still scroll up and re-fetch the pruned message.
- AE5. **Covers R2.** Given the user is at the bottom of a session and a new assistant message streams in, when tokens arrive, the view auto-scrolls to keep the latest message visible. If the user scrolls up mid-stream, auto-scroll pauses and a scroll-to-bottom affordance appears.

---

## Success Criteria

- Opening a session with 500 messages renders within 1 second of receiving the API response (DOM cost eliminated)
- Scrolling through a 500-message session is smooth at 60fps
- A live stream that accumulates 1000+ messages does not cause UI freezes or crashes
- Message rendering fidelity is identical to pre-virtualization
- Memory usage for the active session stays bounded regardless of total message count

---

## Scope Boundaries

- Bypassing the SDK to read JSONL files directly for reduced server-side I/O
- Server-side caching of parsed session messages to speed up re-fetches
- Message search or "jump to message" functionality
- Subagent drawer virtualization (deferred to its own follow-up)
- Scroll position persistence across session switches or page reloads
- Changing the SSE streaming protocol or ring buffer behavior

---

## Key Decisions

- **Render-only virtualization instead of partial disk load:** The SDK's `getSessionMessages` reads the full JSONL file internally before applying limit/offset, so client-side pagination cannot reduce server-side I/O without bypassing the SDK.
- **Uniform sliding window over history-only pruning:** Both historical and streamed messages are subject to the same memory cap, keeping memory bounded regardless of initial session size.
- **Re-fetch on scroll-up instead of compressed cache:** Pruned messages are fully removed from client memory and re-fetched via API when needed, trading scroll-back speed for memory guarantees.
- **Leave reconnect replay behavior to planning:** When the connection drops after old messages have been pruned during live streaming, the server's 500-event ring buffer may replay events for messages no longer in client memory. The exact handling is deferred to implementation planning.

---

## Dependencies / Assumptions

- The `use-stick-to-bottom` library can coexist with virtualized scroll behavior
- The existing messages API (`GET /api/workspaces/:id/sessions/:sessionId/messages`) continues to return the full message array; offset/limit parameters may be added but are not required for the server (since the SDK loads everything anyway)
- Message count tracking is client-side only; the SDK does not expose a message count API
- Sessions with fewer messages than the window cap behave identically to today, with no virtualization overhead visible to the user

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] Which virtualization library or approach to use (tanstack-virtual, react-window, or custom intersection observer)
- [Affects R2][Technical] How to preserve `use-stick-to-bottom` auto-scroll behavior when virtualization changes scroll height dynamically
- [Affects R6][Technical] Exact scroll-trigger threshold and fetch size for loading older messages
- [Affects R7][Technical] Whether to prune immediately on cap exceed or use a debounced/batched approach
- [Affects R7][Technical] Reconnect replay behavior when old messages have been pruned during live streaming
