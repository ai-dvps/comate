---
date: 2026-06-16
topic: disable-arrow-key-history-recall
---

# Disable Arrow-Key History Recall

## Summary

Remove the terminal-style `ArrowUp`/`ArrowDown` history recall from the prompt input so arrow keys move the cursor normally inside multi-line text. Sent-prompt history remains reachable through the existing `Alt+H` searchable history popup.

## Problem Frame

`src/client/components/PromptInput.tsx` intercepts `ArrowUp` and `ArrowDown` whenever no picker is open and walks through previously sent prompts. Because the input supports multi-line text, this steals the arrow keys from ordinary caret movement between lines. Users who only want to move the cursor up or down inside a long prompt accidentally replace the draft with an old prompt instead.

## Requirements

- R1. When the prompt input is focused and no overlay picker has focus, pressing `ArrowUp` or `ArrowDown` moves the text cursor to the previous or next line. It does not recall sent-prompt history.
- R2. The existing `Alt+H` keyboard shortcut and the History toolbar button continue to open the searchable history popup unchanged.
- R3. History popup keyboard navigation inside the popup (`ArrowUp`/`ArrowDown` to cycle rows, `Enter` to commit, `Escape` to close) remains unchanged.

## Key Decisions

- **Remove arrow-key recall rather than make it conditional.** Alternatives such as modifier-key recall (`Ctrl+ArrowUp`) or edge-only recall (only on the first/last line) were considered. Removing the binding entirely was chosen because the popup already provides a deliberate, searchable recall path and avoids re-introducing a mode where the same key sometimes moves the cursor and sometimes swaps the draft.

## Key Flows

- F1. **Multi-line cursor movement**
  - **Trigger:** User has typed two lines of text in the prompt input and presses `ArrowUp` while the caret is on the second line.
  - **Actors:** User
  - **Steps:** The caret moves to the first line. The draft content does not change.
  - **Outcome:** Arrow keys behave like a normal multi-line text field.
  - **Covered by:** R1

- F2. **History recall via popup**
  - **Trigger:** User wants to reuse a previously sent prompt.
  - **Actors:** User
  - **Steps:** User presses `Alt+H` (or clicks the History button), the popup opens, the user types a filter or cycles rows with arrow keys, then presses `Enter`.
  - **Outcome:** The selected prompt replaces the current draft and the popup closes.
  - **Covered by:** R2, R3

## Acceptance Examples

- AE1. **Covers R1.** Given the prompt input contains two lines of text and the caret is on the second line, when the user presses `ArrowUp`, then the caret moves to the first line and the draft text is unchanged.
- AE2. **Covers R1.** Given the prompt input is empty and the user has sent prompts in the current session, when the user presses `ArrowUp`, then the input remains empty and no history recall occurs.
- AE3. **Covers R2, R3.** Given the user has sent prompts in the current session, when the user presses `Alt+H`, then the history popup opens. When the user presses `ArrowDown` and then `Enter`, then the selected prompt replaces the current draft and the popup closes.

## Scope Boundaries

**Deferred for later**

- Rebinding history recall to a modifier-key shortcut (e.g., `Ctrl+ArrowUp`).
- Conditionally triggering history recall only when the caret is on the first or last line of the draft.
- Adding a user setting to toggle arrow-key history recall on or off.

**Outside this product's identity**

- Changing the history popup's design, filtering, or row interaction model.
- Removing the history popup or the History toolbar button.

## Dependencies / Assumptions

- The searchable history popup (`HistoryPicker`) and its `Alt+H` shortcut are already implemented and working in `src/client/components/PromptInput.tsx`.
- Removing the `ArrowUp`/`ArrowDown` handler block will leave the underlying `contentEditable` caret movement unchanged.

## Sources & Research

- **Existing prompt input with arrow-key recall:** `src/client/components/PromptInput.tsx` — the `handleKeyDown` block that intercepts `ArrowUp`/`ArrowDown` for history recall when no picker is open.
- **Existing history popup:** `src/client/components/HistoryPicker.tsx` — searchable list with `ArrowUp`/`ArrowDown` row navigation, `Enter` to commit, `Escape` to close.
