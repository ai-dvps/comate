---
title: 'fix: Live chat streaming render and Stop button state during turns'
type: fix
status: completed
date: 2026-05-17
origin: docs/brainstorms/2026-05-16-prompt-input-and-streaming-input-mode-requirements.md
---

# fix: Live chat streaming render and Stop button state during turns

## Summary

After sending a prompt the streaming response should render live in the page and the Stop button should revert to Send when the turn finishes — today neither holds. The fix dedupes concurrent `SessionRuntime` creation server-side so `GET /stream` and `POST /messages` cannot produce an orphan runtime, gates the first `POST /messages` on the client until `subscription_ack` arrives so events emit to a wired-up SSE response, clears the session-level `isStreaming` flag on the SDK's `result` turn-end event, and adds a streaming loading indicator on the Stop button.

## Problem Frame

After landing U9 (`chat-store` long-lived subscription) and U10 (`ChatPanel` integration), two regressions are user-visible:

1. **No live streaming after send.** Sending the first message on a freshly created draft session produces no visible output. Switching to another session and back surfaces the missed messages. Root cause: `chat-store.sendMessage` kicks off `subscribeToSession` and then immediately POSTs the message. On the server, both routes call `chatService.getOrCreateRuntime` (`src/server/services/chat-service.ts:148`) which is not safe for concurrent invocation — there is no in-flight lock between `runtimes.get(...)` and `runtimes.set(...)`, so both calls can race past the existence check, create two `SessionRuntime` instances, and the second `set(...)` wins. The POST then pushes the user message into one runtime while the GET subscribes to the other. Events emit to the orphan's ring buffer and never reach the active SSE response. When the user switches and returns, `setActiveSession` → `subscribeToSession` reconnects with `Last-Event-ID` from the previous (empty) subscription, the now-stored runtime replays its ring buffer, and the messages finally appear.

2. **Stop button never reverts to Send.** `sendMessage` in `src/client/stores/chat-store.ts:681` optimistically sets `isStreaming[sessionId] = true`. The handlers that clear it are `interrupted` (line 446) and the subscription `catch` block (line 532). The `result` SSE event (the SDK's canonical turn-end signal) lands in the `default: return` branch (line 469). The `assistant_done` handler (line 330) only updates the per-message `isStreaming` flag on the message record, never the session-level flag the Stop button reads. So once a turn begins, the session-level `isStreaming[sessionId]` stays `true` until the user interrupts or the SSE connection errors.

Both bugs trace to the same surface in the 009 plan (origin doc R6, R8, R10, R11, R18). The plan structure is correct; these are post-implementation defects.

---

## Requirements

Carried from the origin brainstorm doc.

- R6. Send replaced by Stop (with loading indicator) while streaming.
- R8. Button reverts to Send when turn completes or is interrupted.
- R10. Draft sessions: first message lands in a fresh SDK session using the local draft id.
- R11. One long-lived `query()` per session, fed by streaming input.
- R18. The server keeps `query()` alive across subscribe/unsubscribe — but the subscription must be visible to the active client.

---

## Scope Boundaries

- No changes to the SSE event protocol or shape (the existing `SseEvent` discriminated union is sufficient).
- No changes to ring buffer size, eviction, or `Last-Event-ID` replay semantics on reconnect.
- No changes to approval/question banner flow, `draftQueue` (the approval-pending message hold), or `ApprovalBanner`.
- No changes to `setActiveSession`'s subscribe-on-switch behavior — only the createSession/first-send window is in scope.
- No changes to subagent message routing.

### Deferred to Follow-Up Work

- Always-replay-the-ring-buffer on an initial subscribe with no `Last-Event-ID`. This is a more general alternative to the client-side gate (call-out from synthesis), worth considering if other races surface; not needed for the reported defect.
- Visual polish on the Stop button loading indicator (exact animation: pulsing dot vs. concentric ring vs. shimmer). The plan picks a Loader2-ring + Square composition; the final visual settles during implementation.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/services/chat-service.ts:148-173` — `getOrCreateRuntime` is the concurrent-safety chokepoint. It awaits `workspaceStore.get` and `getSession` before constructing the runtime and inserting into `runtimes`. Both awaits are yield points where a second concurrent call passes the same `runtimes.get(...) === undefined` check.
- `src/server/routes/chat.ts:81-107` (GET stream) and `src/server/routes/chat.ts:111-133` (POST messages) — both call `getOrCreateRuntime`. The fix is scoped to the service; routes are unchanged.
- `src/server/services/session-runtime.ts:176-186` — `subscribe(res, lastEventId?)` sets the response, emits `subscription_ack`, and replays from `lastEventId` when present. With no `lastEventId`, no replay happens. The client-side gate avoids this race; the replay semantics stay as-is.
- `src/client/stores/chat-store.ts:474-539` — `subscribeToSession` is the SSE fetch + parser. `parseSSEStream` (line 74) already captures `id:` frames and dispatches handlers in `handleSseEvent` (line 192).
- `src/client/stores/chat-store.ts:347-376` — `subscription_ack` handler stores `serverNonce[sessionId]`. This is the readiness signal the gate hooks into.
- `src/client/stores/chat-store.ts:659-708` — `sendMessage` is the gate site. The optimistic-add-then-POST flow stays the same; only the POST is gated.
- `src/client/stores/chat-store.ts:467-470` — `result` is currently in the `default` branch. Adding a real handler is a one-case insertion.
- `src/client/components/PromptInput.tsx:87-100` — the Stop button currently renders a plain `Square` icon when `!isInterrupting`. The streaming-loading composition slots in here.

### Institutional Learnings

- None — `docs/solutions/` does not exist in this repo.

---

## Key Technical Decisions

- **Race-fix uses both server dedup and client gate.** Server-side dedup of `getOrCreateRuntime` removes the orphan-runtime class of failures entirely. The client gate (send waits for `subscription_ack`) covers the remaining window between subscribe initiation and the server actually wiring the response into the emitter. Each is small; together they reach correctness without changing replay semantics. The alternative (always replay the ring on initial subscribe) was considered and deferred — it changes reconnect behavior more than needed for this defect.

- **In-flight Map keyed by sessionId for runtime creation.** Insertion happens synchronously at the top of `getOrCreateRuntime` (around the same instant as the existence check), so a second call entering the function on the next tick sees the pending Promise and awaits it. The entry is cleared in a `finally` so failures don't poison subsequent attempts.

- **`result` is the session-level turn-end signal.** It is the SDK message that fires after every `assistant_done` whether the turn ended cleanly or with an error subtype. `assistant_done` already exists per-message; the session-level flag belongs alongside `result`. `error` (from the chat-store enum) keeps its throw — the subscribe catch handler already clears `isStreaming` there.

- **Gate uses `serverNonce[sessionId]` as the readiness signal.** No new boolean is needed. When `serverNonce[sessionId]` is unset, the subscription has not yet been acknowledged; once `subscription_ack` lands, it is set and the gate releases. A `pendingSend[sessionId]: { workspaceId: string; content: string } | undefined` field carries the queued message between gate-time and ack-time (workspaceId is needed at ack-time to construct the POST URL). The single-slot shape (not a queue) is sufficient because `isStreaming = true` is set optimistically on the first send, which disables PromptInput input until the turn ends.

- **Stop button loading indicator uses a Loader2 ring layered with the Square glyph.** This composes the existing icons (`Square`, `Loader2`) without adding a new asset and keeps `isInterrupting`'s "Stopping…" spinner state visually distinct.

---

## Implementation Units

### U1. Concurrent-safe runtime creation in chatService

**Goal:** Make `chatService.getOrCreateRuntime` safe for concurrent invocation so the `GET /stream` and `POST /messages` race for the same session converges on a single `SessionRuntime` instance.

**Requirements:** R10, R11, R18.

**Dependencies:** None.

**Files:**
- Modify: `src/server/services/chat-service.ts`

**Approach:**

- Add a private `creatingRuntimes = new Map<string, Promise<SessionRuntime>>()` on `ChatService`.
- Refactor `getOrCreateRuntime`:
  1. If `runtimes.has(sessionId)`, return it (unchanged).
  2. If `creatingRuntimes.has(sessionId)`, return the pending promise.
  3. Otherwise, build an inner async function that performs the existing work (workspace lookup, session lookup, options build, `SessionRuntime.open`, `runtimes.set`, draft flag clear), invoke it, and put the resulting promise into `creatingRuntimes` **before** awaiting.
  4. In a `finally`, delete the inflight entry.
- The synchronous order (`set` into `creatingRuntimes` before any `await`) is what makes the dedup safe: the second concurrent caller observes the pending entry on the same microtask.
- No change to the public signature; routes are unaffected.

**Patterns to follow:**

- The shape of the existing `runtimes: Map<string, SessionRuntime>` registry. The new inflight Map mirrors it but stores promises.

**Test scenarios:**

- Happy path: a single call to `getOrCreateRuntime` constructs and registers exactly one runtime.
- Integration (the bug): two concurrent calls for the same sessionId (one from GET /stream, one from POST /messages) resolve to the same `SessionRuntime` instance; `runtimes` ends up with exactly one entry; no orphan runtime is created. Verifiable in dev server by sending the first message on a fresh draft and confirming the response streams without switching sessions.
- Error path: a creation failure (e.g., `workspace not found`) rejects both concurrent callers, and the inflight entry is removed so a subsequent retry can proceed.
- Sequential calls (one resolves, then another fires) continue to return the same cached runtime via the existing `runtimes.get` short-circuit.

**Verification:** `npm run lint` + `npm run build:server`. Manual: open a new draft session and send a prompt — the streaming response should render without needing to switch sessions.

---

### U2. Gate first-send on subscription acknowledgement in chat-store

**Goal:** Prevent the client from POSTing a user message before the server has wired up the SSE response, so events emit to a connected subscriber instead of only into the ring buffer.

**Requirements:** R10, R11, R18.

**Dependencies:** None. (Works alongside U1; either alone narrows the bug, both together close it.)

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**

- Add `pendingSend: Record<string, { workspaceId: string; content: string } | undefined>` to `ChatState`.
- In `sendMessage`:
  - Keep the existing subscribe-if-not-subscribed step, the optimistic local user-message add, the `isStreaming = true` flip, and the approval-pending branch that writes to `draftQueue` (unchanged).
  - Before the POST, check `get().serverNonce[sessionId]`. If unset, write `{ workspaceId, content }` into `pendingSend[sessionId]` and return without POSTing. If set, POST immediately (existing behavior).
- In the `subscription_ack` handler:
  - After recording the nonce (existing behavior), read `state.pendingSend[sessionId]`. If present, clear it and fire the same `POST /api/workspaces/${workspaceId}/sessions/${sessionId}/messages` request used by `sendMessage`. Use the same network-failure handler shape (`addSystemMessage` on error).
- Initialize `pendingSend: {}` in the store factory.
- On `deleteSession`, clear the per-session entry alongside the other per-session cleanups (mirrors how `draftQueue` is cleared at `chat-store.ts:613`).
- Approval-pending still wins: if approval is queued when sendMessage runs, the existing `draftQueue` path handles it. Both gates can coexist — approval queue holds for "pending approval", subscription gate holds for "pre-ack".

**Test scenarios:**

- Happy path (post-fix golden case): create a draft, type, click Send. Optimistic user message appears, Stop button shows. Within a tick, `subscription_ack` arrives, the queued POST fires, assistant streaming events flow into the page.
- Integration: send the second message in the same session (subscription already acked from the first send) → POST fires immediately, no queue path.
- Edge: subscription_ack arrives without a pending send (normal subscribe after switching sessions) → no spurious POST.
- Edge: `deleteSession` while a pending send exists → entry removed; no orphaned POST fires later.
- Edge case (carried over): approval-pending takes precedence — `draftQueue` path executes when an approval is in the queue, regardless of `pendingSend` state.

**Verification:** `npm run lint` + `npm run build`. Manual: confirm the streaming response renders on the first send in a freshly created draft session, without any need to switch sessions.

---

### U3. Clear session streaming flag on turn end and add Stop-button loading indicator

**Goal:** Surface the streaming lifecycle correctly in the UI — `isStreaming[sessionId]` flips back to `false` when the SDK signals turn end, and the Stop button renders with a loading indicator while streaming so the user sees the turn is in progress.

**Requirements:** R6, R8.

**Dependencies:** None.

**Files:**
- Modify: `src/client/stores/chat-store.ts`
- Modify: `src/client/components/PromptInput.tsx`

**Approach:**

- In `chat-store.handleSseEvent` (`src/client/stores/chat-store.ts:192`):
  - Replace the no-op `result` case (currently in the `default` branch) with an explicit handler that sets `isStreaming[sessionId] = false`.
  - Keep `assistant_done` unchanged (it remains per-message); it does not need to touch the session flag now that `result` is handled.
  - The existing `interrupted` handler and the subscribe `.catch` path keep their `isStreaming` clears; both remain authoritative for their respective lifecycles.
- In `PromptInput.tsx` (`src/client/components/PromptInput.tsx:87`):
  - When `isStreaming && !isInterrupting`, render the Stop trigger with a small `Loader2` rotating ring positioned behind the `Square` glyph (use the existing lucide-react imports — no new icons). Keep the existing `isInterrupting` branch (Loader2 alone, "Stopping…" label) intact for the post-confirm state.
  - Tune the loading visual to be distinct from the `isInterrupting` spinner so users can tell "Claude is streaming" from "your interrupt is in flight."

**Test scenarios:**

- Happy path: send a prompt → Stop button shows with loading indicator → assistant text streams → `result` event arrives → button reverts to Send.
- Multi-turn: complete one turn, send again → flag correctly flips true → false on each turn boundary; button toggles cleanly.
- Interrupt path: send → click Stop → confirm → `interrupted` event arrives → flag flips false → button reverts to Send. The interrupting-spinner state is visually distinguishable from the streaming-loading state.
- Error path: server emits `error` SSE → existing throw → subscribe `.catch` clears `isStreaming` (already covered, regression check).
- Reconnect after a turn already completed: open a session whose turn completed while the user was on a different session → replayed `result` event lands → `isStreaming` stays false (no flicker).

**Verification:** `npm run lint` + `npm run build`. Manual: send several prompts in sequence, then test interrupt mid-stream — Send/Stop transitions should be crisp and the streaming-loading indicator should be visible during turns.

---

## System-Wide Impact

- **Interaction graph:** The fix touches the request-handling path (`getOrCreateRuntime`), the SSE event loop on the client (`handleSseEvent`), and the input component (`PromptInput`). The `SessionRuntime`, `SseEmitter`, and approval flow are unchanged.
- **State lifecycle risks:** `creatingRuntimes` entries must be cleaned up in `finally` to avoid permanent lockout on transient failures. `pendingSend` entries must be cleared on `deleteSession` (covered in U2).
- **API surface parity:** None — no route, schema, or SSE event types change.
- **Unchanged invariants:** SSE protocol, ring buffer semantics, `Last-Event-ID` replay on reconnect, approval/question banner queueing, `setActiveSession` subscribe behavior.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `creatingRuntimes` leak on rejection | Use `try { … } finally { creatingRuntimes.delete(sessionId) }` around the inner async work so failures clear the entry. Test the workspace-not-found path. |
| Stop-button loading indicator becomes visually identical to "Stopping…" spinner | Pick distinct compositions (streaming = Loader2 ring + Square; stopping = Loader2 alone with text) and verify side-by-side in dev. |
| Subsequent races outside the first-send window (e.g., approval flow timing) | Out of scope — the reported bug is the first-send-on-draft path; approval queueing already has its own gate (`draftQueue`). |
| `result` event semantics differ from expectation (e.g., does not fire on error subtypes) | The SDK emits `result` for both success and non-success terminal states (see `sse-emitter.ts:100-118`), and `error` keeps clearing `isStreaming` via the existing throw → catch path. |

---

## Sources & References

- **Origin requirements doc:** [docs/brainstorms/2026-05-16-prompt-input-and-streaming-input-mode-requirements.md](../brainstorms/2026-05-16-prompt-input-and-streaming-input-mode-requirements.md) — R6, R8, R10, R11, R18.
- **Predecessor plan:** [docs/plans/2026-05-16-009-feat-streaming-input-mode-prompt-input-plan.md](2026-05-16-009-feat-streaming-input-mode-prompt-input-plan.md) — U3 (SessionRuntime), U5 (routes), U9 (chat-store), U10 (ChatPanel integration). This plan corrects post-implementation defects in U9 and U10's runtime interaction.
- **Relevant code:**
  - `src/server/services/chat-service.ts:148` — `getOrCreateRuntime`
  - `src/server/services/session-runtime.ts:176` — `subscribe`
  - `src/client/stores/chat-store.ts:192` — `handleSseEvent`
  - `src/client/stores/chat-store.ts:659` — `sendMessage`
  - `src/client/components/PromptInput.tsx:87` — Stop button render
