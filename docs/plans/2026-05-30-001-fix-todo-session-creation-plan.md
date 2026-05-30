---
title: Fix todo-to-session creation bugs
type: fix
status: completed
date: 2026-05-30
origin: docs/plans/2026-05-29-008-feat-workspace-todos-plan.md
---

# Fix todo-to-session creation bugs

## Summary

Two regressions in the workspace-todos session-creation flow:
1. After creating a session from a todo, the session does not appear in `SessionList` until a manual refresh.
2. When a todo has no detail, the prompt input is empty instead of being pre-filled with the todo text.

---

## Requirements

- R1. Newly created sessions from todos must immediately render in `SessionList`.
- R2. The prompt input must be pre-filled with the todo detail when present, falling back to the todo text when detail is absent.

---

## Key Technical Decisions

- **Store mutation from TodoList**: `TodoList` calls a dedicated todos endpoint (`POST /api/workspaces/:id/todos/:todoId/session`) rather than `chatStore.createSession`, so it must manually inject the returned session into `chatStore.sessions[workspaceId]`. A lightweight `addSession` store method keeps the component decoupled from store internals.
- **Draft fallback logic**: Changing the condition from `if (todo.detail)` to always set the draft (`todo.detail || todo.text`) preserves the original intent while fixing the empty-input case.

---

## Implementation Units

### U1. Add session to chat store after todo-to-session creation

**Goal:** Ensure the session returned by `POST /api/workspaces/:id/todos/:todoId/session` is immediately visible in `SessionList`.

**Requirements:** R1

**Dependencies:** None

**Files:**
- `src/client/stores/chat-store.ts` (add `addSession` method)
- `src/client/components/TodoList.tsx` (call `addSession` after API response)

**Approach:**
- Add `addSession: (workspaceId: string, session: ChatSession) => void` to `ChatState`. It prepends the session to `state.sessions[workspaceId]` and sets `activeSessionIds[workspaceId]` to the new session id (mirroring `createSession` behavior).
- In `TodoList.handleStartSession`, after parsing the API response, call `useChatStore.getState().addSession(workspaceId, session)` instead of only calling `setActiveSession`.

**Patterns to follow:** `createSession` in `chat-store.ts` already inserts sessions into the workspace array and sets the active id.

**Test scenarios:**
- **Happy path:** Click "Start session" on a pending todo → session appears at the top of `SessionList` without refresh.
- **Edge case:** Click "Start session" on a todo when `sessions[workspaceId]` is empty → the new session renders as the only item.

**Verification:** Create a session from a todo and observe it appears immediately in the sessions sidebar tab.

---

### U2. Pre-fill prompt input with todo text when detail is absent

**Goal:** Ensure the prompt input is never empty after creating a session from a todo.

**Requirements:** R2

**Dependencies:** None (can ship in either order)

**Files:**
- `src/client/components/TodoList.tsx`

**Approach:**
- In `handleStartSession`, replace the conditional `if (todo.detail)` block with an unconditional `setDraft(session.id, todo.detail || todo.text)`.

**Patterns to follow:** The existing `setDraft` call uses `useChatStore.getState().setDraft` directly.

**Test scenarios:**
- **Happy path:** Todo with detail "Investigate OAuth" → prompt input shows "Investigate OAuth".
- **Happy path:** Todo with empty detail and text "Fix login" → prompt input shows "Fix login".
- **Edge case:** Todo with whitespace-only detail and text "Refactor" → prompt input shows "Refactor" (the draft should be trimmed).

**Verification:** Create sessions from todos with and without detail; confirm the prompt input is pre-filled in both cases.

---

## Scope Boundaries

- Does not modify the server-side session creation logic.
- Does not change the original requirement that detail is the preferred draft content.
- Does not add new UI elements or change the todo-to-session confirmation dialog.
