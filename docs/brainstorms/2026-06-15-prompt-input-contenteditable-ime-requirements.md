---
date: 2026-06-15
topic: prompt-input-contenteditable-ime
---

# Prompt Input ContentEditable Rewrite for IME

## Summary

Rewrite the chat prompt input around a browser-native `contentEditable` div so CJK/IME composition is handled by the browser instead of fought through a controlled `<textarea>`. The MarkdownOverlay is removed first as a separate cleanup. All existing user-facing behavior is preserved, including slash/file/history pickers, n-gram completion ghost text, argument hints, send/clear/stop, per-session drafts, and the provider/approval toolbar.

---

## Problem Frame

The current prompt input is a controlled `<textarea>` with several layers of IME recovery code: composition-ref gating, cursor-preservation effects, stuck-composition recovery on keydown, and a reset effect when the textarea becomes disabled mid-composition. Despite these patches, Chinese input still misbehaves because React's controlled reconciliation and textarea selection APIs fight the browser's IME engine. The MarkdownOverlay behind the textarea made the problem worse by introducing transparent text, caret-color workarounds, and scroll-sync drift.

ant-design/x Sender avoids these problems by using `contentEditable` as its input surface. The browser owns composition, selection, and rendering, so IME input works without special-case recovery code. The cost is that the application must extract plain text, normalize block separators, manage placeholder text, and re-implement submit and picker integration on top of the DOM selection API.

---

## Key Decisions

- **`contentEditable` div over a native `<textarea>`.** A `contentEditable` surface lets the browser handle IME composition natively and removes the need for cursor-preservation and stuck-composition recovery code. The trade-off is that value extraction, selection tracking, paste normalization, placeholder rendering, and accessibility must be implemented explicitly.
- **Full rewrite of `PromptInput` around the new surface rather than a wrapper component.** A wrapper that mimics `textarea` APIs on top of `contentEditable` would hide complexity but create an abstraction mismatch with picker insertion, ghost-text positioning, and selection recovery. Owning the editable surface directly keeps the behavior explicit and testable in one place.
- **Remove the MarkdownOverlay first and do not replace it.** The overlay causes IME and cursor bugs that are harder to fix than the feature is worth. The contentEditable rewrite does not introduce inline markdown styling or WYSIWYG formatting as a replacement.
- **Plain-text-only editable surface.** Rich paste and drop content are stripped to plain text. This preserves the prompt's role as a text-only message composer and avoids carrying HTML through the chat store and SDK.
- **Re-implement picker trigger and insertion logic around DOM selections.** The existing `selectionStart`/`selectionEnd` APIs do not exist on `contentEditable`. The rewrite tracks caret offsets and uses the Selection/Range API to insert picker results at the correct position.

---

## Requirements

**IME / composition behavior**

- R1. The prompt input renders a single-line `contentEditable` div that the browser treats as a plain-text editable region.
- R2. IME composition events fire naturally; the component does not intercept or suppress `compositionstart`, `compositionupdate`, or `compositionend`.
- R3. Pressing Enter while an IME composition is active commits the composition or follows the IME's default behavior; it does not submit the message.
- R4. Submitting a message is only allowed when no IME composition is active.

**Editable surface and value**

- R5. The editable surface contains plain text only; any HTML structure created by the browser during composition, paste, or drag-and-drop is normalized to plain text with newline separators.
- R6. The component extracts a single string value from the editable surface, normalizing block separators (`<div>`, `<br>`, `<p>`) to newline characters consistently across supported browsers.
- R7. The extracted value is stored as the per-session draft in the existing chat store.
- R8. When the active session changes, the editable surface is cleared and populated with the new session's draft.
- R9. When the draft is reset to empty, the editable surface is empty and the placeholder is visible.

**Selection and cursor**

- R10. The component tracks the current caret position as a character offset within the extracted plain-text value.
- R11. Programmatic insertions from pickers and history recall replace the current selection or insert at the caret, then move the caret to the end of the inserted text.
- R12. Cursor position is preserved across re-renders caused by draft-store updates, including updates that happen while the user is typing.
- R13. When the editable surface receives focus programmatically, the caret is placed at the end of the existing text unless the caller specifies a different position.

**Pickers**

- R14. Typing `/` at the start of an empty input or immediately after whitespace opens the command picker.
- R15. Typing `@` at the start of an empty input or immediately after whitespace opens the file picker.
- R16. Mid-word `/` and `@` do not trigger pickers.
- R17. Only one picker is open at a time; opening one closes the other.
- R18. Re-typing a trigger after dismissing a picker reopens it without requiring the input to be cleared.
- R19. Typing whitespace after the trigger segment, pressing Escape, or pressing Tab dismisses the active picker.
- R20. Selecting a command inserts `/<command> ` at the trigger location and shows the argument-hint ghost text.
- R21. Selecting a file inserts `@<path> ` at the trigger location.

**History**

- R22. With an empty input and no picker open, pressing ArrowUp replaces the draft with the most recent sent prompt; subsequent ArrowUp presses walk backward through history.
- R23. Pressing ArrowDown walks forward through history; moving past the most recent entry restores the original draft.
- R24. Recalled prompts are editable drafts; sending an edited recalled prompt appends it to history.
- R25. The History popup can be opened via the toolbar History button and a keyboard shortcut.
- R26. The History popup lists sent prompts in reverse-chronological order and supports fuzzy plus glob filter search.
- R27. Selecting a prompt from the popup replaces the draft with the selected text and closes the popup.
- R28. History navigation and the popup are disabled while a stream is in progress.

**Completion and ghost text**

- R29. After inserting a slash command, an argument-hint ghost text appears after the command and stays visible until the user types real characters beyond the command.
- R30. When the argument hint is visible, n-gram completion suggestions do not fire.
- R31. When no picker is open, no argument hint is visible, and the user pauses typing, an n-gram completion suggestion appears after the caret.
- R32. Completion suggestions render as faded ghost text after the caret and can be accepted with Tab or dismissed with Escape, ArrowLeft, or ArrowRight.
- R33. Completion and argument hints do not fire while streaming or restarting.

**Send / stop / clear**

- R34. Enter sends the message unless Shift is held or the configured submit-shortcut mode requires a modifier.
- R35. While a turn is streaming, the Send button is replaced by a Stop button that opens a confirmation popover.
- R36. Confirming stop interrupts the current turn; cancelling leaves the turn running.
- R37. The Clear button empties the draft without affecting chat history, the live stream, or any pending approval banner.

**Toolbar and actions**

- R38. The input container shows Commands, Files, and History buttons alongside Provider and Approval mode selectors.
- R39. The buttons are disabled when the session is streaming, restarting, or absent as appropriate.
- R40. Focus remains in the editable surface after a toolbar action unless the action explicitly moves focus to a picker filter input.

**Paste and input normalization**

- R41. Pasting text into the editable surface inserts plain text only; HTML formatting is stripped.
- R42. Pasting files when no text is present is handled by the existing file-paste path.
- R43. Drag-and-drop into the input is treated as plain-text drop.

**Appearance and accessibility**

- R44. The editable surface grows vertically with content up to a maximum height, then scrolls vertically.
- R45. No horizontal scrollbar is shown; long lines wrap.
- R46. Placeholder text is shown when the editable surface is empty and unfocused.
- R47. The editable surface exposes `role="textbox"` and an `aria-placeholder` attribute matching the visible placeholder.
- R48. Focus, hover, and disabled visual states match the existing input design.

---

## Key Flows

- F1. **Compose and send Chinese text**
  - **Trigger:** User focuses the prompt input and types pinyin using a Chinese IME.
  - **Actors:** User
  - **Steps:** The IME shows preedit text inside the editable surface; the user selects the desired Chinese characters; the composition commits; the user presses Enter.
  - **Outcome:** The composed Chinese text is sent as the user message. No pinyin leakage, cursor jump, or duplicate characters occur.
  - **Covered by:** R2, R3, R4, R34

- F2. **Trigger and select a slash command mid-text**
  - **Trigger:** User types `fix the bug in ` followed by `/`.
  - **Actors:** User
  - **Steps:** The command picker opens; the user types a fuzzy filter and presses Enter on the desired command.
  - **Outcome:** The input becomes `fix the bug in /commit ` with the caret after the trailing space and the argument-hint ghost text visible.
  - **Covered by:** R14, R20, R29

- F3. **Recall and edit a previous prompt**
  - **Trigger:** Input is empty; user presses ArrowUp to recall a sent prompt.
  - **Actors:** User
  - **Steps:** The draft becomes the most recent sent prompt; the user edits it; ArrowDown restores the original empty draft if pressed past the newest entry.
  - **Outcome:** Recalled prompts are editable and original drafts are restored correctly.
  - **Covered by:** R22, R23, R24

- F4. **Composition interrupted by streaming**
  - **Trigger:** User is mid-IME composition when the agent starts streaming and disables the input.
  - **Actors:** User
  - **Steps:** The browser cancels the composition naturally because the surface is no longer editable; streaming shows the Stop button.
  - **Outcome:** When the turn ends and the surface re-enables, typing resumes without a stuck composition state.
  - **Covered by:** R2, R39

- F5. **Accept a completion suggestion**
  - **Trigger:** User has sent similar prompts in the session and types a recognized prefix, then pauses.
  - **Actors:** User
  - **Steps:** A faded completion suggestion appears after the caret; the user presses Tab.
  - **Outcome:** The suggestion text is appended at the caret and the ghost text disappears.
  - **Covered by:** R31, R32

---

## Acceptance Examples

- AE1. **Covers R2, R3, R4, R34.** Given the input is empty, when the user types `nihao` through a Chinese IME and commits the composition to `你好`, then presses Enter, the message `你好` is sent and no pinyin characters leak.

- AE2. **Covers R3, R4.** Given the user is composing pinyin inside the input, when the user presses Enter before the IME commits, the IME commits the current candidate rather than sending a message.

- AE3. **Covers R14, R20.** Given the input contains `fix ` with the caret at the end, when the user types `/`, then `comm`, then presses Enter on `/commit`, the input becomes `fix /commit ` and the argument-hint ghost text `<message>` appears.

- AE4. **Covers R22, R23, R24.** Given three prompts have been sent in this session and the input is empty, when the user presses ArrowUp three times then ArrowDown three times, the draft cycles through the three prompts and returns to empty.

- AE5. **Covers R31, R32.** Given the user has sent `explain the function` twice in this session, when the user types `explain ` and pauses, ghost text `the function` appears after the caret; pressing Tab changes the draft to `explain the function`.

- AE6. **Covers R41.** Given the user copies formatted text from a web page, when they paste it into the input, only the plain text is inserted; no bold, links, or styles survive.

- AE7. **Covers R44, R45.** Given the user pastes a long paragraph, the editable surface grows vertically up to the configured maximum height, then shows a vertical scrollbar; no horizontal scrollbar appears.

- AE8. **Covers R37.** Given the user has typed a multi-line prompt and a turn is streaming, when the user clicks Clear, the draft is emptied but the stream and Stop button remain unchanged.

- AE9. **Covers R5, R6.** Given the user types several lines of text with line breaks, when the draft is read from the editable surface, each line break is represented by a single newline character in the stored value.

- AE10. **Covers R46, R47.** Given the input is empty and unfocused, the placeholder text is visible; when the input receives focus, the placeholder disappears and the editable surface is announced as a textbox by assistive technologies.

---

## Success Criteria

- Chinese, Japanese, and Korean input compose without pinyin/romaji leakage, cursor jumps, duplicated characters, or premature submission.
- All existing prompt-input features remain usable from the user's perspective: pickers, history, completion, ghost text, send/clear/stop, drafts, and toolbar.
- The MarkdownOverlay component, its tests, its metrics hook, and the `prismjs` dependency are fully removed before or as part of this work.
- The component passes the existing composition and prompt-input test suites after adaptation.
- The new input is accessible: screen readers identify it as a textbox, placeholder text is announced, and keyboard navigation works.

---

## Scope Boundaries

**Deferred for later**

- Inline markdown source highlighting or WYSIWYG formatting inside the input.
- File attachments, image paste, or drag-and-drop of files beyond the existing file-paste path.
- Voice input integration.
- Cross-workspace or cross-device draft synchronization.

**Outside this product's identity**

- Replacing the input with CodeMirror 6, TipTap, Lexical, or another rich-text editor library.
- Converting the prompt input into a fully-rendered message composer with message bubbles or inline media.

---

## Dependencies / Assumptions

- The MarkdownOverlay removal work is completed before or merged into this refactor so the prompt input has no overlay when the contentEditable rewrite lands.
- The existing chat-store draft API (`setDraft`, `drafts[sessionId]`) remains the source of truth for the draft value.
- The existing picker components (`CommandPicker`, `FilePicker`, `HistoryPicker`) continue to accept filter values and selection callbacks unchanged.
- Browser `contentEditable` behavior is consistent enough across Chromium, Safari, and Firefox for newline normalization and selection management.
- The n-gram completion model (`useNgramCompletion`) and sent-prompt history (`useSentPrompts`) continue to operate on plain text strings.

---

## Outstanding Questions

### Resolve Before Planning

- None. The architectural direction (contentEditable rewrite after overlay removal) is settled.

### Deferred to Planning

- [Affects R5, R6][Technical] What is the exact normalization rule for block separators across browsers? Should the implementation use `innerText`, `textContent`, or a walk over child nodes?
- [Affects R10–R13][Technical] How are caret offsets computed and restored using the Selection/Range API? Does the implementation need a lightweight range-to-offset helper?
- [Affects R29–R32][Technical] How is ghost text rendered with `contentEditable`? Options include an absolutely positioned mirror layer, a `::after` pseudo-element anchored to the caret, or an inline non-editable span.
- [Affects R46, R47][Technical] Is placeholder text implemented with a CSS `:empty::before` pseudo-element, a separate overlay div, or a background attribute?
- [Affects R41][Technical] Should paste interception use the `beforeinput` event, the `paste` event, or both to strip HTML reliably?
- [Affects R1, R44, R45][Design] What are the exact minimum and maximum heights, padding, and scroll behaviors for the new editable surface?
- [Affects R2, R3][Technical] How is composition state detected for gating submit? Does the implementation still need a composition ref, or can it rely on `event.isComposing` exclusively?
