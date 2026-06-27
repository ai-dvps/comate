---
date: 2026-06-27
topic: wecom-bot-stop-command
---

## Summary

Add a `/stop` text command to the WeCom bot so users can interrupt an in-flight AI turn in their own active session. The command cancels any pending tool approval or question and sends a dedicated "已中断" confirmation.

## Problem Frame

WeCom bot users currently have no way to halt a long or off-track response after sending a message. The GUI has an Interrupt button, and the Feishu bot already supports `/stop`, but the WeCom bot only exposes `/clear`, `/new`, and `/resume`. Without an escape hatch, users must wait for the turn to complete or abandon the conversation.

## Key Decisions

- **KTD-1. Command name is `/stop`.** This mirrors the existing Feishu bot convention and keeps cross-platform bot commands consistent.
- **KTD-2. Send a dedicated confirmation message.** WeCom's stream reply closes quietly on `interrupted`; a proactive "已中断" message makes the action visible to the user.
- **KTD-3. Scope is the user's own active session only.** Admins and other users cannot interrupt someone else's session.
- **KTD-4. Cancel pending approvals and questions.** `/stop` resolves any in-flight tool approval or question as denied so the user lands in a clean state.

## Requirements

R1. `/stop` is parsed as a bot command before session lookup or creation, so it never creates a new session.

R2. If the user has no active WeCom session, reply with the markdown message `没有活跃的会话可中断。请运行 /resume 选择会话。`

R3. If the user has an active session but it has no in-flight turn, reply with the markdown message `当前没有正在进行的对话。`

R4. If the active session has an in-flight turn, call `runtime.interrupt()` on the session's cached runtime.

R5. Any pending tool approval or question for the interrupted turn is cancelled and resolved as denied.

R6. After a successful interrupt, send the user a markdown message `已中断`.

R7. Errors during `/stop` handling are logged and must not crash the bot connection or leave the runtime in an inconsistent state.

## Key Flows

- F1. **Interrupt an in-flight turn**
  - **Trigger:** WeCom text message `/stop`.
  - **Preconditions:** The user has an active WeCom session, and `chatService.getRuntimeIfExists(sessionId).isProcessingTurn()` is true.
  - **Steps:**
    1. Parse `/stop` as a command.
    2. Look up the user's active WeCom session.
    3. Get the cached runtime for that session.
    4. Call `runtime.interrupt()`.
    5. Resolve any pending approvals or questions as denied.
    6. Send the user the markdown message `已中断`.
  - **Outcome:** The AI turn stops and the user sees a confirmation.

- F2. **No active session**
  - **Trigger:** WeCom text message `/stop`.
  - **Steps:**
    1. Parse `/stop` as a command.
    2. Find no active WeCom session.
    3. Send `没有活跃的会话可中断。请运行 /resume 选择会话。`
  - **Outcome:** The user is informed and no session is created.

- F3. **Active session but nothing in flight**
  - **Trigger:** WeCom text message `/stop`.
  - **Steps:**
    1. Parse `/stop` as a command.
    2. Look up the active session.
    3. Find the runtime exists but `isProcessingTurn()` is false.
    4. Send `当前没有正在进行的对话。`
  - **Outcome:** The user is informed there is nothing to interrupt.

## Acceptance Examples

- AE1. **Interrupt a running turn**
  - **Covers:** R1, R4, R6.
  - **Given** user `U` has an active WeCom session `S` with a turn currently streaming.
  - **When** `U` sends `/stop`.
  - **Then** the turn is interrupted and `U` receives the markdown message `已中断`.

- AE2. **No active session**
  - **Covers:** R2, R8.
  - **Given** user `U` has no active WeCom session.
  - **When** `U` sends `/stop`.
  - **Then** `U` receives `没有活跃的会话可中断。请运行 /resume 选择会话。` and no new session is created.

- AE3. **Nothing in flight**
  - **Covers:** R3.
  - **Given** user `U` has active session `S` but no turn is processing.
  - **When** `U` sends `/stop`.
  - **Then** `U` receives `当前没有正在进行的对话。`.

- AE4. **Cancel pending approval**
  - **Covers:** R5.
  - **Given** user `U` has active session `S` with a pending tool approval card.
  - **When** `U` sends `/stop`.
  - **Then** the pending approval is cancelled and `U` receives `已中断`.

## Scope Boundaries

- Does not add `/interrupt` or other aliases for the command.
- Does not add a template-card button for interrupt.
- Does not allow admins or other users to interrupt someone else's session.
- Does not apply to Feishu bot or other channels.
- Does not cancel or affect proactive messages queued in `WeComQueueWorker`.

## Dependencies / Assumptions

- `SessionRuntime.interrupt()` in `src/server/services/session-runtime.ts` is available and emits the `interrupted` SSE event.
- `chatService.getRuntimeIfExists(sessionId)` returns the cached runtime for an active session.
- The WeCom stream reply handler already handles `interrupted` events by clearing placeholders and finalizing the stream.
- The Feishu bot `/stop` command in `src/server/services/feishu-bot-service.ts` provides the reference behavior.

## Sources / Research

- `src/server/services/wecom-bot-service.ts` — existing WeCom bot command parsing and message handling.
- `src/server/services/feishu-bot-service.ts:367-384` — Feishu `/stop` command reference.
- `src/server/services/session-runtime.ts:616-627` — `SessionRuntime.interrupt()` implementation.
- `src/server/services/wecom-stream-reply.ts:287-289` — `interrupted` event handling in WeCom stream replies.
- `src/server/routes/chat.ts:354-370` — GUI interrupt API route.
