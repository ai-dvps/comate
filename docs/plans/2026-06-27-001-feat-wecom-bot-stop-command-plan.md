---
title: Add /stop command to WeCom bot
type: feat
date: 2026-06-27
origin: docs/brainstorms/2026-06-27-wecom-bot-stop-command-requirements.md
---

## Summary

Add a `/stop` text command to the WeCom bot so users can interrupt an in-flight AI turn in their own active session. The command cancels pending tool approvals or questions and sends a dedicated "已中断" confirmation.

## Problem Frame

WeCom bot users currently have no escape hatch for a long or off-track response after sending a message. The GUI has an Interrupt button, and the Feishu bot already supports `/stop`, but the WeCom bot only exposes `/clear`, `/new`, and `/resume`. Without `/stop`, users must wait for the turn to complete or abandon the conversation.

## Requirements

R1. `/stop` is parsed as a bot command before session lookup or creation, so it never creates a new session.

R2. If the user has no active WeCom session, reply with `没有活跃的会话可中断。请运行 /resume 选择会话。`

R3. If the user has an active session but it has no in-flight turn, reply with `当前没有正在进行的对话。`

R4. If the active session has an in-flight turn, call `runtime.interrupt()` on the session's cached runtime.

R5. Any pending tool approval or question for the interrupted turn is cancelled and resolved as denied.

R6. After a successful interrupt, send the user the markdown message `已中断`.

R7. Errors during `/stop` handling are logged and must not crash the bot connection or leave the runtime in an inconsistent state.

## Key Technical Decisions

- **KTD-1. Send the confirmation from the command handler.** The WeCom stream reply already finalizes silently on `interrupted`; sending `已中断` from `handleStopCommand` makes the action explicit without touching shared stream-reply logic. This diverges from Feishu, which sends no confirmation.
- **KTD-2. Add an explicit pending-approval cancellation helper.** `SessionRuntime.interrupt()` cancels the SDK query but does not resolve entries in the pending-approvals map. A dedicated helper resolves all pending approvals/questions as denied so R5 holds regardless of SDK abort behavior.
- **KTD-3. Reuse the existing `/resume` command grammar.** `/stop` matches exact `/stop` or `/stop ` prefix, consistent with how other WeCom bot commands are parsed.

## Implementation Units

### U1. Add `/stop` parser and command dispatch

- **Goal:** Detect the `/stop` command before the message reaches the agent.
- **Requirements:** R1.
- **Dependencies:** None.
- **Files:** `src/server/services/wecom-bot-service.ts`
- **Approach:** Add `parseWecomStopCommand(content)` mirroring `parseWecomResumeCommand`. Intercept it in `handleTextMessage` after `/resume` and before `getOrCreateSession`.
- **Patterns to follow:** Existing parser functions at the top of `wecom-bot-service.ts` and the `/resume` interception block.
- **Test scenarios:**
  - Exact `/stop` is recognized.
  - `/stop now` is recognized.
  - `/stopping` is not recognized.
  - `/stop` is intercepted before session creation.

### U2. Implement `handleStopCommand`

- **Goal:** Look up the user's active session, interrupt the runtime if a turn is in flight, and send the confirmation or error message.
- **Requirements:** R2, R3, R4, R6, R7.
- **Dependencies:** U1, U3.
- **Files:** `src/server/services/wecom-bot-service.ts`
- **Approach:** Follow the Feishu `handleStopCommand` shape but with WeCom-specific messages. Look up `workspaceStore.getActiveWecomSession`, get `chatService.getRuntimeIfExists`, guard with `isProcessingTurn()`, call `runtime.interrupt()` plus the pending-approval cancellation helper, then send `已中断`. Wrap the interrupt call in try/catch, log errors, and do not crash the connection.
- **Patterns to follow:** `src/server/services/feishu-bot-service.ts:367-384`.
- **Test scenarios:**
  - Active session with processing turn → `runtime.interrupt()` called, confirmation sent.
  - No active session → "no active session" message sent, no session created.
  - Active session but no turn in flight → "nothing in flight" message sent.
  - `runtime.interrupt()` throws → error logged, bot connection stays alive.

### U3. Add pending-approval cancellation helper to SessionRuntime

- **Goal:** Provide a reliable way to resolve all pending approvals/questions as denied when a turn is interrupted.
- **Requirements:** R5.
- **Dependencies:** None.
- **Files:** `src/server/services/session-runtime.ts`
- **Approach:** Add a public method that iterates the private `pendingApprovals` map, clears timers, emits `approval_resolved` events, and resolves each pending promise with `behavior: 'deny'` and a message indicating the user interrupted the turn.
- **Patterns to follow:** `resolveApproval()` in the same file; the close path already resolves dangling approvals on shutdown.
- **Test scenarios:**
  - Helper resolves pending tool approvals as denied.
  - Helper resolves pending questions as denied.
  - Calling helper twice is safe (no-op for already-resolved entries).

### U4. Add WeCom bot `/stop` tests

- **Goal:** Cover the new command end-to-end in the WeCom bot service test suite.
- **Requirements:** R1–R7.
- **Dependencies:** U1, U2, U3.
- **Files:** `src/server/services/wecom-bot-service.test.ts`
- **Approach:** Mock `workspaceStore.getActiveWecomSession`, `chatService.getRuntimeIfExists`, and a fake runtime with `isProcessingTurn` and `interrupt`. Spy on `conn.client.sendMessage`. Reset store data between tests.
- **Patterns to follow:** Existing `wecom-bot-service.test.ts` setup with isolated store and mocked services.
- **Test scenarios:**
  - Covers the interrupt-with-confirmation acceptance case.
  - Covers the no-active-session acceptance case.
  - Covers the nothing-in-flight acceptance case.
  - Covers the cancel-pending-approval acceptance case.

## Scope Boundaries

- Does not add `/interrupt` or other aliases.
- Does not add a template-card interrupt button.
- Does not allow admins or other users to interrupt someone else's session.
- Does not change Feishu bot behavior.
- Does not cancel or affect proactive messages queued in `WeComQueueWorker`.

## Risks & Dependencies

- **Pending-approval cancellation assumption:** `runtime.interrupt()` may or may not abort pending approvals via the SDK signal. U3 makes R5 robust by resolving them explicitly. If the SDK also resolves them, the helper's second pass is a no-op.
- **Stream finalization race:** If the 9-minute safeguard has fired, the stream reply may proactively deliver partial content before the `已中断` confirmation arrives. This is acceptable per the product decision to let the stream reply finalize normally.
- **WeCom SDK timing:** `handleTextMessage` is fire-and-forget, so the 5-second response window does not block `/stop` handling.

## Acceptance Examples

- AE1. **Interrupt a running turn**
  - **Covers:** R1, R4, R6.
  - **Given** user `U` has an active WeCom session `S` with a turn currently streaming.
  - **When** `U` sends `/stop`.
  - **Then** the turn is interrupted and `U` receives `已中断`.

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

## Sources / Research

- `docs/brainstorms/2026-06-27-wecom-bot-stop-command-requirements.md` — origin requirements doc.
- `src/server/services/wecom-bot-service.ts` — existing command parsing and message handling.
- `src/server/services/feishu-bot-service.ts:367-384` — Feishu `/stop` reference.
- `src/server/services/session-runtime.ts:616-627` — runtime interrupt implementation.
- `src/server/services/wecom-stream-reply.ts:287-289` — `interrupted` event handling.
- `src/server/services/wecom-bot-service.test.ts` — existing test patterns.
- `docs/solutions/integration-issues/wecom-update-template-card-5s-window.md` — WeCom response timing.
- `docs/solutions/integration-issues/sse-stream-resume-on-reconnect-2026-05-18.md` — `interrupted` event clears `currentMessageStartId`.
- `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md` — pending approvals can replay on reconnect; server-side cancellation prevents this.
