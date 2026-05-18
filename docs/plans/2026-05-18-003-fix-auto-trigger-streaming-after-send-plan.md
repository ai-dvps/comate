---
title: 'fix: Auto-trigger streaming after send by cleaning up dead SSE subscriptions'
type: fix
status: completed
date: 2026-05-18
---

# fix: Auto-trigger streaming after send by cleaning up dead SSE subscriptions

## Summary

Dead SSE subscription entries in `sessionSubscriptions` prevent `sendMessage` from establishing a fresh stream after the previous one closes. The fix adds lifecycle cleanup in `subscribeToSession` so entries are removed when the stream ends — whether by normal completion, abort, or error — and guards cleanup with a close-function identity check to avoid races between overlapping subscriptions.

## Problem Frame

After sending a message, the streaming response should appear automatically. Today it does not; the user must click the session (triggering `setActiveSession` → `subscribeToSession`) to force a re-subscription, sometimes multiple times, before all events arrive.

Root cause: `subscribeToSession` stores a `{ close }` object in `sessionSubscriptions` when a stream starts, but never removes it when the stream ends. The `for await` loop over `parseSSEStream(res.body)` exits on connection close or error without cleaning up the map entry. On the next `sendMessage`, `sessionSubscriptions.has(sessionId)` returns `true` (the stale entry), so the function skips starting a new subscription. The message is POSTed to the server, but no client-side SSE connection is active to receive the response events. Clicking the session forces a re-subscription because `setActiveSession` unconditionally calls `subscribeToSession`, which aborts any existing entry and opens a new stream — but this is a manual workaround, not the intended auto-trigger behavior.

This is a post-implementation defect in the streaming subscription path introduced by the 010 plan.

---

## Requirements

- R1. After sending any message, the SSE stream for that session is active so response events render without manual session clicks.
- R2. Subscription entries are removed when the SSE stream ends (completion, abort, or error).
- R3. Overlapping subscribe/unsubscribe races cannot delete a newer subscription's entry.

---

## Scope Boundaries

- No changes to the SSE event protocol or `SseEvent` shape.
- No changes to server-side runtime creation, ring buffer, or `Last-Event-ID` replay semantics.
- No changes to `sendMessage` optimistic-add, `pendingSend` gate, or `subscription_ack` handling.
- No changes to approval/question banner flow or `draftQueue`.

### Deferred to Follow-Up Work

- Auto-retry with exponential backoff on transient subscription errors (network hiccups). The current fix surfaces the error as a system message; automatic retry would be a separate enhancement.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/stores/chat-store.ts:742-807` — `subscribeToSession` is the subscription lifecycle site. The `fetch(...)` promise chain starts the SSE connection, parses events, and stores the abort handle in `sessionSubscriptions`. There is no cleanup when the `for await` loop exits or when the `.catch` handler fires.
- `src/client/stores/chat-store.ts:939-943` — `sendMessage` gates new subscriptions on `sessionSubscriptions.has(sessionId)`. With stale entries, this check falsely indicates an active subscription.
- `src/client/stores/chat-store.ts:911-919` — `setActiveSession` unconditionally calls `subscribeToSession`, which aborts any existing entry and starts fresh. This is why clicking the session works around the bug.
- `src/server/services/session-runtime.ts:179-189` — `subscribe` wires a new `res` into the emitter; `unsubscribe` clears it. The runtime stays alive across client disconnects, so a fresh subscription reconnects to the same runtime and receives `subscription_ack` plus ring-buffer replay.
- `src/server/routes/chat.ts:81-107` — GET `/stream` calls `getOrCreateRuntime` and then `runtime.subscribe`. The `req.on('close', ...)` handler calls `unsubscribe` when the HTTP connection closes.

### Institutional Learnings

- None — `docs/solutions/` does not exist in this repo.

---

## Key Technical Decisions

- **Cleanup lives in `subscribeToSession`, not in `sendMessage`.** The subscription lifecycle belongs with the code that creates the subscription. Moving cleanup into `sendMessage` would couple send logic to stream internals and still miss cleanup on session switches or errors.
- **Close-function identity check prevents cross-subscription races.** When an old subscription's abort propagates asynchronously, its cleanup handler may run after a newer subscription has already replaced the map entry. Comparing `current?.close === thisClose` before deleting ensures only the owner of the current entry can remove it.
- **`lastEventId` is preserved on cleanup.** The per-session event ID is needed for replay on reconnect; only the `sessionSubscriptions` entry (the abort handle) is removed.

---

## Implementation Units

### U1. Clean up SSE subscription entries when streams end

**Goal:** Remove dead subscription entries from `sessionSubscriptions` so `sendMessage`'s `has()` check accurately reflects whether an active stream exists.

**Requirements:** R1, R2, R3.

**Dependencies:** None.

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**

- In `subscribeToSession`, capture the `close` function in a local constant (`const thisClose = () => abortController.abort()`).
- Store `{ close: thisClose }` in `sessionSubscriptions`.
- After the `for await` loop in `.then` completes (normal stream end), delete the entry only if `sessionSubscriptions.get(sessionId)?.close === thisClose`.
- In `.catch`, perform the same guarded delete for both `AbortError` and other errors.
- Keep `lastEventId` untouched — it must survive for reconnect replay.

**Patterns to follow:**

- The existing `deleteSession` cleanup pattern (lines 860-867) shows how `sessionSubscriptions` entries are meant to be removed.

**Test scenarios:**

- **Happy path:** send a message → subscription starts → assistant streams → stream ends → `sessionSubscriptions` no longer contains the session → next send starts a fresh subscription automatically.
- **Edge case (rapid sends):** send message A, stream ends, immediately send message B. B's `sendMessage` sees no entry and starts a new subscription; no cross-talk with A's cleanup.
- **Edge case (session switch):** switch to session X while session Y is streaming. Y's subscription is aborted and its entry cleaned up. X gets a fresh subscription.
- **Error path:** server closes connection with an error → `.catch` runs → entry cleaned up → error surfaced as system message → next send starts fresh subscription.
- **Integration:** first message in fresh draft → `pendingSend` gates until `subscription_ack` → queued POST fires → events stream → entry cleaned on completion → second send in same session auto-triggers new subscription.

**Verification:** `npm run lint` + `npm run build`. Manual: send multiple messages in the same session and confirm each response streams without clicking the session. Switch sessions mid-stream and confirm the old session's entry is cleaned and the new session subscribes correctly.
