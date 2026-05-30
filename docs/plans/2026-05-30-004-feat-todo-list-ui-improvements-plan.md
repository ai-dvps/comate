---
title: Todo list UI improvements — multiline titles and dual-field editing
type: feat
status: active
date: 2026-05-30
origin: docs/brainstorms/2026-05-29-workspace-todos-requirements.md
---

# Todo list UI improvements — multiline titles and dual-field editing

## Summary

Two UX refinements for the workspace todo list:
1. Todo titles currently truncate with ellipsis; users need to see the full title, so titles should wrap across multiple lines.
2. In-place editing currently allows editing only one field (text or detail) at a time. Users want both fields editable simultaneously when a todo enters edit mode.

---

## Requirements

- R1. Todo titles must wrap to multiple lines instead of truncating.
- R2. When a todo enters edit mode, both title and detail inputs must be visible and editable at the same time.
- R3. Committing edits should update both fields in a single API call if either changed.
- R4. Cancel must restore both fields to their original values.

---

## Key Technical Decisions

- **Remove `truncate` and `line-clamp`** from the title text element; rely on natural text wrapping with `break-words`.
- **Dual-input edit state**: Replace the single `editText` + `editingField` state with `editTitle` and `editDetail` strings. Both are populated when edit mode starts and both inputs render while `editingTodoId` matches.
- **Blur behavior change**: Auto-commit on blur is removed for dual-edit mode because clicking between the two inputs would trigger premature saves. Commit is explicit (Enter) and cancel is explicit (Escape or click outside).
- **Single `updateTodo` call**: On commit, if either field changed, call `updateTodo(todoId, { text: editTitle, detail: editDetail })` rather than two separate calls.

---

## Implementation Units

### U1. Display todo titles on multiple lines

**Goal:** Remove truncation so full todo titles are readable.

**Requirements:** R1

**Dependencies:** None

**Files:**
- `src/client/components/TodoList.tsx`

**Approach:**
- Remove the `truncate` Tailwind class from the title `<p>` element.
- Add `break-words` to prevent overflow from long unbroken strings.

**Test scenarios:**
- **Happy path:** A todo with a long title renders across multiple lines without clipping.
- **Edge case:** A todo with a very long single word (e.g., a URL) wraps correctly with `break-words`.

**Verification:** Create or view a todo with a long title and confirm the full text is visible.

---

### U2. Dual-field inline editing

**Goal:** Allow editing title and detail simultaneously within a single todo item.

**Requirements:** R2, R3, R4

**Dependencies:** None

**Files:**
- `src/client/components/TodoList.tsx`

**Approach:**
- Replace `editingField` and `editText` state with `editTitle` and `editDetail` strings.
- `startEdit(todo)` sets `editingTodoId`, `editTitle` (todo.text), and `editDetail` (todo.detail).
- While `editingTodoId === todo.id`, render two inputs:
  - Title input (styled like the current text edit input)
  - Detail input (styled like the current detail edit input), always shown regardless of whether detail was originally empty
- Enter on either input commits; Escape on either input cancels.
- Remove `onBlur` auto-commit to avoid saving while the user moves between the two inputs.
- `commitEdit` compares current values to the original todo; if either differs, call `updateTodo(todoId, { text: editTitle.trim(), detail: editDetail.trim() })`.
- `cancelEdit` clears edit state without calling the API.
- Clicking outside the editing todo item should also cancel edit mode (attach a document-level mousedown listener while editing, scoped to dismiss when clicking outside the active todo row).

**Patterns to follow:** The existing `startEdit`, `commitEdit`, and `cancelEdit` patterns in TodoList.tsx.

**Test scenarios:**
- **Happy path:** Click a todo title → both title and detail inputs appear; modify both; press Enter → both fields update.
- **Happy path:** Click a todo detail → both inputs appear; modify only detail; press Enter → only detail updates (or both are sent, server handles no-op).
- **Happy path:** Press Escape → edits are discarded, original values render.
- **Edge case:** Click outside the todo row while editing → edit mode cancels without saving.
- **Edge case:** Detail was originally empty; in edit mode, the detail input is visible and empty, allowing the user to add one.

**Verification:** Edit a todo, confirm both fields are editable together, and that commit/cancel behave correctly.

---

## Scope Boundaries

- Does not change the todo data model or API.
- Does not modify the quick-add input or search behavior.
- Does not affect status dropdown, context menu, or session-linking actions.
