---
title: Disable Arrow-Key History Recall in Prompt Input
type: fix
date: 2026-06-16
origin: docs/brainstorms/2026-06-16-disable-arrow-key-history-recall-requirements.md
---

# Disable Arrow-Key History Recall in Prompt Input

## Summary

Remove the terminal-style `ArrowUp`/`ArrowDown` history recall from `PromptInput` so arrow keys move the caret normally inside multi-line text. History recall remains available through the existing `Alt+H` searchable popup.

## Problem Frame

`PromptInput` intercepts `ArrowUp` and `ArrowDown` whenever no picker is open and cycles through previously sent prompts. Because the input supports multi-line drafts, this steals the arrow keys from ordinary caret movement between lines. Users who only want to move the cursor up or down inside a long prompt accidentally replace the draft with an old prompt instead.

## Requirements

- R1. When the prompt input is focused and no overlay picker has focus, pressing `ArrowUp` or `ArrowDown` moves the text cursor to the previous or next line. It does not recall sent-prompt history.
- R2. The existing `Alt+H` keyboard shortcut and the History toolbar button continue to open the searchable history popup unchanged.
- R3. History popup keyboard navigation inside the popup (`ArrowUp`/`ArrowDown` to cycle rows, `Enter` to commit, `Escape` to close) remains unchanged.

## Key Technical Decisions

- **Delete the arrow-key recall branch rather than guard it.** The branch and the state it owns (`historyCursor`, `originalDraftRef`, `applyHistory`, `restoreOriginal`) only exist to support ArrowUp/ArrowDown recall. Removing them keeps the component simpler and avoids dead code. The `Alt+H` popup path is unaffected, though `handleHistorySelect` must be edited to remove references to the deleted state.

## Implementation Units

### U1. Remove arrow-key history recall and dead state

- **Goal:** Stop `ArrowUp`/`ArrowDown` from recalling history and remove the state that supported only that behavior.
- **Requirements:** R1
- **Dependencies:** None
- **Files:** `src/client/components/PromptInput.tsx`
- **Approach:**
  - Delete the `History recall (terminal-style ArrowUp/Down)` keydown branch.
  - Remove the `historyCursor` state variable and its setter.
  - Remove `originalDraftRef` and the `applyHistory`/`restoreOriginal` helper functions.
  - Clean up any effect lines or reset logic that touch `historyCursor` or `originalDraftRef` (for example, the session-switch cleanup effect and `resetInput`).
  - Edit `handleHistorySelect` to remove references to deleted state (`setHistoryCursor(null)` and `originalDraftRef.current = ''`).
  - Leave the `Alt+H` shortcut, `handleHistoryClick`, and the `HistoryPicker` integration unchanged.
- **Patterns to follow:** Existing keydown handler structure in `PromptInput.tsx`; keep the `contentEditable` surface's default arrow-key behavior.
- **Test scenarios:**
  - **Happy path:** Given a multi-line draft and the caret on the second line, pressing `ArrowUp` moves the caret to the first line without changing the draft text.
  - **Edge case:** Given an empty input and existing sent-prompt history, pressing `ArrowUp` leaves the input empty and does not recall a prompt.
  - **Edge case:** Given a single-line draft, pressing `ArrowUp` moves the caret to the start of the line (default contentEditable behavior) and does not recall history.
- **Verification:** The component renders and responds to keyboard input; no remaining `e.preventDefault()` in `handleKeyDown` fires for `ArrowUp`/`ArrowDown` when no picker is open; the editable surface moves the caret natively.

### U2. Update PromptInput browser tests

- **Goal:** Align the existing browser tests with the new arrow-key behavior.
- **Requirements:** R1, R2, R3
- **Dependencies:** U1
- **Files:** `src/client/components/PromptInput.browser.test.tsx`
- **Approach:**
  - Remove or rewrite the test at `PromptInput.browser.test.tsx:251` titled 'recalls history with ArrowUp and restores original with ArrowDown'.
  - Add tests that assert ArrowUp/ArrowDown no longer recall history.
  - Keep the existing command picker, file picker, and completion tests intact.
  - Keep or add coverage that the `Alt+H` shortcut still opens the history popup and that selecting a row with `Enter` commits the prompt to the draft.
- **Patterns to follow:** Existing `userEvent.keyboard` patterns and `seedHistory` helper in the test file.
- **Test scenarios:**
  - **Happy path:** `ArrowUp` with history present and an empty input leaves the input empty.
  - **Happy path:** `ArrowUp` inside a multi-line draft does not change the draft content.
  - **Integration scenario:** `Alt+H` opens the history popup, `ArrowDown` highlights a row, and `Enter` replaces the draft with the selected prompt.
  - **Edge case:** The streaming-state test that asserts the input is disabled remains valid; rename it if its current title implies history navigation behavior.
- **Verification:** `npm test -- PromptInput.browser.test.tsx` (or the project's equivalent browser-test command) passes.

## Scope Boundaries

**Deferred for later**

- Rebinding history recall to a modifier-key shortcut.
- Conditionally triggering history recall only when the caret is on the first or last line.
- Adding a user setting to toggle arrow-key history recall.

**Outside this plan's identity**

- Changing the history popup's design, filtering, or row interaction model.
- Removing the history popup or the History toolbar button.

## Sources & Research

- **Origin requirements:** `docs/brainstorms/2026-06-16-disable-arrow-key-history-recall-requirements.md`
- **Component to change:** `src/client/components/PromptInput.tsx` — keydown handler and related history-recall state.
- **Tests to update:** `src/client/components/PromptInput.browser.test.tsx` — existing ArrowUp/ArrowDown history recall coverage.
- **Unchanged popup component:** `src/client/components/HistoryPicker.tsx` — searchable history popup triggered by `Alt+H` and the History button.
