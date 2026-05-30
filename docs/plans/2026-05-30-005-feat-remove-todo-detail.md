---
title: Remove detail field from workspace todos
type: feat
status: active
date: 2026-05-30
---

# Remove detail field from workspace todos

## Summary

Remove the `detail` field from the todo model entirely, keeping only the `text` (title) field. This simplifies the todo data model and UI.

## Requirements

- R1. Remove `detail` from the todo TypeScript interfaces (server and client).
- R2. Remove `detail` from the SQLite schema and storage layer methods.
- R3. Remove `detail` validation from API routes.
- R4. Remove `detail` rendering, editing, and search from the TodoList component.
- R5. Add a database migration to drop the `detail` column from existing databases.

## Key Technical Decisions

- **SQLite migration via table recreation**: SQLite versions before 3.35.0 do not support `DROP COLUMN`. Use the standard recreate-tables migration pattern to safely remove the column while preserving all todo data.
- **Session prefill behavior**: When creating a session from a todo, the draft was previously pre-filled with `todo.detail || todo.text`. Since detail is removed, prefill with `todo.text` directly.

## Implementation Units

### U1. Server model, storage, and routes

**Files:**
- `src/server/models/todo.ts`
- `src/server/storage/sqlite-store.ts`
- `src/server/routes/todos.ts`

**Approach:**
- Remove `detail` from `Todo`, `CreateTodoInput`, `UpdateTodoInput` interfaces.
- Remove `detail` from `CREATE TABLE todos` schema.
- Add `migrateTodoDetailColumn()` private method on `SqliteStore` that recreates the `todos` table without the `detail` column, copies existing data, and drops the old table. Call it in the constructor.
- Remove `detail` from `createTodo`, `updateTodo`, `RawTodoRow`, `parseTodoRow`.
- Remove `detail` validation from `POST /` and `PUT /:todoId` routes.

### U2. Client store and component

**Files:**
- `src/client/stores/todo-store.ts`
- `src/client/components/TodoList.tsx`

**Approach:**
- Remove `detail` from client `Todo` interface.
- Remove `detail` parameter from `createTodo`.
- Remove `detail` from `updateTodo` patch type.
- Remove `detail` search from `getFilteredTodos`.
- Remove `editDetail` state and the detail textarea from TodoList edit mode.
- Remove detail display (`todo.detail && <p>...</p>`) from TodoList.
- Update `handleStartSession` to prefill draft with `todo.text` instead of `todo.detail || todo.text`.
- Remove `editDetail` from search filter.

## Scope Boundaries

- Does not affect session data model or chat functionality.
- Does not change todo status or session-linking behavior.
- Does not modify the quick-add input or search behavior beyond removing detail from search scope.
