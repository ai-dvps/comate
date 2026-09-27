---
title: "feat: Feishu streaming replace-in-place"
type: feat
date: 2026-06-22
origin: docs/brainstorms/2026-06-22-feat-feishu-streaming-replace-in-place-requirements.md
---

# Feishu Streaming Replace-in-Place

## Summary

Replace Feishu bot streaming replies with CardKit native streaming so a single card updates in place, transient thinking/tool labels disappear before the final answer is committed, and the finished card contains only the answer.

---

## Problem Frame

WeCom streaming replies (`src/server/services/wecom-stream-reply.ts`) keep one `responseText` buffer and re-send the full accumulated text on every update. Placeholders are appended while work is happening and stripped before the final answer is delivered, so the user never sees them in the completed message.

Feishu streaming replies (`src/server/services/feishu-stream-reply.ts`) currently yield an async iterable that the Chat SDK consumes. Placeholder labels are enqueued as ordinary text and are never removed from the final card, so the finished message still contains `正在思考...`, `🔧 Bash...`, and similar transient indicators. This is inconsistent with WeCom.

A first guess at fixing this was to use `im.v1.message.patch` to replace the whole card on every update, but that API is rate-limited to roughly 5 QPS per bot per conversation — far too strict for live streaming. CardKit's native streaming APIs (`cardkit.v1.card.create`, `cardkit.v1.cardElement.content`, `cardkit.v1.card.settings`) are designed for high-frequency incremental updates and avoid that bottleneck.

---

## Requirements

### Streaming behavior

- R1. A Feishu bot reply is rendered as a single card that updates in place while the answer is generated.
- R2. While the model is thinking, the card shows a transient thinking label.
- R3. While a tool is being used, the card shows a transient tool label that includes the tool name.
- R4. While a sub-agent is running, the card shows a transient sub-agent label.
- R5. When the final answer begins arriving, previous thinking/tool/sub-agent labels are removed from the visible content.
- R6. When the stream completes, the card content is replaced with the final answer text and any remaining transient labels are removed.
- R7. The streaming cursor/indicator is disabled once the final answer is committed.

### Error and fallback behavior

- R8. If the final cleanup call fails, the bot logs the failure and leaves the streamed card as-is.
- R9. If the stream errors before completion, the card shows an error footer and the streaming indicator is disabled.

### Consistency and scope

- R10. The final message visible to the user contains only the model's final answer text (plus any error footer); no thinking, tool, or sub-agent labels remain.
- R11. WeCom streaming behavior is not changed.
- R12. Approval and question cards continue to be sent as separate interactive cards.

---

## Key Technical Decisions

- **Use CardKit native streaming, not `im.v1.message.patch`.** `cardkit.v1.cardElement.content` is built for frequent incremental updates and is what the Lark SDK's `MarkdownStreamController` uses internally. `im.v1.message.patch` is rate-limited to ~5 QPS and cannot sustain WeCom-style live updates.
- **Maintain a WeCom-style `responseText` buffer on the server.** Feishu will accumulate the final answer in a buffer and, when rendering, append the active placeholder label to that buffer for display. Transitions strip the label by re-rendering the buffer alone.
- **Replace the visible markdown element via full-content updates.** CardKit element updates accept a complete new markdown string. Setting the full visible text on each update lets us remove placeholder labels at transition points, something the adapter's append-only producer path cannot do cleanly. The origin requirements explored keeping the adapter's typewriter stream with a final replace-in-place patch, but this was abandoned because the adapter's append-only path makes it impossible to remove placeholder labels mid-stream — the card would show stale labels until the stream finishes, violating R5 ("labels removed when the final answer begins arriving"). Full-content replacement at every delta is the only approach that satisfies R5 without waiting for stream completion.
- **Keep approval/question cards as separate messages.** They are out of scope for the streaming card and already work as standalone interactive cards.
- **Best-effort finalization.** If the CardKit finish call fails, log and move on rather than retrying or crashing the message handler.

---

## Implementation Units

### U1. Streaming-card controller helper

**Goal:** Encapsulate the CardKit streaming lifecycle (create card, send message, update element, finish stream) behind a small, testable controller.

**Requirements:** R1, R7, R8.

**Dependencies:** None.

**Execution note:** If the controller remains single-consumer (only `FeishuStreamReply`), consider inlining the CardKit lifecycle methods directly into `FeishuStreamReply` during U3 implementation to reduce indirection. The separate file is justified for test isolation but should not survive if it stays a pass-through layer.

**Files:**
- Create `src/server/services/feishu-card-stream.ts`.
- Create `src/server/services/feishu-card-stream.test.ts`.

**Approach:**
- Provide a `FeishuCardStream` class that accepts a `lark.Client` and target `open_id`.
- `start(initialText)` creates a CardKit card (`cardkit.v1.card.create`) with `streaming_mode: true` and a single markdown element with a stable `element_id`, then sends an interactive message referencing that card (`im.v1.message.create`), returning both `cardId` and `messageId`.
- `setContent(text)` calls `cardkit.v1.cardElement.content` with a monotonically increasing `sequence` and a deterministic `uuid`. Calls are throttled — fires on a 100ms interval or every 50 characters accumulated, whichever comes first (matching the SDK's default). Unlike a debounce, this guarantees a minimum update frequency during sustained text output rather than waiting for a pause.
- `finish(text?)` is idempotent — first call sets a `finalized` flag, flushes pending updates, commits the final text (if supplied), and calls `cardkit.v1.card.settings` to set `streaming_mode: false` and `summary: { content: truncateSummary(finalText) }` so the chat-list preview reflects the completed answer rather than the initial hint. Subsequent calls are a no-op and return the same promise. If a final text is supplied, it is committed first so the card shows answer-only content when the cursor disappears.
- Errors during updates are logged and do not crash the handler; a failure flag prevents further updates from spamming the API.
- If card creation or initial message send fails during `start()`, log the error and throw so `FeishuBotService` can catch and fall back to a plain text reply.

**Patterns to follow:**
- Mirror the WeCom debounce/flush pattern in `src/server/services/wecom-stream-reply.ts`.
- Use the same `uuid` composition the SDK uses internally (`c_${cardId}_${sequence}`) so updates are idempotent.

**Test scenarios:**
- `start` creates a card and a message and returns both ids.
- If card creation or message send fails, `start` throws and logs the error.
- Multiple rapid `setContent` calls are debounced into a single CardKit update.
- `finish` disables `streaming_mode`.
- Calling `finish` twice returns the same promise (second call is a no-op).
- A CardKit error during update is logged and does not throw.

**Verification:** Unit tests pass; mock client records the expected CardKit and IM API calls with correct sequence/uuid values.

---

### U2. Streaming answer card builder

**Goal:** Produce the card JSON used by the streaming controller.

**Requirements:** R1, R7.

**Dependencies:** None.

**Files:**
- Modify `src/server/services/feishu-card-builder.ts`.

**Approach:**
- Add `buildStreamingAnswerCard(initialText)` returning a CardKit card spec object (standalone type, not `FeishuCard` — that interface models interactive cards sent via `im.message.create` and lacks `streaming_mode`, `streaming_config`, and the `schema: '2.0'`/`body.elements` shape CardKit requires). The returned shape includes:
  - `schema: '2.0'`.
  - `config.wide_screen_mode: true`.
  - `config.streaming_mode: true`.
  - `config.streaming_config` with print frequency/strategy defaults.
  - `body.elements` containing one markdown element with a stable `element_id` (e.g., `stream_md`).
- The builder stays minimal so the controller owns the lifecycle.

**Patterns to follow:** Existing `baseCard`/`markdownText` helpers in the same file.

**Test scenarios:**
- The returned card has `streaming_mode: true`.
- The markdown element has the expected `element_id` and initial content.

**Verification:** Existing/new builder assertions pass.

---

### U3. Refactor `FeishuStreamReply` for replace-in-place

**Goal:** Replace the async-iterable stream with the CardKit controller while preserving placeholder semantics.

**Requirements:** R2–R6, R9, R10, R12.

**Dependencies:** U1, U2.

**Files:**
- Modify `src/server/services/feishu-stream-reply.ts`.
- Modify `src/server/services/feishu-stream-reply.test.ts`.

**Approach:**
- Remove the internal queue/async-iterable machinery.
- Add a `responseText` buffer and a `visiblePlaceholder` string, matching the WeCom model.
- The constructor retains the `initialHint` option. `start()` passes it as the initial text to `controller.start(initialHint ?? '收到，正在处理...')`.
- On events:
  - `assistant_start` sets `collecting = true`, clears the placeholder, and if `responseText` is non-empty and doesn't already end with `\n\n`, appends `\n\n` — matching WeCom behavior.
  - `thinking_start` / `tool_use_start` / `subagent_start` set `visiblePlaceholder` to the appropriate label and call `controller.setContent(responseText + visiblePlaceholder)`.
  - `text_delta` clears the placeholder, appends to `responseText`, and calls `controller.setContent(responseText)`.
  - `tool_result`, `subagent_done`, `assistant_done` clear the placeholder and flush the current buffer.
  - `error_note`, `result`, `interrupted` finalize: clear the placeholder, append any error footer to `responseText`, call `controller.finish(responseText)`.
- Keep `postApprovalCard`, `postQuestionCard`, and `sendText` unchanged; they continue to post separate cards via `larkClient.im.message.create`.
- Expose `start()` and `finalize()` (or equivalent) so the caller drives the lifecycle.
- `finalize()` is idempotent: the first call stores an `async finishPromise` from `controller.finish()`, subsequent calls return the same promise. This mirrors the synchronous `finalized` guard in the current code and WeCom's `finalizeStream` pattern, and handles the case where the internal event handler initiates finalization before the external caller calls `finalize()`.

**Execution note:** This unit is a behavioral refactor — add/update tests before changing the implementation to ensure existing approval/question/timeout behavior is preserved.

**Patterns to follow:**
- WeCom placeholder accumulation/removal in `src/server/services/wecom-stream-reply.ts`.
- Existing event handling order in `src/server/services/feishu-stream-reply.ts`.

**Test scenarios:**
- During `thinking_start`, the controller receives content that includes the thinking label; after the first `text_delta`, the label is gone.
- During `tool_use_start`, the controller receives content that includes `🔧 Bash...`; after `tool_result`, the label is gone.
- On `result`, the controller's final `setContent`/`finish` call contains only the answer text.
- On `error_note`, the final content includes the error footer and `finish` disables streaming mode.
- `pending_approval` and `pending_question` still post separate interactive cards and fire `onWaiting` exactly once.
- `approval_timeout` still posts a timeout text card.

**Verification:** `feishu-stream-reply.test.ts` passes; tests explicitly assert placeholder removal and final content shape.

---

### U4. Update `FeishuBotService` to use the new reply lifecycle

**Goal:** Wire the refactored reply into the chat message flow.

**Requirements:** R1, R11, R12.

**Dependencies:** U3.

**Files:**
- Modify `src/server/services/feishu-bot-service.ts`.

**Approach:**
- Remove `safePostStream` and the stream promise. Call `reply.start()` to obtain the handler and finalize. Pass handler to `chatService.pushMessage(...)`. After `pushMessage` returns, await `reply.finalize()`.
- Keep the `onWaiting` signal and the early-return behavior for pending approval/question unchanged. For pending approval or question, call `finalize()` in a background promise so the streaming card is cleaned up when the queue advances.
- Remove or deprecate `safePostStream` if it is no longer used.

**Patterns to follow:** Existing `handleChatMessage` structure in the same file.

**Test scenarios:**
- A normal chat message creates one streaming card and finalizes it.
- Rewrite the `'delivers the answer content'` test: the existing test consumes an async iterable from `thread.post()` which no longer exists after U3. Replace it with assertions against mocked `larkClient.cardkit.v1.*` calls (card create, element content updates, settings finalization) to verify the CardKit API sequence with correct content. Remove the stream-consuming `consumingThread` mock.
- A pending approval leaves the stream finalization running in the background while the queue advances.
- A `pushMessage` error still posts a fallback text message and cleans up the reply.

**Verification:** `feishu-bot-service.test.ts` passes (or add coverage there if missing); manual sanity check that `/session` and `/stop` still work.

---

### U5. Quality checks

**Goal:** Keep the branch green.

**Requirements:** R11.

**Dependencies:** U1–U4.

**Files:** All files changed above.

**Approach:**
- Run `npm run lint` on changed files.
- Run server tests for the affected modules (`npx tsx --test src/server/services/feishu-*.test.ts`).
- Run client tests if any shared type changes touch the client (not expected).

**Verification:** Lint and targeted server tests pass.

---

## Scope Boundaries

### Deferred for later

- Exposing raw tool arguments, tool results, or reasoning chains to the user.
- Inline approval/question prompts inside the streaming card.
- Cross-platform unification of placeholder wording or animation timing.

### Outside this product's identity

- Changing WeCom streaming behavior.
- Altering the SSE event stream produced by the runtime.

---

## Risks & Dependencies

- **CardKit content replacement semantics.** The plan assumes `cardkit.v1.cardElement.content` accepts a complete markdown string and that Feishu renders the diff, including deletions. If Feishu only animates additions, placeholder removal may not be smooth; the placeholder will still disappear, but the transition may be a hard cut rather than a typewriter effect.
- **Sequence/uuid correctness.** Updates must use a monotonically increasing `sequence` and deterministic `uuid` per SDK convention. Out-of-order or duplicate updates are rejected by Feishu.
- **Rate limits on CardKit updates.** CardKit streaming is assumed to have higher rate limits than `im.v1.message.patch`, but exact limits are undocumented. The debounce (150ms) and content coalescing should keep us well under typical limits.
- **Threading/reply context.** The new controller sends the initial message via `larkClient.im.message.create` with `receive_id_type: 'open_id'`. Direct messages are the only supported Feishu flow today, so this preserves the existing behavior.

---

## Acceptance Examples

- AE1. **Tool then answer**
  - **Trigger:** The model calls `Bash` and then produces a final answer.
  - **During:** The card shows `🔧 Bash...` while the tool runs, then switches to accumulating the answer text.
  - **Final:** The card contains only the answer text; `🔧 Bash...` is gone and the streaming cursor is disabled.

- AE2. **Thinking then answer**
  - **Trigger:** The model emits `thinking_start` before the first token.
  - **During:** The card shows the thinking label.
  - **Final:** After the first answer token arrives, the thinking label disappears and is not present in the final card.

- AE3. **No tool, no thinking**
  - **Trigger:** The model produces a plain text answer.
  - **Final:** The card contains only the answer text; no placeholder labels were ever shown.

---

## Sources / Research

- `docs/brainstorms/2026-06-22-feat-feishu-streaming-replace-in-place-requirements.md` — origin requirements and scope.
- `src/server/services/wecom-stream-reply.ts` — replace-in-place buffer and placeholder removal pattern.
- `src/server/services/feishu-stream-reply.ts` — current async-iterable stream and event handling.
- `src/server/services/feishu-bot-service.ts` — consumes the stream and posts approval/question cards.
- `src/server/services/feishu-card-builder.ts` — existing card-building helpers.
- `@larksuiteoapi/node-sdk` — CardKit streaming internals (`MarkdownStreamController`, `createCardInstance`, `updateCardElementContent`, `finishStreamingCard`).
