---
title: "fix: WeCom bot multi-turn streaming and tool status"
description: Fix WeCom stream finalization on multi-turn queries (tool use) and add inline tool/thinking status so users see progress during agent work.
type: fix
status: completed
date: 2026-05-26
---

# WeCom Bot Multi-Turn Streaming and Tool Status

## Problem Frame

When a WeCom user sends a message that triggers Claude to use tools, the bot's response is truncated or lost.

The root cause is in `WeComBotService.handleTextMessage`: the bot event handler sends `finish=true` on the first `assistant_done` event, which finalizes the WeCom stream. But the Claude Agent SDK produces **multiple assistant messages** within a single turn when tools are used — one before the tool call and one after. The first `assistant_done` closes the stream, so the second assistant's text deltas have no open message to update. The user never sees the post-tool result.

Additionally, the handler ignores `tool_use_start`, `tool_result`, `thinking_delta`, and `subagent_*` events. Users see nothing during file reads, command execution, or subagent work — only a static placeholder or the last text before tools started.

This is a bug in the streaming response handler implementation that shipped with the WeCom streaming feature (see `docs/plans/2026-05-22-009-feat-wecom-streaming-response-plan.md`). That plan assumed a single `assistant_start`/`assistant_done` pair per message; the implementation did not account for multi-turn SDK behavior.

---

## Summary

Fix the bot event handler so that:
1. `finish=true` is deferred until the turn truly ends (`result` event), not sent on intermediate `assistant_done` events.
2. `responseText` accumulates across assistant turns instead of being reset on each `assistant_start`.
3. Tool use, thinking, and subagent events append brief inline status indicators to the stream so users see progress.
4. The thinking placeholder animation is managed correctly across turns.

All changes are localized to `WeComBotService`. No changes to `SessionRuntime`, `SseEmitter`, or the GUI streaming path.

---

## Key Technical Decisions

- **`result` is the sole stream finalizer:** `assistant_done` only flushes pending text; `result` (plus `error_note` / `interrupted` as terminal errors) sends `finish=true`. This matches the SDK's event model where `assistant_done` ends an assistant message and `result` ends the turn.
- **Accumulate `responseText` across turns:** Do not reset on `assistant_start`. Each `text_delta` appends to the same buffer. `replyStreamNonBlocking` always sends the full accumulated text, so earlier turns remain visible while later turns update the same message.
- **Inline status, not separate messages:** Tool and thinking status is appended to `responseText` as short markdown lines (e.g. `\n\n🔧 Read: path/to/file`). This avoids extra WeCom API calls (rate limits: 30/min, 1000/hour per bot) and keeps the conversation compact.
- **No animation restart between turns:** Restarting the "思考中" animation would overwrite the accumulated text with the placeholder. Instead, the last known text remains visible during tool execution, and new text deltas resume updates.

---

## Scope Boundaries

### In Scope
- Fix stream finalization logic in `WeComBotService.handleTextMessage`
- Accumulate response text across assistant turns
- Inline status for `tool_use_start`, `tool_result`, `thinking_delta`, `subagent_start`, `subagent_done`
- Proper flush/abort behavior on `assistant_done` vs `result`

### Out of Scope
- Changes to GUI SSE streaming
- Changes to `SessionRuntime`, `SseEmitter`, or SDK integration
- WeCom HTTP bridge or CLI changes
- New bot platforms

### Deferred to Follow-Up Work
- Configurable placeholder text or animation interval
- Per-workspace toggle for tool status visibility
- Rich tool status (argument preview, duration tracking)

---

## Context & Research

### Relevant Code

- `src/server/services/wecom-bot-service.ts` — `handleTextMessage` (lines ~149–251) contains the buggy handler closure.
- `src/server/services/sse-emitter.ts` — Defines the `SseEvent` union and emits `assistant_done` on `message_stop` (per assistant message) and `result` at end of turn.
- `src/server/services/session-runtime.ts` — `runMessageLoop` yields all SDK messages; `botEventHandlers` receive every `SseEvent`.
- `src/server/utils/debounce.ts` — `flush()` forces immediate execution; `abort()` cancels without executing.

### SDK Event Sequence

For a query with tool use, the bot handler receives:
```
assistant_start
  text_delta ...
  tool_use_start
  tool_input_delta ...
  tool_use_done
assistant_done        ← was sending finish=true here (WRONG)
tool_result
assistant_start
  text_delta ...
assistant_done
result                ← turn truly ends here
```

For a simple query without tools:
```
assistant_start
  text_delta ...
assistant_done
result
```

### Institutional Learnings

- Project has **no test infrastructure** (no jest, vitest, mocha, or test files). Verification is manual.
- The WeCom streaming plan (`2026-05-22-009`) intended `streamId` regeneration per `assistant_start`, but the implementation generated it once per `handleTextMessage` call. We keep a single `streamId` per message and accumulate text instead, which preserves the initial placeholder and avoids orphaned messages.

---

## Open Questions

### Resolved During Planning
- **How does the handler know the real end of the conversation?** The `result` event signals end of turn. `assistant_done` signals end of an individual assistant message within the turn.
- **Should tool status be inline or separate messages?** Inline, to respect WeCom rate limits and avoid message clutter.

### Deferred to Implementation
- Exact emoji/prefix for tool status indicators (default: 🔧 for tools, 💭 for thinking, 🤖 for subagents).
- Whether to include tool arguments in the status line (default: tool name only, to keep messages concise).

---

## Implementation Units

### U1. Fix multi-turn stream finalization and add tool status

**Goal:** Fix the bot event handler so multi-turn queries deliver the complete response, and users see inline status during tool use.

**Requirements:** Fixes the WeCom bot response loss bug; adds visibility into tool/thinking/subagent work.

**Dependencies:** None.

**Files:**
- Modify: `src/server/services/wecom-bot-service.ts`

**Approach:**

Rewrite the `handler` closure in `handleTextMessage` with the following event handling:

1. **`assistant_start`**
   - Set `collecting = true`.
   - Do **not** reset `responseText`. If this is a subsequent turn (i.e., `responseText` is non-empty), append a newline separator so the new text doesn't run into the previous turn.
   - Do **not** start the dot animation. The accumulated text remains visible.

2. **`text_delta`** (when `collecting`)
   - Stop animation if running.
   - Append `event.text` to `responseText`.
   - Call `flushStream()` (debounced at 150ms).

3. **`tool_use_start`** (when `collecting`)
   - Append a brief status line to `responseText`: e.g. `\n\n🔧 ${event.toolName}`.
   - Call `flushStream.flush()` to show the status immediately (don't wait for debounce).

4. **`tool_result`**
   - Append a completion indicator to `responseText`: e.g. `\n✅ ${event.toolUseId.slice(0, 8)}…` or a simple `\n✅ Done`.
   - Call `flushStream.flush()`.

5. **`thinking_delta`** (when `collecting`)
   - Optional: append `\n\n💭 Thinking…` once (track with a flag) to show extended thinking is happening.
   - Call `flushStream.flush()`.

6. **`subagent_start`**
   - Append `\n\n🤖 ${event.description ?? 'Running subagent'}…`.
   - Call `flushStream.flush()`.

7. **`subagent_done`**
   - Append `\n✅ Subagent ${event.state}`.
   - Call `flushStream.flush()`.

8. **`assistant_done`** (when `collecting`)
   - Set `collecting = false`.
   - Stop animation.
   - Call `flushStream.flush()` (not `abort()`) to ensure the latest accumulated text is sent immediately.
   - Do **not** send `finish=true`.

9. **`result`** / **`error_note`** / **`interrupted`**
   - If `streamFinalized` flag is already true, return early (guard against duplicate finalization).
   - Set `streamFinalized = true`, `collecting = false`.
   - Stop animation.
   - Call `flushStream.abort()` to cancel any pending debounce.
   - Send `conn.client.replyStream(frame, streamId, responseText, true)`.
   - On catch: if `responseText.trim()`, fall back to `conn.client.sendMessage(wecomUserId, { msgtype: 'markdown', markdown: { content: responseText } })`.

10. **`error`**, **`done`**, **`system_init`**, and other non-content events
    - Ignore for the stream handler.

**State variables in the closure:**
- `responseText: string` — accumulated text across all turns; never reset.
- `collecting: boolean` — whether we are inside an assistant turn.
- `streamFinalized: boolean` — whether `finish=true` has already been sent.
- `animationInterval: NodeJS.Timeout | null` — the dot animation timer.
- `thinkingShown: boolean` — whether the thinking indicator has been appended (to avoid spam).

**Patterns to follow:**
- Keep the handler as an inline closure bound to the current message context.
- Use `.catch()` for logging, not `try/await/catch`, to avoid blocking the event loop.
- Match existing error-handling style.

**Test scenarios:**

- **Happy path — simple query:** User sends message → AI generates text → debounced flushes update stream → `result` sends `finish=true`. User sees complete response.
- **Happy path — query with tools:** User sends message → AI says "Let me check…" → `tool_use_start` appends "🔧 Read: file.md" → `assistant_done` flushes → `tool_result` appends "✅ Done" → AI generates final text → `result` sends `finish=true`. User sees the full chain in one message.
- **Edge case — tool use with no pre-tool text:** AI immediately uses a tool. Placeholder "思考中…" is replaced by tool status, then final result. No orphaned placeholder.
- **Edge case — empty final response after tools:** AI produces no post-tool text. `result` sends `finish=true` with accumulated status text. User sees tool status as the final message.
- **Edge case — rapid text deltas across turns:** First turn's text is already in `responseText`. Second turn appends immediately. Debounce batches rapid deltas within each turn.
- **Error path — `error_note`:** Turn ends with an error. `error_note` triggers finalization with `finish=true`. User sees error text.
- **Error path — streaming failure on final frame:** `replyStream` throws. Fallback `sendMessage` delivers the complete accumulated text.
- **Integration — sequential messages in same session:** Each `handleTextMessage` call creates a fresh handler with its own `streamId` and `responseText`. Earlier handlers are cleared by `ChatService.getOrCreateRuntime`.

**Verification:**
- TypeScript compiles without errors.
- Manual test: send a WeCom message that triggers tool use (e.g., "read package.json") → verify the complete response is delivered, including tool status and final text.
- Manual test: send a simple message without tools → verify streaming and finalization still work.

---

## System-Wide Impact

- **Interaction graph:** `WeComBotService` only. No changes to `ChatService`, `SessionRuntime`, `SseEmitter`, or client code.
- **Error propagation:** Unchanged. Streaming errors are logged and fall back to `sendMessage`.
- **API surface parity:** No new endpoints or type changes.
- **Rate limit consideration:** Inline status avoids extra API calls. The debounce (150ms) and `replyStreamNonBlocking` behavior are unchanged.
- **Unchanged invariants:**
  - GUI SSE streaming is unaffected.
  - `SessionRuntime` event emission is unaffected.
  - `SseEmitter` event vocabulary is unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| WeCom `replyStream` rejects updates after a prior `finish=true` | Fix ensures `finish=true` is only sent once, on `result` |
| Accumulated text grows large for many-turn queries | WeCom has a message size limit; risk is low for typical usage. If hit, text is truncated by WeCom, not the handler |
| Tool status spam for rapid tool_use sequences | Status is appended once per tool_use_start; debounce batches updates |
| `result` event missing in some SDK error paths | `error_note` and `interrupted` also trigger finalization as safety nets |

---

## Documentation / Operational Notes

- Bot sessions auto-approve all tools. The inline status makes this visible to WeCom users but does not add approval gates.
- Tool status uses simple markdown. Complex formatting may not render in all WeChat Work clients.

---

## Sources & References

- **Origin bug report:** WeCom bot final result not sent after tool use; no status during tool execution.
- **Related plan:** `docs/plans/2026-05-22-009-feat-wecom-streaming-response-plan.md` — the streaming feature whose implementation introduced this bug.
- **Related requirements:** `docs/brainstorms/2026-05-21-wecom-bot-integration-requirements.md` (R10), `docs/brainstorms/2026-05-22-wecom-processing-status-requirements.md` (R1–R3).
- **Relevant code:** `src/server/services/wecom-bot-service.ts`, `src/server/services/sse-emitter.ts`, `src/server/services/session-runtime.ts`, `src/server/utils/debounce.ts`.
