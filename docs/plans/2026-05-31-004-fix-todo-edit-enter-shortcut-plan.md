---
title: 'fix: Todo edit save shortcut — Enter to save, Shift+Enter for newline'
type: fix
status: active
date: 2026-05-31
---

# fix: Todo edit save shortcut — Enter to save, Shift+Enter for newline

## Summary

Align the todo item edit textarea keyboard behavior with the main prompt input: pressing Enter commits the edit, while Shift+Enter inserts a newline. Currently, save requires Cmd+Enter (or Ctrl+Enter), which is inconsistent with the chat input pattern.

## Requirements

- R1. Pressing Enter while editing a todo title must commit the edit.
- R2. Pressing Shift+Enter while editing a todo title must insert a newline.
- R3. Pressing Escape while editing must continue to cancel the edit.

## Scope Boundaries

- Does not change the quick-add input behavior (Enter already adds a todo there).
- Does not modify any other keyboard shortcuts in the app.
- Does not affect todo display, status changes, or session linking.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/TodoList.tsx` — contains the todo edit textarea with the current `onKeyDown` handler (lines 278–287).
- `src/client/components/PromptInput.tsx` — the chat prompt textarea uses `e.key === 'Enter' && !e.shiftKey` to send (line 288), which is the pattern to match.

## Implementation Units

### U1. Change todo edit keyboard shortcut

**Goal:** Replace Cmd+Enter with Enter-to-save and Shift+Enter-for-newline in the todo edit textarea.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/client/components/TodoList.tsx`

**Approach:**
- Update the `onKeyDown` handler on the todo edit `<textarea>`:
  - Change the save condition from `(e.ctrlKey || e.metaKey) && e.key === 'Enter'` to `e.key === 'Enter' && !e.shiftKey`.
  - Keep the Escape handler unchanged.
  - `Shift+Enter` will naturally insert a newline because `preventDefault()` is not called when `shiftKey` is true.

**Patterns to follow:**
- The `PromptInput.tsx` textarea uses the same `e.key === 'Enter' && !e.shiftKey` pattern for sending messages.

**Test scenarios:**
- **Happy path:** Click a todo to edit, type text, press Enter → edit is saved.
- **Happy path:** Edit a todo, press Shift+Enter → a newline is inserted in the textarea.
- **Happy path:** Edit a todo, press Escape → edit is cancelled and original text restored.
- **Edge case:** Edit a todo with existing multiline text, press Shift+Enter to add another line, then press Enter → the multiline text is saved correctly.

**Verification:**
- Edit a todo in the UI and confirm Enter saves, Shift+Enter adds a newline, and Escape cancels.
