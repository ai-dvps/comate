---
title: Fix SSE heartbeat and read-timeout recovery
type: fix
status: completed
date: 2026-05-24
---

# Fix SSE heartbeat and read-timeout recovery

## Summary

Add periodic server-to-client SSE heartbeat events so the client can distinguish an idle but healthy connection from a silently dropped one, and fix the client's read-timeout abort path so it actually reconnects instead of permanently dropping the subscription.

---

## Problem Frame

SSE connections can be silently dropped by proxies, load balancers, or OS network stacks when no data flows for an extended period. The client currently guards against this with a 30-second read timeout (`readTimeout`) that aborts the `fetch` connection if no events arrive. However:

1. **The server never emits keepalive frames**, so the timeout fires during normal idle periods (e.g., waiting for tool approval, long model thinking), causing unnecessary reconnects.
2. **The client's abort handler treats all `AbortError`s as intentional closes** and returns without retry. When the read timeout fires, the subscription is permanently lost even though the user never asked to close it.

These two issues compound: without heartbeats, idle connections look dead; without retry on timeout, dead connections are never recovered.

---

## Requirements

- **R1.** Server emits a lightweight heartbeat event at a regular interval while a client is actively subscribed to a session stream.
- **R2.** Heartbeat events bypass the ring buffer — they are pure keepalive with no replay value.
- **R3.** Client resets its connection-deadline timer on every heartbeat and reconnects via exponential backoff when heartbeats are missed.
- **R4.** Intentional client disconnects (session switch, tab close) do not trigger retry.

---

## Scope Boundaries

- Does not change the SSE protocol beyond adding the `heartbeat` event type.
- Does not change the retry backoff parameters (base 2s, max 30s, max 5 attempts).
- Does not change the ring buffer capacity or replay logic.
- Does not add client-to-server pings or bidirectional heartbeat.

### Deferred to Follow-Up Work

- Configurable heartbeat interval (hardcoded 15s is sufficient for current deployment).

---

## Context & Research

### Relevant Code and Patterns

- `src/server/services/sse-emitter.ts` — `SseEmitter.send()` is the single emission point; it formats `id:`, `event:`, and `data:` lines and pushes to the ring buffer via `onEvent`.
- `src/server/services/session-runtime.ts` — `subscribe()` / `unsubscribe()` manage the active `Response`; `close()` tears down the runtime. `RING_BUFFER_CAP = 500`.
- `src/server/routes/chat.ts` — Express route wires `runtime.subscribe(res)` on connect and `runtime.unsubscribe(res)` on `req.close`.
- `src/client/stores/chat-store.ts` — `subscribeToSession()` manages the `fetch` + `AbortController` lifecycle, the 30s `readTimeout`, and exponential-backoff retry.
- `src/server/types/message.ts` and `src/client/types/message.ts` — Must remain byte-identical; CI verifies with `diff`.

### Institutional Learnings

- `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md` — A prior incident where clean SSE stream closes caused silent connection loss. The doc explicitly recommends adding a lightweight heartbeat/ping frame.
- `docs/plans/2026-05-21-001-fix-sse-subscription-race-condition-plan.md` — `unsubscribe(res)` is guarded by response identity; only clears `activeRes` when the closed response is still the active one. Heartbeat timer must respect the same guard.
- `docs/plans/2026-05-18-006-fix-sse-stream-resume-on-reconnect-plan.md` — Ring buffer replay uses event IDs; heartbeats must not carry IDs to avoid polluting `lastEventId` and causing full-buffer replay on reconnect.

---

## Key Technical Decisions

- **Heartbeat bypasses ring buffer.** Heartbeats are emitted via a dedicated `SseEmitter.emitHeartbeat()` method that writes directly to `this.res` without an `id:` line, without incrementing `eventIndex`, and without calling `onEvent`. This keeps the 500-slot ring buffer for semantic events only.
- **Heartbeat timer lives in `SessionRuntime`.** The timer is a `NodeJS.Timeout` property started in `subscribe()` (if not already running) and stopped in `unsubscribe()` only when the closed response is the active one, or in `close()`. This matches the existing single-subscriber invariant and the guarded-unsubscribe pattern.
- **Client read timeout raised to 35s.** With a 15s heartbeat interval, 35s allows two heartbeats to be missed (30s) plus 5s of network jitter before declaring the connection dead.
- **Distinguish timeout abort from intentional abort.** A boolean flag `abortedIntentionally` is set inside `thisClose()` before calling `abortController.abort()`. The `.catch()` handler checks this flag: `true` means the user/session-switch initiated the close — return without retry; `false` means the read timeout fired — fall through to the retry logic.

---

## Open Questions

### Resolved During Planning

- **Should heartbeats be sent during `replayFrom()`?** No. Replays are expected to complete quickly (500 events max). Interleaving heartbeats would complicate direct `res.write` calls in `replayFrom` without meaningful benefit.
- **Should `close()` call `unsubscribe()`?** Yes. `close()` must clear `activeRes` and stop the heartbeat timer to prevent `res.write()` on a closed response.

### Deferred to Implementation

- None.

---

## Implementation Units

### U1. Add heartbeat event type to shared SseEvent union

**Goal:** Define the heartbeat event shape in the shared server/client protocol type.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/server/types/message.ts`
- Modify: `src/client/types/message.ts`

**Approach:**
- Append `{ type: 'heartbeat' }` to the `SseEvent` discriminated union in both files.
- Keep the two files byte-identical.

**Patterns to follow:**
- Match the existing union-member style (no trailing comma on the last member before heartbeat, or adjust as needed to maintain formatting).

**Test scenarios:**
- **Happy path:** `diff src/server/types/message.ts src/client/types/message.ts` returns no output.

**Verification:**
- `npm run diff-message-types` or equivalent CI check passes.

---

### U2. Emit heartbeat from server while subscriber is active

**Goal:** Server emits a heartbeat every 15 seconds when a client is subscribed, bypassing the ring buffer, and cleans up the timer on unsubscribe or runtime close.

**Requirements:** R1, R2

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/sse-emitter.ts`
- Modify: `src/server/services/session-runtime.ts`

**Approach:**

In `SseEmitter`:
- Add `emitHeartbeat(): void` that writes `event: heartbeat\ndata: {}\n\n` directly to `this.res` when present. This method must not touch `eventIndex`, `onEvent`, or the ring buffer.

In `SessionRuntime`:
- Add `private heartbeatTimer?: NodeJS.Timeout`.
- In `subscribe(res)`, after setting `this.activeRes = res`, start the timer if it is not already running:
  ```
  if (!this.heartbeatTimer) {
    this.heartbeatTimer = setInterval(() => this.emitter.emitHeartbeat(), 15000);
  }
  ```
- In `unsubscribe(res)`, when `(!res || this.activeRes === res)` causes `emitter.setResponse(null)` to run, also clear the timer and set it to undefined.
- In `close()`, clear the timer if present and call `this.unsubscribe()` to ensure `activeRes` is nulled and the emitter is detached.

**Technical design:**
> *Directional guidance, not implementation specification.*
>
> The heartbeat is intentionally outside the normal `send()` pipeline because it has no semantic value for replay. Writing raw SSE bytes avoids ID allocation, ring buffer churn, and `lastEventId` pollution. The timer is owned by `SessionRuntime` because that class already manages the subscribe/unsubscribe lifecycle.

**Patterns to follow:**
- Match the existing `diagLog`/`diagWarn` logging style.
- Match the existing `unsubscribe` guard pattern (only clear when `res` matches `activeRes`).

**Test scenarios:**
- **Happy path:** Client subscribes → heartbeat events arrive every ~15s during idle periods.
- **Edge case:** Client subscribes, then unsubscribes → heartbeats stop.
- **Edge case:** Client subscribes, stale connection's `close` fires asynchronously after a new `subscribe` → heartbeat timer continues firing on the new subscriber, not the old one.
- **Edge case:** `SessionRuntime.close()` is called while a client is connected → heartbeats stop immediately, no `res.write` on closed response.
- **Integration:** Heartbeat does not appear in the ring buffer — reconnecting with `Last-Event-ID` set to the last real event replays only real events, not heartbeats.

**Verification:**
- Open browser DevTools Network tab, subscribe to a session, wait 15s → observe `heartbeat` SSE frames with no `id:` line.
- Reconnect with `Last-Event-ID` set to a prior real event → verify heartbeats are not replayed.

---

### U3. Handle heartbeat on client and fix read-timeout recovery

**Goal:** Client no-ops heartbeat events, extends the read timeout to 35s, and fixes the `AbortError` handling so timeout-driven aborts trigger retry.

**Requirements:** R3, R4

**Dependencies:** U1, U2

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**

1. **Handle heartbeat event:** Add a `case 'heartbeat':` in `handleSseEvent` that returns immediately (no-op). The `resetReadTimeout()` call in the `for await` loop already fires before `handleSseEvent` is invoked, so heartbeats naturally keep the connection alive.

2. **Extend read timeout:** Change the `setTimeout` duration in `resetReadTimeout` from `30000` to `35000`.

3. **Fix `AbortError` retry:** Introduce a boolean flag scoped to each `connect()` invocation:
   - Declare `let abortedIntentionally = false` inside `connect()`.
   - In `thisClose()`, set `abortedIntentionally = true` before calling `abortController.abort()`.
   - In the `.catch()` handler, replace the blanket `if (err.name === 'AbortError') { return; }` with:
     ```typescript
     if (err.name === 'AbortError') {
       if (abortedIntentionally) {
         diagLog(`[SSE ${sessionId}] subscription aborted intentionally`)
         return
       }
       // Timeout-driven abort — fall through to retry logic
     }
     ```
   - The retry logic (exponential backoff, max attempts, system message on exhaustion) remains unchanged and is now reachable for timeout aborts.

**Patterns to follow:**
- Match existing `diagLog` / `diagWarn` patterns.
- Preserve the existing retry backoff math and max-attempt messaging.

**Test scenarios:**
- **Happy path:** Heartbeat arrives → `resetReadTimeout()` fires → connection stays open past 30s.
- **Happy path:** No heartbeats for 35s → client aborts, reconnects with exponential backoff, replays missed events.
- **Edge case:** User switches sessions → `thisClose()` sets `abortedIntentionally = true` → `.catch()` returns without retry.
- **Edge case:** Read timeout fires after 35s → `.catch()` falls through to retry → `connect()` is scheduled with backoff.
- **Edge case:** Max retry attempts exceeded after timeout → client shows "Connection lost" system message and stops retrying.
- **Integration:** Server restart (new nonce) after a timeout-driven reconnect → client shows "Server was restarted" message and replays from `Last-Event-ID` correctly.

**Verification:**
- Subscribe to a session, let it idle → verify no reconnect occurs before 35s; heartbeats appear in Network tab every ~15s.
- Block heartbeats at network layer (e.g., throttle to offline in DevTools after connection) → verify client reconnects within ~35-40s.
- Switch to another session and back → verify old subscription closes cleanly with no retry storm.

---

## System-Wide Impact

- **Interaction graph:** `SessionRuntime.subscribe` starts the heartbeat; `SseEmitter.emitHeartbeat` writes the frame; client `parseSSEStream` yields it; `handleSseEvent` no-ops it. The `resetReadTimeout` call in the `for await` loop is the critical handshake.
- **Error propagation:** If `res.write()` throws during heartbeat (e.g., client already closed TCP), the exception is caught by the interval callback's implicit try/catch (or Node.js uncaught exception handler). To be safe, wrap the interval callback body in a try/catch that logs and clears `activeRes` if a write fails.
- **State lifecycle risks:** The heartbeat timer must be cleared in three places: `unsubscribe` (when active), `close`, and any error path that nulls `activeRes`. Missing one creates a timer leak or a crash on closed-response write.
- **API surface parity:** No HTTP API changes. The SSE event vocabulary gains one member.
- **Unchanged invariants:** Ring buffer behavior, replay logic, exponential backoff parameters, background polling (`/sessions/status`), and the single-subscriber-per-session model are all untouched.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `res.write()` after response end throws and crashes the process | Wrap heartbeat emission in try/catch; on write failure, clear `activeRes` and stop the timer. |
| Heartbeat timer leaks if `unsubscribe` is called with a mismatched `res` | Timer is only cleared when `activeRes` is actually nulled (`!res \|\| this.activeRes === res`). On mismatch, timer keeps running — correct because the new subscriber is still active. |
| Client `parseSSEStream` yields heartbeat with no `id`, leaving `lastEventId` stale | Intended behavior — `lastEventId` should only advance on semantic events. The parser handles missing `id:` correctly. |
| 15s heartbeat is too chatty for battery-powered clients | Acceptable for desktop app context. Mobile optimization is deferred. |

---

## Documentation / Operational Notes

- No new user-facing documentation required. Heartbeat is a transport-level mechanism.
- Diagnostic logs (`diagLog`) will show heartbeat sends and timeout-driven reconnects.

---

## Sources & References

- Related plan: `docs/plans/2026-05-21-001-fix-sse-subscription-race-condition-plan.md` — guarded unsubscribe pattern
- Related plan: `docs/plans/2026-05-18-006-fix-sse-stream-resume-on-reconnect-plan.md` — ring buffer replay
- Related solution: `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md` — recommends heartbeat/ping frame
- Related code: `src/server/services/sse-emitter.ts`, `src/server/services/session-runtime.ts`, `src/client/stores/chat-store.ts`
- Type files: `src/server/types/message.ts`, `src/client/types/message.ts`
