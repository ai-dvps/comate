---
title: Remove markdown syntax highlight overlay from prompt input
type: refactor
date: 2026-06-15
---

# Remove markdown syntax highlight overlay from prompt input

## Summary

Remove the live markdown source-highlighting overlay from the prompt input box. The overlay (`MarkdownOverlay`) sits behind the textarea and is synchronized via `useTextareaMetrics`, but it has introduced caret-positioning, IME composition, and text-color issues that block reliable user input. After removal, the prompt input will be a plain auto-resizing textarea with no syntax highlighting.

## Problem Frame

The prompt input currently renders a `MarkdownOverlay` component behind the textarea to highlight markdown syntax (bold, italic, code, headings, etc.). The textarea text is made transparent and the overlay shows the styled source. This approach has caused several input-blocking bugs:

- IME composition state gets out of sync with the overlay visibility flag.
- Cursor jumps to the end of the line when typing in the middle of text.
- Transparent textarea text complicates caret visibility and selection styling.

The overlay is non-essential for the core chat experience and is cheaper to remove than to keep patching.

## Requirements

R1. The prompt input must no longer render a markdown syntax-highlighting overlay.
R2. The prompt input must remain an auto-resizing, multi-line textarea.
R3. Existing picker, history, completion, IME recovery, and cursor-preservation behavior must continue to work.
R4. All code, styles, tests, and dependencies that exist only to support the overlay must be removed.

## Key Technical Decisions

K1. Delete `MarkdownOverlay` component and tests rather than disabling it behind a flag. Rationale: the user wants the feature gone because it causes input problems; keeping dead code increases maintenance surface.
K2. Delete `useTextareaMetrics` hook and inline the auto-resize behavior directly in `PromptInput` (or replace with a minimal equivalent). Rationale: the hook's only purpose was to keep the overlay's dimensions and scroll in sync with the textarea; without the overlay, it is unnecessary.
K3. Remove `prismjs` and `@types/prismjs` dependencies. Rationale: no other source file uses Prism after `MarkdownOverlay` is deleted.

## Implementation Units

### U1. Remove overlay integration from PromptInput

- **Goal:** Strip all MarkdownOverlay usage and overlay-related state from the prompt input component.
- **Requirements:** R1, R3
- **Dependencies:** none
- **Files:**
  - `src/client/components/PromptInput.tsx`
- **Approach:**
  - Remove `MarkdownOverlay` import.
  - Remove `overlayRef`, `overlayHidden` state, and the textarea-disabled reset effect that clears `overlayHidden`.
  - Remove `useTextareaMetrics` call.
  - Remove the `<MarkdownOverlay>` JSX and the wrapping `md-input-container` div class.
  - Remove `onScroll` synchronization logic that copies scroll position to the overlay.
  - Remove `setOverlayHidden(true)` from `onCompositionStart` and `setOverlayHidden(false)` from `onCompositionEnd`.
  - Keep the IME composition ref and cursor-preservation logic intact.
- **Patterns to follow:** Preserve existing event handler structure for `onChange`, `onCompositionStart`, `onCompositionEnd`, and `handleKeyDown`; only delete overlay-specific lines.
- **Test scenarios:**
  - Happy path: `PromptInput` renders a textarea and the toolbar buttons.
  - Edge case: `PromptInput` renders with no element matching `.md-overlay`.
  - Integration scenario: IME composition recovery still works after the overlay is gone.
  - Integration scenario: Cursor preservation still works after the overlay is gone.
- **Verification:** `PromptInput.test.tsx` and `PromptInput.composition.test.tsx` pass without overlay assertions.

### U2. Delete MarkdownOverlay component and its tests

- **Goal:** Remove the now-unused overlay component and its test file.
- **Requirements:** R4
- **Dependencies:** U1
- **Files:**
  - `src/client/components/MarkdownOverlay.tsx`
  - `src/client/components/MarkdownOverlay.test.tsx`
- **Approach:** Delete both files. No replacement component is needed.
- **Test scenarios:**
  - Test expectation: none — the component is deleted.
- **Verification:** The files no longer exist; no imports reference `MarkdownOverlay`.

### U3. Delete useTextareaMetrics hook

- **Goal:** Remove the hook whose only consumer was the prompt input overlay sync.
- **Requirements:** R4
- **Dependencies:** U1
- **Files:**
  - `src/client/hooks/useTextareaMetrics.ts`
- **Approach:** Delete the file. The auto-resize behavior it provided must be replaced (see U4).
- **Test scenarios:**
  - Test expectation: none — the hook is deleted.
- **Verification:** The file no longer exists; no imports reference `useTextareaMetrics`.

### U4. Restore textarea auto-resize without the overlay

- **Goal:** Keep the textarea growing as the user types, now without relying on the overlay.
- **Requirements:** R2, R3
- **Dependencies:** U1, U3
- **Files:**
  - `src/client/components/PromptInput.tsx`
- **Approach:**
  - Add a minimal `useLayoutEffect` in `PromptInput` that sets `textarea.style.height = 'auto'` then `textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`` whenever `input` or `maxHeight` changes.
  - Reuse the existing `maxHeight` calculation and `textareaRef`.
  - Do not introduce a new hook file unless it becomes needed elsewhere.
- **Patterns to follow:** Match the existing resize behavior from `useTextareaMetrics` but drop the overlay branch.
- **Test scenarios:**
  - Happy path: Typing a long prompt increases textarea height up to `maxHeight`.
  - Edge case: Clearing the input resets the textarea to its minimum height.
  - Edge case: The textarea does not exceed `maxHeight`.
- **Verification:** Existing composition tests and a visual/manual check confirm the textarea still grows.

### U5. Remove overlay CSS

- **Goal:** Delete CSS rules that made the textarea transparent and styled the overlay.
- **Requirements:** R1, R4
- **Dependencies:** U1, U2
- **Files:**
  - `src/client/index.css`
- **Approach:** Remove the entire `/* PromptInput mirror-div markdown source highlighting */` block and all `.md-overlay` rules. Keep other styles untouched.
- **Test scenarios:**
  - Test expectation: none — visual verification only.
- **Verification:** Textarea text is visible with the default `text-text-primary` color; no `.md-overlay` selectors remain.

### U6. Remove prismjs dependency

- **Goal:** Remove the markdown tokenizer dependency that is no longer used.
- **Requirements:** R4
- **Dependencies:** U2
- **Files:**
  - `package.json`
  - `package-lock.json`
- **Approach:**
  - Remove `prismjs` and `@types/prismjs` from `package.json` dependencies.
  - Run the package manager to update `package-lock.json`.
- **Test scenarios:**
  - Test expectation: none — dependency cleanup.
- **Verification:** `npm ls prismjs` reports it is not installed; the app still builds and tests pass.

## Scope Boundaries

### In scope

- Removing `MarkdownOverlay`, `useTextareaMetrics`, related styles, tests, and dependencies.
- Preserving textarea auto-resize and all non-overlay prompt input behavior.

### Out of scope

- Redesigning the prompt input toolbar, pickers, or ghost text.
- Adding a different syntax-highlighting mechanism.
- Changing message rendering or code-block highlighting elsewhere in the app.

### Deferred to follow-up work

- If future designs want lightweight formatting hints, evaluate an uncontrolled `contentEditable` or a separate preview mode rather than reintroducing a transparent-overlay pattern.

## Risks & Dependencies

- **Risk:** Auto-resize behavior regresses if the inline replacement does not handle `maxHeight`, empty value, or rapid value changes exactly like `useTextareaMetrics` did.
  - **Mitigation:** Add explicit test coverage for textarea height and keep the same resize algorithm.
- **Risk:** Removing `prismjs` from `package.json` without regenerating the lockfile leaves stale entries.
  - **Mitigation:** Run `npm install` (or the repo's preferred install command) after editing `package.json`.

## Sources / Research

- Existing overlay consumer: `src/client/components/PromptInput.tsx` (`MarkdownOverlay` import, `overlayRef`, `overlayHidden`, `useTextareaMetrics`).
- Overlay component: `src/client/components/MarkdownOverlay.tsx`.
- Overlay sync hook: `src/client/hooks/useTextareaMetrics.ts`.
- Overlay styles: `src/client/index.css` (`.md-input-container`, `.md-overlay` rules).
- Dependency usage scan: `prismjs` is only imported by `src/client/components/MarkdownOverlay.tsx`.
