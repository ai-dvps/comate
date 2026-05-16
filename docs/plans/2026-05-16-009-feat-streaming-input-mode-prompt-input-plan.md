---
title: 'feat: Streaming Input Mode, rich PromptInput, and approval banner'
type: feat
status: completed
date: 2026-05-16
origin: docs/brainstorms/2026-05-16-prompt-input-and-streaming-input-mode-requirements.md
---

# feat: Streaming Input Mode, rich PromptInput, and approval banner

## Summary

Migrate the server from per-turn `query({ prompt: string })` calls to one long-lived Streaming Input Mode `query()` per session (fed by a pushable async iterator), refactor the chat route from a single POST into a long-lived per-session SSE subscription plus small REST endpoints for message push, approval responses, and interrupt, and replace the single-line textarea with a new `PromptInput` component (auto-grow with height ceiling, Send/Stop/Clear, anchored Stop confirm popover) and an `ApprovalBanner` pinned above the input for `canUseTool` permissions and `AskUserQuestion` clarifying questions. Existing AI Elements rendering, draft-to-SDK session lifecycle, and all current SSE event types are preserved and only extended additively.

## Problem Frame

The chat panel uses a single-line `<textarea>` with `max-h-32` and no horizontal-overflow control (origin doc R1, R2). There is no way to interrupt a running turn, no Clear affordance, and the server speaks to the SDK in single-prompt mode (`query({ prompt: string })`) — which is incompatible with `canUseTool` callbacks and `AskUserQuestion`. The structural gap between the SDK's interactive surface and the app's one-shot HTTP shape is why approvals and clarifying questions are invisible today (origin doc Problem Frame). Fixing the input UX without the input-mode migration would leave the chat polished but still mute when Claude tries to talk back.

## Requirements

Carried forward from the origin brainstorm doc. See `docs/brainstorms/2026-05-16-prompt-input-and-streaming-input-mode-requirements.md` for full text (R1-R22, F1-F5, AE1-AE10).

**Prompt input behavior**
- R1. Auto-grow multi-line textarea up to a configured maximum height; vertical scrollbar past that.
- R2. No horizontal scrollbar; long lines wrap.
- R3. Placeholder text when empty; visually distinct focused state.
- R4. Enter sends, Shift+Enter inserts newline (unchanged).
- R5. Send button on the right; disabled when empty or no active session.

**Send / Stop / Clear**
- R6. Send replaced by Stop (with loading indicator) while streaming.
- R7. Stop opens anchored confirmation popover (Cancel / Confirm).
- R8. Button reverts to Send when turn completes or is interrupted.
- R9. Clear button empties textarea draft only.

**Session continuity**
- R10. New sessions send no resume ID; capture SDK session ID from response. Existing sessions resume.
- R11. Streaming Input Mode: one long-lived `query()` per session.

**Approvals and clarifying questions**
- R12. `canUseTool` banner pinned above input: tool name, input summary, Allow / Allow always / Deny.
- R13. Allow always echoes SDK suggestions as `updatedPermissions` (SDK writes `.claude/settings.local.json`).
- R14. Agent paused while approval pending; Send queued until resolved.
- R15. `AskUserQuestion` uses same banner surface with question/header/options; multi-select support.
- R16. One banner at a time, FIFO queue; not dismissable except by resolving.
- R17. Persisted rules honored by CLI and other SDK consumers.

**Background sessions and reconnection**
- R18. Server keeps `query()` alive when user switches sessions or closes tab.
- R19. Reconnect resubscribes and replays missed output via ring buffer.
- R20. Existing streaming rendering unchanged; approval banner is additive.

**Failure surfaces**
- R21. Interrupt failure shows system note; button stays in Stop state.
- R22. Server restart: next message reopens query with `resume`; system note explains lost work.

## Context & Research

### Relevant Code and Patterns

- `src/server/services/sdk-client.ts` — sole call site for `query()`. Currently wraps single-prompt mode. The streaming-input migration (U4) is the critical chokepoint: switching `prompt: string` to `prompt: AsyncIterable<SDKUserMessage>` enables `canUseTool` and `AskUserQuestion` callbacks.
- `src/server/services/chat-service.ts` — orchestrates session lifecycle and `sendMessage()`. Currently returns a per-turn `MessageStream` from a one-shot `createQuery()`. U5 restructures this to delegate to `SessionRuntime`.
- `src/server/services/sse-emitter.ts` — stateful per-stream SSE writer. Currently scoped to a single HTTP request's lifetime. After U5, a single `SseEmitter` instance lives inside `SessionRuntime` and writes to whichever SSE `Response` is currently subscribed.
- `src/server/routes/chat.ts` — Express router. The `POST /:sessionId/chat` handler (lines 80-138) runs a `for await` loop over one turn's messages. U5 replaces this with a long-lived `GET /:sessionId/stream` and separate REST endpoints.
- `src/client/stores/chat-store.ts` — Zustand store. `sendMessage` (lines 388-449) calls `fetch(...).then()` with a one-shot SSE consumer (`parseSseStream`). U9 refactors to manage a single `EventSource`-style subscription per active session.
- `src/client/components/ChatPanel.tsx` — current inline `<textarea>` (lines 89-99) with `max-h-32`, `rows={1}`, and a single Send icon button. U11 replaces this with the composed `PromptInput` + `ApprovalBanner`.
- `src/client/types/message.ts` + `src/server/types/message.ts` — byte-identical `SseEvent` discriminated union (lines 68-98). Extended additively in U2.
- `src/client/components/ui/collapsible.tsx` — Radix wrapper pattern (re-export with `'use client'` prefix). The new `popover.tsx` (U6) follows this pattern.
- `package.json` — no `@radix-ui/react-popover` yet; U6 adds it. No test framework; manual dev-server verification per repo precedent.

### External References

- Claude Agent SDK Streaming Input Mode: `query({ prompt: AsyncIterable<SDKUserMessage>, options })` with `canUseTool` callback — only fires in streaming mode.
- `canUseTool(toolName, input, options)` — options carries `suggestions?: PermissionUpdate[]`, `title`, `displayName`, `description`, `toolUseID`, `signal: AbortSignal`. Returns `PermissionResult`.
- `PermissionResult` allow variant: `{ behavior: 'allow', updatedInput?, updatedPermissions?: PermissionUpdate[] }`. Echoing `suggestions` as `updatedPermissions` triggers the SDK's "Approve and remember" pattern — SDK writes to `.claude/settings.local.json`.
- `AskUserQuestion` surfaces through `canUseTool` with `toolName === 'AskUserQuestion'`. Input has `questions: [{ question, header?, options: [{ label, description? }], multiSelect? }]`. Response: `{ behavior: 'allow', updatedInput: { questions: input.questions, answers: { [questionText]: 'label1,label2' } } }`.
- `Query.interrupt()` — safe to call mid-tool-call; returns control without corrupting the long-lived session.
- Session ID capture: `system` + `subtype: 'init'` event carries `session_id` field.

### Institutional Learnings

- None — `docs/solutions/` does not exist in this repo yet.

## Key Technical Decisions

- **Long-lived `query()` per session in a `SessionRuntime` registry.** The server holds one `SessionRuntime` per active session. Each owns a pushable async iterator (input channel), the `Query` object, a ring buffer of recent SSE events for replay, and a pending-approval resolver map. The registry is an in-memory `Map<string, SessionRuntime>` on `chatService`. When a session is deleted or the server shuts down, the runtime is torn down. (See origin: Key Decisions, bullet 1.)

- **Single long-lived SSE per session view with ring-buffer replay.** Alternative: hybrid (persistent control-plane SSE + per-turn content streams). The single-stream shape is simpler: the client opens `GET /sessions/:id/stream` and keeps it open; the server writes all events (streaming output, approval requests, system notes) through one pipe. A server-side ring buffer (cap ~500 events) stores recent output for replay when the client reconnects. Client sends `Last-Event-Id` header on reconnect to skip already-seen events. (See origin: Key Decisions, bullet 2 — banner choice is separate from subscription model.)

- **Banner above input for both `canUseTool` and `AskUserQuestion`.** Same visual surface, same FIFO queue, two payload shapes. Alternatives: inline message card (mixes decision UI with content), modal (disruptive). The banner pins the request and lets the user keep reading underneath. (See origin: Key Decisions, bullet 2.)

- **Forward SDK `suggestions` verbatim as `updatedPermissions`.** The SDK provides pre-built `PermissionUpdate[]` objects in the `canUseTool` callback's options. Echoing them back triggers the SDK's built-in persistence to `.claude/settings.local.json`. The app does not construct its own rules and does not maintain a parallel store. Free interop with CLI and other SDK consumers in the same workspace. (See origin: Key Decisions, bullet 3.)

- **Stop = `query.interrupt()` of the current turn, not session teardown.** The long-lived query stays open after interrupt. A follow-up message can be sent immediately. (See origin: Key Decisions, bullet 4.)

- **Anchored Radix Popover for Stop confirmation.** Follows the `collapsible.tsx` wrapper pattern already in the repo. Lightweight, dismissable with Escape, explicitly gated behind Cancel/Confirm. (See origin: Key Decisions, bullet 5.)

- **Server-start nonce for restart detection.** A process-unique string generated once at server boot. Emitted in the `subscription_ack` event. If the client reconnects and sees a different nonce, it knows the server restarted and any running sessions' background work was lost — it shows a system note per R22.

- **Ring buffer cap ~500 events, in-memory per session.** Sufficient for 30+ seconds of streaming output replay. Not persisted; a server restart loses the buffer (acceptable per R22). The cap is a constant, not user-configurable (scope boundary).

- **SseEmitter refactored for swappable Response.** The current `SseEmitter` binds `Response` in its constructor. After U5, a single `SseEmitter` lives inside `SessionRuntime` and must write to whichever SSE `Response` is currently subscribed — or to the ring buffer when no client is connected. The refactor adds a `setResponse(res: Response | null)` method and a null guard in `send()`. When `activeResponse` is null, events go only to the ring buffer. This is an explicit modification scoped in U2.

- **SSE `id:` field emitted on every frame.** The current `SseEmitter.send()` writes only `event:` and `data:` lines. Without an `id:` line, the client cannot send `Last-Event-Id` on reconnect, making ring-buffer replay dead code. U2 adds a monotonically increasing event counter and emits `id: <n>\n` before the `data:` line. The client's `parseSseStream` is extended to capture and store the last-seen event ID.

- **AbortSignal wired into approval Promise.** The SDK's `canUseTool` callback receives an `AbortSignal` in its options. If the SDK aborts the tool call (subprocess crash, turn timeout), the signal fires. U3 attaches `signal.addEventListener('abort', ...)` to resolve the parked approval Promise with `{ behavior: 'deny', message: '...' }` (not `reject()`) and emit an `approval_resolved` event, preventing zombie sessions. Using `resolve` instead of `reject` avoids propagating an unhandled rejection into the SDK, which could leave the query in an unusable state.

- **No test framework introduced.** Per repo precedent (plans 005-008), manual dev-server verification is sufficient. Each unit enumerates specific test scenarios.

- **Draft session lifecycle preserved.** The existing flow — draft store creates a local stub, first message promotes it to an SDK session via `sessionId` option, `clearDraftFlag` fires after the turn — is unchanged. The `SessionRuntime` opens on first message send and closes when the session is deleted.

## Implementation Units

### U1. PushableIterator utility

**Goal:** Provide a reusable async-iterator primitive that the `SessionRuntime` uses as its input channel. Supports `push(value)`, `close()`, and `Symbol.asyncIterator`.

**Requirements:** R11 (Streaming Input Mode backbone).

**Dependencies:** None.

**Files:**
- Create: `src/server/services/pushable-iterator.ts`

**Approach:**

- Export class `PushableIterator<T> implements AsyncIterable<T>`.
- Internal state: a queue `T[]`, a deferred-resolve pair `(resolve: (result: IteratorResult<T>) => void) | null`, and a `closed` flag.
- `push(value)`: if a deferred reader is waiting, resolve it with `{ value, done: false }`; otherwise enqueue.
- `close()`: set `closed = true`; if a deferred reader is waiting, resolve with `{ value: undefined, done: true }`.
- `[Symbol.asyncIterator]()`: returns an async iterator whose `next()` either dequeues or parks on a new Promise.
- No back-pressure logic — the SDK pulls at its own pace; if the user sends faster than the SDK processes, the queue grows in memory (bounded by human typing speed, not a concern).

**Test scenarios:**
- Push three values then close → iterator yields all three then completes.
- Close with no values → iterator completes immediately.
- Push after close → values are silently dropped (or throw; pick one and document).

**Verification:** `npm run lint` + `npm run build:server`.

### U2. SSE event protocol additions

**Goal:** Extend the shared `SseEvent` discriminated union with new event types for subscriptions, approvals, interrupt feedback, and server restarts. Update the `SseEmitter` to emit them.

**Requirements:** R12, R14, R15, R18, R19, R20, R21, R22.

**Dependencies:** None (types-only for the union; emitter changes are internal).

**Files:**
- Modify: `src/client/types/message.ts`
- Modify: `src/server/types/message.ts` (keep byte-identical)
- Modify: `src/server/services/sse-emitter.ts`

**Approach:**

Add these variants to `SseEvent`:

```
| { type: 'subscription_ack'; serverNonce: string; sessionId: string }
| { type: 'pending_approval'; requestId: string; toolName: string; toolUseId: string; input: unknown; title?: string; description?: string; suggestions?: PermissionUpdate[] }
| { type: 'pending_question'; requestId: string; questions: QuestionPayload[] }
| { type: 'approval_resolved'; requestId: string }
| { type: 'interrupted'; messageId: string | null }
| { type: 'error_note'; text: string }
| { type: 'server_restarted'; serverNonce: string }
```

Where `QuestionPayload` is `{ question: string; header?: string; options: { label: string; description?: string; preview?: string }[]; multiSelect: boolean }`.

`PermissionUpdate` is imported from the SDK types — no re-declaration.

Add methods to `SseEmitter`:
- `emitSubscriptionAck(serverNonce, sessionId)`
- `emitPendingApproval(...)` — extracts a summary string from `input` for display (first ~200 chars of JSON, or a one-line key summary).
- `emitPendingQuestion(requestId, questions)`
- `emitApprovalResolved(requestId)`
- `emitInterrupted(messageId)`
- `emitErrorNote(text)`
- `emitServerRestarted(serverNonce)`

Refactor `SseEmitter` constructor to accept `Response | null`. Add `setResponse(res: Response | null)` for swapping the active subscriber. Add a null guard in `send()`: when `this.res` is null, events go only to the ring buffer (passed via a callback or stored reference from `SessionRuntime`). Add `reset()` method that clears all per-turn state (`currentMessageId`, `assistantStartEmitted`, `blockStates`, `seenStreamPartIndexes`, `finalizedMessageIds`) — called when `assistant_start` fires for a new turn within the long-lived session, preventing state bleed across turns.

Add a monotonically increasing `eventIndex: number` counter. `send()` now writes `id: ${this.eventIndex++}\n` before the `event:` line. This enables the client to send `Last-Event-Id` on reconnect for ring-buffer replay (R19).

The existing `handle(msg: SDKMessage)` method and all current event emissions are unchanged (R20). The new methods are called only from `SessionRuntime`.

**Test scenarios:**
- `subscription_ack` serializes with correct nonce and session ID.
- `pending_approval` with a large Bash command input → input summary is truncated to ~200 chars.
- `pending_question` with two questions (one multiSelect) serializes correctly.
- All new events parse cleanly from the client's `parseSseStream`.
- Existing events (`text_delta`, `tool_use_start`, etc.) still emit and parse correctly.

**Verification:** `npm run lint` + `npm run build` + byte-identical diff check on the two message.ts files.

### U3. SessionRuntime registry

**Goal:** Own the lifecycle of one long-lived `query()` per session: open the query, wire the pushable input channel and `canUseTool` callback, buffer events for replay, resolve or queue approval responses, and emit all output through a single `SseEmitter`.

**Requirements:** R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R22.

**Dependencies:** U1 (PushableIterator), U2 (event protocol), U4 (streaming-input SdkClient).

**Files:**
- Create: `src/server/services/session-runtime.ts`

**Approach:**

Export class `SessionRuntime`:

```
class SessionRuntime {
  private input: PushableIterator<SDKUserMessage>
  private query: Query
  private emitter: SseEmitter
  private ringBuffer: SseEvent[]          // cap ~500
  private pendingApprovals: Map<string, { resolve: (result: PermissionResult) => void }>
  private activeResponse: Response | null  // current SSE subscriber

  // Called when the runtime needs to emit an event — writes to both the
  // active Response and the ring buffer.
  private emit(event: SseEvent): void

  // Subscription management
  subscribe(res: Response): void           // swap active response
  unsubscribe(): void                      // clear active response

  // User actions (called from REST handlers)
  pushMessage(content: string): void       // push user message into input channel
  resolveApproval(requestId: string, result: PermissionResult): void
  interrupt(): Promise<void>

  // Ring buffer replay
  replayFrom(lastEventId: string | undefined, res: Response): void

  // Lifecycle
  close(): void
}
```

**Opening a runtime:**

`chatService` calls `SessionRuntime.open(session, workspace, serverNonce)`:
1. Create a `PushableIterator<SDKUserMessage>`.
2. Call `sdkClient.createStreamingQuery(inputIterator, options, canUseToolCallback)`.
3. Create a fresh `SseEmitter` (initially with no `Response` — events buffer in `ringBuffer`).
4. Start an async loop: `for await (const msg of this.query) { this.emitter.handle(msg); }` — each event the emitter produces also gets pushed into `ringBuffer` (capped, oldest evicted).
5. When the loop ends (turn completes), the query stays alive waiting for the next `push()` on the input channel.

**canUseTool callback:**

```
async (toolName, input, options) => {
  const requestId = options.toolUseID || generateId();

  if (toolName === 'AskUserQuestion') {
    // Parse questions from input, emit pending_question event
    this.emit({ type: 'pending_question', requestId, questions: parsedQuestions });
  } else {
    // Emit pending_approval event
    this.emit({ type: 'pending_approval', requestId, toolName, input, ... });
  }

  // Return a Promise that the REST handler resolves
  return new Promise<PermissionResult>((resolve, reject) => {
    this.pendingApprovals.set(requestId, { resolve });

    // Wire SDK AbortSignal — if the SDK aborts this tool call (subprocess
    // crash, turn timeout), resolve with deny (not reject) so the SDK
    // receives a well-formed denial instead of an unhandled rejection.
    if (options.signal) {
      const onAbort = () => {
        this.pendingApprovals.delete(requestId);
        this.emit({ type: 'approval_resolved', requestId });
        resolve({ behavior: 'deny', message: `Tool approval aborted by SDK: ${requestId}` });
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
```

**resolveApproval(requestId, result):**

Looks up the pending resolver, calls it, emits `approval_resolved`, removes from map. If the result carries `updatedPermissions` (Allow always), those are forwarded to the SDK as-is — the SDK handles persistence.

**pushMessage(content):**

Constructs `{ type: 'user' as const, message: { role: 'user' as const, content }, parent_tool_use_id: null }` and calls `this.input.push(...)`. The `parent_tool_use_id` field is required by the SDK's `SDKUserMessage` type; `null` indicates a top-level user message.

**interrupt():**

Calls `this.query.interrupt()`. On success, emits `interrupted`. On failure, emits `error_note` per R21.

**subscribe(res: Response):**

Sets `activeResponse`. The `SseEmitter` now writes to this response. Sends `subscription_ack` with the server nonce. If the client sends `Last-Event-Id`, calls `replayFrom` first.

**Ring buffer replay:**

Linear scan from the event after `Last-Event-Id` to the end; write each buffered event to the new `Response`. If `Last-Event-Id` is not found in the buffer (evicted by the cap), replay the entire buffer as a best-effort catch-up and emit an `error_note` warning that some output may have been lost.

**Server nonce:**

Generated once at server startup in `chatService`. Stored as a module-level constant. If the client reconnects with a different nonce cached, `subscription_ack` still sends the current nonce, and the client detects the mismatch and shows a system note (R22).

**Test scenarios:**
- Open runtime, push a message → query starts, events flow to ring buffer.
- Subscribe a Response → `subscription_ack` sent, then live events flow.
- Disconnect (unsubscribe) while a turn is running → events buffer in ring buffer.
- Reconnect with `Last-Event-Id` → replayed events precede live events.
- `canUseTool` fires → `pending_approval` emitted, runtime pauses until `resolveApproval` called.
- `resolveApproval` with `updatedPermissions` → runtime forwards to SDK, emits `approval_resolved`.
- Interrupt succeeds → `interrupted` emitted, query stays open.
- Interrupt fails → `error_note` emitted.
- Close runtime → input channel closed, query ends.

**Verification:** `npm run lint` + `npm run build:server`. Manual integration test via U5 routes + U9 store in the dev server.

### U4. SdkClient streaming-input mode

**Goal:** Add a `createStreamingQuery` method that accepts an `AsyncIterable<SDKUserMessage>` and a `canUseTool` callback, and calls `query()` in Streaming Input Mode.

**Requirements:** R11 (backbone for streaming input).

**Dependencies:** U1 (PushableIterator, imported by SessionRuntime, not directly by SdkClient).

**Files:**
- Modify: `src/server/services/sdk-client.ts`

**Approach:**

Add to `SdkClient`:

```
createStreamingQuery(
  input: AsyncIterable<SDKUserMessage>,
  options: Options,
): QueryResult {
  const q = query({
    prompt: input,
    options: {
      ...options,
      includePartialMessages: true,
      toolConfig: {
        askUserQuestion: { previewFormat: 'markdown' },
      },
    },
  });

  async function* messageGenerator(): AsyncGenerator<SDKMessage> {
    for await (const msg of q) {
      yield msg;
    }
  }

  return { query: q, messages: messageGenerator() };
}
```

Note: `canUseTool` is passed inside the `options` object by the caller (`chatService.buildSdkOptions` or `SessionRuntime.open`), not as a separate parameter. The SDK's `query()` signature is `query({ prompt, options? })` where `Options` includes `canUseTool`. The caller constructs the full options including the callback; `createStreamingQuery` spreads and augments.

The existing `createQuery(prompt: string, options)` is preserved for backward compatibility during migration — it is removed once U5 is complete.

Import `PermissionResult`, `PermissionUpdate` from `@anthropic-ai/claude-agent-sdk`.

**Test scenarios:**
- `createStreamingQuery` with a pushable iterator → query opens, yields messages.
- `canUseTool` callback fires when a non-auto-approved tool is attempted.
- Existing `createQuery` still compiles and works (backward compat during migration).

**Verification:** `npm run lint` + `npm run build:server`.

### U5. Chat routes restructure

**Goal:** Replace the per-turn `POST /:sessionId/chat` with a long-lived SSE subscription and separate REST endpoints for message push, approval resolution, and interrupt.

**Requirements:** R6, R7, R10, R11, R12, R13, R14, R15, R16, R18, R19, R21, R22.

**Dependencies:** U2 (event types and SseEmitter refactor), U3 (SessionRuntime).

**Files:**
- Modify: `src/server/routes/chat.ts`
- Modify: `src/server/services/chat-service.ts`

**Approach:**

**New route: `GET /sessions/:sessionId/stream`**

- Looks up or creates a `SessionRuntime` for the session.
- Sets SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`).
- Calls `runtime.subscribe(res)`.
- On client disconnect (`req.on('close')`), calls `runtime.unsubscribe()`.
- Does NOT close the runtime — the query stays alive (R18).

**New route: `POST /sessions/:sessionId/messages`**

- Validates `{ message: string }`.
- Looks up the `SessionRuntime`.
- If no runtime exists (first message to a draft, or server restarted), opens one:
  - Draft session: pass `sessionId` option so the SDK uses our ID.
  - Existing session: pass `resume: sessionId`.
- Calls `runtime.pushMessage(message)`.

**New route: `POST /sessions/:sessionId/approvals/:requestId`**

- Validates `{ behavior: 'allow' | 'deny'; updatedPermissions?: PermissionUpdate[]; answers?: Record<string, string> }`.
- For `AskUserQuestion`: constructs `PermissionResult` with `updatedInput` containing the answers.
- Calls `runtime.resolveApproval(requestId, result)`.

**New route: `POST /sessions/:sessionId/interrupt`**

- Calls `runtime.interrupt()`.
- Returns `{ ok: true }` or `{ ok: false, error: string }`.

**Remove: `POST /sessions/:sessionId/chat`**

The old per-turn route is removed. The old `SseEmitter`-per-request pattern is gone — `SseEmitter` now lives inside `SessionRuntime`.

**chatService changes:**

- Add a `Map<string, SessionRuntime>` registry.
- Add `getOrCreateRuntime(sessionId, workspaceId, serverNonce)` — looks up existing, or creates + starts a new one.
- Add `closeRuntime(sessionId)` — called on session delete.
- The existing `sendMessage` method is replaced by the route handlers calling `runtime.pushMessage` directly (or a thin `chatService.sendMessage` wrapper for backward compat during migration).

**Draft-session flow (R10):**

First `POST /messages` to a draft session:
1. `chatService` creates the runtime with `options.sessionId = draft.id` and `options.title = draft.name`.
2. `runtime.pushMessage(content)` — the input iterator yields the first message.
3. SDK creates the session, emits `system_init` with `session_id`.
4. `chatService.clearDraftFlag(draft.id)` fires (same as today).

Subsequent messages in the same session: runtime already exists, just `pushMessage`.

**Server restart detection (R22):**

The server generates a nonce at startup (UUID or timestamp). The `subscription_ack` event includes it. If a client reconnects and its cached nonce differs, it emits a client-side system note.

**Test scenarios:**
- Open `GET /stream` → `subscription_ack` received, connection stays open.
- `POST /messages` while subscribed → user message appears in stream, assistant response streams back.
- Close browser tab while streaming → server runtime stays alive, events buffer.
- Reopen `GET /stream` with `Last-Event-Id` → replayed events + live events.
- `POST /approvals/:id` with `{ behavior: 'allow' }` → tool executes.
- `POST /approvals/:id` with `{ behavior: 'allow', updatedPermissions: [...] }` → tool executes + rule persisted.
- `POST /approvals/:id` with `{ behavior: 'deny', message: '...' }` → denial returned to agent.
- `POST /interrupt` while streaming → `interrupted` event sent, stream halts.
- Delete a session → runtime closed, stream ends.
- Server restart → client sees new nonce, shows system note.

**Verification:** `npm run lint` + `npm run build`. Manual dev-server integration via U9 + U10.

### U6. Popover primitive

**Goal:** Add a Radix Popover wrapper following the existing `collapsible.tsx` pattern.

**Requirements:** R7 (anchored confirm popover for Stop).

**Dependencies:** None.

**Files:**
- Create: `src/client/components/ui/popover.tsx`

**Approach:**

Install `@radix-ui/react-popover` (devDependency or dependency — matches `collapsible` placement in `dependencies`). Create a re-export wrapper:

```tsx
'use client'
import * as PopoverPrimitive from '@radix-ui/react-popover'
export const Popover = PopoverPrimitive.Root
export const PopoverTrigger = PopoverPrimitive.Trigger
export const PopoverContent = PopoverPrimitive.Content
```

`PopoverContent` uses portal + side="top" + align="center" as defaults, with Tailwind classes matching the existing surface/border token palette. Final positioning settles during U7 implementation.

**Test scenarios:**
- Render Popover with trigger and content → content appears anchored to trigger on click.
- Click outside → content closes.
- Press Escape → content closes.

**Verification:** `npm run lint` + `npm run build`.

### U7. PromptInput component

**Goal:** Replace the inline textarea in `ChatPanel` with a standalone auto-grow input component that includes Send/Stop/Clear buttons and the Stop confirmation popover.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R9.

**Dependencies:** U6 (Popover).

**Files:**
- Create: `src/client/components/PromptInput.tsx`

**Approach:**

Props:

```
interface PromptInputProps {
  onSend: (content: string) => void
  onStop: () => void
  disabled?: boolean
  isStreaming?: boolean
  isInterrupting?: boolean
  hasSession?: boolean
}
```

State:
- `input: string` — the textarea draft.
- `stopPopoverOpen: boolean` — Stop confirmation popover state.

**Auto-grow textarea (R1, R2):**

- Use a `ref` to the `<textarea>`.
- On every `onChange`, reset `height` to `'auto'` (so `scrollHeight` reports the natural height), then set `height` to `Math.min(textarea.scrollHeight, MAX_HEIGHT)`.
- `MAX_HEIGHT` = `Math.round(window.innerHeight * 0.4)` (origin doc deferred question: ~40% of viewport). Clamp to a minimum of `160px` so small viewports still get a usable input.
- CSS: `resize-none overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words`. No horizontal scrollbar ever.
- `minHeight: 44px` (matches current).

**Placeholder and focus (R3):**

- Placeholder: `"Ask Claude anything about your code..."` (unchanged).
- `focus-within:border-border-hover` on the outer wrapper (unchanged).

**Keyboard (R4):**

- `Enter` without Shift → `handleSend()`.
- `Shift+Enter` → default behavior (newline inserted).

**Send button (R5, R6, R8):**

- When `isStreaming` is false and `hasSession` is true and `input.trim()` is non-empty: enabled Send icon button.
- When `isStreaming` is true: replaced by Stop icon button with a pulsing/spinning loading indicator.
- Button reverts to Send when `isStreaming` transitions back to false.

**Stop popover (R7):**

- Clicking Stop toggles `stopPopoverOpen`.
- Popover anchored to the Stop button (Radix `PopoverTrigger`).
- Content: "Cancel current turn?" text + Cancel / Confirm buttons.
- When `isInterrupting` is true, Confirm shows a spinner and both buttons are disabled.
- Cancel: closes popover, turn continues.
- Confirm: calls `onStop()`, popover stays open with loading state until `isStreaming` transitions to false.
- Escape: closes popover (Radix default).

**Clear button (R9):**

- Visible when `input` is non-empty, regardless of streaming state.
- Clicking empties `input`. Does not affect streaming or history.
- Positioned next to Send/Stop.

**Layout:**

```
<div className="relative bg-surface border border-border rounded-xl ...">
  <textarea ... />
  <div className="absolute right-2 bottom-2 flex items-center gap-1">
    {input && <ClearButton />}
    {isStreaming ? <StopButtonWithPopover /> : <SendButton />}
  </div>
</div>
```

**Test scenarios:**
- Empty textarea → Send disabled, Clear hidden.
- Type text → Send enabled, Clear visible.
- Click Send → `onSend` called with text, input cleared.
- While streaming → Send replaced by Stop with loading animation.
- Click Stop → popover opens with Cancel/Confirm.
- Click Cancel → popover closes, turn continues.
- Click Confirm → `onStop` called, popover closes.
- Press Escape while popover open → popover closes.
- Paste 200-word paragraph → textarea grows to max height, shows vertical scrollbar, no horizontal scrollbar.
- Click Clear while streaming → input cleared, streaming continues.

**Verification:** Manual dev-server testing. `npm run lint` + `npm run build`.

### U8. ApprovalBanner component

**Goal:** Render a pinned banner above the prompt input for pending `canUseTool` approvals and `AskUserQuestion` clarifying requests, with Allow / Allow always / Deny buttons or question option selectors.

**Requirements:** R12, R13, R14, R15, R16.

**Dependencies:** None (props-driven; store integration is in U9).

**Files:**
- Create: `src/client/components/ApprovalBanner.tsx`

**Approach:**

Props:

```
interface ApprovalBannerProps {
  pendingItem: PendingApproval | PendingQuestion | null
  queueDepth: number
  isResolving?: boolean
  onAllow: () => void
  onAllowAlways: () => void
  onDeny: (message: string) => void
  onAnswerQuestion: (answers: Record<string, string>) => void
}
```

Where:
- `PendingApproval` = `{ requestId: string; toolName: string; toolUseId: string; input: unknown; inputSummary: string; title?: string; description?: string; suggestions?: PermissionUpdate[] }`
- `PendingQuestion` = `{ requestId: string; questions: QuestionPayload[] }`

**Permission banner:**

- Outer wrapper: `bg-surface border border-border/50 rounded-lg px-4 py-3` — pinned above input, not scrolling with conversation.
- Tool name in bold.
- Input summary (first ~200 chars of JSON, or key-value pairs for common tools). If the full input is larger, a "Show more" toggle expands it in a `Collapsible`.
- Three buttons: Allow (primary), Allow always (secondary), Deny (destructive).
- When `isResolving` is true, all buttons show a spinner and are disabled.
- If `suggestions` is empty or absent, "Allow always" is hidden (no rule to persist).

**Question banner:**

- Same outer wrapper.
- For each question: header (if present) in bold, question text, option list.
- Single-select: radio-style buttons; only one selectable. Clicking the already-selected option deselects it (allows "no answer" state). Confirm button disabled until every question has at least one selection.
- Multi-select: checkbox-style; multiple selectable.
- If an option has `preview`, render it below the option label in muted text.
- Confirm button at the bottom.

**Queue indicator (R16):**

- If `queueDepth > 0`, show "1 of {queueDepth + 1}" in muted text.

**Not dismissable:**

- No X button, no click-outside-to-close. Only Allow / Allow always / Deny or answering questions resolves the banner.

**Test scenarios:**
- Permission banner for a Write tool → shows tool name "Write", input summary with file path.
- Permission banner for a Bash tool with long command → summary truncated, "Show more" expands.
- Click Allow → `onAllow` called.
- Click Allow always → `onAllowAlways` called (carries `suggestions`).
- Click Deny → `onDeny` called with a default message.
- Question banner with two questions → both rendered with options.
- Single-select: clicking a second option deselects the first.
- Multi-select: clicking multiple options selects all.
- Queue depth 3 → shows "1 of 4".
- Banner is not dismissable by clicking outside or pressing Escape.

**Verification:** Manual dev-server testing. `npm run lint` + `npm run build`.

### U9. Chat store refactor

**Goal:** Replace the per-turn fetch-based SSE consumer with a long-lived subscription per active session, add approval state management, and support message queuing while an approval is pending.

**Requirements:** R10, R11, R14, R15, R16, R19, R20, R21, R22.

**Dependencies:** U2 (new event types), U5 (new routes).

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**

**New state fields:**

```
approvalQueue: Record<string, (PendingApproval | PendingQuestion)[]>
serverNonce: Record<string, string>
sessionSubscriptions: Record<string, { close: () => void }>
```

**Subscription management:**

Add `subscribeToSession(workspaceId: string, sessionId: string)`:

1. Build URL: `GET /api/workspaces/${workspaceId}/sessions/${sessionId}/stream`.
2. If a subscription already exists for this session, close it first (reconnect).
3. Open a `fetch` GET with streaming (same hand-rolled SSE parser `parseSseStream` already in the store). Extend `parseSseStream` to capture `id:` lines (in addition to existing `event:` and `data:` lines) and yield them alongside the event data.
4. Pass `Last-Event-Id` header from the last processed event ID (tracked in state).
5. On each SSE event, dispatch to `handleSseEvent` (existing) or new handlers for `subscription_ack`, `pending_approval`, `pending_question`, `approval_resolved`, `interrupted`, `error_note`, `server_restarted`.

**New event handlers in `handleSseEvent`:**

- `subscription_ack`: store `serverNonce[sessionId]`. Compare with cached nonce; if different, push a system note "Server was restarted. Background work may have been lost."
- `pending_approval`: push to `approvalQueue[sessionId]`.
- `pending_question`: push to `approvalQueue[sessionId]`.
- `approval_resolved`: remove the item from the queue. If a draft message was queued, send it now.
- `interrupted`: set `isStreaming[sessionId] = false`.
- `error_note`: push a system message with the error text.
- `server_restarted`: same as nonce-mismatch logic — push system note.

**Message sending refactor:**

Replace `sendMessage` with:

```
sendMessage(workspaceId: string, sessionId: string, content: string) {
  // If no subscription exists, open one
  if (!sessionSubscriptions[sessionId]) {
    subscribeToSession(workspaceId, sessionId);
  }

  // Optimistically add user message to local state
  addLocalUserMessage(sessionId, content);

  // If approval is pending, queue the message
  if (approvalQueue[sessionId]?.length > 0) {
    draftQueue[sessionId] = content;
    // Still add to local messages with a "queued" visual indicator (muted styling, clock icon)
    // so the user sees their message is waiting
    return;
  }

  // Otherwise, POST to server
  postMessage(workspaceId, sessionId, content);
}
```

Add `postMessage` (separate from the subscription):
- `POST /api/workspaces/${workspaceId}/sessions/${sessionId}/messages` with `{ message: content }`.
- No response body needed — the subscription SSE stream delivers the output.
- On network failure: mark the optimistically-added user message as "failed to send" (error styling, retry button). Do not silently drop the message.

**Approval resolution:**

Add actions:
- `resolveApproval(workspaceId: string, sessionId: string, requestId: string, result: PermissionResult)`: `POST /sessions/${sessionId}/approvals/${requestId}`. On network failure, show an error toast and keep the banner visible so the user can retry.

**Interrupt:**

Add `interruptSession(workspaceId: string, sessionId: string)`:
- `POST /sessions/${sessionId}/interrupt`.
- On success, `isStreaming[sessionId]` transitions to false when the `interrupted` SSE event arrives.
- On failure, the `error_note` SSE event handles it.

**Session lifecycle:**

- `setActiveSession`: if switching to a new session, subscribe to it. (The old session's subscription stays open in the background — R18.)
- `deleteSession`: close the subscription, remove from store.
- On component unmount (ChatPanel): subscription stays open (R18). Closing is only on session delete.

**Test scenarios:**
- Subscribe to a session → `subscription_ack` received, events flow.
- Send a message → user message appears locally, `POST /messages` fires, assistant response streams via subscription.
- Send while approval pending → message queued, not sent.
- Resolve approval → queued message sent, approval removed from queue.
- Second `pending_approval` arrives while first is pending → queued (FIFO).
- Switch sessions → old subscription stays open, new subscription opened.
- Close and reopen tab → reconnect with `Last-Event-Id`, replayed events appear.
- Server restart → system note appears in conversation.
- Interrupt → `interrupted` event received, `isStreaming` cleared.

**Verification:** Manual dev-server testing with U10 integration. `npm run lint` + `npm run build`.

### U10. ChatPanel integration

**Goal:** Replace the inline textarea and Send button in `ChatPanel` with the composed `PromptInput` and `ApprovalBanner` components. Wire store actions to component callbacks.

**Requirements:** R1-R9, R12-R16 (integration surface).

**Dependencies:** U7 (PromptInput), U8 (ApprovalBanner), U9 (store refactor).

**Files:**
- Modify: `src/client/components/ChatPanel.tsx`

**Approach:**

Replace the current `<textarea>` + `<Send>` button block (lines 89-99) with:

```tsx
{/* Approval Banner */}
{activeSessionId && (
  <ApprovalBanner
    pendingItem={currentApproval}
    queueDepth={approvalQueueLength}
    onAllow={handleAllow}
    onAllowAlways={handleAllowAlways}
    onDeny={handleDeny}
    onAnswerQuestion={handleAnswerQuestion}
  />
)}

{/* Prompt Input */}
<PromptInput
  onSend={handleSend}
  onStop={handleStop}
  disabled={!activeSessionId}
  isStreaming={isStreaming}
  hasSession={!!activeSessionId}
/>
```

Where:
- `handleSend(content)` → `sendMessage(workspaceId, activeSessionId, content)`.
- `handleStop()` → `interruptSession(workspaceId, activeSessionId)`.
- `handleAllow()` → `resolveApproval(...)` with `{ behavior: 'allow' }`.
- `handleAllowAlways()` → `resolveApproval(...)` with `{ behavior: 'allow', updatedPermissions: currentApproval.suggestions }`.
- `handleDeny(msg)` → `resolveApproval(...)` with `{ behavior: 'deny', message: msg }`.
- `handleAnswerQuestion(answers)` → `resolveApproval(...)` with `{ behavior: 'allow', updatedInput: { questions, answers } }`.

`currentApproval` = first item in `approvalQueue[activeSessionId]` or null.
`approvalQueueLength` = `approvalQueue[activeSessionId]?.length || 0`.

The keyboard hint line ("Enter to send, Shift+Enter for new line") moves inside `PromptInput` as part of its layout.

Remove the old `input` state, `inputRef`, `handleSend` inline handler, and `handleKeyDown` from `ChatPanel` — these are now owned by `PromptInput`.

**Test scenarios:**
- Full end-to-end: type, send, watch response stream, approval banner appears when tool needs permission, approve, continue.
- Send a message, click Stop, confirm → turn interrupted, button returns to Send.
- Type a draft, click Clear → draft cleared, nothing else affected.
- Switch to a session with a pending approval → banner appears immediately.
- Paste a long paragraph → input grows to max height, no horizontal scroll.
- No session selected → Send disabled, no banner.

**Verification:** Manual dev-server testing. `npm run lint` + `npm run build`.

## Scope Boundaries

**Out (carried from origin):**

- Approve-with-changes (modifying tool input before allowing).
- Settings UI for editing/revoking `.claude/settings.local.json` rules.
- Multi-machine / cross-host session resume.
- Image, file, or non-text attachments; file mentions; slash commands; voice input.
- Light-mode theming for new surfaces.
- Tool approvals for subagent tool calls (SDK does not surface them).
- Permission-mode toggle (plan / acceptEdits / bypassPermissions).
- Inline-message-card and modal approval surfaces (rejected in favor of banner).
- Soft-interrupt that drains in-progress tool calls.
- Persistent draft sync across devices.
- Exposing the per-session background-query cap as a user-visible setting.

**Deferred to follow-up work:**

- Input summary expand/collapse inside the approval banner — v1 shows a truncated summary; a "Show more" toggle is a UX polish that can land after the core flow works.
- Ring buffer size configuration — constant is fine for v1; if long sessions need tuning, expose it later.
- Draft persistence per-session (remember textarea content across page reloads) — client-only, not critical for v1.
- Multiple concurrent session subscriptions visible at once (e.g., split pane) — current UI is single-session view; background work is supported but not visible simultaneously.

## Dependencies / Assumptions

- The Claude Agent SDK `^0.2.141` supports Streaming Input Mode (`prompt: AsyncIterable<SDKUserMessage>`), `canUseTool` with `suggestions`, and `AskUserQuestion` via `toolConfig`. Verified against `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`.
- **Blocking verification gate (before U1-U3):** Two empirical tests must pass before SessionRuntime implementation begins: (1) Multi-turn query longevity — a single `query()` fed by an `AsyncIterable` must stay alive after processing one turn, waiting for the next value. (2) AskUserQuestion routing — `canUseTool` must fire with `toolName === 'AskUserQuestion'` when the agent asks a clarifying question. If either test fails, the plan documents the fallback architecture before proceeding. If multi-turn query does not hold: fallback to per-turn `query()` calls (still supports `canUseTool` but loses "one query per session"). If AskUserQuestion does not route through `canUseTool`: identify the correct interception point before building U8/U9.
- `query.interrupt()` is safe to call mid-tool-call and does not corrupt the long-lived session (per SDK docs).
- Writing to `.claude/settings.local.json` is handled by the SDK when `updatedPermissions` with `localSettings` destination is echoed back. The app does no file IO for permissions.
- The server process can hold dozens of open Claude CLI subprocesses (one per active session runtime) without resource issues on a developer machine. A future cap and queue mechanism is out of scope for v1.
- The byte-identical duplication between `src/client/types/message.ts` and `src/server/types/message.ts` is preserved. Both files receive the same additive changes.
- `@radix-ui/react-popover` will be added as a dependency. It follows the same version pattern as the existing `@radix-ui/react-collapsible`.
- The existing hand-rolled `parseSseStream` in `chat-store.ts` works with the long-lived subscription pattern with an additive extension to capture `id:` lines — it already handles `event:` and `data:` lines from streaming `ReadableStream<Uint8Array>`.
- The `chat-store.ts` module-level `parseSSEStream` function and `handleSseEvent` are preserved and extended (not replaced).
- The `use-stick-to-bottom` scroll behavior in `MessageList` is unaffected by the new components — `ApprovalBanner` and `PromptInput` live outside the scrollable message area.
- Manual dev-server verification is the established pattern (plans 005-008).

## Outstanding Questions

### Deferred to Implementation

- **Exact max-height calculation.** ~40% of viewport is the starting point. Final pixel value settles during U7 implementation against the dev server. Minimum floor of `160px` so small viewports remain usable.
- **Input summary format in approval banner.** First ~200 chars of JSON is the default. During U8, decide whether common tools (Write, Bash, Read) get special key extraction (e.g., show `file_path` and first line of `content` for Write).
- **Stop button loading animation.** Pulsing dot, spinning icon, or gradient shimmer. Low-cost visual detail that settles during U7.
- **Deny message.** When the user clicks Deny without typing a reason, a default message is sent (e.g., `"User denied this tool call."`). The exact copy settles during U8.
- **Ring buffer eviction behavior.** Oldest-first eviction when cap is reached. If this causes visible gaps on reconnect, the cap can be increased. The ~500 cap is a starting point.
- **Concurrent `canUseTool` resolution ordering.** The SDK may invoke `canUseTool` for multiple tools in a single turn. The plan queues them FIFO in `pendingApprovals` and the client shows one banner at a time. The REST endpoint `POST /approvals/:requestId` does not enforce ordering — a client could resolve the second before the first. If the SDK does not tolerate out-of-order resolution, add a server-side guard that blocks resolution of request N+1 until N is resolved. Verify during U3 implementation by triggering parallel tool calls.
- **`SDKUserMessage` content shape.** U3 constructs `{ type: 'user', message: { role: 'user', content } }` where `content` is a bare string. The SDK's `MessageParam.content` accepts `string | ContentBlockParam[]`. If the SDK does not coerce bare strings in streaming mode, wrap as `[{ type: 'text', text: content }]`. Verify during U3 implementation.

### Open Questions (from review)

- **Keyboard accessibility for ApprovalBanner.** The banner is pinned and non-dismissable, blocking the session until resolved. Consider adding `role="alert"`, `aria-live="assertive"`, and auto-focus on the first action button when the banner appears. Not in current requirements — assess during U8 implementation.
- **Deny action reason input.** The Deny button currently sends a hardcoded message. Consider adding an optional text input that expands when Deny is clicked, allowing the user to type a reason. UX decision that can settle during U8.
- **Visual indicator when Send will queue behind approval.** When a message is queued (sent while approval pending), the user should know the message won't send immediately. Consider a small indicator on Send or in the input area. UX detail that can settle during U9 implementation.

## Sources & References

- Origin requirements doc: `docs/brainstorms/2026-05-16-prompt-input-and-streaming-input-mode-requirements.md` (R1-R22, F1-F5, AE1-AE10, Key Decisions, Scope Boundaries).
- Predecessor plan: `docs/plans/2026-05-16-005-feat-sdk-session-delegation-plan.md` — session lifecycle baseline (draft → SDK session promotion, `clearDraftFlag`).
- Predecessor plan: `docs/plans/2026-05-16-006-feat-ai-elements-message-rendering-plan.md` — chat surface conventions, `MessagePart` type shape.
- Predecessor plan: `docs/plans/2026-05-16-007-fix-session-message-list-scroll-plan.md` — scroll layout constraint (preserve `overflow` behavior).
- Predecessor plan: `docs/plans/2026-05-16-008-feat-cli-meta-message-rendering-plan.md` — muted-system-note precedent, byte-identical type file pattern.
- Claude Agent SDK types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — `Query`, `canUseTool`, `PermissionResult`, `PermissionUpdate`, `ToolConfig.askUserQuestion`.
