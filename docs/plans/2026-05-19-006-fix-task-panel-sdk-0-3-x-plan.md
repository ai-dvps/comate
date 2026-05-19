---
title: Fix task panel for SDK 0.3.x system-message task events
type: fix
status: active
date: 2026-05-19
origin: docs/plans/2026-05-19-005-feat-task-todo-panel-plan.md
---

# Fix task panel for SDK 0.3.x system-message task events

## Summary

The task/todo panel implemented in U1–U3 of the parent plan works only when the SDK emits tasks as `TodoWrite`/`TaskCreate`/`TaskUpdate` tool_use blocks (SDK 0.2.x behavior). After upgrading to SDK 0.3.144, tasks are emitted as `system` messages with subtypes (`task_started`, `task_updated`, `task_progress`, `task_notification`). The server currently drops all non-`init` system messages from both the live SSE stream and historical message loading, so the client never receives task events and the panel remains permanently empty.

This plan adds server-side forwarding of task system messages as new SSE events, extracts historical task state from SDK session messages server-side, and updates the client store to build task state from these new sources. The existing tool_use-based task parsing is preserved for backward compatibility with pre-0.3 sessions.

---

## Problem Frame

- SDK 0.3.x task lifecycle is expressed via `system` message subtypes, not tool_use blocks.
- `SseEmitter.handle()` drops all `system` messages except `subtype === 'init'`.
- `normalizeSessionMessage()` drops all `system` messages from historical transcripts (returns `null`).
- The client `scanMessagesForTasks()` and `handleSseEvent` only look for `tool_use` blocks named `TodoWrite`/`TaskCreate`/`TaskUpdate`.
- Result: no task data reaches the client in any path (live streaming or history load), so `tasks[sessionId]` is always empty and the panel never renders.

---

## Requirements

- R1. The server shall forward SDK `task_started` system messages as SSE `task_started` events.
- R2. The server shall forward SDK `task_updated` system messages as SSE `task_updated` events.
- R3. The server shall extract task state from historical SDK session messages and return it alongside messages in the load-messages API.
- R4. The client shall accumulate task state from `task_started` and `task_updated` SSE events in real time.
- R5. The client shall populate initial task state from the server-provided historical task list on `loadMessages`.
- R6. The existing tool_use-based task parsing (`TodoWrite`/`TaskCreate`/`TaskUpdate`) shall remain functional for backward compatibility.
- R7. The UI shall display SDK 0.3.x task statuses (`pending`, `running`, `completed`, `failed`, `killed`, `paused`) with appropriate styling.

---

## Scope Boundaries

- Out: `task_progress` and `task_notification` events are not surfaced as distinct UI states; `task_progress` updates description only, `task_notification` finalizes status.
- Out: Subagent task nesting (`parent_tool_use_id` on task events) is not visualized as a tree; tasks are flat.
- Out: No new persistence layer for tasks; state remains in-memory per session.

---

## Key Technical Decisions

- **Server-side extraction for historical, SSE events for live:** Historical task state is extracted server-side because `normalizeSessionMessage` drops system messages and changing that would require new `MessagePart` variants that propagate to renderers. Live events are forwarded as SSE because the pipeline already supports it.
- **Unified `TaskItem` shape:** SDK 0.3.x uses `description` (not `subject`) and `status: 'running'`. The existing `TaskItem` interface is extended: `subject` is populated from `description`, `running` maps to `'in_progress'`.
- **Preserve both paths:** Tool_use-based parsing stays in the client for backward compatibility; the new system-message-based parsing is additive.

---

## Context & Research

### Relevant Code

- **SSE emitter:** `src/server/services/sse-emitter.ts` — `handle()` drops non-init system messages at line 86–96.
- **Message normalizer:** `src/server/services/message-normalizer.ts` — `roleFromType()` drops all system messages at line 175–181.
- **Chat service:** `src/server/services/chat-service.ts` — `loadMessages()` returns `ChatMessage[]` only.
- **Messages route:** `src/server/routes/chat.ts` — GET `/sessions/:sessionId/messages` returns `{ messages }`.
- **Client store:** `src/client/stores/chat-store.ts` — `handleSseEvent` has no cases for task events; `loadMessages` has no task handling from API response.
- **Message types:** `src/client/types/message.ts` and `src/server/types/message.ts` — `SseEvent` union lacks task events; must stay byte-identical.
- **TaskPanel:** `src/client/components/TaskPanel.tsx` — handles `pending`/`in_progress`/`completed` only.

### SDK 0.3.x Task Message Shapes

```typescript
// task_started
{ type: 'system', subtype: 'task_started', task_id: string, description: string, ... }

// task_updated
{ type: 'system', subtype: 'task_updated', task_id: string, patch: { status?, description?, ... } }

// task_progress (ignored for UI state — description-only pulse)
{ type: 'system', subtype: 'task_progress', task_id: string, description: string, ... }

// task_notification (terminal state)
{ type: 'system', subtype: 'task_notification', task_id: string, status: 'completed'|'failed'|'stopped', ... }
```

---

## Implementation Units

### U1. Add task SSE events and emit them from server

**Goal:** Forward SDK task system messages as typed SSE events so the client can receive them in real time.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/server/types/message.ts`
- Modify: `src/client/types/message.ts` (must stay byte-identical)
- Modify: `src/server/services/sse-emitter.ts`

**Approach:**
- Add two new variants to the `SseEvent` union in both message.ts files:
  - `{ type: 'task_started'; taskId: string; description: string }`
  - `{ type: 'task_updated'; taskId: string; patch: { status?: string; description?: string; error?: string } }`
- In `sse-emitter.ts` `handle()`, extend the `case 'system'` branch:
  - If `msg.subtype === 'task_started'`, emit `task_started` with `taskId: msg.task_id`, `description: msg.description`.
  - If `msg.subtype === 'task_updated'`, emit `task_updated` with `taskId: msg.task_id`, `patch: msg.patch`.
  - `task_progress` can be folded into `task_updated` logic if it carries meaningful state, or ignored if it only updates description.
  - `task_notification` emits `task_updated` with the terminal status.

**Test scenarios:**
- Happy path: SDK emits `task_started` → SSE `task_started` event reaches client.
- Happy path: SDK emits `task_updated` with `status: 'completed'` → SSE `task_updated` event reaches client.
- Edge case: Unknown system subtype → silently dropped (existing behavior).

**Verification:**
- Streaming a prompt that triggers tasks emits `task_started`/`task_updated` frames in the SSE stream.

---

### U2. Extract historical task state from SDK messages

**Goal:** Reconstruct a session's task list from historical SDK session messages so the panel is populated on initial load.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/server/services/message-normalizer.ts`
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/server/routes/chat.ts`

**Approach:**
- Add a `scanSdkMessagesForTasks(sdkMessages: SessionMessage[]): TaskItem[]` helper in `message-normalizer.ts` (or a new file).
  - Iterate `sdkMessages`; for each with `type === 'system'`:
    - `task_started`: create `TaskItem` with `id: msg.task_id`, `subject: msg.description`, `status: 'pending'`.
    - `task_updated`: patch existing task by `task_id` with fields from `patch` (map `running` → `'in_progress'`).
    - `task_notification`: patch existing task with terminal `status`.
  - Return rebuilt task list.
- Update `chat-service.ts` `loadMessages()` to call the scanner and return `{ messages: ChatMessage[], tasks: TaskItem[] }`.
- Update `chat.ts` GET `/sessions/:sessionId/messages` to return `{ messages, tasks }`.

**Patterns to follow:**
- The scanning logic mirrors `scanMessagesForTasks` in the chat store but operates on raw `SessionMessage[]` instead of `ChatMessage[]`.

**Test scenarios:**
- Happy path: Historical session has 3 task system messages (start, update to running, update to completed) → extracted task list has 1 item with correct final status.
- Edge case: No task system messages → empty task list.
- Edge case: `task_updated` for unknown task_id → ignored.

**Verification:**
- Loading a session with historical task system messages populates the task panel.

---

### U3. Handle task events in client chat store

**Goal:** Build and maintain task state from the new SSE events and the historical API response.

**Requirements:** R4, R5, R6

**Dependencies:** U1, U2

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- Extend `TaskItem['status']` to include `'failed' | 'killed' | 'paused'`.
- Add a `normalizeSdkStatus(status: string): TaskItem['status']` helper that maps SDK statuses:
  - `'pending'` → `'pending'`
  - `'running'` → `'in_progress'`
  - `'completed'` → `'completed'`
  - `'failed'` → `'failed'`
  - `'killed'` → `'killed'`
  - `'paused'` → `'paused'`
  - Unknown → `'pending'`
- In `handleSseEvent`, add cases:
  - `task_started`: append new `TaskItem` to `tasks[sessionId]`.
  - `task_updated`: find task by `taskId`, apply `patch` (status via normalizer, description to subject).
- In `loadMessages` (client action), update to expect `{ messages, tasks }` from API and set `tasks[sessionId]` from the response.
- Keep the existing `tool_use_done` and `tool_result` task handling intact for backward compatibility.

**Test scenarios:**
- Happy path: `task_started` event → new task appears in panel.
- Happy path: `task_updated` with `status: 'running'` → task shows as in_progress.
- Happy path: `task_updated` with `status: 'completed'` → task shows as completed.
- Integration: `loadMessages` loads historical tasks → panel populated.
- Backward compat: `TodoWrite` tool_use still works.

**Verification:**
- Task panel updates in real time during streaming.
- Task panel shows correct state after session switch.

---

### U4. Update TaskPanel for extended statuses

**Goal:** Render SDK 0.3.x task statuses with appropriate visual treatment.

**Requirements:** R7

**Dependencies:** U3

**Files:**
- Modify: `src/client/components/TaskPanel.tsx`

**Approach:**
- Extend `statusConfig` to cover new statuses:
  - `failed`: red XCircle icon, red badge
  - `killed`: gray XCircle icon, gray badge
  - `paused`: amber Pause icon, amber badge
- Map `in_progress` display (from SDK `running`) to the existing spinner animation.
- Completed tasks keep existing dimmed/strikethrough styling.

**Test scenarios:**
- Happy path: Task with `status: 'failed'` renders red error badge.
- Happy path: Mixed statuses (1 pending, 2 running, 1 completed, 1 failed) → correct icons and colors for each.

**Verification:**
- Component renders correctly with all status variants.

---

## System-Wide Impact

- **API contract change:** The `GET /sessions/:sessionId/messages` response gains a `tasks` field. The client currently ignores unknown fields, so this is backward-compatible for older clients. However, the client `loadMessages` action must be updated to read it.
- **SseEvent union change:** New event types are additive; old clients ignore unknown event types in `handleSseEvent`.
- **Message type parity:** Both `src/client/types/message.ts` and `src/server/types/message.ts` are modified; CI `diff` must pass.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|-----------|
| SDK 0.3.x task messages coexist with tool_use-based tasks in the same session | Both paths are additive; the same task could appear twice if IDs overlap. Task IDs from system messages and synthetic tool_use IDs are in different namespaces, so collision is unlikely. |
| `task_progress` events flood the SSE stream | Only `task_started` and `task_updated` affect state; `task_progress` is ignored or throttled. |

---

## Sources & References

- Parent plan: `docs/plans/2026-05-19-005-feat-task-todo-panel-plan.md`
- SDK types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (lines 3503–3584)
- Related code: `src/server/services/sse-emitter.ts`, `src/server/services/message-normalizer.ts`, `src/server/services/chat-service.ts`, `src/client/stores/chat-store.ts`
