---
title: Multi-Question Stepper UX
type: feat
status: completed
date: 2026-05-18
origin: docs/brainstorms/2026-05-18-multi-question-stepper-ux-requirements.md
---

# Multi-Question Stepper UX

## Summary

Modify `QuestionView` in `ApprovalSurface.tsx` to render questions one at a time in a stepper when 2+ questions arrive. Add `stepIndex` state, Next/Back/Confirm navigation with step indicator, and per-question preview pane activation. Single-question behavior is unchanged.

---

## Problem Frame

AskUserQuestion allows up to 4 questions in a single call. The current `QuestionView` renders them in a flat `space-y-3` list with no scroll container (without previews) or a cramped 60vh side-by-side layout (with previews). Either way, the user faces a wall of 10-20 interactive elements with no visual hierarchy.

---

## Requirements

- R1. When 2+ questions, render one at a time in a stepper layout
- R2. When 1 question, render directly without stepper chrome
- R3. Display step position indicator (e.g., "1 of 3") in stepper mode
- R4. Next button on every step except the last; disabled until current question answered
- R5. Back button on every step except the first
- R6. Preserve all answers (selections, Other state, Other text) across step navigation
- R7. Final step shows Confirm; single question shows Confirm directly
- R8. Confirm enabled only when every question answered
- R9. Show preview pane when current question's options have previews
- R10. Hide preview pane and use full width when current question has no previews

**Origin flows:** F1 (multi-question stepper), F2 (single-question no stepper)
**Origin acceptance examples:** AE1 (R1, R2), AE2 (R4, R5), AE3 (R6), AE4 (R9, R10)

---

## Scope Boundaries

- Out-of-order question navigation (jumping to any question freely)
- Changing the multi-PendingItem queue system
- Redesigning the approval (non-question) flow
- Changing the AskUserQuestion API contract or QuestionPayload type
- Per-question confirm (each answer committed immediately)
- Keyboard shortcuts for step navigation (ArrowLeft/Right)
- Animations or transitions between steps

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/ApprovalSurface.tsx` — `QuestionView` (lines 275-595): manages `selections`, `otherSelected`, `otherText` keyed by `q.question` string. State naturally persists across step changes with no extra work.
- `src/client/components/ApprovalSurface.tsx` — header `queueLabel` pattern (`1 of N`): reuse this styling for step indicator.
- `src/client/components/ui/button.tsx` — `Button` with `variant="default"` (accent) for Next/Confirm, `variant="secondary"` for Back.
- `src/client/components/PreviewPane.tsx` — takes `html: string | null | undefined`, renders sanitized preview or "No preview available" placeholder.
- Keyboard navigation pattern: ArrowUp/ArrowDown for options within a question, `lastInteractionMode` tracking, `requestAnimationFrame` focus management via `data-option-key` attributes.

### Institutional Learnings

- No `docs/solutions/` directory exists. The approval surface swap plan recommends capturing learnings after work lands.
- The `updatedInput` fix (commit `7fa313a`) auto-fills from cached input when missing — the AskUserQuestion path already supplies `{ questions, answers }` correctly.

---

## Key Technical Decisions

- **Modify QuestionView in place** rather than extracting to a new component. The change adds ~50 lines of stepper logic to an existing ~300-line component. Extraction would add indirection without proportional benefit at this size.
- **`stepIndex` state lives inside QuestionView** — not hoisted to store. The stepper is a presentation concern within the approval surface; the queue system and answer resolution contract are unchanged.
- **Per-question preview computed from `item.questions[stepIndex]`** rather than request-wide `hasPreviews`. This is the core change from the current behavior. The "Chat about this" button remains gated by request-wide `hasPreviews` (any question in the set has a preview).
- **Focus resets to current step on navigation** — a separate `stepIndex`-gated effect (not the requestId-gated answer-clearing effect) re-scopes `findInitialFocus` to the current question and moves focus to the new question's first option.
- **Layout shift accepted** — when navigating from a preview-bearing question to one without, the preview pane disappears and the question area expands to full width. Horizontal scrollbar from a fixed-width container would be worse UX than the layout shift.
- **Navigation buttons stay enabled during resolving** — the user can still navigate back to modify answers while the submit is in-flight. Only Confirm is disabled.

---

## Open Questions

### Resolved During Planning

- State preservation across steps: confirmed free — `selections`, `otherSelected`, `otherText` are keyed by `q.question` (stable string key), so they persist without extra work.
- Step indicator placement: replaces `queueLabel` in the header when in stepper mode (queue label is less relevant during focused question answering).

### Deferred to Implementation

- Exact styling of step transitions (whether to add a subtle fade or instant swap) — low-risk visual choice.

---

## Implementation Units

### U1. Stepper state, rendering, and navigation

**Goal:** Add step-index state to QuestionView, conditionally render one question at a time when 2+ questions, add Next/Back/Confirm buttons and step indicator.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8

**Dependencies:** None

**Files:**
- Modify: `src/client/components/ApprovalSurface.tsx`

**Approach:**

1. Add `stepIndex` state (initialized to `0`) to `QuestionView`.
2. Compute `isStepper = item.questions.length >= 2`.
3. When `!isStepper`, render the single question as-is with a Confirm button (current behavior preserved).
4. When `isStepper`, derive `currentQuestion = item.questions[stepIndex]` and render only that question.
5. Replace the request-wide `hasPreviews` with `currentHasPreviews = currentQuestion.options.some(o => !!o.preview)` (covers R9/R10).
6. Step indicator: render `${stepIndex + 1} of ${item.questions.length}` using the same `text-xs text-text-tertiary` style as `queueLabel`. In stepper mode, replace `queueLabel` with the step indicator in the same position (the queue label is less relevant when the user is focused on a single question).
7. Button bar changes:
   - When `isStepper && stepIndex < last`: show Back (secondary, disabled when `stepIndex === 0`) and Next (default, disabled when current question unanswered). Both remain enabled during `isResolving`.
   - When `isStepper && stepIndex === last`: show Back and Confirm (default, disabled when not all answered). Back remains enabled during `isResolving`.
   - When `!isStepper`: show Confirm only (existing behavior).
8. The existing `allAnswered` check already iterates all questions — it continues to work unchanged.
9. The `handleConfirm` callback already builds answers from all questions — no changes needed.
10. On `item.requestId` change, reset `stepIndex` to `0` in the existing cleanup effect.

**State preservation (R6):** The existing `selections`, `otherSelected`, and `otherText` records are keyed by `q.question`. When the user navigates between steps, these records are not cleared — only `stepIndex` changes. Previous answers are visible when returning to a step because the rendered question reads from the same key. No additional state management is needed.

**Focus management on step change (critical):** Split the existing `useEffect` on `item.requestId` into two separate effects:
1. **requestId-gated effect** (existing): clears `selections`, `otherSelected`, `otherText`, resets `stepIndex` to `0`, resets `focused` and `lastInteractionMode`. Dependencies: `[item.requestId, findInitialFocus]`. Does NOT include `stepIndex`.
2. **stepIndex-gated effect** (new): re-scopes `findInitialFocus` to the current step's question only (search `item.questions[stepIndex]` for a preview-bearing option, falling back to first option). Updates `focused` state, resets `lastInteractionMode` to `'keyboard'`, and moves DOM focus to the first option via `requestAnimationFrame`. Dependencies: `[stepIndex]`.

Do NOT add `stepIndex` to the requestId-gated effect — that would clear all answers on every step navigation, violating R6.

**Keyboard navigation:** ArrowUp/ArrowDown within the current question's options remains unchanged. The wrap-around logic (`total = q.options.length + 1`) operates on the single rendered question. No ArrowLeft/ArrowRight shortcuts for step navigation (out of scope).

**Accessibility (stepper):** Wrap the single-question rendering in a container with `aria-roledescription="step"` and `aria-label` including step position (e.g., "Question 2 of 3"). The existing `aria-live="polite"` on the dialog container covers step changes. On step change, move focus to the first option of the new question via `requestAnimationFrame` (part of the stepIndex-gated effect). The `role="radiogroup"` / `role="group"` on the option container retains `aria-label={q.question}` unchanged.

**Preview pane (R9, R10):** Replace the request-wide `hasPreviews` with per-question `currentHasPreviews` for layout decisions. When `currentHasPreviews` is true, show the side-by-side layout with `PreviewPane`. When false, show the question at full width (layout shift is accepted — horizontal scrollbar from a fixed-width container is worse UX). The `focusedPreview` computation changes from `item.questions[focused.qIdx]` to always use `item.questions[stepIndex]` (since `focused.qIdx` is now always `stepIndex` in stepper mode). The "Chat about this" button remains gated by request-wide `hasPreviews` (any question in the set has a preview), not per-question.

**Patterns to follow:**
- Header `queueLabel` pattern for step indicator styling
- `Button` component with `variant="secondary"` / `variant="default"` for Back/Next
- Existing `selections` / `otherSelected` / `otherText` state shape
- Existing `findInitialFocus` logic, scoped to current question

**Test scenarios:**
- Happy path: 3-question stepper shows question 1 with "1 of 3", Next enabled after selecting option, Back disabled on first step, Confirm on last step submits all answers
- Happy path: 1-question renders directly with Confirm, no Next/Back, no step indicator
- Edge case: navigating Next then Back preserves previous selection
- Edge case: "Other" selected with text on question 1, navigate away and back — text preserved
- Edge case: Confirm disabled when any question unanswered (e.g., question 2 has no selection)
- Edge case: Preview pane visible on question with previews, hidden on question without — layout shifts from side-by-side to full width (accepted trade-off)
- Edge case: Screen reader announces step position on step change, focus moves to first option of new question
- Covers AE1: 3-question shows stepper, 1-question shows direct Confirm
- Covers AE2: unanswered question disables Next, answered enables it; Back enabled on step 2+
- Covers AE3: answer preserved across step navigation
- Covers AE4: per-question preview visibility

**Verification:**
- With 2+ questions, only one question renders at a time with correct step indicator
- With 1 question, no stepper chrome appears
- All answers batch correctly on final Confirm
- Preview pane toggles per-question
- Keyboard ArrowUp/Down navigates options within current question
