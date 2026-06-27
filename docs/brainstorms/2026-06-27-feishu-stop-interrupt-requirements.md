---
date: 2026-06-27
topic: feishu-stop-interrupt
---

# Feishu `/stop` 中断命令需求

## Summary

Extend the existing Feishu `/stop` command so it behaves like the WeCom `/stop` interrupt: stop the bot's in-flight turn, append the literal text `已中断` to the active streaming Feishu reply, and cancel any pending tool approvals or questions. If there is no active turn, reply to the Feishu user with a clear status message instead.

## Problem Frame

The Feishu bot already recognizes `/stop`, but its current handler only calls `runtime.interrupt()` and does not finalize the streaming reply. Users who trigger the menu therefore see the stream end abruptly without the explicit "已中断" confirmation that the WeCom bot provides. The goal is to make the Feishu experience consistent with WeCom and to give users clear feedback when they interrupt a session.

## Key Decisions

- **Feishu-only display.** The text `已中断` is appended to the bot's Feishu reply; the Comate GUI chat panel is not changed to show this text.
- **Mirror WeCom's richer interrupt.** The handler will cancel pending tool approvals and finalize the active stream reply, not only call `runtime.interrupt()`.
- **Literal text for now.** Use the exact string `已中断`; make it configurable or translatable only if a future requirement asks for it.
- **Track active stream replies per session.** `FeishuBotService` must keep a reference to the active stream reply for each session so `/stop` can append the text before finalizing it.

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

## Key Flows

- F1. **Active streaming reply**
  - **Trigger:** Feishu user sends `/stop`.
  - **Preconditions:** An active Feishu-bound session exists; `SessionRuntime.isProcessingTurn()` is true; an active `FeishuStreamReply` is tracked for that session.
  - **Steps:** Resolve the active session and runtime; call `streamReply.interrupt('已中断')`; call `runtime.interrupt()`; call `runtime.cancelPendingApprovals()`.
  - **Outcome:** The streaming reply finalizes with `已中断` appended; pending approvals are denied.

- F2. **Processing turn but no active stream reply**
  - **Trigger:** Feishu user sends `/stop`.
  - **Preconditions:** An active session exists; the runtime is processing a turn; no active stream reply is tracked.
  - **Steps:** Resolve the active session and runtime; call `runtime.interrupt()`; call `runtime.cancelPendingApprovals()`; send a standalone `已中断` message.
  - **Outcome:** The turn stops, approvals are denied, and the user receives `已中断`.

- F3. **No active session**
  - **Trigger:** Feishu user sends `/stop`.
  - **Preconditions:** No active Feishu-bound session is recorded for the user.
  - **Outcome:** The bot replies with `没有活跃的会话可中断。请运行 /resume 选择会话。`

- F4. **Active session, no in-flight turn**
  - **Trigger:** Feishu user sends `/stop`.
  - **Preconditions:** An active session exists, but `isProcessingTurn()` is false and there are no pending approvals.
  - **Outcome:** The bot replies with `当前没有正在进行的对话。`

## Acceptance Examples

- AE1. **Interrupt an active streaming reply.** Covers R1, R2.
  - **Given** a Feishu user has an active session and the bot is streaming a card reply,
  - **When** the user sends `/stop`,
  - **Then** the streaming card finalizes and its visible content ends with `已中断`.

- AE2. **Interrupt a turn waiting for tool approval.** Covers R3, R4.
  - **Given** a session has a pending tool approval card and no active stream reply,
  - **When** the user sends `/stop`,
  - **Then** the approval is resolved as denied and the user receives the standalone message `已中断`.

- AE3. **No active session.** Covers R5.
  - **Given** the Feishu user has not selected or created a session,
  - **When** the user sends `/stop`,
  - **Then** the bot replies with `没有活跃的会话可中断。请运行 /resume 选择会话。`

- AE4. **Active session with no in-flight turn.** Covers R6.
  - **Given** the user has an active session but the bot is idle,
  - **When** the user sends `/stop`,
  - **Then** the bot replies with `当前没有正在进行的对话。`

## Scope Boundaries

- **Deferred for later:** Making the interrupt text configurable or translatable; adding a similar "已中断" label to the GUI interrupt button; extracting a shared `/stop` abstraction across WeCom and Feishu.
- **Outside this feature:** Changes to the GUI interrupt button behavior, new bot platform integrations, persistence or history changes beyond the active stream reply.

## Dependencies / Assumptions

- Feishu bot integration already receives `/stop` text messages and routes them to `FeishuBotService.handleStopCommand`.
- `SessionRuntime` exposes `isProcessingTurn()`, `interrupt()`, and `cancelPendingApprovals()`.
- WeCom's `handleStopCommand` in `src/server/services/wecom-bot-service.ts` is the reference behavior.
- `FeishuStreamReply` needs a way to append text and finalize the stream; this may require adding an `interrupt(message)` method similar to WeCom's stream-reply implementation.

## Sources / Research

- Existing Feishu `/stop` handler: `src/server/services/feishu-bot-service.ts:644-661`
- WeCom `/stop` reference handler: `src/server/services/wecom-bot-service.ts:488-539`
- `SessionRuntime` interrupt APIs: `src/server/services/session-runtime.ts:434-641`
- `FeishuStreamReply` event handling (no `interrupt()` method today): `src/server/services/feishu-stream-reply.ts:86-165`
- GUI interrupt route: `src/server/routes/chat.ts:356-372`
