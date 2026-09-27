---
title: Fix task tool lifecycle and suppress task tool cards from message stream
type: fix
status: active
date: 2026-05-20
origin: user report — TaskCreate/TaskUpdate tool_use blocks not creating tasks in the panel
---

# Fix task tool lifecycle and suppress task tool cards from message stream

## Summary

TaskCreate and TaskUpdate tool_use blocks from the compound-engineering skill (and SDK Task tools mode) are not populating the task panel. The root cause is that the task metadata lives in a `toolUseResult` field at the **message level**, but the current pipeline only looks at `message.content`. The normalizer ignores `toolUseResult`, the SSE emitter does not forward it, and the chat store tries to parse the human-readable `content` text as JSON — which fails. Additionally, TaskCreate and TaskUpdate tool cards clutter the message stream even though the panel already shows the same information.

This plan threads `toolUseResult` through the SSE pipeline, updates the chat store to read task IDs from it, and suppresses TaskCreate/TaskUpdate tool cards from the message stream.

---

## Problem Frame

- SDK messages with `tool_result` blocks carry an **outer-level** `toolUseResult` field containing structured data (e.g., `{ task: { id, subject } }`).
- `message-normalizer.ts` `partsFromSdkContent()` only processes `message.content` blocks; `toolUseResult` is discarded.
- `sse-emitter.ts` `handleUser()` only forwards `tool_use_id`, `content`, and `is_error`; `toolUseResult` is never emitted.
- The chat store `tool_result` handler tries `JSON.parse(output)` where `output` is human-readable text like `"Task #1 created successfully..."`. This throws, so the task is never promoted from `pendingTaskCreates` to `tasks`.
- `scanMessagesForTasks()` has the same bug: it parses `part.output` instead of checking `part.toolUseResult`.
- TaskCreate and TaskUpdate tool cards render in the message list even though the task panel already surfaces the same state.

---

## Requirements

- **R1.** The server shall extract `toolUseResult` from SDK/Session messages and attach it to `tool_result` parts and SSE events.
- **R2.** The client shall read task creation metadata from `toolUseResult` (when present) instead of parsing `output` as JSON.
- **R3.** The client shall read task update metadata from `TaskUpdate` tool_use input and apply it to the correct task by `taskId`.
- **R4.** The message list shall not render tool cards for `TaskCreate` or `TaskUpdate` tool_use parts.
- **R5.** Existing TodoWrite, SDK system-message task events, and backward-compatible tool_use parsing shall remain functional.

---

## Scope Boundaries

- **In scope:** Threading `toolUseResult` through the server→client pipeline; fixing task creation/updating logic; suppressing TaskCreate/TaskUpdate tool cards.
- **Out of scope:** Changing how TodoWrite tool cards are rendered.
- **Out of scope:** New UI features in the task panel (the panel already exists).
- **Out of scope:** Server-side `scanSdkMessagesForTasks` for historical loading — the client-side `scanMessagesForTasks` covers historical tool_use parsing and is fixed in this plan.

---

## Key Technical Decisions

- **Attach `toolUseResult` to the `tool_result` part/event:** The outer message may contain one tool_result block (typical for TaskCreate). Attaching `toolUseResult` to the `tool_result` part keeps the data co-located with the block it describes. If a future message contains multiple tool_result blocks with distinct `toolUseResult` values, the message-level field can be matched by `tool_use_id`.
- **Suppress at render time, not at ingestion time:** TaskCreate/TaskUpdate tool_use parts are still stored in the message list (for historical accuracy and subagent detection), but `MessageList.tsx` skips rendering them.
- **Preserve `pendingTaskCreates` as a fallback:** If `toolUseResult` is absent, the existing JSON-parse fallback on `output` remains. This keeps backward compatibility with sessions that don't emit `toolUseResult`.

---

## Context & Research

### Relevant Code

- **Message types:** `src/client/types/message.ts` and `src/server/types/message.ts` — `MessagePart['tool_result']` and `SseEvent['tool_result']` shapes.
- **Normalizer:** `src/server/services/message-normalizer.ts` — `partsFromSdkContent()` and `normalizeSessionMessage()`.
- **SSE emitter:** `src/server/services/sse-emitter.ts` — `handleUser()` and `SubagentEmitter.handleUser()`.
- **Chat store:** `src/client/stores/chat-store.ts` — `tool_result` event handler (line ~649), `scanMessagesForTasks()` (line ~265), `tool_use_done` handler (line ~564).
- **Message list:** `src/client/components/MessageList.tsx` — tool_use rendering loop (line ~286).

### Message Shape

TaskCreate assistant message:
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {
        "type": "tool_use",
        "id": "tool_xxx",
        "name": "TaskCreate",
        "input": { "subject": "...", "description": "..." }
      }
    ]
  }
}
```

TaskCreate result user message:
```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "tool_xxx",
        "content": "Task #1 created successfully: ..."
      }
    ]
  },
  "toolUseResult": {
    "task": { "id": "1", "subject": "..." }
  }
}
```

---

## Implementation Units

### U1. Update message types to carry `toolUseResult`

**Goal:** Add `toolUseResult` to `tool_result` MessagePart and SSE event shapes so it can flow through the pipeline.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/server/types/message.ts`
- Modify: `src/client/types/message.ts` (must stay byte-identical)

**Approach:**
- Add optional `toolUseResult?: unknown` to the `tool_result` variant of `MessagePart` in both files.
- Add optional `toolUseResult?: unknown` to the `tool_result` variant of `SseEvent` in both files.
- Run `diff src/client/types/message.ts src/server/types/message.ts` to verify byte identity.

**Patterns to follow:**
- Both files must remain byte-identical; CI enforces this via `diff`.

**Test scenarios:**
- Type check: `tool_result` parts can be constructed with and without `toolUseResult`.
- Type check: `SseEvent` union accepts `tool_result` events with and without `toolUseResult`.

**Verification:**
- `npm run build:server` and `npm run build` pass without type errors.
- `diff src/client/types/message.ts src/server/types/message.ts` exits 0.

---

### U2. Extract and forward `toolUseResult` in the SSE emitter

**Goal:** Capture `toolUseResult` from SDK user messages and include it in emitted `tool_result` SSE events.

**Requirements:** R1

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/sse-emitter.ts`

**Approach:**
- In `SseEmitter.handleUser()`, after extracting `tool_use_id`, `content`, and `is_error` from each block, also read `toolUseResult` from the outer `msg` object (e.g., `(msg as Record<string, unknown>).toolUseResult`).
- Include `toolUseResult` in the `this.send({ type: 'tool_result', ... })` call.
- Apply the same change to `SubagentEmitter.handleUser()`.

**Patterns to follow:**
- Use the same `as Record<string, unknown>` cast pattern already used elsewhere in the emitter for accessing optional fields.

**Test scenarios:**
- Happy path: SDK user message with `toolUseResult` → SSE `tool_result` event includes `toolUseResult`.
- Happy path: SDK user message without `toolUseResult` → SSE `tool_result` event omits the field (undefined).
- Edge case: Message with multiple tool_result blocks — the same `toolUseResult` is attached to each emitted event (acceptable because TaskCreate/TaskUpdate messages contain a single block).

**Verification:**
- Stream a session that uses TaskCreate; verify the SSE frames contain `toolUseResult` in `tool_result` events.

---

### U3. Extract `toolUseResult` in the message normalizer

**Goal:** Populate `toolUseResult` on `tool_result` MessageParts when loading historical messages.

**Requirements:** R1

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/message-normalizer.ts`

**Approach:**
- Update `normalizeSessionMessage()` to read `toolUseResult` from the outer `sessionMessage` object before processing content.
- Pass `toolUseResult` into `partsFromSdkContent()` as an optional second parameter.
- In `partsFromSdkContent()`, when constructing a `tool_result` part, attach `toolUseResult` if present.

**Patterns to follow:**
- Keep the defensive `typeof` / `as` casting style already used in the file.

**Test scenarios:**
- Happy path: SessionMessage with `toolUseResult` → normalized `ChatMessage` has `tool_result` part with `toolUseResult` attached.
- Happy path: SessionMessage without `toolUseResult` → `tool_result` part has no `toolUseResult` field.
- Edge case: Non-object `toolUseResult` → still attached as-is (client is responsible for parsing).

**Verification:**
- Load a historical session with TaskCreate tool results; verify the API response includes `toolUseResult` on `tool_result` parts.

---

### U4. Fix task lifecycle in client chat store

**Goal:** Use `toolUseResult` to create tasks on tool_result arrival, and ensure TaskUpdate finds the correct task.

**Requirements:** R2, R3

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- In the `tool_result` SSE event handler (~line 649):
  - First check `data.toolUseResult` for task creation metadata.
  - If `toolUseResult` is an object with `task.id`, create the task using that ID.
  - Fall back to the existing `JSON.parse(output)` logic only if `toolUseResult` is absent.
- In `scanMessagesForTasks()` (~line 265):
  - In the `part.type === 'tool_result'` branch, first check `part.toolUseResult` for task metadata.
  - Fall back to `JSON.parse(part.output)` only if `toolUseResult` is absent.
- In the `tool_use_done` handler's `TaskUpdate` branch (~line 607):
  - Ensure the update works even if the task was just created in the same batch of messages (for `scanMessagesForTasks`, process TaskCreates and their matching tool_results before TaskUpdates, or use a two-pass approach).
  - For the streaming path, the current logic already updates `state.tasks[sessionId]` directly; this is fine as long as the tool_result arrives before the TaskUpdate.

**Patterns to follow:**
- Keep the existing `PendingTaskCreate` and `pendingTaskCreates` structures for backward compatibility.
- Use the same type-casting pattern (`as Record<string, unknown>`) for inspecting `toolUseResult`.

**Test scenarios:**
- Happy path: `tool_result` SSE event with `toolUseResult.task.id` → task is created in panel.
- Happy path: `tool_result` SSE event without `toolUseResult` but with JSON `output` → fallback parsing still works.
- Happy path: `TaskUpdate` tool_use with valid `taskId` and `status` → task status updates in panel.
- Edge case: `tool_result` with `toolUseResult` but missing `task.id` → no task created, pending entry cleaned up.
- Edge case: `TaskUpdate` references unknown `taskId` → silently ignored.
- Integration: Historical message load with TaskCreate + tool_result + TaskUpdate → `scanMessagesForTasks` produces correct final task list.

**Verification:**
- Stream a session with TaskCreate → task appears in panel.
- Stream a session with TaskUpdate → task status updates in panel.
- Load a historical session with task tool_use blocks → panel populates correctly.

---

### U5. Suppress TaskCreate and TaskUpdate tool cards from message stream

**Goal:** Prevent TaskCreate and TaskUpdate tool_use parts from rendering as tool cards in the message list.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `src/client/components/MessageList.tsx`

**Approach:**
- In the `part.type === 'tool_use'` rendering branch (~line 286), before the existing `if (part.toolName === 'Agent')` check, add an early return for TaskCreate and TaskUpdate:
  ```tsx
  if (part.toolName === 'TaskCreate' || part.toolName === 'TaskUpdate') {
    return null
  }
  ```
- This keeps the part in the message data (so subagent logic and task scanning still work) but skips UI rendering.

**Patterns to follow:**
- The existing `Agent` check already returns early for subagent rendering; follow the same pattern.

**Test scenarios:**
- Happy path: Message with TaskCreate tool_use → no tool card rendered for that part.
- Happy path: Message with TaskUpdate tool_use → no tool card rendered for that part.
- Happy path: Message with Bash tool_use → Bash tool card still renders.
- Backward compat: Message with TodoWrite tool_use → tool card still renders (TodoWrite suppression is out of scope).

**Verification:**
- Open a session with TaskCreate/TaskUpdate → message stream shows no task tool cards, but the task panel shows the tasks.

---

## System-Wide Impact

- **API contract:** The `tool_result` SSE event and `MessagePart` gain an optional `toolUseResult` field. Old clients ignore unknown fields, so this is backward-compatible.
- **Message type parity:** Both `src/client/types/message.ts` and `src/server/types/message.ts` are modified; CI `diff` must pass.
- **Task panel dependency:** The task panel (existing component) becomes the sole visible surface for TaskCreate/TaskUpdate state.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|-----------|
| `toolUseResult` shape varies across SDK versions or skills | Use `unknown` typing and defensive property access; fall back to existing JSON-parse logic. |
| Suppressing tool cards removes transcript visibility of task operations | The task panel still shows all tasks; this is an intentional UX trade-off confirmed by the user. |
| Multiple tool_result blocks in one message with conflicting `toolUseResult` values | Currently theoretical — TaskCreate/TaskUpdate messages contain a single block. If this changes, match by `tool_use_id`. |

---

## Deferred to Follow-Up Work

- Suppress TodoWrite tool cards from the message stream (requires user confirmation).
- Add click-to-scroll navigation from a task panel item to its originating message in the stream.
- Persist task state beyond the browser session.

---

## Sources & References

- User-provided example messages showing `toolUseResult` at the message level.
- Existing task panel plan: `docs/plans/2026-05-19-005-feat-task-todo-panel-plan.md`
- SDK 0.3.x task fix plan: `docs/plans/2026-05-19-006-fix-task-panel-sdk-0-3-x-plan.md`
- Relevant code: `src/server/services/message-normalizer.ts`, `src/server/services/sse-emitter.ts`, `src/client/stores/chat-store.ts`, `src/client/components/MessageList.tsx`
