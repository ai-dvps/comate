---
title: Picker Width Follows Input - Plan
type: feat
date: 2026-07-02
topic: picker-width-follows-input
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Picker Width Follows Input - Plan

## Goal Capsule

- **Objective:** Make `CommandPicker`, `FilePicker`, and `HistoryPicker` popovers match the width of the `PromptInput` input-card container and update in real time as the parent panel resizes.
- **Product authority:** User-facing UI consistency in the chat input area.
- **Open blockers:** None identified.

---

## Product Contract

*Product Contract preserved from the requirements-only brainstorm artifact. No scope changes were required during planning.*

### Summary

Unify the width of the skill, file, and history pickers with the `PromptInput` input-card container. Each picker popover will align its left edge to the input card's left edge and track the card's width as the surrounding panel changes size.

### Problem Frame

The three pickers currently render through Radix Popover portals with a fixed `w-[360px]` width (`src/client/components/CommandPicker.tsx:177`, `src/client/components/FilePicker.tsx:206`, `src/client/components/HistoryPicker.tsx:176`). The input card below them, however, lives inside `max-w-3xl mx-auto` and stretches or shrinks with the parent panel. This mismatch makes the pickers feel visually detached—too narrow on wide panels and misaligned on narrow ones.

### Key Decisions

- **Width benchmark is the input card itself**, not the outer `px-4` container that wraps `PromptInput`.
- **Left-edge alignment:** each picker popover's left edge aligns to the input card's left edge.
- **No minimum width:** the pickers strictly follow the input card width, even when the panel becomes very narrow.
- **Runtime measurement approach:** measure the input card width with `ResizeObserver` and pass it to the pickers, rather than moving the picker DOM inside the input card. This avoids disturbing the existing focus and keyboard-event chains.
- **Bot-session input bar is out of scope:** those pickers do not appear in bot sessions.

### Requirements

- R1. `CommandPicker` popover width equals the current width of the `PromptInput` input-card container.
- R2. `FilePicker` popover width equals the current width of the `PromptInput` input-card container.
- R3. `HistoryPicker` popover width equals the current width of the `PromptInput` input-card container.
- R4. Each picker popover's left edge aligns horizontally with the left edge of the input-card container.
- R5. When the parent panel resizes and the input-card width changes, all three picker widths update in real time.
- R6. Picker height, maximum height, list scrolling, and keyboard navigation behavior remain unchanged.
- R7. The bot-session input bar is unaffected by this change.

### Scope Boundaries

- Bot-session input bar is not changed.
- `ScopePickerModal` and any other picker components are not changed.
- Picker open direction (`side="top"`) and default alignment behavior are not changed.
- No new responsive breakpoints or mobile-specific layouts are introduced.
- The input card's `max-w-3xl` limit and outer container padding are not changed.

### Acceptance Examples

- AE1. **Wide panel**
  - **Covers:** R1, R2, R3, R4.
  - **Given:** the parent panel is 1200px wide.
  - **When:** any of the three pickers is opened.
  - **Then:** the picker popover is 768px wide (the `max-w-3xl` cap) and its left edge lines up with the input card's left edge.

- AE2. **Narrow panel**
  - **Covers:** R1, R2, R3, R4, R5.
  - **Given:** the parent panel is 480px wide.
  - **When:** any of the three pickers is opened.
  - **Then:** the picker popover matches the input-card width (after accounting for its own padding) and remains left-aligned with the card.

- AE3. **Resize while open**
  - **Covers:** R5.
  - **Given:** a picker is already open at 768px wide.
  - **When:** the user drags the panel narrower to 600px.
  - **Then:** the open picker resizes to match the new input-card width without closing or losing keyboard focus.

### Sources / Research

- `src/client/components/PromptInput.tsx` — renders the input-card container and hosts the three picker buttons.
- `src/client/components/CommandPicker.tsx:177` — fixed `w-[360px]` on `PopoverContent`.
- `src/client/components/FilePicker.tsx:206` — fixed `w-[360px]` on `PopoverContent`.
- `src/client/components/HistoryPicker.tsx:176` — fixed `w-[360px]` on `PopoverContent`.

---

## Planning Contract

### Approach Summary

`PromptInput` will measure the width of the input-card container with `ResizeObserver` and pass that width to `CommandPicker`, `FilePicker`, and `HistoryPicker`. Each picker will replace its fixed `w-[360px]` with a dynamic width derived from that prop. To keep the popover's left edge aligned with the input card's left edge, each picker will use an invisible absolute-positioned `PopoverAnchor` located at the input card's top-left corner, combined with `align="start"` on `PopoverContent`.

### Key Technical Decisions

- **Measure width in `PromptInput`**, not inside each picker, and only in non-bot sessions.
  - There is one input card and three pickers; measuring once avoids duplicate observers and keeps the source of truth where the layout actually lives.
  - Bot sessions do not host these pickers, so `contentWidth` should be left undefined for the bot-session input bar to preserve the current fixed-width fallback.
  - Existing precedent: `src/client/components/ai-elements/compactable-container.tsx` uses the same inline `ResizeObserver` pattern.

- **Pass width via a new optional `contentWidth` prop** on each picker.
  - Keeps the change additive and preserves picker reusability outside `PromptInput` if needed.
  - When `contentWidth` is absent, fall back to the current `w-[360px]` behavior.

- **Use an invisible anchor for left-edge alignment** rather than `alignOffset` math.
  - The toolbar button that triggers a picker is not at the input card's left edge, so `align="start"` alone would align the popover to the button.
  - Each picker renders a zero-size `<span className="absolute top-0 left-0 w-0 h-0" />` as its `PopoverAnchor`. Because the picker is rendered inside the `relative` input card, this span sits at the card's top-left corner and becomes the alignment reference.

- **Set `boxSizing: 'border-box'` on `PopoverContent`** when a dynamic width is applied.
  - The Radix `PopoverContent` has `p-2` padding and a `border`, so `border-box` ensures the declared width matches the input card's `offsetWidth` without extra subtraction.

- **Do not extract a shared `useResizeObserver` hook** for this change.
  - The repo currently uses inline `ResizeObserver` in the two `compactable-*` components and does not have a hook abstraction. Adding one is outside the scope of this UI tweak and would create a new pattern without team buy-in.

### Assumptions

- The input card's `relative` positioning and the picker's placement inside it remain stable. If the DOM structure changes later, the invisible anchor's positioning assumption may need revisiting.
- `ResizeObserver` is available in the Tauri WebView and in the Playwright/browser test environments. The repo already mocks it globally in `vitest.setup.ts`.
- The popover's default `side="top"` and the new `align="start"` do not conflict with viewport collision handling in a way that would shift the left edge at small widths.
- Radix `PopoverContent` forwards `style` props to the outer positioned element. If implementation shows it does not, the width must be applied through a wrapper or className instead.

### Sequencing

1. Add width measurement and prop drilling in `PromptInput`.
2. Update each picker to accept `contentWidth`, set dynamic width on `PopoverContent`, and render the invisible anchor for left-edge alignment.
3. Add/update tests to verify the dynamic width and alignment behavior.
4. Run lint and the relevant client test suites.

---

## Implementation Units

### U1. Measure input-card width in `PromptInput`

- **Goal:** Track the input-card container width in real time and make it available to the three pickers.
- **Requirements:** R1, R2, R3, R5.
- **Dependencies:** None.
- **Files:**
  - `src/client/components/PromptInput.tsx`
- **Approach:**
  - Add a `useRef<HTMLDivElement>` on the input-card container (the `relative bg-surface border border-border rounded-xl` div).
  - Add a `useState<number | undefined>` for the measured width.
  - In a `useEffect`, create a `ResizeObserver` that records `el.offsetWidth`. Observe the input card, call the measure callback immediately, and disconnect on cleanup.
  - Pass the measured width to `CommandPicker`, `FilePicker`, and `HistoryPicker` as a new optional `contentWidth` prop only when not in bot-session mode; in bot-session mode leave the prop undefined so the pickers fall back to `w-[360px]` (R7).
- **Patterns to follow:** Mirror the inline `ResizeObserver` usage in `src/client/components/ai-elements/compactable-container.tsx` (`observer.observe`, `measure`, `observer.disconnect` in cleanup).
- **Test scenarios:**
  - Happy path: after render in a browser test, the picker popover's computed width matches the input card's width.
  - Edge case: when the input card width is zero or unmeasured, pickers fall back to their original fixed width.
- **Verification:** The three pickers receive a numeric `contentWidth` equal to the input card's `offsetWidth` in the browser test environment.

### U2. Update `CommandPicker` for dynamic width and left-edge alignment

- **Goal:** Make the command popover width match the input card and align its left edge to the card's left edge.
- **Requirements:** R1, R4, R6.
- **Dependencies:** U1.
- **Files:**
  - `src/client/components/CommandPicker.tsx`
- **Approach:**
  - Add an optional `contentWidth?: number` prop.
  - Replace the fixed `w-[360px]` class on `PopoverContent` with `w-full`, and apply `style={{ width: contentWidth, boxSizing: 'border-box' }}` only when `contentWidth` is defined; when undefined, keep `w-[360px]`.
  - The picker already defaults to `align="start"` and `PromptInput` passes `align="start"`; verify this is not overridden.
  - Replace the existing `<PopoverAnchor asChild>{anchor}</PopoverAnchor>` with an invisible `<PopoverAnchor asChild><span className="absolute top-0 left-0 w-0 h-0" aria-hidden="true" /></PopoverAnchor>`, then render `{anchor}` (the trigger button) as a sibling after the anchor span. Because the picker is rendered inside the relative input card, the zero-size span sits at the card's top-left corner and becomes the alignment reference. The button still opens/closes the picker via its existing `onClick` handler in `PromptInput`.
- **Patterns to follow:** Use `cn()` from `src/client/components/ui/utils.ts` if combining conditional classes. Preserve existing keyboard navigation and focus behavior.
- **Test scenarios:**
  - Happy path: when `contentWidth` is provided, the popover's rendered width equals the prop value.
  - Edge case: when `contentWidth` is undefined, the popover keeps the original 360px width.
- **Verification:** Browser test asserts the command picker popover width equals the input card width when opened via the toolbar button.

### U3. Update `FilePicker` for dynamic width and left-edge alignment

- **Goal:** Make the file popover width match the input card and align its left edge to the card's left edge.
- **Requirements:** R2, R4, R6.
- **Dependencies:** U1.
- **Files:**
  - `src/client/components/FilePicker.tsx`
- **Approach:**
  - Same pattern as U2: add `contentWidth?: number`, conditionally apply dynamic width with `boxSizing: 'border-box'`, and replace the existing `<PopoverAnchor asChild>{anchor}</PopoverAnchor>` with an invisible anchor span at the input card's top-left corner. Render `{anchor}` as a sibling after the anchor span.
- **Patterns to follow:** Match the conditional-width logic from U2 so the three pickers behave identically.
- **Test scenarios:**
  - Happy path: `@` trigger opens the file picker at the input-card width.
  - Happy path: clicking the Files toolbar button opens the picker at the input-card width.
  - Edge case: undefined `contentWidth` falls back to 360px.
- **Verification:** Browser test asserts the file picker popover width equals the input card width for both trigger paths.

### U4. Update `HistoryPicker` for dynamic width and left-edge alignment

- **Goal:** Make the history popover width match the input card and align its left edge to the card's left edge.
- **Requirements:** R3, R4, R6.
- **Dependencies:** U1.
- **Files:**
  - `src/client/components/HistoryPicker.tsx`
- **Approach:**
  - Same pattern as U2 and U3: add `contentWidth?: number`, conditionally apply dynamic width with `boxSizing: 'border-box'`, and replace the existing `<PopoverAnchor asChild>{anchor}</PopoverAnchor>` with an invisible anchor span at the input card's top-left corner. Render `{anchor}` as a sibling after the anchor span.
- **Patterns to follow:** Match the conditional-width logic from U2/U3.
- **Test scenarios:**
  - Happy path: `Alt+H` opens the history picker at the input-card width.
  - Happy path: clicking the History toolbar button opens the picker at the input-card width.
  - Edge case: undefined `contentWidth` falls back to 360px.
- **Verification:** Browser test asserts the history picker popover width equals the input card width for both trigger paths.

### U5. Add tests for dynamic picker width

- **Goal:** Verify the width-following behavior across all three pickers and preserve existing behavior.
- **Requirements:** R1, R2, R3, R4, R5, R6.
- **Dependencies:** U1, U2, U3, U4.
- **Files:**
  - `src/client/components/PromptInput.browser.test.tsx`
  - `src/client/components/CommandPicker.test.tsx` (create if missing)
  - `src/client/components/FilePicker.test.tsx` (create if missing)
  - `src/client/components/HistoryPicker.test.tsx`
- **Approach:**
  - Extend the existing `PromptInput.browser.test.tsx` with assertions that each picker's popover width matches the input-card width when opened.
  - For unit-level coverage, add or update jsdom tests for each picker that assert the popover receives the dynamic width when `contentWidth` is provided and falls back when it is not. Check whether `CommandPicker.test.tsx` and `FilePicker.test.tsx` exist; create them only if they do not.
  - Mock `ResizeObserver` if needed; the repo already provides a global mock in `vitest.setup.ts`.
- **Execution note:** Prefer browser tests for the actual width-follows-input-card assertion because jsdom does not compute layout reliably. Use jsdom tests for prop-to-style wiring only.
- **Test scenarios:**
  - Happy path (browser): open each picker and assert `popover.offsetWidth === inputCard.offsetWidth`.
  - Edge case (jsdom): with `contentWidth={500}`, the popover's `style.width` is `"500px"`; with `contentWidth` omitted, the fixed width class is present.
  - Regression: existing keyboard navigation, selection, and close behavior still pass.
- **Verification:** `npm run test:client` passes for the modified/added test files.

---

## Verification Contract

- Run `npm run lint` after all file changes.
- Run `npm run test:client` for jsdom-based component tests.
- Run `npm run test:browser` for Playwright-based PromptInput tests.
- Manual smoke check: open each picker in the dev app at a wide panel width (≈768px picker), a narrow panel width (<400px picker), and while resizing, confirming no visual tearing or focus loss.

---

## Definition of Done

- `CommandPicker`, `FilePicker`, and `HistoryPicker` popovers render at the input-card width in real time.
- Each picker's left edge aligns with the input card's left edge.
- When `contentWidth` is not provided, each picker retains its original 360px width (backward-compatible fallback).
- Bot-session input bar is unaffected.
- Lint passes and all modified/added tests pass.
- No dead code, stray logs, or temporary measurement UI remain in the diff.

---

## Risks & Dependencies

- **ResizeObserver loop risk:** Measuring `offsetWidth` and writing it to React state could theoretically cause a loop if the state update changes the layout. The input card's width is driven by its parent, not by the picker's state, so this is low risk. If a loop appears, switch the measurement to `clientWidth` or debounce the observer callback.
- **Portal positioning edge case:** Radix may flip or shift the popover to keep it in the viewport at very narrow widths. This should not break left-edge alignment, but it may introduce a small `alignOffset` at the collision boundary. Monitor the narrow-width smoke check.
- **Prior institutional learning:** A prior workspace-tabs feature removed `ResizeObserver` in favor of a simpler CSS overflow pattern because of complexity. This change is smaller and measurement-boundary-safe, but if the implementation grows beyond one observer, reconsider a CSS-first approach.

---

## Sources / Research

- `src/client/components/PromptInput.tsx` — parent component and input-card container.
- `src/client/components/CommandPicker.tsx` — fixed `w-[360px]` popover.
- `src/client/components/FilePicker.tsx` — fixed `w-[360px]` popover.
- `src/client/components/HistoryPicker.tsx` — fixed `w-[360px]` popover.
- `src/client/components/ai-elements/compactable-container.tsx` — existing inline `ResizeObserver` pattern.
- `src/client/components/ai-elements/compactable-text.tsx` — additional inline `ResizeObserver` pattern.
- `src/client/components/PromptInput.browser.test.tsx` — existing browser test suite to extend.
- `src/client/components/HistoryPicker.test.tsx` — existing jsdom test suite to extend.
- `docs/plans/2026-05-24-003-feat-chrome-style-workspace-tabs-plan.md` — prior decision to remove `ResizeObserver` in favor of simpler CSS when complexity grows.
- `docs/plans/2026-05-29-006-fix-workspace-dropdown-positioning-plan.md` — prior use of Radix `side`/`align`/`sideOffset` to match existing visual placement.
