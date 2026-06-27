---
title: 'feat: Extend Feishu /stop to mirror WeCom interrupt behavior'
type: feat
date: 2026-06-27
origin: docs/brainstorms/2026-06-27-feishu-stop-interrupt-requirements.md
---

# feat: Extend Feishu `/stop` to mirror WeCom interrupt behavior

## Summary

Add an `interrupt()` method to `FeishuStreamReply`, track active stream replies per session in `FeishuBotService`, and update the Feishu `/stop` handler to mirror WeCom: append `已中断` to the active streaming card, interrupt the runtime, and cancel any pending tool approvals or questions.

## Problem Frame

The Feishu bot already recognizes `/stop`, but its current handler only calls `runtime.interrupt()`. The streaming card is left without an explicit confirmation, so users see the turn stop abruptly. The WeCom bot already provides the richer behavior this plan copies: it appends `已中断` to the streaming reply, interrupts the runtime, and cancels pending approvals.

## Requirements

### Interrupt behavior

- R1. When a Feishu user sends `/stop` and has an active Feishu-bound session with an in-flight turn, the command must interrupt that turn.
- R2. If an active streaming reply exists for the session when `/stop` is handled, the handler must append the literal text `已中断` to the end of that streaming reply and finalize it.
- R3. If no active streaming reply exists but the session is still processing a turn, the handler must still interrupt the turn and send a standalone `已中断` message to the Feishu user.
- R4. The handler must cancel all pending tool approvals or questions for the interrupted session so the user lands in a clean state.

### No-active-turn responses

- R5. When the user has no active Feishu-bound session, `/stop` must reply with `没有活跃的会话可中断。请运行 /resume 选择会话。`
- R6. When the user has an active session but no in-flight turn, `/stop` must reply with `当前没有正在进行的对话。`

### Error handling

- R7. If the interrupt handler throws, the bot must catch the error and send a fallback message such as `⚠️ 中断会话失败，请稍后重试。`

## Key Technical Decisions

- **KTD1. Expose `interrupt(message)` on `FeishuStreamReplyHandle` and add lifecycle callbacks to `start()`.** This mirrors WeCom's `StreamReplyResult` and lets `FeishuBotService` call `interrupt()` and clean up the active-stream map when the reply finalizes, without holding the whole `FeishuStreamReply` instance.
- **KTD2. Track active stream replies per session in `FeishuBotService`.** A `Map<sessionId, FeishuStreamReplyHandle>` is stored when a chat message starts and removed on finalization/cleanup. This is the same pattern `WeComBotService` uses and is the simplest way for `/stop` to target the right stream.
- **KTD3. Send the standalone fallback via `thread.post`.** Existing Feishu status replies use `safePostText(thread, ...)`, so the standalone `已中断` fallback should use the same path for consistency in DM and group-thread contexts.
- **KTD4. Sequence the interrupt like WeCom: stream reply first, then runtime, then approvals.** `streamReply.interrupt('已中断')` finalizes the visible card before `runtime.interrupt()` emits its own `interrupted` event; `cancelPendingApprovals()` runs last so the session ends in a clean state.

## Implementation Units

### U1. Add `interrupt()` to `FeishuStreamReply`

- **Goal:** Allow appending a marker message to an active streaming reply and finalizing it.
- **Requirements:** R2
- **Dependencies:** None
- **Files:** `src/server/services/feishu-stream-reply.ts`, `src/server/services/feishu-stream-reply.test.ts`
- **Approach:**
  - Add a public `interrupt(message: string): boolean` method.
  - Return `false` if the reply is already finalized.
  - Clear any visible placeholder, ensure `responseText` ends with `\n\n`, append the marker, update the card controller, and trigger `finalize()`.
  - Add `interrupt` to `FeishuStreamReplyHandle` and wire it in `start()`.
- **Patterns to follow:** WeCom's `interrupt()` in `src/server/services/wecom-stream-reply.ts:265-278`.
- **Test scenarios:**
  - Happy path: after `assistant_start` and `text_delta`, `interrupt('已中断')` returns `true` and the finished card contains the original text followed by `\n\n已中断`.
  - Edge case: `interrupt()` returns `false` and does not modify content when called after the reply has already finalized.
  - Edge case: `interrupt()` clears an active placeholder before appending the marker.

### U2. Track active stream replies in `FeishuBotService`

- **Goal:** Maintain a reference to the active stream reply for each session so `/stop` can target it.
- **Requirements:** R2, R3
- **Dependencies:** U1
- **Files:** `src/server/services/feishu-bot-service.ts`
- **Approach:**
  - Add `private activeStreamReplies = new Map<string, FeishuStreamReplyHandle>()`.
  - In `handleChatMessage`, after `reply.start()` succeeds, store the returned handle under the session id.
  - Pass `onFinalized` and `onCleanup` callbacks to `reply.start()` that remove the entry from the map.
- **Patterns to follow:** `WeComBotService.activeStreamReplies` in `src/server/services/wecom-bot-service.ts:154` and its lifecycle callbacks.
- **Test scenarios:**
  - Integration: after `handleChatMessage` starts, the active session's stream reply is present in the service's map.
  - Integration: when the stream finalizes (e.g., via a `result` event), the map entry is removed.

### U3. Update the Feishu `/stop` handler

- **Goal:** Make `/stop` behave like WeCom's `/stop`.
- **Requirements:** R1, R2, R3, R4, R7
- **Dependencies:** U1, U2
- **Files:** `src/server/services/feishu-bot-service.ts`
- **Approach:**
  - In `handleStopCommand`, after confirming the active session and a processing turn, look up the active stream reply.
  - Call `streamReply?.interrupt('已中断')`; capture whether it returned `true`.
  - Call `runtime.interrupt()` and `runtime.cancelPendingApprovals('Turn interrupted by user.')`.
  - If no stream reply was active or `interrupt()` returned `false`, send a standalone `已中断` message via `safePostText`.
  - Wrap the body in `try/catch` and reply with the fallback error message on failure.
- **Patterns to follow:** `WeComBotService.handleStopCommand` in `src/server/services/wecom-bot-service.ts:488-539`.
- **Test scenarios:**
  - Happy path with active stream: `/stop` calls `interrupt('已中断')`, `runtime.interrupt()`, and `cancelPendingApprovals()`; no standalone text is sent.
  - Fallback when no stream reply: `/stop` interrupts the runtime, cancels approvals, and sends `已中断` via `thread.post`.
  - No active session: `/stop` replies with `没有活跃的会话可中断。请运行 /resume 选择会话。`
  - Active session but idle: `/stop` replies with `当前没有正在进行的对话。`
  - Error path: when `runtime.interrupt()` throws, `/stop` catches the error and sends `⚠️ 中断会话失败，请稍后重试。`
  - Regression: `/stop` does not create a new session when no active session exists.

### U4. Add tests for the interrupt path

- **Goal:** Verify the new behavior at unit and service levels.
- **Requirements:** R1-R7
- **Dependencies:** U1-U3
- **Files:** `src/server/services/feishu-stream-reply.test.ts`, `src/server/services/feishu-bot-service.test.ts`
- **Approach:**
  - Extend `feishu-stream-reply.test.ts` with tests for `interrupt()`.
  - Extend `feishu-bot-service.test.ts` with a new `/stop` describe block modeled on `wecom-bot-service.test.ts:1237-1509`.
- **Patterns to follow:** `wecom-bot-service.test.ts` for mock runtime injection and assertion style; existing `feishu-bot-service.test.ts` for workspace/session mocking.
- **Test scenarios:**
  - Covers the interrupt-active-stream acceptance case.
  - Covers the no-active-stream, idle-runtime, missing-runtime, and error acceptance cases.
  - Covers pending-approval cancellation after interrupt.

## Scope Boundaries

### Deferred for later

- Making the interrupt text configurable or translatable.
- Adding a similar `已中断` label to the GUI interrupt button.
- Extracting a shared `/stop` abstraction across WeCom and Feishu.

### Outside this plan

- Changes to the GUI interrupt button behavior.
- New bot platform integrations.
- Persistence or history changes beyond the active stream reply.

## Acceptance Examples

- **AE1. Interrupt an active streaming reply.** Covers R1, R2.
  - **Given** a Feishu user has an active session and the bot is streaming a card reply,
  - **When** the user sends `/stop`,
  - **Then** the streaming card finalizes and its visible content ends with `已中断`.

- **AE2. Interrupt a turn waiting for tool approval.** Covers R3, R4.
  - **Given** a session has a pending tool approval card and no active stream reply,
  - **When** the user sends `/stop`,
  - **Then** the approval is resolved as denied and the user receives the standalone message `已中断`.

- **AE3. No active session.** Covers R5.
  - **Given** the Feishu user has not selected or created a session,
  - **When** the user sends `/stop`,
  - **Then** the bot replies with `没有活跃的会话可中断。请运行 /resume 选择会话。`

- **AE4. Active session with no in-flight turn.** Covers R6.
  - **Given** the user has an active session but the bot is idle,
  - **When** the user sends `/stop`,
  - **Then** the bot replies with `当前没有正在进行的对话。`

## Sources / Research

- Existing Feishu `/stop` handler: `src/server/services/feishu-bot-service.ts:644-661`
- Feishu chat message flow that creates stream replies: `src/server/services/feishu-bot-service.ts:707-772`
- WeCom `/stop` reference handler: `src/server/services/wecom-bot-service.ts:488-539`
- WeCom active stream reply tracking: `src/server/services/wecom-bot-service.ts:154` and `wecom-bot-service.test.ts:1300-1307`
- WeCom `interrupt()` implementation: `src/server/services/wecom-stream-reply.ts:265-278`
- `SessionRuntime` interrupt APIs: `src/server/services/session-runtime.ts:616-641`
- Existing Feishu stream reply tests: `src/server/services/feishu-stream-reply.test.ts`
- Existing Feishu bot service tests: `src/server/services/feishu-bot-service.test.ts`
- Existing WeCom `/stop` tests: `src/server/services/wecom-bot-service.test.ts:1237-1509`
