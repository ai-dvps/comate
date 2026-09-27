---
title: "Refactor: Rewrite prompt input with contentEditable for IME support"
type: refactor
date: 2026-06-15
deepened: 2026-06-15
origin: docs/brainstorms/2026-06-15-prompt-input-contenteditable-ime-requirements.md
---

# Refactor: Rewrite prompt input with contentEditable for IME support

## Summary

Replace the controlled `<textarea>` in the chat prompt input with a browser-native `contentEditable` div so CJK/IME composition works without the cursor-jump and stuck-composition bugs that accumulate in controlled textareas. The MarkdownOverlay has already been removed on the current branch. The plan preserves all existing user-facing behavior (pickers, history, completion ghost text, send/clear/stop, toolbar) and introduces Vitest Browser Mode so the composition and editing tests run against a real browser.

---

## Problem Frame

The prompt input currently uses a controlled `<textarea>` with multiple IME recovery mechanisms: a composition-ref that gates side effects, a `pendingCursorPosRef` + `useLayoutEffect` to restore caret position, a `keydown` recovery for stuck composition after IME switches, and an effect that resets composition state when the textarea is disabled mid-stream. Despite these patches, Chinese input still suffers from pinyin leakage, cursor jumps, duplicated characters, and premature submission because React's controlled reconciliation fights the browser's IME engine.

The MarkdownOverlay compounded the problem with transparent textarea text and scroll-sync drift. It has been removed in the current branch. Moving to `contentEditable` lets the browser own composition, selection, and rendering, eliminating the recovery-code treadmill. The trade-off is explicit handling of plain-text extraction, newline normalization, selection management, placeholder text, paste stripping, and accessibility.

---

## Requirements

Requirements below are carried forward from `docs/brainstorms/2026-06-15-prompt-input-contenteditable-ime-requirements.md`. The acceptance examples AE1–AE10 from the origin document are exercised in the test scenarios of the implementation units below.

**IME / composition behavior**

- R1. The prompt input renders a `contentEditable` div as its editable surface.
- R2. IME composition events fire naturally without interception or suppression.
- R3. Enter during an active IME composition commits the composition; it does not submit the message.
- R4. Submit is only allowed when no IME composition is active.

**Editable surface and value**

- R5. The editable surface is plain text only; HTML from composition, paste, or drag-and-drop is normalized to text.
- R6. The component extracts a single string value, normalizing block separators (`<div>`, `<br>`, `<p>`) to newline characters consistently across browsers.
- R7. The extracted value is stored as the per-session draft in the existing chat store.
- R8. When the active session changes, the editable surface is cleared and populated with the new session's draft.
- R9. When the draft is reset, the editable surface is empty and the placeholder is visible.

**Selection and cursor**

- R10. The component tracks the current caret position as a character offset within the plain-text value.
- R11. Programmatic insertions replace the current selection or insert at the caret, then move the caret to the end of the inserted text.
- R12. Cursor position is preserved across re-renders caused by draft-store updates.
- R13. Programmatic focus places the caret at the end of the existing text unless specified otherwise.

**Pickers**

- R14. `/` at the start of an empty input or after whitespace opens the command picker.
- R15. `@` at the start of an empty input or after whitespace opens the file picker.
- R16. Mid-word `/` and `@` do not trigger pickers.
- R17. Only one picker is open at a time.
- R18. Re-typing a trigger after dismissal reopens the picker without clearing the input.
- R19. Whitespace after the trigger segment, Escape, or Tab dismisses the active picker.
- R20. Selecting a command inserts `/<command> ` at the trigger location and shows the argument-hint ghost text.
- R21. Selecting a file inserts `@<path> ` at the trigger location.

**History**

- R22. ArrowUp with an empty input recalls the most recent sent prompt; subsequent ArrowUp presses walk backward.
- R23. ArrowDown walks forward through history; moving past the most recent entry restores the original draft.
- R24. Recalled prompts are editable drafts; sending an edited recalled prompt appends it to history.
- R25. The History popup opens via the toolbar button and a keyboard shortcut.
- R26. The History popup lists sent prompts in reverse-chronological order with fuzzy/glob filter search.
- R27. Selecting a prompt from the popup replaces the draft and closes the popup.
- R28. History navigation and the popup are disabled while streaming.

**Completion and ghost text**

- R29. After inserting a slash command, an argument-hint ghost text appears after the command and stays visible until the user types real characters beyond it.
- R30. When the argument hint is visible, n-gram completion suggestions do not fire.
- R31. When no picker is open, no argument hint is visible, and the user pauses typing, an n-gram completion suggestion appears after the caret.
- R32. Completion suggestions render as faded ghost text after the caret and can be accepted with Tab or dismissed with Escape, ArrowLeft, or ArrowRight.
- R33. Completion and argument hints do not fire while streaming or restarting.

**Send / stop / clear**

- R34. Enter sends unless Shift is held or the configured submit-shortcut mode requires a modifier.
- R35. While streaming, the Send button becomes a Stop button with a confirmation popover.
- R36. Confirming stop interrupts the turn; cancelling leaves it running.
- R37. Clear empties the draft without affecting chat history, the live stream, or pending approvals.

**Toolbar and actions**

- R38. The input container shows Commands, Files, and History buttons alongside Provider and Approval mode selectors.
- R39. Buttons are disabled when the session is streaming, restarting, or absent as appropriate.
- R40. Focus remains in the editable surface after a toolbar action unless the action explicitly moves focus to a picker filter input.

**Paste and input normalization**

- R41. Paste inserts plain text only; HTML formatting is stripped.
- R42. File paste with no text is handled by the existing file-paste path.
- R43. Drag-and-drop into the input is treated as plain-text drop.

**Appearance and accessibility**

- R44. The editable surface grows vertically with content up to a maximum height, then scrolls vertically.
- R45. No horizontal scrollbar is shown; long lines wrap.
- R46. Placeholder text is shown when the editable surface is empty and unfocused.
- R47. The editable surface exposes `role="textbox"` and an `aria-placeholder` attribute matching the visible placeholder.
- R48. Focus, hover, and disabled visual states match the existing input design.

---

## Key Technical Decisions

- **`contentEditable="plaintext-only"` with `true` fallback.** Modern Chromium, Safari, and Edge support `plaintext-only`, which natively rejects rich formatting and simplifies value extraction. For Firefox and older browsers, fall back to `contentEditable="true"` with paste sanitization and input normalization. Rationale: reduces the amount of HTML we must strip while keeping broad browser support.
- **DOM as source of truth during editing; chat store synced on `input` and `blur`.** React state does not drive the inner HTML during typing. The editable surface is uncontrolled at the DOM level; plain text is extracted and pushed to the chat store, which triggers re-renders only when the value actually changes. Rationale: prevents React reconciliation from fighting the browser's editing engine and causing cursor jumps.
- **Lightweight selection helpers in `src/client/lib/contenteditable.ts`.** The codebase has no Range/Selection utilities. A small module will convert between DOM `Range` and character offsets and insert/delete text at an offset. Rationale: isolates browser-specific selection logic and makes it testable.
- **Ghost text rendered as an absolutely positioned mirror layer.** The existing `PromptGhostText` uses an invisible copy of the input plus faded suggestion text. This pattern is adapted for `contentEditable` by rendering the mirror layer with the same text metrics as the editable surface and positioning it behind the caret. Rationale: preserves the existing visual stacking and avoids embedding non-editable spans inside the editable DOM, which can interfere with IME.
- **Placeholder implemented as a separate visual element, not `:empty::before`.** A `::before` pseudo-element is fragile when the browser inserts a `<br>` in an empty `contentEditable`. An absolutely positioned span toggled by emptiness is more reliable. Rationale: avoids placeholder flicker and visibility bugs.
- **Paste handled on `onPaste`; `beforeinput` used as a guard.** `onPaste` is the most reliable cross-browser interception point. `beforeinput` with `inputType === 'insertFromPaste'` is added as a fallback guard to catch paste paths that bypass `onPaste`. Rationale: plain-text insertion must work consistently across browsers and input methods.
- **Composition state detected with both `event.isComposing` and a ref.** `event.isComposing` is authoritative but not available on all events of interest. A lightweight `isComposingRef` set by `compositionstart`/`compositionend` provides a stable gate for submit. Rationale: covers the maximum set of composition edge cases without the heavy recovery code the textarea required.
- **Vitest Browser Mode with Playwright for prompt-input tests.** jsdom does not implement the `contentEditable` editing engine, so existing `fireEvent.change` tests cannot run against the new surface. Browser Mode runs the tests in a real Chromium instance. Rationale: composition, paste, selection, and picker tests require a real browser.

---

## High-Level Technical Design

```mermaid
flowchart TB
  User([User]) -- keystrokes, paste, IME --> Editable[contentEditable div]
  Editable -- input event --> Extract[extractPlainText]
  Extract -- normalized value --> ChatStore[drafts[sessionId]]
  ChatStore -- value changed --> PromptInput[PromptInput re-render]
  PromptInput -- restore selection --> Editable
  PromptInput -- render ghost text --> Ghost[PromptGhostText mirror layer]
  PromptInput -- open/close --> Pickers[CommandPicker / FilePicker / HistoryPicker]
  Pickers -- selected value --> Insert[insertTextAtOffset helper]
  Insert -- DOM mutation --> Editable
  History -- ArrowUp/Down --> Recall[recall prompt]
  Recall -- setDraft --> ChatStore
  Completion -- suggestion --> Ghost
```

The editable div is the source of truth while the user is typing. On every `input` event, `extractPlainText` clones the editable node, normalizes block separators to newlines, and pushes the result to the chat store. If the store value matches the current extracted value, the re-render is a no-op; if it differs, `PromptInput` re-renders and restores the saved selection. Programmatic insertions (pickers, history recall, completion accept) mutate the DOM through the selection helper and then sync the new value to the store.

---

## Implementation Units

### U1. Replace textarea with contentEditable core

- **Goal:** Swap the `<textarea>` element in `PromptInput` for a `contentEditable` div, preserving the surrounding container, toolbar, and visual styling.
- **Requirements:** R1, R8, R9, R44, R45, R48
- **Dependencies:** none
- **Files:**
  - `src/client/components/PromptInput.tsx`
  - `src/client/index.css`
- **Approach:**
  - Remove `textareaRef` and textarea JSX.
  - Add an editable `div` with `contentEditable="plaintext-only"` and a fallback to `contentEditable="true"` for Firefox.
  - Apply the same `whitespace-pre-wrap break-words overflow-y-auto overflow-x-hidden` behavior.
  - Implement auto-resize with `useLayoutEffect` keyed on `input` and `maxHeight`.
  - Preserve the `disabled` behavior by toggling `contentEditable` and `tabIndex` when streaming/restarting.
- **Patterns to follow:** The existing auto-resize math (`Math.min(scrollHeight, maxHeight)`) and max-height calculation (`Math.max(Math.round(window.innerHeight * 0.4), 160)`).
- **Test scenarios:**
  - Happy path: the component renders a `[role="textbox"]` element.
  - Edge case: the surface grows when multi-line text is inserted programmatically.
  - Edge case: the surface scrolls vertically when content exceeds `maxHeight`.
  - Edge case: the surface is not editable while streaming.
- **Verification:** `PromptInput` renders without a `<textarea>`; visual check confirms auto-resize and scroll behavior.

### U2. Plain-text extraction and normalization

- **Goal:** Extract a consistent plain-text value from the `contentEditable` DOM and sync it to the chat-store draft.
- **Requirements:** R5, R6, R7
- **Dependencies:** U1
- **Files:**
  - `src/client/components/PromptInput.tsx`
  - `src/client/lib/contenteditable.ts` (new)
- **Approach:**
  - Add `extractPlainText(element)` in `src/client/lib/contenteditable.ts`.
  - Clone the element, replace block separator tags (`<br>`, `<div>`, `<p>`) and their closing counterparts with newline characters, read `textContent`, and collapse consecutive newlines.
  - Call `extractPlainText` on `onInput` and `onBlur` and push the result to `setDraft`.
  - Avoid syncing during active IME composition; flush on `compositionend`.
- **Patterns to follow:** The existing `prevInputRef` pattern for comparing previous and current values.
- **Test scenarios:**
  - Happy path: typing text produces the same string in the store.
  - Edge case: multi-line content with `<div>` separators normalizes to single newlines.
  - Edge case: `<br>` and `<p>` also normalize to single newlines.
  - Edge case: empty surface produces an empty string.
  - Edge case: consecutive block separators collapse to one newline.
- **Verification:** `PromptInput` unit tests (or Browser Mode tests) assert that the store draft matches the visible text for a range of inputs.

### U3. Selection and caret helpers

- **Goal:** Provide utilities to read and write the caret position as a character offset within the editable surface.
- **Requirements:** R10, R11, R12, R13
- **Dependencies:** U1, U2
- **Files:**
  - `src/client/lib/contenteditable.ts`
- **Approach:**
  - Implement `getCaretOffset(element)` that walks text nodes and maps the current `Range` to a character offset.
  - Implement `setCaretOffset(element, offset)` that creates a `Range` at the corresponding text node/offset and applies it to `window.getSelection()`.
  - Implement `insertTextAtOffset(element, text, offset?)` that deletes the current selection if any, inserts text, and places the caret after the insertion.
  - Save the selection before DOM mutations that come from store updates and restore it afterward.
- **Patterns to follow:** Avoid storing `Range` objects in React state; use refs.
- **Test scenarios:**
  - Happy path: `getCaretOffset` returns the correct offset after typing.
  - Happy path: `setCaretOffset` places the caret at the requested offset.
  - Edge case: caret at the start, middle, and end of multi-line content.
  - Edge case: selection is preserved after a store-driven re-render.
  - Integration scenario: inserting text at the caret leaves the caret at the end of the inserted text.
- **Verification:** Browser Mode tests exercise typing, selection, and insertion across line boundaries.

### U4. IME composition gating and submit

- **Goal:** Re-implement send-on-Enter with proper IME composition gating.
- **Requirements:** R2, R3, R4, R34
- **Dependencies:** U1, U3
- **Files:**
  - `src/client/components/PromptInput.tsx`
  - `src/client/lib/keyboard.ts`
- **Approach:**
  - Track `isComposingRef` via `compositionstart` and `compositionend`.
  - In `onKeyDown`, check `e.nativeEvent.isComposing || isComposingRef.current` before processing Enter.
  - Add a `submitLockRef` set on submit and cleared on `keyup(Enter)` to prevent double submit.
  - Preserve `shouldSubmitOnEnter` behavior including the `useModifierToSubmit` setting and Shift+Enter newline.
- **Patterns to follow:** The existing `shouldSubmitOnEnter` helper already checks `nativeEvent.isComposing`; ensure it is still called from the editable div's keydown handler.
- **Test scenarios:**
  - Happy path: plain Enter sends when not composing.
  - Edge case: Enter during composition does not send.
  - Edge case: Shift+Enter inserts a newline.
  - Edge case: modifier+Enter sends when `useModifierToSubmit` is true.
  - Edge case: rapid Enter presses do not double-send.
- **Verification:** Browser Mode composition tests pass.

### U5. Picker trigger and insertion

- **Goal:** Re-implement slash and file picker triggers and insertion using character offsets instead of `selectionStart`.
- **Requirements:** R14-R21
- **Dependencies:** U2, U3, U4
- **Files:**
  - `src/client/components/PromptInput.tsx`
- **Approach:**
  - Replace `textareaRef.current.selectionStart` with `getCaretOffset(editableRef.current)`.
  - Keep `slashTriggerStart` and `fileTriggerStart` as character indices.
  - Derive filter text with `value.slice(triggerStart + 1, caretOffset)`.
  - On picker select, use `insertTextAtOffset` to replace the trigger segment and trailing cursor-to-end-of-filter range with `/<command> ` or `@<path> `.
  - Preserve mutual-exclusivity and re-trigger rules.
- **Patterns to follow:** Existing picker state management and keyboard delegation in `PromptInput`.
- **Test scenarios:**
  - Covers AE3. Trigger `/` at start of empty input and after whitespace mid-text.
  - Edge case: mid-word `/` and `@` do not open pickers.
  - Edge case: typing whitespace, Escape, or Tab dismisses the picker.
  - Edge case: re-typing the trigger reopens the picker.
  - Integration scenario: selecting a command inserts the command and shows the argument hint.
  - Integration scenario: selecting a file inserts the path.
- **Verification:** Existing picker tests (adapted to Browser Mode) pass.

### U6. History, completion, and ghost text

- **Goal:** Re-implement history recall and completion/argument-hint ghost text for the new editable surface.
- **Requirements:** R22-R33
- **Dependencies:** U2, U3, U5
- **Files:**
  - `src/client/components/PromptInput.tsx`
  - `src/client/components/PromptGhostText.tsx`
- **Approach:**
  - Keep the existing `historyCursor`, `originalDraftRef`, `applyHistory`, and `restoreOriginal` logic.
  - For completion and argument hints, adapt `PromptGhostText` to render an absolutely positioned mirror layer that matches the editable div's text metrics.
  - Compute caret coordinates using the Selection/Range API (`getBoundingClientRect` of the current range) to position the ghost text correctly when wrapping.
  - Accept completion with Tab; dismiss with Escape, ArrowLeft, or ArrowRight.
- **Patterns to follow:** Existing debounce timer for completion and priority rule (argument hint over completion).
- **Test scenarios:**
  - Covers AE4. ArrowUp/Down recall and restore original draft.
  - Covers AE5. Completion ghost appears after debounce and accepts with Tab.
  - Edge case: completion does not fire while a picker is open.
  - Edge case: completion does not fire while an argument hint is visible.
  - Edge case: history and completion are disabled while streaming.
- **Verification:** Browser Mode tests for history and completion pass.

### U7. Toolbar, paste, placeholder, and accessibility

- **Goal:** Wire the toolbar buttons, paste/drop handling, placeholder, and accessibility attributes.
- **Requirements:** R38-R43, R46, R47
- **Dependencies:** U1
- **Files:**
  - `src/client/components/PromptInput.tsx`
  - `src/client/index.css`
- **Approach:**
  - Keep the existing toolbar button structure and disabled states.
  - Implement `onPaste` to call `e.preventDefault()` and insert `e.clipboardData.getData('text/plain')`.
  - Add a `beforeinput` guard for `insertFromPaste` as a defensive fallback.
  - Implement `onDrop` similarly for plain-text drops.
  - Render a placeholder element absolutely positioned behind the editable surface; toggle visibility based on whether the extracted value is empty and the surface is unfocused.
  - Add `role="textbox"`, `aria-placeholder`, `aria-multiline="true"`, `tabIndex={0}`, and an accessible name.
- **Patterns to follow:** Existing toolbar disabled logic; existing i18n placeholder text.
- **Test scenarios:**
  - Covers AE6. Paste of formatted content inserts plain text only.
  - Edge case: paste of files when no text is present routes to the existing file-paste handler.
  - Edge case: placeholder is visible when empty and unfocused; hidden when focused or non-empty.
  - Edge case: toolbar buttons disable correctly during streaming and restarting.
  - Edge case: the editable surface is announced as a textbox by assistive technologies.
- **Verification:** Browser Mode paste test and accessibility tree checks pass.

### U8. Vitest Browser Mode setup and prompt-input tests

- **Goal:** Add Vitest Browser Mode so prompt-input tests can exercise `contentEditable` composition, selection, paste, and picker behavior in a real browser.
- **Requirements:** success criteria around test coverage
- **Dependencies:** U1-U7
- **Files:**
  - `package.json`
  - `package-lock.json`
  - `vitest.config.ts`
  - `src/client/components/PromptInput.browser.test.tsx` (new)
  - `src/client/components/PromptInput.composition.test.tsx`
- **Approach:**
  - Add `@vitest/browser` and the Playwright provider.
  - Extend `vitest.config.ts` with a browser-mode project targeting Chromium.
  - Create `PromptInput.browser.test.tsx` covering composition, pickers, history, completion, paste, and submit.
  - Migrate or delete `PromptInput.composition.test.tsx` once Browser Mode coverage replaces it.
  - Keep non-editing unit tests (e.g., toolbar disabled states) in the existing jsdom suite where possible.
- **Patterns to follow:** Existing test wrappers (`I18nextProvider`, chat-store mock).
- **Test scenarios:**
  - Covers AE1. Chinese IME composition and submit.
  - Covers AE2. Enter during composition does not submit.
  - Covers AE7. Long content grows then scrolls.
  - Covers AE8. Clear does not affect streaming.
  - Covers AE9. Multi-line value normalizes to single newlines.
  - Covers AE10. Placeholder and textbox role are correct.
  - Integration scenario: picker open, select, insert, and submit.
  - Integration scenario: history recall, edit, and submit.
- **Verification:** `npm run test:browser` (or equivalent) passes for the prompt-input suite.

### U9. Cleanup residual textarea code and styles

- **Goal:** Remove leftover textarea-specific state, refs, effects, and CSS now that the input is contentEditable.
- **Requirements:** none (verification-only cleanup)
- **Dependencies:** U1-U8
- **Files:**
  - `src/client/components/PromptInput.tsx`
  - `src/client/index.css`
  - `src/client/components/PromptInput.test.tsx`
  - `src/client/components/PromptInput.composition.test.tsx`
- **Approach:**
  - Remove `textareaRef`, `pendingCursorPosRef`, and the cursor-preservation `useLayoutEffect`.
  - Remove the stuck-composition recovery effect and keydown recovery logic.
  - Remove any remaining `.md-overlay` or textarea-specific CSS rules.
  - Delete or fully migrate `PromptInput.composition.test.tsx`.
  - Update `PromptInput.test.tsx` assertions that depend on textarea APIs.
- **Patterns to follow:** Verify no references to `selectionStart`, `selectionEnd`, `setSelectionRange`, or textarea-specific event types remain in `PromptInput.tsx`.
- **Test scenarios:**
  - Test expectation: none for this unit — it is cleanup.
- **Verification:** `grep` shows no `textarea` references in `PromptInput.tsx`; all tests pass.

---

## System-Wide Impact

- **User experience.** The prompt input is the primary surface for every chat interaction. A regression here affects every send, edit, paste, and picker use. The plan mitigates this with Browser Mode tests and by preserving existing behavior.
- **Test infrastructure.** Adding Vitest Browser Mode introduces Playwright as a test dependency and increases CI runtime. The jsdom-based `PromptInput.test.tsx` will need to be split: non-editing assertions can remain in jsdom; editing/composition tests move to Browser Mode.
- **Developer workflow.** Engineers will need the Playwright browsers installed locally to run prompt-input tests. The standard `npm test` command may need a separate `npm run test:browser` script, and CI will need to run both suites.
- **Accessibility.** Moving from a native `<textarea>` to `contentEditable` changes the screen-reader contract. The plan adds `role="textbox"`, `aria-multiline`, `aria-placeholder`, and an accessible name, but this needs manual screen-reader verification before release.
- **Bundle and dependencies.** `@vitest/browser` and the Playwright provider add dev dependencies. No runtime dependencies change.

---

## Scope Boundaries

### In scope

- Rewriting `PromptInput` around a `contentEditable` div.
- Re-implementing value extraction, selection, IME gating, pickers, history, completion, ghost text, paste, placeholder, and accessibility.
- Adding Vitest Browser Mode and migrating prompt-input tests.
- Removing leftover textarea-specific code and styles.

### Deferred for later

- Inline markdown source highlighting or WYSIWYG formatting inside the input.
- File attachments, image paste, or drag-and-drop of files beyond the existing file-paste path.
- Voice input integration.
- Cross-workspace or cross-device draft synchronization.

### Outside this product's identity

- Replacing the input with CodeMirror 6, TipTap, Lexical, or another rich-text editor library.
- Converting the prompt input into a fully-rendered message composer with message bubbles or inline media.

---

## Risks & Dependencies

- **Risk:** Browser differences in `contentEditable` newline handling cause inconsistent multi-line drafts.
  - **Mitigation:** U2 implements explicit normalization and adds Browser Mode tests covering Chromium; manual Safari/Firefox checks are noted in verification.
- **Risk:** Vitest Browser Mode increases CI time and introduces flakiness.
  - **Mitigation:** Keep jsdom tests for non-editing logic; run Browser Mode only for the prompt-input suite initially. Re-evaluate CI budget after the first week.
- **Risk:** Ghost-text positioning breaks on wrapped lines or high-DPI displays.
  - **Mitigation:** Use caret `getBoundingClientRect` and compare against the editable container's rect. Add visual regression tests if the project supports them.
- **Risk:** Picker insertion edge cases (cursor before trigger, deleted trigger) behave differently than with `selectionStart`.
  - **Mitigation:** U5 test scenarios explicitly cover trigger deletion and cursor movement before the trigger.
- **Risk:** Accessibility regression because screen-reader support for `contentEditable` is weaker than for `textarea`.
  - **Mitigation:** Add `role="textbox"`, `aria-multiline`, `aria-placeholder`, and an accessible name. Include an a11y verification step in U7.

---

## Open Questions

- [Affects R1, R44, R45][Design] The exact minimum height and padding for the new editable surface will be matched to the existing textarea design during implementation. The maximum height (`Math.max(Math.round(window.innerHeight * 0.4), 160)`) and vertical scroll behavior are already specified.

---

## Sources & Research

- **Origin requirements:** `docs/brainstorms/2026-06-15-prompt-input-contenteditable-ime-requirements.md`
- **Current prompt input:** `src/client/components/PromptInput.tsx`, `src/client/components/PromptGhostText.tsx`
- **Existing tests:** `src/client/components/PromptInput.test.tsx`, `src/client/components/PromptInput.composition.test.tsx`
- **Overlay removal plan:** `docs/plans/2026-06-15-001-refactor-remove-prompt-input-markdown-overlay-plan.md`
- **External reference:** ant-design/x Sender `TextArea.tsx` and `SlotTextArea.tsx` — composition-ref gating, submit lock, Range/Selection cursor management, and paste normalization patterns.
- **External reference:** W3C ContentEditable spec and 2026 best-practice guidance on `textContent` vs `innerText`, newline normalization, and `plaintext-only` support.
- **External reference:** Vitest Browser Mode documentation for testing `contentEditable` in a real browser.
