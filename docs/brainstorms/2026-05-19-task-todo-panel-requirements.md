---
date: 2026-05-19
topic: task-todo-panel
---

# Task / Todo Panel

## Summary

Add a toggleable Task drawer to the chat UI that accumulates and displays todo/task items parsed from `TodoWrite` and `TaskCreate`/`TaskUpdate` tool_use blocks in the SSE stream. The panel shows task description, status, and progress in real time, scoped to the active session.

---

## Problem Frame

When Claude works through complex multi-step requests, it creates todos to track progress. Currently, these todos appear only as generic `tool_use` blocks buried in the message stream. Users must scroll back through the transcript to understand what tasks are in progress, what's completed, and what's remaining. There is no ambient overview of session-level task state. The SDK's task tracking exists but is dropped on the floor — neither the SSE emitter nor the chat store handle task-related tool_use blocks specially.

---

## Requirements

**Task detection**

- R1. The system shall detect `TodoWrite` tool_use blocks in the SSE stream and extract the `todos` array from the block input.
- R2. The system shall detect `TaskCreate` tool_use blocks and extract subject, description, and optional activeForm from the block input.
- R3. The system shall detect `TaskUpdate` tool_use blocks and extract taskId, status, and any other patch fields from the block input.

**Task state accumulation**

- R4. The system shall maintain a task map per session, keyed by a stable task identifier.
- R5. For `TodoWrite` mode, the system shall replace the session's entire task list with the full array from each detected tool_use block.
- R6. For Task tools mode, the system shall create a new task entry on `TaskCreate` (capturing the assigned ID from the matching `tool_result`) and patch existing entries on `TaskUpdate`.
- R7. The system shall update task state in real time as new SSE events arrive, without requiring a page refresh.

**UI rendering**

- R8. The chat UI shall include a toggleable Task drawer panel, analogous to the existing SubagentDrawer.
- R9. The panel shall display all tasks for the active session with their current status.
- R10. Each task shall render: description or subject, status indicator (pending, in_progress, completed), and activeForm text when the status is in_progress.
- R11. Completed tasks shall remain visible in the panel (distinctly styled, e.g., struck through or dimmed) for the session lifetime; they are not auto-removed.
- R12. When the active session has no tasks, the panel shall show an empty state or remain hidden.

**Session lifecycle**

- R13. Switching to a different session shall display that session's task list (or empty state if none).
- R14. Deleting a session shall clear its accumulated task state from the store.

---

## Acceptance Examples

- AE1. **Covers R1, R5, R9.** Given a streaming chat session, when the model emits a `TodoWrite` tool_use block containing three todos (two pending, one in_progress), the Task panel immediately shows three items with their respective statuses.
- AE2. **Covers R3, R6, R7.** Given a task already exists from a prior `TaskCreate`, when a `TaskUpdate` tool_use block changes that task's status to completed, the panel updates the same item to completed styling without duplicating it.
- AE3. **Covers R13.** Given the user is viewing Session A with two tasks, when the user switches to Session B which has no tasks, the panel shows Session B's empty state instead of Session A's tasks.

---

## Success Criteria

- A user can open the Task panel and see at a glance what tasks Claude is working on, without scrolling through the message transcript.
- Task status updates are visible in the panel within seconds of the model emitting the corresponding tool_use block.
- The feature works with the existing SDK version (0.2.141) without requiring an upgrade.

---

## Scope Boundaries

- Workspace-wide task aggregation across multiple sessions.
- User-initiated task creation, editing, or deletion from the panel (read-only).
- Click-to-scroll navigation from a task to its originating message in the stream.
- Persistence of task state beyond the browser session (in-memory store only).
- Suppression or special rendering of raw `TodoWrite`/`TaskCreate`/`TaskUpdate` tool_use blocks in the message stream — they remain visible as generic tool cards.
- Integration with SDK `todoFeatureEnabled` or SDK system task messages (`task_started`, `task_updated`, etc.).

---

## Key Decisions

- **Parse tool_use blocks instead of SDK system task messages:** tool_use blocks carry the actual task content (descriptions, subjects, statuses). SDK system messages contain only task IDs and metadata, making them insufficient for a useful UI on their own.
- **Session-scoped over workspace-scoped:** Aligns with the existing SubagentDrawer pattern and keeps the first version focused on the active conversation.
- **Support both TodoWrite and Task tools:** The app runs SDK 0.2.141 where `TodoWrite` is the default behavior. Task tools (`TaskCreate`, `TaskUpdate`, etc.) became default in SDK 0.3.142; supporting both provides forward compatibility.

---

## Dependencies / Assumptions

- The SDK continues to emit `TodoWrite` or `TaskCreate`/`TaskUpdate` as regular tool_use blocks within assistant messages.
- The existing SSE emitter and chat store architecture can accommodate new per-session state without restructuring.
- Task tool result payloads for `TaskCreate` contain the assigned task ID in a predictable shape (`{ task: { id, subject } }`).
