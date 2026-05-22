---
title: "feat: WeCom streaming response support"
description: Enable WeCom bot to stream AI responses incrementally instead of sending the complete message at the end.
type: feat
created: 2026-05-22
status: active
---

## Problem Frame

WeCom bot users currently receive AI responses only after the full response has been generated. The web UI already streams responses via SSE, but WeCom users experience a delay and then a single message. The `@wecom/aibot-node-sdk` (v1.0.7) already supports streaming replies via `replyStream` and `replyStreamNonBlocking` — the application is not using them.

## Summary

This plan adds streaming response support for WeCom bot messages. Instead of accumulating the full AI response and sending it once via `sendMessage`, the bot will send incremental updates via `replyStreamNonBlocking` (debounced at 150ms) and finalize with `replyStream(..., finish=true)`. This keeps the scope to WeCom only; the web UI streaming path is unchanged.

## Key Technical Decisions

- **Non-blocking intermediate frames:** Use `replyStreamNonBlocking` for text_delta updates. It skips sending if the previous frame's ack is still pending, preventing queue buildup. The final `finish=true` frame uses `replyStream` (blocking) to guarantee delivery.
- **150ms debounce:** Batches rapid text_delta events to reduce API calls while keeping the UX smooth.
- **Stream ID per response:** Each `assistant_start` generates a new `streamId` (e.g., `${sessionId}-${Date.now()}`) so concurrent or sequential responses in the same session do not collide.
- **Frame headers captured in closure:** The incoming `WsFrame` headers (containing `req_id`) are captured in the handler closure alongside `conn` and `wecomUserId`, since `replyStream` requires the original frame headers.
- **Fallback on final frame:** If `replyStream` throws on the final frame, fall back to `conn.client.sendMessage` with the accumulated text to ensure the user still receives the response.

## Scope Boundaries

### In Scope
- WeCom bot text message responses streamed incrementally
- Debounced intermediate frame sending
- Final frame with `finish=true`
- Error fallback to non-streaming send

### Out of Scope
- Web UI SSE streaming (already works)
- Streaming for other message types (image, file, etc.)
- Template card streaming
- Proactive message streaming (`sendProactiveMessage` uses `sendMessage` by design)

### Deferred to Follow-Up Work
- Extract a shared stream-sender abstraction if other bot platforms are added
- Configurable debounce interval via workspace settings

## Implementation Units

### U1. Add debounce utility

**Goal:** Create a reusable debounce helper for the server.

**Files:**
- `src/server/utils/debounce.ts` (create)

**Approach:**
Implement a simple `debounce<T extends (...args: any[]) => void>(fn: T, waitMs: number)` helper using `setTimeout`/`clearTimeout`. It should return a function that resets the timer on each call and invokes `fn` after `waitMs` of inactivity. Include an `abort` or `flush` method so callers can force immediate execution or cancel pending invocations.

**Patterns to follow:**
Keep the utility small and self-contained, matching the style of existing server utils like `sidecar-logger.ts`.

**Test scenarios:**
- Debounced function delays execution until `waitMs` after the last call
- Multiple rapid calls within `waitMs` only execute once
- Calling `flush()` immediately invokes the function with the latest arguments
- Calling `abort()` cancels pending invocation

**Verification:**
The utility compiles and the test scenarios are covered.

---

### U2. Implement streaming response handler in WeComBotService

**Goal:** Replace the wait-for-complete response handler with a streaming handler that uses `replyStreamNonBlocking` and `replyStream`.

**Files:**
- `src/server/services/wecom-bot-service.ts` (modify)

**Approach:**
In `handleTextMessage`, after creating the session, generate a `streamId` and build a handler that:

1. On `assistant_start`: reset `responseText`, set `collecting = true`, generate a new `streamId`
2. On `text_delta`: append to `responseText`, call the debounced flush function
3. Debounced flush (150ms): if `collecting` and `responseText` is non-empty, call `conn.client.replyStreamNonBlocking(frame.headers, streamId, responseText)`
4. On `assistant_done` / `error_note` / `interrupted`: set `collecting = false`, cancel pending debounce, call `conn.client.replyStream(frame.headers, streamId, responseText, true)`. If this throws, fall back to `conn.client.sendMessage(wecomUserId, { msgtype: 'markdown', markdown: { content: responseText } })`
5. On `error_note` where `responseText` is empty: skip sending to avoid empty messages

The `frame` received by `handleTextMessage` must be captured in the handler closure so its `headers` (specifically `req_id`) can be passed to `replyStreamNonBlocking` and `replyStream`.

Remove the now-unused `sendResponse` private method, or keep it if `sendProactiveMessage` still needs a similar helper (it does not — `sendProactiveMessage` uses `sendMessage` directly).

**Patterns to follow:**
Match the existing error-handling style (`.catch` for logging, `try/await/catch` for fallback). The handler should remain an inline closure bound to the current message context.

**Test scenarios:**
- **Happy path:** User sends message → AI generates text deltas → debounced stream frames are sent → final `finish=true` frame is sent
- **Edge case - rapid text deltas:** Multiple text deltas within 150ms are batched into a single stream frame
- **Edge case - empty response:** AI returns no text; no stream frames are sent
- **Edge case - ack pending:** `replyStreamNonBlocking` returns `'skipped'` when previous ack is pending; the next debounced flush or final frame carries the updated text
- **Error path - streaming failure on final frame:** `replyStream` throws; fallback to `sendMessage` delivers the complete text
- **Integration:** Sequential messages in the same session each get a fresh `streamId` and do not interfere with each other

**Verification:**
- TypeScript compiles without errors
- The WeCom bot handler no longer references `sendResponse`
- The `text_delta` path triggers `replyStreamNonBlocking` (can be verified by console logging during manual test)

## Deferred to Implementation

- Exact debounce wait interval (150ms is the planned default; can be tuned during implementation)
- Whether to send the first text_delta immediately (before debounce) for faster perceived response time

## Risks

| Risk | Mitigation |
|------|------------|
| WeCom streaming API has stricter rate limits than `sendMessage` | Debouncing (150ms) reduces frame count; `replyStreamNonBlocking` skips when ack is pending |
| `replyStreamNonBlocking` drops intermediate frames if ack is slow | The final `finish=true` frame is guaranteed (blocking); user sees the full text, just with fewer intermediate updates |
| Stream ID collision across concurrent responses in same session | Each `assistant_start` generates a new `streamId` with timestamp + random suffix |
