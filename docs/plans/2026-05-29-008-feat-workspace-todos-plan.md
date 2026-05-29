---
title: Workspace Todos
type: feat
status: completed
date: 2026-05-29
origin: docs/brainstorms/2026-05-29-workspace-todos-requirements.md
---

# Workspace Todos

## Summary

Add a persistent workspace-scoped todo list backed by SQLite, surfaced as a third sidebar tab. Users create todos with text and optional detail, edit in place, track four statuses, and spawn named chat sessions from any pending todo. Todos link one-to-one with sessions; deleting a session soft-unlinks the todo. (see origin: docs/brainstorms/2026-05-29-workspace-todos-requirements.md)

---

## Problem Frame

Users currently track workspace-related tasks in external apps because Comate has no persistent user-managed todo surface. The existing TaskPanel shows only AI-generated ephemeral tasks that vanish when a session ends. This forces context-switching whenever the user wants to start work on a saved idea. A workspace-scoped todo list collapses that gap.

---

## Requirements

- R1. Create todo via quick-add input at bottom of list.
- R2. Todo has required text and optional detail.
- R3. Edit text and detail in place; detail renders as smaller subtext.
- R4. Four statuses: pending, done, discard, did-but-need-verify.
- R5. Change status at any time.
- R6. Persist status changes immediately.
- R7. "Start session" action on pending todos.
- R8. Confirmation dialog before creating session.
- R9. Create new session in current workspace when confirmed.
- R10. Session name set to todo text.
- R11. Pre-fill session input box with todo detail as unsent draft.
- R12. One-to-one todo-to-session link.
- R13. Clickable link indicator on linked todos; navigates to session.
- R14. Session deletion removes link but preserves todo.
- R15. Click text/detail to edit; link indicator navigates.
- R16. Workspace-scoped visibility.
- R17. Switch workspaces to switch todo list.
- R18. Real-time search by text.

**Origin actors:** User

**Origin flows:** F1 (Create a todo), F2 (Create a session from a todo), F3 (Session deletion unlinks todo)

**Origin acceptance examples:** AE1 (covers R1–R3, R18), AE2 (covers R7–R12), AE3 (covers R14), AE4 (covers R13, R15)

---

## Scope Boundaries

- Due dates, priorities, labels, or tags.
- Cross-workspace todo views or aggregation.
- Integration with the existing AI ephemeral TaskPanel (TodoWrite/TaskCreate tool_use blocks).
- Multiple sessions per todo (one-to-many).
- Todo ordering via drag-and-drop.
- Notifications or reminders.
- Archiving or hiding completed/discarded todos beyond status filtering.
- Retroactive session name sync when todo text is edited.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/storage/sqlite-store.ts` — Constructor-based schema with `CREATE TABLE IF NOT EXISTS`, `better-sqlite3` sync API, JSON text columns, `safeJsonParse`. Add table and CRUD methods here.
- `src/server/routes/workspaces.ts`, `src/server/routes/chat.ts` — Express `Router` with `mergeParams: true`, nested under `/api/workspaces/:id`. New todo routes follow this pattern.
- `src/client/stores/workspace-store.ts`, `src/client/stores/chat-store.ts` — Zustand stores with workspace-keyed records (`Record<string, T[]>`), optimistic updates, i18n error messages.
- `src/client/components/Sidebar.tsx` — `useState<SidebarTab>('sessions' | 'files')` tab switcher; add `'todos'` to the union.
- `src/client/components/SessionList.tsx` — List rendering pattern: `mx-2 px-3 py-2.5 rounded-lg`, hover `surface-hover`, active `surface-active`, inline editing with local state.
- `docs/design/ui-ux-design.md` — Color tokens, sidebar width (256px), tab active indicator (`border-b-2 border-accent`), typography and spacing conventions.

### Institutional Learnings

- SQLite persistence was originally migrated from JSON flat files; schema lives in `SqliteStore` constructor with ad-hoc migration helpers (`docs/plans/2026-05-15-003-feat-toolbar-modal-sqlite-plan.md`).
- Sidebar tabs were introduced with local state and `border-b-2 border-accent` active styling (`docs/plans/2026-05-15-004-feat-workspace-switcher-and-sidebar-tabs-plan.md`).
- Session-scoped TaskPanel parses AI tool_use blocks and must not be conflated with user-managed todos (`docs/plans/2026-05-19-005-feat-task-todo-panel-plan.md`).
- Plan and brainstorm files should be committed alongside code changes (`docs/solutions/conventions/commit-plan-and-brainstorm-files-with-code-changes.md`).

---

## Key Technical Decisions

- **Separate `todos` table with `ON DELETE CASCADE` on `workspace_id`:** Prevents orphaned todo rows when a workspace is deleted. Aligns with existing `sessions` and `wecom_user_sessions` patterns.
- **Dedicated `POST /api/workspaces/:id/todos/:todoId/session` endpoint:** Centralizes validation (todo exists, is pending, not already linked) and session creation with todo text as name. Keeps the integration explicit.
- **Quick-add is text-only; detail added after creation via in-place edit:** Simplifies the creation flow. A single-line input at the bottom matches chat-style quick-add conventions.
- **No retroactive session name sync:** Session name is set once at creation from todo text. Independent session rename avoids surprise renames and keeps the two names loosely coupled.
- **Search filters across all statuses:** Predictable behavior; if status filters are added later, search intersects with them.
- **Default ordering: created_at desc, with done/discard at bottom:** Active work stays visible at the top without requiring a sort control.
- **In-place edit: Enter to save, Escape to cancel, blur to save:** Standard editing behavior users expect from list UIs.

---

## Open Questions

### Resolved During Planning

- **Search behavior:** Filters across all statuses by default.
- **Quick-add detail:** Text-only; detail added after creation via edit.
- **Ordering:** Created_at descending, done/discard grouped at bottom.
- **Edit cancel behavior:** Enter saves, Escape cancels, blur saves.
- **Already-linked todo action:** "Start session" is replaced with "Go to session" when linked.

### Deferred to Implementation

- **Exact chat store input state shape for pre-filling:** The draft message field name and setter pattern in `chat-store.ts` must be discovered during implementation.

---

## Implementation Units

### U1. Database schema and storage layer

**Goal:** Add the `todos` table and typed CRUD methods to `SqliteStore`.

**Requirements:** R1, R2, R4, R16

**Dependencies:** None

**Files:**
- Modify: `src/server/storage/sqlite-store.ts`

**Approach:**
- Add `CREATE TABLE IF NOT EXISTS todos` in the `SqliteStore` constructor with columns: `id`, `workspace_id`, `text`, `detail`, `status`, `session_id`, `created_at`, `updated_at`.
- Add `workspace_id` foreign key with `ON DELETE CASCADE`.
- Add methods: `createTodo`, `getTodosByWorkspace`, `updateTodo`, `deleteTodo`, `linkTodoToSession`, `unlinkTodoBySessionId`, `getTodoById`.
- Use `uuidv4()` for IDs and ISO strings for timestamps, matching existing patterns.

**Patterns to follow:**
- Existing `sessions` table creation and CRUD methods in `src/server/storage/sqlite-store.ts`.

**Test scenarios:**
- Happy path: Create a todo, read it back by workspace, update text and status, delete it.
- Edge case: Create todo with empty detail — detail column stores `NULL` or empty string consistently.
- Integration: Delete a workspace and verify its todos are cascade-deleted.
- Error path: Attempt to link a non-existent todo to a session.

**Verification:**
- `getTodosByWorkspace(workspaceId)` returns correct todos in created_at desc order.
- Deleting a workspace removes its todos.

---

### U2. API routes

**Goal:** REST endpoints for todo CRUD and session creation from a todo.

**Requirements:** R1–R3, R7–R12, R16

**Dependencies:** U1

**Files:**
- Create: `src/server/routes/todos.ts`
- Modify: `src/server/index.ts`

**Approach:**
- Create `todosRouter` with `mergeParams: true`.
- Routes under `/api/workspaces/:id/todos`:
  - `GET /` — list todos for workspace.
  - `POST /` — create todo. Validate text is non-empty after trim, max 500 chars; detail max 2000 chars.
  - `PUT /:todoId` — update text, detail, or status.
  - `DELETE /:todoId` — delete todo.
  - `POST /:todoId/session` — create session from todo. Validate todo is pending and not already linked. Create session with todo text as name, link todo to session, return session.
- Mount router in `src/server/index.ts` under `/api/workspaces/:id/todos`.

**Patterns to follow:**
- `src/server/routes/workspaces.ts` and `src/server/routes/chat.ts` for route structure and error shapes.

**Test scenarios:**
- Happy path: CRUD operations return expected shapes.
- Happy path: Create session from pending todo links correctly.
- Edge case: Create session from already-linked todo returns 409 or 400.
- Edge case: Create session from non-pending todo returns 400.
- Error path: Update todo with empty text after trim returns 400.
- Error path: Access todo in non-existent workspace returns 404.

**Verification:**
- All endpoints respond with correct HTTP status and JSON shapes.
- `POST /:todoId/session` creates a session row and sets `session_id` on the todo.

---

### U3. Zustand store

**Goal:** Frontend state management for todos with workspace-scoped records and search filtering.

**Requirements:** R1–R6, R16–R18

**Dependencies:** U2

**Files:**
- Create: `src/client/stores/todo-store.ts`

**Approach:**
- State shape: `todosByWorkspace: Record<string, Todo[]>`, `isLoading: Record<string, boolean>`, `error: Record<string, string | null>`, `searchQuery: string`.
- Methods: `fetchTodos(workspaceId)`, `createTodo(workspaceId, text, detail?)`, `updateTodo(todoId, patch)`, `deleteTodo(todoId)`, `changeStatus(todoId, status)`, `setSearchQuery(query)`.
- Computed filtering: derived list filters by search query (case-insensitive, matches text and detail) and sorts pending/verify above done/discard.
- Optimistic updates with server confirmation/revert pattern.

**Patterns to follow:**
- `src/client/stores/workspace-store.ts` for simple CRUD Zustand patterns.
- `src/client/stores/chat-store.ts` for workspace-keyed record shape and optimistic update revert.

**Test scenarios:**
- Happy path: Fetch, create, update, delete todos reflect in store.
- Happy path: Search query filters todos case-insensitively across text and detail.
- Edge case: Rapid status changes are debounced or queued to avoid race conditions.
- Edge case: Create todo while offline/store has stale workspace ID — capture workspaceId at action invocation, not at render time.

**Verification:**
- Switching workspaces fetches and displays the correct todo list.
- Search updates the filtered list in real time without re-fetching.

---

### U4. Sidebar tab integration

**Goal:** Add a "Todos" tab to the sidebar alongside Sessions and Files.

**Requirements:** R16, R17

**Dependencies:** U5 (TodoList component must exist before tab can render it)

**Files:**
- Modify: `src/client/components/Sidebar.tsx`

**Approach:**
- Extend `SidebarTab` type to `'sessions' | 'files' | 'todos'`.
- Add third tab button with matching styling: `flex-1`, active state `border-b-2 border-accent text-text-primary`.
- Render `TodoList` component when `activeTab === 'todos'`, passing `activeWorkspaceId`.

**Patterns to follow:**
- Existing tab switcher implementation in `src/client/components/Sidebar.tsx`.

**Test scenarios:**
- Happy path: Clicking the Todos tab switches content and applies active styling.
- Happy path: Switching workspaces while on Todos tab shows the new workspace's todos.

**Verification:**
- Sidebar renders three tabs with correct active indicator behavior.

---

### U5. TodoList component

**Goal:** Render the todo list with search, in-place editing, status controls, link indicator, and quick-add.

**Requirements:** R1–R6, R13, R15, R18

**Dependencies:** U3, U4

**Files:**
- Create: `src/client/components/TodoList.tsx`

**Approach:**
- Layout: vertical flex container.
  - Top: search input (filters todos from store).
  - Middle: scrollable list of todo rows.
  - Bottom: quick-add single-line input (Enter creates todo; empty text ignored).
- Todo row:
  - Main text line + smaller detail subtext below when present.
  - Status badge/indicator (pending, done, discard, did-but-need-verify).
  - Link indicator icon when linked (click navigates to session).
  - Status changer: click to cycle or dropdown to set status.
  - In-place editing: click text or detail to enter edit mode (Enter saves, Escape cancels, blur saves).
  - Delete action: accessible via row context menu or hover button, with confirmation.
- Empty state: shown when workspace has no todos.
- Done/discard items render at the bottom of the list.

**Patterns to follow:**
- `src/client/components/SessionList.tsx` for list item styling, hover states, inline editing, and context menu positioning.
- `docs/design/ui-ux-design.md` for color tokens and spacing.

**Test scenarios:**
- Happy path: Type in quick-add input and press Enter — todo appears at top of list.
- Happy path: Click todo text — enters edit mode; type and press Enter — saves.
- Happy path: Click Escape during edit — reverts to previous value.
- Happy path: Click link indicator on linked todo — navigates to associated session.
- Edge case: Attempt to save empty text after trim — reverts or shows validation.
- Edge case: Create todo with very long text — truncates with ellipsis in list view.
- Integration: Search filters update list without server round-trip.

**Verification:**
- Component renders with search, list, and quick-add.
- In-place editing behaves correctly for both text and detail.
- Done/discard todos sort to bottom.

---

### U6. Session creation from todo

**Goal:** Wire the "Start session" action to create a named session and pre-fill the input box.

**Requirements:** R7–R12

**Dependencies:** U2, U3, U5

**Files:**
- Modify: `src/client/components/TodoList.tsx`
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- In `TodoList`, show "Start session" button only on pending, unlinked todos. Show "Go to session" on linked todos.
- Clicking "Start session" opens a confirmation dialog (use existing dialog pattern or browser `confirm`).
- On confirm, call the dedicated API endpoint and await the new session.
- After session creation, activate the new session in `chat-store` and pre-fill the message input box with the todo detail.
- The todo row updates to show the link indicator.

**Patterns to follow:**
- Existing session creation and activation patterns in `src/client/stores/chat-store.ts`.

**Test scenarios:**
- Happy path: Click "Start session" on pending todo → confirm → new session created with todo name, input pre-filled, todo shows link indicator.
- Edge case: Click "Start session" on already-linked todo — action is "Go to session" instead.
- Error path: Server rejects creation (todo not found, not pending) — show error toast, do not create session.
- Integration: After creation, switching to the Sessions tab shows the new session at the top.

**Verification:**
- Session is created with correct name and linked to the todo.
- Input box contains todo detail as unsent draft.

---

### U7. Session deletion unlink hook

**Goal:** Remove todo-to-session links when sessions are deleted.

**Requirements:** R14

**Dependencies:** U1, U6

**Files:**
- Modify: `src/server/routes/chat.ts`

**Approach:**
- In the session deletion route handler, before deleting the session row, query for any todo with `session_id = :sessionId`.
- If found, set `session_id = NULL` on that todo.
- Then proceed with session deletion.
- Do this inside the same transaction if the store supports it, or as two sequential operations with the unlink first.

**Patterns to follow:**
- Existing session deletion route in `src/server/routes/chat.ts`.

**Test scenarios:**
- Happy path: Delete a linked session — todo remains in list, link indicator disappears.
- Edge case: Delete an unlinked session — no todo query needed, deletion proceeds normally.
- Integration: Delete session via API; fetch todos and verify `session_id` is null.

**Verification:**
- Deleting a session never deletes a todo.
- Todo's link indicator is removed after session deletion.

---

## System-Wide Impact

- **Interaction graph:** Session creation gains a todo-linked variant (`U6`). Session deletion now queries todo storage before proceeding (`U7`). The sidebar tab switcher renders a third branch (`U4`).
- **Error propagation:** Todo API validation errors (empty text, invalid status) surface as `{ error: string }`. Session-from-todo creation failures return 400/409 and surface in the UI via toast.
- **State lifecycle risks:** Rapid status changes are debounced in the store (`U3`). Workspace deletion cascade-deletes todos via SQLite `ON DELETE CASCADE` (`U1`).
- **API surface parity:** No other interfaces require changes. The new routes are additive under `/api/workspaces/:id/todos`.
- **Integration coverage:** Session deletion unlinking (`U7`) and session creation pre-fill (`U6`) are cross-layer scenarios that unit tests alone will not fully prove.
- **Unchanged invariants:** The existing AI ephemeral TaskPanel (`TodoWrite`/`TaskCreate` parsing) is untouched. Session messaging, SSE streaming, and approval flows are unaffected.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Stale link indicator if session is deleted via CLI/SDK (not GUI) | Validate session existence when navigating from link indicator; if gone, clear the link and show a toast. |
| Sidebar tab switching jank with large todo lists | Monitor list size; if >100 items cause perceptible lag, defer virtualization to follow-up work. |
| In-place editing conflicts with workspace/session navigation | Blur/save on navigation events; clear local edit state when workspace switches. |
| Chat store input state shape is unknown until implementation | Deferred to implementation — discover the draft setter during `U6` and adapt. |

---

## Documentation / Operational Notes

- Update this plan's `status` to `completed` when implementation finishes.
- Commit the requirements doc and plan file alongside code changes per project convention.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-29-workspace-todos-requirements.md](docs/brainstorms/2026-05-29-workspace-todos-requirements.md)
- Related code: `src/server/storage/sqlite-store.ts`, `src/server/routes/chat.ts`, `src/client/stores/chat-store.ts`, `src/client/components/Sidebar.tsx`, `src/client/components/SessionList.tsx`
- Related plans: `docs/plans/2026-05-15-003-feat-toolbar-modal-sqlite-plan.md`, `docs/plans/2026-05-15-004-feat-workspace-switcher-and-sidebar-tabs-plan.md`, `docs/plans/2026-05-19-005-feat-task-todo-panel-plan.md`
- Design doc: `docs/design/ui-ux-design.md`
