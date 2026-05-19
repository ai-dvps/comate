---
title: Task / Todo Panel
type: feat
status: active
date: 2026-05-19
origin: docs/brainstorms/2026-05-19-task-todo-panel-requirements.md
---

# Task / Todo Panel

## Summary

Add a client-side task progress panel to the chat UI. The chat store scans historical messages on load and intercepts live SSE events to accumulate session-scoped task state from `TodoWrite` and `TaskCreate`/`TaskUpdate` tool_use blocks. A compact progress bar below the chat header shows task count and completion status; clicking it expands to reveal the full task list.

---

## Problem Frame

When Claude works through complex multi-step requests, it creates todos to track progress. Currently these appear only as generic `tool_use` blocks in the message stream. Users must scroll through the transcript to understand what tasks are in progress, completed, or remaining. There is no ambient overview of session-level task state.

---

## Requirements

- R1. Detect `TodoWrite` tool_use blocks in the SSE stream and extract the `todos` array.
- R2. Detect `TaskCreate` tool_use blocks and extract subject, description, and optional activeForm.
- R3. Detect `TaskUpdate` tool_use blocks and extract taskId, status, and patch fields.
- R4. Maintain a task map per session, keyed by a stable task identifier.
- R5. For `TodoWrite` mode, replace the session's entire task list with the full array from each detected tool_use block.
- R6. For Task tools mode, create a new task entry on `TaskCreate` (capturing the assigned ID from the matching `tool_result`) and patch existing entries on `TaskUpdate`.
- R7. Update task state in real time as new SSE events arrive.
- R8. The chat UI shall include a toggleable task panel.
- R9. The panel shall display all tasks for the active session with their current status.
- R10. Each task shall render description/subject, status indicator, and activeForm text when in_progress.
- R11. Completed tasks shall remain visible in the panel for the session lifetime.
- R12. When the active session has no tasks, the panel shall show an empty state or remain hidden.
- R13. Switching to a different session shall display that session's task list.
- R14. Deleting a session shall clear its accumulated task state.

**Origin acceptance examples:** AE1 (TodoWrite with 3 todos), AE2 (TaskUpdate changes status), AE3 (session switch shows correct list)

---

## Scope Boundaries

- Workspace-wide task aggregation across sessions.
- User-initiated task creation, editing, or deletion from the panel (read-only).
- Click-to-scroll navigation from a task to its originating message.
- Persistence of task state beyond the browser session.
- Suppression of raw `TodoWrite`/`TaskCreate`/`TaskUpdate` tool_use blocks in the message stream.
- Integration with SDK `todoFeatureEnabled` or SDK system task messages.
- Server-side SSE changes or new event types.

---

## Context & Research

### Relevant Code and Patterns

- **Chat store:** `src/client/stores/chat-store.ts` — central SSE lifecycle manager using Zustand. Already handles `tool_use_start`, `tool_use_done`, `tool_result`, and `subagent_*` events. Subagent state accumulation (`subagents: Record<string, SubagentState[]>`) is the closest existing pattern.
- **SSE subscription lifecycle:** `sessionSubscriptions` Map for abort handles, `lastEventId` Map for replay, guarded cleanup with identity checks. `loadMessages` overwrites local state only when not streaming.
- **FileDrawer:** `src/client/components/FileDrawer.tsx` — fixed overlay + aside panel pattern with `z-40`/`z-50` layering.
- **SubagentDrawer:** `src/client/components/SubagentDrawer.tsx` — bottom drawer with header, status badges, and conversation body.
- **Message types:** `src/client/types/message.ts` and `src/server/types/message.ts` must stay byte-identical; CI enforces via `diff`.
- **No test infrastructure** exists for the client store or components.

### Institutional Learnings

- Prior SSE fixes established that `loadMessages` should not overwrite streaming state. The task scanner must run after `loadMessages` sets historical messages, but must not interfere with live streaming.
- Session switch closes previous SSE subscriptions; `lastEventId` is preserved for replay.

---

## Key Technical Decisions

- **Client-side only, no server changes:** The existing SSE pipeline already emits `tool_use_done` and `tool_result` events with all necessary data. Adding server-side task events would require new SseEvent types and emitter changes without meaningful benefit.
- **Scan historical messages + intercept live events:** On `loadMessages`, scan the loaded `ChatMessage[]` for task tool_use blocks to populate initial state. During streaming, incrementally update state from live `tool_use_done` and `tool_result` events. This covers both fresh loads and streaming resume.
- **Unified task shape:** A single `TaskItem` interface covers both TodoWrite and Task tools. TodoWrite's `content` maps to `subject`; array index generates a synthetic ID. Task tools use the real `taskId` from `tool_result`.
- **Inline header bar over side drawer:** A compact progress strip below the chat header provides ambient awareness without consuming screen space. Clicking expands into a dropdown/panel showing the full task list.

---

## Open Questions

### Resolved During Planning

- **Server-side vs client-side approach:** Resolved to client-side only. The existing SSE events carry sufficient data; server changes would add complexity without benefit.
- **Drawer position (right-side vs inline header bar):** Resolved to inline header bar for ambient visibility with minimal screen usage.

### Deferred to Implementation

- **Exact expand/collapse animation and styling:** Will be decided during component implementation to match existing design system patterns.
- **Progress bar visualization:** Whether to show a linear progress bar or just "X/Y completed" text will be decided based on available horizontal space.

---

## Implementation Units

### U1. Add task state and parsing to chat store

**Goal:** Detect and accumulate task state from TodoWrite and Task tool_use blocks, both from historical messages and live SSE events.

**Requirements:** R1–R7, R13–R14

**Dependencies:** None

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- Add `TaskItem` interface and `tasks: Record<string, TaskItem[]>` to `ChatState`.
- Add a `pendingTaskCreates: Record<string, Record<string, PendingTaskCreate>>` map (keyed by sessionId, then toolUseId) to track TaskCreate tool_use blocks awaiting their `tool_result`.
- Create a `scanMessagesForTasks(messages: ChatMessage[]): TaskItem[]` helper that iterates through messages in order, detects `tool_use` parts named `TodoWrite`, `TaskCreate`, or `TaskUpdate`, and also `tool_result` parts that match pending TaskCreates. Returns a rebuilt task list.
- In `loadMessages`, after setting historical messages, call `scanMessagesForTasks` and populate `tasks[sessionId]`.
- In `handleSseEvent`, extend the `tool_use_done` handler: if the tool name (looked up from existing message parts) is `TodoWrite`, replace the session task list. If `TaskCreate`, add to `pendingTaskCreates`. If `TaskUpdate`, patch the existing task by `taskId`.
- Extend the `tool_result` handler: if the `toolUseId` matches a pending TaskCreate, parse the result for `{ task: { id, subject } }`, create the `TaskItem`, and remove from pending.
- In `deleteSession`, clear `tasks[sessionId]` and `pendingTaskCreates[sessionId]`.

**Patterns to follow:**
- Subagent state accumulation pattern in the same file (`subagents`, `findSubagent`, `updateSubagent`).

**Test scenarios:**
- Happy path: `TodoWrite` with 3 todos → task list contains 3 items with correct statuses.
- Happy path: `TaskCreate` tool_use followed by matching `tool_result` → task added with real ID.
- Happy path: `TaskUpdate` on existing task → status patched without duplication.
- Edge case: `TaskUpdate` for unknown taskId → ignored.
- Edge case: Multiple `TodoWrite` calls → list replaced each time, not appended.
- Edge case: Session switch → correct task list shown for new session.
- Integration: `loadMessages` loads historical messages with past `TodoWrite` → task state populated from history.
- Integration: Streaming resume with `lastEventId` replay → live events update task state correctly on top of historical base.

**Verification:**
- Loading a session with historical TodoWrite messages populates the task panel.
- Sending a prompt that triggers TodoWrite updates the panel in real time.
- Switching sessions shows the correct task list for each session.

---

### U2. Create TaskPanel component

**Goal:** Render the task progress bar and expandable task list.

**Requirements:** R8–R12

**Dependencies:** U1

**Files:**
- Create: `src/client/components/TaskPanel.tsx`

**Approach:**
- Read `tasks[sessionId]` from `useChatStore`.
- **Collapsed state:** A compact bar below the chat header showing a progress summary (e.g., "Tasks: 2/5 completed" or a mini progress bar). Only rendered when tasks exist. Clicking toggles to expanded.
- **Expanded state:** A dropdown/panel below the bar showing the full task list. Each task renders:
  - Status icon/badge (pending, in_progress, completed)
  - Subject/description
  - `activeForm` text when status is `in_progress`
  - Completed tasks styled distinctly (dimmed or struck through)
- Include an empty state when expanded but no tasks exist.
- Escape key closes the expanded panel.

**Patterns to follow:**
- Status badge styling from `SubagentDrawer` (`bg-amber-500/10`, `text-green-600`, etc.).
- Overlay/backdrop pattern from `FileDrawer` for the expanded panel if using a fixed overlay.

**Test scenarios:**
- Happy path: 5 tasks (2 pending, 2 in_progress, 1 completed) → collapsed bar shows "2/5 completed", expanded shows all 5 with correct badges.
- Edge case: No tasks → bar hidden, empty state in expanded view.
- Edge case: All tasks completed → bar shows "5/5 completed".

**Verification:**
- Component renders correctly with various task counts and statuses.
- Clicking toggles between collapsed and expanded states.

---

### U3. Integrate TaskPanel into ChatPanel

**Goal:** Wire the task panel into the main chat UI.

**Requirements:** R8, R12

**Dependencies:** U1, U2

**Files:**
- Modify: `src/client/components/ChatPanel.tsx`

**Approach:**
- Import `TaskPanel` and render it between the chat header and the messages area.
- Pass the active `sessionId` and `workspaceId` as props.
- The panel manages its own expanded/collapsed state internally.
- On session switch, the panel automatically reflects the new session's tasks (handled by U1's session-scoped state).

**Patterns to follow:**
- `SubagentDrawer` is conditionally rendered at the bottom of `ChatPanel`; `TaskPanel` is permanently mounted but self-hides when no tasks exist.

**Test scenarios:**
- Happy path: Switching sessions updates the task panel content.
- Edge case: Creating a new draft session → panel hidden (no tasks).

**Verification:**
- TaskPanel is visible in the chat UI when tasks exist.
- Panel updates correctly on session switch.

---

## System-Wide Impact

- **State lifecycle risks:** `tasks` and `pendingTaskCreates` must be cleared on session delete to prevent memory growth. The `deleteSession` action already cleans up session-scoped maps; this plan extends that cleanup.
- **Unchanged invariants:** The SSE emitter and server routes are not modified. Raw tool_use blocks continue to render as generic tool cards in the message stream. The `SseEvent` union is unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|-----------|
| TodoWrite / Task tool shape changes in future SDK versions | The parsing logic is isolated in the chat store; shape changes require only local updates. |
| Task state drift between historical scan and live events | Both paths use the same `TaskItem` shape and update the same store field. The incremental live handler is a subset of the full scan logic. |
| Performance with very long message histories | Message scanning happens once per `loadMessages` call. Linear scan of message parts is acceptable for typical transcript sizes (hundreds of messages). |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-19-task-todo-panel-requirements.md](docs/brainstorms/2026-05-19-task-todo-panel-requirements.md)
- Related code: `src/client/stores/chat-store.ts`, `src/client/components/ChatPanel.tsx`, `src/client/components/SubagentDrawer.tsx`
- Related plan: `docs/plans/2026-05-17-014-feat-subagent-streaming-display-plan.md`
