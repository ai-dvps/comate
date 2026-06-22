---
date: 2026-06-22
topic: feat-feishu-streaming-replace-in-place
---

# Feishu Streaming Replace-in-Place Requirements

## Summary

Make Feishu bot streaming replies behave like WeCom: a single message updates in place as the model generates text, tool/thinking placeholders are visible only while work is in progress, and the finished message contains only the final answer.

## Problem Frame

WeCom streaming replies (`src/server/services/wecom-stream-reply.ts`) maintain one `responseText` buffer and re-send the full accumulated text on every update. Placeholders for thinking and tool use are appended while work is happening and removed before the final answer is sent, so the user never sees them in the completed message.

Feishu streaming replies (`src/server/services/feishu-stream-reply.ts`) currently yield an async iterable of `StreamChunk` values that are consumed by the Lark adapter's native cardkit typewriter stream. Placeholders are enqueued as ordinary text chunks and are never removed from the card content, so the finished message still contains labels like `正在思考...` and `🔧 Bash...`. This is inconsistent with WeCom and leaves transient progress indicators in the final answer.

## Key Decisions

- **Native cardkit streaming with a final cleanup patch.** Feishu will keep the adapter's cardkit typewriter stream for live updates, then apply a final replace-in-place patch to the card that contains only the final answer and disables the streaming cursor. This preserves Feishu's smooth typing animation while still matching WeCom's final-state behavior.
- **Placeholder labels, not raw tool output.** The user sees short labels while the model is thinking or a tool/sub-agent is running. The raw tool arguments, tool results, and reasoning text are not surfaced.
- **Approval and question cards stay separate.** Interactive approval and question cards remain standalone messages, unchanged from the current Feishu behavior.

## Requirements

### Streaming behavior

- R1. A Feishu bot reply is rendered as a single card that updates in place while the answer is being generated.
- R2. While the model is thinking, the card shows a transient thinking label.
- R3. While a tool is being used, the card shows a transient tool label that includes the tool name.
- R4. While a sub-agent is running, the card shows a transient sub-agent label.
- R5. When the final answer begins arriving, the previous thinking/tool/sub-agent label is removed from the visible content.
- R6. When the stream completes, the card content is replaced with the final answer text and any remaining transient labels are removed.
- R7. The streaming cursor/indicator is disabled once the final answer is committed.

### Error and fallback behavior

- R8. If the final cleanup patch fails, the bot must not crash the message handler; it should log the failure and leave the streamed card as-is.
- R9. If the stream errors before completion, the card shows an error footer and the streaming indicator is disabled.

### Consistency and scope

- R10. The final message visible to the user contains only the model's final answer text (plus any error footer); no thinking, tool, or sub-agent labels remain.
- R11. WeCom streaming behavior is not changed.
- R12. Approval and question cards continue to be sent as separate interactive cards.

## Acceptance Examples

- AE1. **Tool then answer**
  - **Trigger:** The model calls `Bash` and then produces a final answer.
  - **During:** The card shows `🔧 Bash...` while the tool runs, then switches to accumulating the answer text.
  - **Final:** The card contains only the answer text; `🔧 Bash...` is gone.

- AE2. **Thinking then answer**
  - **Trigger:** The model emits a `thinking_start` event before the first token.
  - **During:** The card shows the thinking label.
  - **Final:** After the first answer token arrives, the thinking label disappears and is not present in the final card.

- AE3. **No tool, no thinking**
  - **Trigger:** The model produces a plain text answer.
  - **Final:** The card contains only the answer text; no placeholder labels were ever shown.

## Scope Boundaries

### Deferred for later

- Exposing raw tool arguments, tool results, or reasoning chains to the user.
- Inline approval/question prompts inside the streaming card.
- Cross-platform unification of placeholder wording or animation timing.

### Outside this product's identity

- Changing WeCom streaming behavior.
- Altering the SSE event stream produced by the runtime.

## Dependencies / Assumptions

- The Lark adapter and underlying Feishu SDK support patching an already-sent card/message to replace its content and disable the streaming cursor.
- The Feishu bot service can capture the message/card identifiers returned when the stream starts.
- The current `SseEvent` union already provides `thinking_start`, `tool_use_start`, `tool_result`, `subagent_start`, `subagent_done`, `assistant_done`, `result`, and `error_note` events; no new event types are needed.

## Outstanding Questions

- **Deferred to planning:** If the final placeholder-stripping patch fails, is retrying once acceptable, or should the system always leave the streamed card as-is on the first failure?

## Sources / Research

- `src/server/services/wecom-stream-reply.ts` — replace-in-place buffer and placeholder removal logic.
- `src/server/services/feishu-stream-reply.ts` — current async-iterable stream and placeholder handling.
- `src/server/services/feishu-bot-service.ts` — consumes the Feishu stream and posts it via `thread.post()`.
- `@larksuite/vercel-chat-adapter` and `@larksuiteoapi/node-sdk` — provide cardkit streaming and message/card patch APIs.
