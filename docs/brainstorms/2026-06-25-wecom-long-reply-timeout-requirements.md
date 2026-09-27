---
date: 2026-06-25
topic: wecom-long-reply-timeout
---

# WeCom Long Reply Timeout Handling

## Summary

Add a 9-minute safety threshold to WeCom bot passive reply streaming. If the model has not produced a final result within 9 minutes, the bot sends a status message to the user, stops refreshing the passive reply, and lets the original message auto-end. The model keeps running; the final result is pushed afterward via proactive `sendMessage`, split if it exceeds WeCom's 20480-byte UTF-8 limit.

---

## Problem Frame

WeCom's bot API requires a streaming passive reply to finish within 10 minutes (`finish=true`). Current code in `src/server/services/wecom-stream-reply.ts` only calls `finalizeStream` on `result`, `interrupted`, or `error_note` events, with no intermediate safeguard. For long tasks — extended thinking, multi-tool chains, or long-pending approvals — the passive reply can be cut off by WeCom at the 10-minute boundary while the Claude Code session continues running. The user sees a truncated or "frozen" message and never receives the eventual result.

---

## Key Decisions

- **9-minute trigger** leaves a 1-minute buffer before WeCom's 10-minute hard limit, reducing race conditions.
- **Do not actively finish the original message** after the threshold. Send the status message, stop passive refreshes, and let WeCom auto-end the stream. This keeps state management simple.
- **Ignore deltas after the threshold** and only push the final result. This balances user value with implementation complexity and rate-limit exposure.
- **Proactive `sendMessage` for the final result** is valid within WeCom's 24-hour reply window for the same conversation.
- **Split by UTF-8 byte length** to comply with WeCom's 20480-byte single-message limit.

---

## Actors

- A1. WeCom User: sends a message to the bot and expects a response, even for long-running tasks.
- A2. Claude Code Agent: processes the message, may run tools, subagents, or questions.
- A3. Bot Adapter (`wecom-stream-reply.ts`): translates SDK events into WeCom messages and manages the passive/proactive switch.

---

## Requirements

### Timeout Safeguard

- R1. Start a timer when the first `replyStream` call is made for an inbound message. If no `result`, `interrupted`, or `error_note` event has arrived after 9 minutes, trigger the safeguard.
- R2. When the safeguard triggers, send a proactive message to the user: "任务处理需要更长的时间，在任务处理完成后，我将把结果发送给你。"
- R3. After sending the status message, stop calling `replyStreamNonBlocking` for that stream.
- R4. Do not call `replyStream(..., true)` to finish the original message; let WeCom end it automatically.

### Final Result Delivery

- R5. The `SessionRuntime` continues running and the stream handler keeps listening, but `text_delta` events received after the safeguard are ignored.
- R6. When the final event (`result`, `interrupted`, or `error_note`) arrives, deliver the complete result via proactive `sendMessage`.
- R7. Measure the result length in UTF-8 bytes. If it exceeds 20480 bytes, split it at character boundaries into multiple sequential messages, each under the limit.
- R8. Split messages should preserve readability where feasible (avoid splitting mid-word or mid-sentence when possible) and may include an optional part indicator such as "(1/3)".

### State and Error Handling

- R9. Mark the passive reply channel as closed after the safeguard triggers so no further passive refreshes are attempted.
- R10. Log and, where reasonable, retry failures when pushing the final result via `sendMessage`.
- R11. Preserve the existing fast path: if the final event arrives before the 9-minute threshold, finalize via the current `finalizeStream` passive-reply path.

---

## Key Flows

- F1. Short task completes within 9 minutes
  - **Trigger:** A1 sends a message.
  - **Actors:** A1, A2, A3
  - **Steps:** A3 sends placeholder → A2 streams `text_delta` events → A2 emits `result` → A3 calls `finalizeStream` with `finish=true`.
  - **Outcome:** A1 sees a single, complete passive-reply message.
  - **Covered by:** R11

- F2. Long task exceeds 9 minutes
  - **Trigger:** A1 sends a message that requires extended processing.
  - **Actors:** A1, A2, A3
  - **Steps:**
    - A3 sends placeholder and starts 9-minute timer.
    - A3 streams `text_delta` updates as they arrive.
    - 9 minutes elapse with no `result` → A3 sends status message via `sendMessage`, marks passive channel closed, stops passive refreshes.
    - A2 continues running in the background.
    - A2 emits `result` → A3 collects the full response, splits if needed, and sends it via proactive `sendMessage`.
  - **Outcome:** A1 first sees a brief status message, then receives the full result later.
  - **Covered by:** R1–R10

---

## Acceptance Examples

- AE1. **Covers R1, R11.** Given a user sends a short question, when the model returns a result after 8 minutes, then the existing passive-reply finalize path is used and the user sees one complete message.

- AE2. **Covers R1, R2, R5, R6, R7.** Given a user sends a complex task, when 9 minutes pass without a result, then the user receives the status message and the original passive reply ends. When the model finishes 6 minutes later with 30000 bytes of UTF-8 text, then the result is split into two messages and delivered proactively.

- AE3. **Covers R6.** Given the model finishes after the threshold but produces no text output, then no empty result message is sent to the user.

---

## Scope Boundaries

- No per-conversation rate limiting for the 30 messages/minute or 1000 messages/hour quotas.
- No timeout handling for non-text inbound messages such as files, images, or voice.
- No changes to WeCom bot connection, session creation, user mapping, or tool permission policy.
- No UI styling or rich formatting changes beyond optional part indicators on split messages.

---

## Dependencies / Assumptions

- `@wecom/aibot-node-sdk` supports proactive `sendMessage` delivery after the passive reply stream has ended.
- The combined proactive messages (status + result parts) stay within WeCom's 24-hour reply window and practical rate limits.
- The model eventually produces a final result; otherwise the status message is the last contact.

---

## Sources / Research

- WeCom bot API: streaming passive replies must set `finish=true` within 10 minutes or the message auto-ends.
- WeCom bot API: single markdown messages are limited to 20480 bytes and must be UTF-8 encoded.
- Current implementation: `src/server/services/wecom-stream-reply.ts` finalizes the passive reply only on `result`, `interrupted`, or `error_note` events.
