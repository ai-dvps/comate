---
title: Move Prompt Input Toolbar to Bottom Row with Send Button - Plan
type: refactor
date: 2026-07-16
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Move Prompt Input Toolbar to Bottom Row with Send Button

## Goal Capsule

- **Objective:** Move the prompt-input toolbar controls from above the text box to the bottom action row, sharing a row with the Send button.
- **Authority:** User request (direct).
- **Stop conditions:** Toolbar controls render in the bottom row; Send remains right-aligned; bot-session layout unchanged; tests pass.
- **Execution profile:** Lightweight, single-component layout refactor.
- **Tail ownership:** Implementer handles any visual polish discovered during review.

## Product Contract

### Summary

Consolidate the two toolbar rows in `PromptInput` so the Skills, Files, History, Provider, Fast mode, and Approval mode controls live in the same bottom row as Clear/Stop/Send.

### Problem Frame

The current input card shows a toolbar above the editable area and a separate action row below it. The user wants the controls on one row with Send, reducing vertical footprint and matching the bottom-action convention.

### Requirements

- R1. Move the existing top toolbar (Skills, Files, History, Provider selector, Fast mode toggle, Approval mode toggle) into the bottom toolbar row.
- R2. Keep the Send button on the far right of the bottom row.
- R3. Preserve the Clear and Stop buttons in the bottom row.
- R4. Leave the bot-session info bar unchanged; bot sessions do not display the normal input toolbar.
- R5. Preserve all existing keyboard shortcuts, picker behavior, and disabled states.
- R6. Keep all existing i18n labels; no new copy needed.

### Scope Boundaries

- **In scope:** Layout change inside `src/client/components/PromptInput.tsx` and its browser tests.
- **Out of scope:** Changing control behavior, adding/removing controls, theming changes, bot-session layout changes.

## Planning Contract

### Key Technical Decisions

- **KTD1. Single bottom toolbar with flex groups.** The existing bottom row already holds Clear/Stop/Send. Moving all controls into that row uses established patterns and keeps Send right-aligned via `justify-between` or a left-side flex group plus spacer.
- **KTD2. Preserve picker anchor structure.** `CommandPicker`, `FilePicker`, and `HistoryPicker` receive their trigger buttons as `anchor` props. Their popover alignment depends on the relative input-card container, not the anchor's row. Keeping the anchor nodes intact avoids breaking picker positioning.
- **KTD3. No i18n changes.** All toolbar labels and titles already exist in `src/client/i18n/{en,zh-CN}/chat.json`.

### Assumptions

- The user wants the controls in the same physical row as Send, not a new row below Send.
- Control order left-to-right can stay as-is (Skills → Files → History → spacer → Provider → Fast → Approval → Clear/Stop → Send).

## Implementation Units

### U1. Consolidate toolbars in PromptInput.tsx

**Goal:** Move the top toolbar controls into the bottom action row and remove the empty top toolbar.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** None

**Files:** `src/client/components/PromptInput.tsx`

**Approach:**
Move the `CommandPicker`, `FilePicker`, `HistoryPicker`, `ProviderSelector`, `FastModeToggle`, and `ApprovalModeToggle` nodes from the top toolbar into the bottom toolbar container. Keep the left-side picker group, a `flex-1` spacer, the provider/toggle group, and the right-side Clear/Stop/Send group in one row. Use `flex items-center justify-between` or equivalent so Send stays on the far right. Remove the now-empty top toolbar `<div>`. Preserve all event handlers, disabled states, refs, and `contentWidth` measurements. Keep the bot-session branch (`isBotSession === true`) completely unchanged.

**Patterns to follow:** Existing Tailwind toolbar classes in `PromptInput.tsx`; `cn()` utility from `src/client/components/ui/utils.ts` for any conditional classes.

**Test scenarios:**

- **Happy path:** Render normal session; Skills, Files, Provider, Fast mode, Approval mode, and Send buttons are all present.
- **Edge case:** Render with empty input; Clear button is absent, Send is disabled, other controls still render.
- **Edge case:** Render while streaming; Stop button replaces Send, other controls disable appropriately.
- **Edge case:** Render bot session; normal input toolbar is absent, bot info bar and Provider selector still render.

**Verification:** Component renders without errors; visual inspection shows all controls in one bottom row.

### U2. Update PromptInput browser tests

**Goal:** Add layout assertions for the consolidated toolbar and guard picker alignment.

**Requirements:** R1, R2, R5

**Dependencies:** U1

**Files:** `src/client/components/PromptInput.browser.test.tsx`

**Approach:**
Add a test that the Skills and Files buttons share a common ancestor with the Send button (i.e., are in the same toolbar row). Keep existing tests for bot sessions, placeholder, typing, IME, and picker behavior. If `inputCardElement()` helper breaks due to DOM nesting changes, update it to use a stable data attribute or the card ref.

**Patterns to follow:** Existing browser test patterns using `@testing-library/react` and `@vitest/browser/context`.

**Test scenarios:**

- **Happy path:** Skills, Files, History, Provider, Fast, Approval, and Send are all descendants of the bottom toolbar container.
- **Integration scenario:** Open Command picker; popover width and left alignment still match the input card.
- **Edge case:** Bot session still does not render the normal-session toolbar controls.

**Verification:** `npm run test:browser -- src/client/components/PromptInput.browser.test.tsx` passes.

### U3. Responsive layout polish

**Goal:** Prevent control overflow on narrow viewports.

**Requirements:** R1, R2

**Dependencies:** U1

**Files:** `src/client/components/PromptInput.tsx`

**Approach:**
Evaluate whether the History/Skills/Files labels need to hide below `sm` to avoid crowding Send. If so, add `hidden sm:inline` to their text spans while keeping icons visible. Ensure `ProviderSelector` uses `hideNameBelowSm` to match existing behavior. Avoid changing control sizes or introducing new breakpoints unless necessary.

**Patterns to follow:** Existing responsive patterns in `ProviderSelector.tsx` and `FastModeToggle.tsx`.

**Test scenarios:**

- **Happy path:** At desktop width, labels are visible and controls do not wrap.
- **Edge case:** At narrow width, labels hide and icons remain; Send stays accessible.

**Verification:** Manual resize test in browser dev tools; no layout wrapping or clipped buttons.

## Verification Contract

| Gate | Command / Check | Applies to |
|---|---|---|
| Lint | `npm run lint` | All units |
| Browser tests | `npm run test:browser -- src/client/components/PromptInput.browser.test.tsx` | U1, U2 |
| Client unit tests | `npm run test:client` | U1 (no direct tests, but ensures no regressions) |
| Visual smoke | Run `npm run dev:client` and exercise normal session input | U1, U3 |

## Definition of Done

- Toolbar controls render in the bottom row with Send; top toolbar is gone.
- Bot-session layout is untouched.
- All existing picker behaviors and keyboard shortcuts work.
- Browser tests pass and include layout assertions.
- No new i18n keys are introduced.
- `npm run lint` passes.
- Any experimental layout attempts are removed from the diff.
