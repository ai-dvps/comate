---
date: 2026-05-29
topic: workspace-todos
---

# Workspace Todos

## Summary

Add a persistent, workspace-scoped todo list where users create items with optional detail, track them through done/discard/need-verify states, and spawn chat sessions from any todo with a confirmation step. Todos link one-to-one with sessions; deleting a session unlinks the todo without deleting it.

---

## Problem Frame

Users currently track workspace-related tasks in external apps (Notion, Apple Notes, Obsidian, etc.) because Comate has no persistent user-managed todo surface. The existing TaskPanel only shows AI-generated ephemeral tasks from the current session — it disappears when the session ends and offers no way for the user to seed a new conversation from a pre-planned task. This forces context-switching between Comate and an external tool whenever the user wants to start work on a saved idea.

---

## Key Flows

- F1. **Create a todo**
  - **Trigger:** User clicks "New todo" in the todo panel.
  - **Actors:** User
  - **Steps:**
    1. User enters todo text and optional detail.
    2. System saves the todo to the active workspace in pending status.
    3. Todo appears in the workspace's todo list.
  - **Outcome:** A new todo exists in pending state.
  - **Covered by:** R1, R2, R3

- F2. **Create a session from a todo**
  - **Trigger:** User clicks "Start session" on a pending todo.
  - **Actors:** User
  - **Steps:**
    1. System shows a confirmation dialog.
    2. User confirms.
    3. System creates a new session in the current workspace.
    4. Session name is set to the todo text.
    5. Todo detail is pre-filled in the session's message input box as an unsent draft.
    6. Todo is linked to the new session.
  - **Outcome:** A new session exists, linked to the originating todo.
  - **Covered by:** R7, R8, R9, R10, R11, R12

- F3. **Session deletion unlinks todo**
  - **Trigger:** User deletes a session that was created from a todo.
  - **Actors:** User
  - **Steps:**
    1. User deletes the session.
    2. System removes the session-todo link.
    3. Todo remains in the list, now unlinked.
  - **Outcome:** Todo is preserved but no longer linked.
  - **Covered by:** R14

---

## Requirements

**Todo creation and editing**

- R1. The system shall allow users to create a todo item within the active workspace via a quick-add input box at the bottom of the todo list.
- R2. Each todo shall have a required text field and an optional detail field.
- R3. The system shall allow users to edit a todo's text and detail in place within the list. The detail shall appear as smaller subtext below the main todo text when present.

**Todo status**

- R4. A todo shall have one of four statuses: pending, done, discard, or did-but-need-verify.
- R5. The system shall allow users to change a todo's status at any time.
- R6. Status changes shall be persisted immediately.

**Session creation from todo**

- R7. The system shall provide an action on each pending todo to create a new session from it.
- R8. Before creating the session, the system shall show a confirmation dialog.
- R9. When confirmed, the system shall create a new session in the current workspace.
- R10. The new session's name shall be set to the todo text.
- R11. If the todo has detail, the system shall pre-fill the session's message input box with that detail as an unsent draft.
- R12. The system shall store a one-to-one relationship between the todo and the newly created session.

**Todo-session relationship**

- R13. When a todo is linked to a session, the system shall display a clickable link indicator on the todo. Clicking the indicator navigates to the associated session.
- R14. If a linked session is deleted, the system shall remove the link but preserve the todo.
- R15. Clicking a todo's text or detail subtext shall enter in-place editing mode for that field. Navigation to a linked session is via the separate link indicator, not the row click.

**Workspace scoping and list behavior**

- R16. Todos shall be scoped to a workspace; only todos belonging to the active workspace shall be visible.
- R17. Switching workspaces shall switch the visible todo list.
- R18. The system shall provide a search box at the top of the todo list to filter todos by text in real time.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3, R18.** Given the user is in Workspace A, when they type "Refactor auth module" and "Use bcrypt for password hashing" into the bottom quick-add input, the todo appears in Workspace A's list with the detail shown as subtext. Both fields are editable in place by clicking them.
- AE2. **Covers R7, R8, R9, R10, R11, R12.** Given a pending todo with text "Fix login bug" and detail "Check the token validation logic", when the user clicks "Start session" and confirms, a new session named "Fix login bug" is created in the current workspace with "Check the token validation logic" pre-filled in the input box, and the todo shows a linked-session indicator.
- AE3. **Covers R14.** Given a todo linked to Session B, when the user deletes Session B, the todo remains in the list but no longer shows a linked-session indicator.
- AE4. **Covers R13, R15.** Given a todo linked to Session C, when the user clicks the link indicator, the UI navigates to Session C. When the user clicks the todo text, it enters in-place edit mode.

---

## Success Criteria

- A user can create, edit, and track todos within a workspace without leaving Comate.
- Starting a session from a todo takes two clicks (initiate + confirm) and pre-fills the context correctly.
- Todos survive app restarts and workspace switches.
- Deleting a session never accidentally deletes a user's todo.

---

## Scope Boundaries

- Due dates, priorities, labels, or tags on todos.
- Cross-workspace todo views or aggregation.
- Integration with the existing AI ephemeral TaskPanel (TodoWrite/TaskCreate tool_use blocks).
- Multiple sessions per todo (one-to-many).
- Todo ordering via drag-and-drop.
- Notifications or reminders for todos.
- Archiving or hiding completed/discarded todos beyond status filtering.

---

## Key Decisions

- **Workspace-scoped over global:** Todos live within a workspace, matching the existing sidebar tab model and avoiding a cross-workspace aggregation problem.
- **Soft unlink on session deletion:** Preserves the user's planned work even if the conversation is discarded.
- **Status "did-but-need-verify" is a passive label:** No special AI verification flow is triggered; it's purely for user tracking.
- **In-place editing with subtext detail:** Todos are edited directly in the list. The detail appears as smaller subtext below the main text. Navigation to a linked session is via a dedicated link indicator, not row click.
- **Quick-add at bottom, search at top:** New todos are created via an input box at the bottom of the list. A search box at the top filters todos in real time.

---

## Dependencies / Assumptions

- The existing sidebar tab system can accommodate a third tab without structural redesign.
- The session creation and naming APIs support programmatic session creation with a custom name.
- The message input box supports programmatic pre-filling without auto-submission.

---

## Outstanding Questions

### Resolve Before Planning

- None remaining.

### Deferred to Planning

- [Affects R3][Technical] Should editing a todo's text retroactively update the linked session's name?
- [Affects UI][Needs research] How should the search box behave — filter across all statuses, or respect a status filter if one exists?
