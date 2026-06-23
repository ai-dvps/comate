---
title: Fix Feishu tool-failure message delivery
type: fix
date: 2026-06-23
origin: docs/brainstorms/2026-06-23-feishu-tool-failure-message-delivery-requirements.md
---

# Fix Feishu tool-failure message delivery

## Summary

Add an empty-answer fallback in `FeishuStreamReply` so a Feishu bot turn that ends with no model text replaces the initial placeholder with a generic failure message, rather than leaving the card stuck on "收到，正在处理...".

## Problem Frame

When a Claude Code tool fails mid-turn and the model produces no answer text, `FeishuStreamReply.finalize()` calls `FeishuCardStream.finish('')`. `FeishuCardStream` skips empty content updates and only disables streaming mode, so the Feishu user is left with the initial processing hint. The WeCom bot already guarantees a final frame; Feishu needs the same delivery guarantee.

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

## Key Technical Decisions

- KTD-1. **Caller supplies fallback text; `FeishuCardStream` stays content-agnostic.** `FeishuCardStream` already rejects empty/whitespace content; the semantic meaning of "no answer" belongs to the Feishu reply orchestrator.
- KTD-2. **Substitute the generic failure message only when `responseText` has no visible characters at finalization.** This preserves model explanations and `error_note` details when they exist, and matches AE1 and AE2.
- KTD-3. **Keep the change inside the Feishu streaming reply layer.** `SessionRuntime` and the SSE vocabulary already produce end-of-turn events; other channels such as WeCom or the GUI should not change.

## Implementation Units

### U1. Ensure final content patch in `FeishuCardStream`

**Goal:** Verify and regression-test that `finish()` always pushes a `cardElement.content` update when the final text is non-empty, including when no prior `setContent()` calls were made.

**Files:**
- `src/server/services/feishu-card-stream.ts` (read-only unless a gap is found)
- `src/server/services/feishu-card-stream.test.ts` (add tests)

**Approach:**
The current `finish()` path already flushes the throttle and calls `pushContent()` with the supplied text. No code change is expected unless that path proves incomplete. Add a regression test that calls `finish('final')` immediately after `start()` without any `setContent()` and asserts one `cardElement.content` call containing `'final'`. Retain the existing test that `finish('')` produces no content call, confirming the caller must provide fallback text.

**Test scenarios:**
- `finish('final')` after `start()` with no `setContent()` pushes one `cardElement.content` call with `'final'`.
- `finish('')` after `start()` with no `setContent()` pushes zero `cardElement.content` calls.
- `finish()` remains idempotent: repeated calls return the same promise and produce exactly one `card.settings` call.
- Content update errors are logged and swallowed; the final `card.settings` call is still attempted.

**Verification:**
```bash
npm run test:server -- src/server/services/feishu-card-stream.test.ts
```

### U2. Substitute fallback message on empty final answer in `FeishuStreamReply`

**Goal:** When a turn ends with no visible answer text, replace the placeholder with a generic failure message before finalizing the card.

**Files:**
- `src/server/services/feishu-stream-reply.ts` (modify)
- `src/server/services/feishu-stream-reply.test.ts` (add tests)

**Approach:**
In `finalize()`, after clearing the placeholder state, inspect `responseText`. If it has no visible characters, set it to a constant fallback message such as `FALLBACK_TEXT = '⚠️ 处理失败，请稍后重试。'`. Then call `this.controller.finish(this.responseText)`. Because the fallback contains visible characters, `FeishuCardStream` will push it as the final content patch.

**Patterns to follow:**
Match the existing warning style already used for `result` with `isError: true` (`\n\n⚠️ 处理失败，请稍后重试。`). Keep the constant at the top of the file near the imports.

**Test scenarios:**
- `result` (`isError: false`) with no model text → the final `cardElement.content` call contains the fallback message and the `card.settings` summary contains the fallback message.
- `error_note` with empty text → the final content call contains the fallback message.
- `interrupted` with no model text → the final content call contains the fallback message.
- `result` (`isError: true`) with no model text → the final content contains the existing error footer and does not append a duplicate fallback.
- Normal turn with answer text → the final content is the answer text and no fallback is injected.
- `finalize()` called twice returns the same promise and does not duplicate content calls.

**Verification:**
```bash
npm run test:server -- src/server/services/feishu-stream-reply.test.ts
```

## Scope Boundaries

### Deferred for later

- Runtime-level retries for failed tool calls.
- Changing how tool errors are summarized or reported to the model.
- Group-chat `@mention` behavior or other Feishu channel features.
- Finalization of standalone approval or question cards.

### Outside this product's identity

- Changing WeCom streaming behavior.
- Changing the React client or SSE event vocabulary.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Lark cardkit content updates may fail | Existing behavior logs and swallows the error; the card keeps its last visible state |
| The runtime never emits a terminating event due to a hang or lost session | Out of scope; this fix only handles the case where an end-of-turn event arrives with no answer text |
| Fallback message is too generic for some failure modes | Acceptable per the brainstorm decision; more detailed errors are still delivered via `error_note` or `result(isError: true)` |

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

## Sources / Research

- `src/server/services/feishu-stream-reply.ts` — event handling and finalization.
- `src/server/services/feishu-card-stream.ts` — card creation, content updates, and `finish()` behavior.
- `src/server/services/feishu-stream-reply.test.ts` and `src/server/services/feishu-card-stream.test.ts` — existing test coverage.
- `docs/brainstorms/2026-06-23-feishu-tool-failure-message-delivery-requirements.md` — origin requirements.
