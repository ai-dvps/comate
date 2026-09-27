---
date: 2026-06-23
topic: feishu-tool-failure-message-delivery
---

# Feishu Tool-Failure Message Delivery Requirements

## Summary

Ensure Feishu bot replies always conclude with the model's final answer or a clear failure message, instead of leaving users stuck on the initial "收到，正在处理…" placeholder when a tool fails mid-turn.

---

## Problem Frame

When a Claude Code tool fails during a Feishu turn, the streaming card is created with an initial processing hint. The current finalization path disables the streaming cursor but does not push a final content patch. If the model produces no answer text after the failure, the card is never updated, so the Feishu user continues to see only the placeholder. The WeCom bot already guarantees a final frame; Feishu needs the same delivery guarantee.

---

## Key Decisions

- **Tool failures stay non-fatal to the turn.** The runtime passes the `tool_result` to the model, which decides whether to retry with another tool or explain the failure in the final answer. We will not add a separate abort path for tool errors.
- **Empty final answers get a generic failure message.** When the turn ends with no model answer text, the placeholder is replaced with a concise failure message rather than left in its initial state.
- **Keep the change Feishu-local.** The fix belongs in the Feishu streaming reply layer; it does not change `SessionRuntime`, the SSE event vocabulary, or WeCom behavior.

---

## Requirements

### Final content patch

- R1. `FeishuCardStream.finish()` must push a final `cardElement.content` update that replaces the card's markdown element with the final text, even when no prior content updates occurred.
- R2. When the final answer text is non-empty, the final patch must contain exactly that text, including any appended warning or error notes.
- R3. When the final answer text is empty at finalization, `FeishuStreamReply` must substitute a generic failure message (e.g., "⚠️ 处理失败，请稍后重试。") for the final patch.
- R4. Finalization must be idempotent; calling `finish()` or `finalize()` more than once must not duplicate messages or corrupt the card.
- R5. If the final content patch fails, the bot must log the failure and leave the card as-is, matching the existing cleanup-patch fallback behavior.

### Turn continuity

- R6. A tool failure must not trigger an early stream abort. The streaming reply waits for the normal end-of-turn event (`result`, `error_note`, or `interrupted`) before finalizing.
- R7. Placeholder labels for tools, thinking, or subagents must be cleared before the final patch is applied, so the finished card contains only the answer or failure message.

---

## Acceptance Examples

- AE1. **Tool fails, model explains**
  - **Given:** A tool fails mid-turn and the model produces a final explanation.
  - **When:** The turn ends.
  - **Then:** The Feishu card shows the model's explanation, the streaming cursor is disabled, and no tool placeholder remains.

- AE2. **Tool fails, model produces no text**
  - **Given:** A tool fails mid-turn and the model produces no answer text.
  - **When:** The turn ends.
  - **Then:** The Feishu card shows the generic failure message, the streaming cursor is disabled, and the initial placeholder is gone.

- AE3. **Normal turn with an answer**
  - **Given:** A turn completes without a tool failure and the model produces an answer.
  - **When:** The turn ends.
  - **Then:** The Feishu card shows the final answer and the streaming cursor is disabled.

---

## Scope Boundaries

### Deferred for later

- Runtime-level retries for failed tool calls.
- Changing how tool errors are summarized or reported to the model.
- Group-chat `@mention` behavior or other Feishu channel features.
- Finalization of standalone approval or question cards.

### Outside this product's identity

- Changing WeCom streaming behavior.
- Changing the React client or SSE event vocabulary.

---

## Dependencies / Assumptions

- The Lark cardkit API supports patching the content of an existing card element.
- The existing SSE event stream and `SessionRuntime` behavior remain unchanged.
- Feishu cards require at least one visible character in content updates.

---

## Sources / Research

- `src/server/services/feishu-stream-reply.ts` — event handling and finalization.
- `src/server/services/feishu-card-stream.ts` — card creation, content updates, and finish behavior.
- `src/server/services/wecom-stream-reply.ts` — final-frame delivery pattern used by WeCom.
- `src/server/services/session-runtime.ts` — runtime error handling and event emission.
- `docs/brainstorms/2026-06-22-feat-feishu-streaming-replace-in-place-requirements.md` — prior Feishu streaming cleanup work.
