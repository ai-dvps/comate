---
title: Extend todo title length and add auto-grow textarea
type: feat
status: completed
date: 2026-06-01
---

# Extend todo title length and add auto-grow textarea

## Summary

Increase the todo text validation limit from 500 to 2000 characters so the title can absorb content previously held in the removed `detail` field. Convert the edit-mode textarea from a fixed 4-row height to an auto-growing textarea that follows the established `PromptInput`/`ApprovalSurface` pattern.

---

## Requirements

- R1. Increase the server-side todo text validation limit from 500 to 2000 characters on both create and update routes.
- R2. Convert the todo edit textarea from fixed `rows={4}` to an auto-growing height capped at a reasonable maximum.
- R3. Add a client-side length guard in the todo store so over-long text fails fast before reaching the server.
- R4. Update server error messages to reference the new 2000-character limit.

---

## Scope Boundaries

- Does not convert the quick-add `<input>` to a textarea (remains single-line).
- Does not add a database schema migration (SQLite `TEXT` has no intrinsic length limit).
- Does not change todo status, session linking, or search behavior.
- Does not add a character counter or visual limit indicator in the UI.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/routes/todos.ts` — server validation currently enforces `text.trim().length > 500` on POST and PUT.
- `src/client/stores/todo-store.ts` — `createTodo` checks for non-empty text but has no length guard; `updateTodo` has no validation at all.
- `src/client/components/TodoList.tsx` — edit textarea uses `rows={4}` and `resize-none` (line 276–292). Display mode already uses `break-words` with no truncation.
- `src/client/components/PromptInput.tsx` and `src/client/components/ApprovalSurface.tsx` — both implement auto-grow textareas via `textareaRef` + `scrollHeight` measurement.

### Institutional Learnings

- The `detail` field removal plan (`docs/plans/2026-05-30-005-feat-remove-todo-detail.md`) shows the full cross-layer touch surface for todo model changes.
- Prior UI improvements removed truncation from todo titles in favor of multiline wrapping, so the display layer is already prepared for longer text.

---

## Key Technical Decisions

- **2000-character ceiling** — matches the former `detail` field limit, giving users the same total capacity in a single field.
- **No schema migration** — SQLite `TEXT` is unbounded; the limit is purely application-layer.
- **Auto-grow via `scrollHeight`** — follows the established `PromptInput.tsx` pattern: reset `height` to `auto`, then set to `scrollHeight` (capped at a max) on every value change.
- **Client-side guard in the store** — keeps the failure path synchronous and avoids a network round-trip for a known-over-limit input.

---

## Open Questions

### Resolved During Planning

- **What should the new limit be?** 2000 characters (matches the old detail limit).
- **Should the edit textarea auto-grow?** Yes — confirmed as better UX.

### Deferred to Implementation

- **Exact max height for the auto-grow textarea** — set to a reasonable cap (e.g., 160–200px) during implementation based on visual fit within the sidebar.

---

## Implementation Units

### U1. Server route validation

**Goal:** Update the server to accept todo text up to 2000 characters.

**Requirements:** R1, R4

**Dependencies:** None

**Files:**
- Modify: `src/server/routes/todos.ts`

**Approach:**
- Change the length check in `POST /` from `> 500` to `> 2000`.
- Change the length check in `PUT /:todoId` from `> 500` to `> 2000`.
- Update both error messages from `'text must be 500 characters or less'` to `'text must be 2000 characters or less'`.

**Patterns to follow:**
- Existing validation block structure in `todos.ts` (lines 31–34 and 55–58).

**Test scenarios:**
- Happy path: Create and update a todo with exactly 2000 characters — succeeds.
- Edge case: Create and update a todo with 2001 characters — returns 400 with updated error message.
- Edge case: Update a todo with `text` set to an empty string after trim — returns 400 `'text cannot be empty'` (unchanged behavior).

**Verification:**
- Server routes accept 2000-character text and reject 2001-character text with the correct error message.

---

### U2. Client store guards and edit textarea auto-grow

**Goal:** Add client-side length validation and make the edit textarea grow with content.

**Requirements:** R2, R3

**Dependencies:** U1

**Files:**
- Modify: `src/client/stores/todo-store.ts`
- Modify: `src/client/components/TodoList.tsx`

**Approach:**
- In `todo-store.ts`:
  - Add a `MAX_TODO_TEXT_LENGTH = 2000` constant.
  - In `createTodo`, reject text whose `trim().length` exceeds the max before sending the request.
  - In `updateTodo`, reject patches whose `text` exceeds the max before sending the request.
- In `TodoList.tsx`:
  - Replace the fixed `rows={4}` edit `<textarea>` with an auto-growing textarea using a `textareaRef`.
  - On `value` change (or via `useLayoutEffect` keyed to `editTitle`), measure `scrollHeight` and update `style.height`.
  - Cap the height at a reasonable maximum (e.g., 160–200px) so the sidebar is not overwhelmed.
  - Keep `resize-none`.

**Patterns to follow:**
- `PromptInput.tsx` lines 106–109 and `ApprovalSurface.tsx` lines 765–768 for the auto-grow effect.

**Test scenarios:**
- Happy path: Edit a todo and type a 2000-character title — textarea grows smoothly and update succeeds.
- Happy path: Create a todo with 2000 characters via the quick-add input — succeeds.
- Edge case: Attempt to create/update with 2001 characters from the client — blocked in the store before the network request.
- Integration: Edit a todo, type multiple lines, and confirm the height auto-adjusts and caps correctly.

**Verification:**
- Client store rejects over-long text synchronously.
- Edit textarea height increases with content and stops growing at the cap.
- Existing keyboard shortcuts (Enter to save, Escape to cancel) continue to work.

---

## System-Wide Impact

- **Unchanged invariants:** Todo status transitions, session creation from todos, todo-session linking, and search filtering remain unchanged. The SQLite schema is untouched.
- **API surface parity:** The validation change applies to both `POST` and `PUT` routes; no other API endpoints consume todo text.
