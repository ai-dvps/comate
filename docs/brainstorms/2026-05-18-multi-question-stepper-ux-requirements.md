---
date: 2026-05-18
topic: multi-question-stepper-ux
---

# Multi-Question Stepper UX

## Summary

When AskUserQuestion delivers 2+ questions, render them one at a time in a stepper with Next/Back navigation and a single batch Confirm on the final step. Single questions skip stepper chrome. The preview pane appears per-question when the current question's options have previews.

---

## Problem Frame

AskUserQuestion allows up to 4 questions in a single call. When 2+ questions arrive, QuestionView renders them in a flat vertical list (`space-y-3`). Each question has 2-4 options plus an "Other" entry — easily 10-20 interactive elements stacked together.

Without previews, the container has no max-height or scroll (`<div className="mb-3">{questionList}</div>`), so content overflows the visible area. With previews, a 60vh side-by-side layout crams all questions into half the available width. In both cases the user sees a wall of options with no visual hierarchy or sense of progress.

---

## Key Flows

- F1. Multi-question stepper
  - **Trigger:** AskUserQuestion arrives with 2+ questions
  - **Steps:** Show first question with step indicator → user selects an answer → Next becomes enabled → user taps Next → next question appears → ... → final question shows Confirm → user taps Confirm → all answers batched and sent
  - **Outcome:** All answers submitted as a single batch to `onAnswerQuestion`
  - **Covered by:** R1, R3, R4, R5, R7, R8

- F2. Single-question (no stepper)
  - **Trigger:** AskUserQuestion arrives with exactly 1 question
  - **Steps:** Show the question directly with Confirm button → user answers → taps Confirm → answer sent
  - **Outcome:** Answer submitted immediately
  - **Covered by:** R2, R7

---

## Requirements

**Stepper display**

- R1. When AskUserQuestion contains 2+ questions, render one question at a time in a stepper layout.
- R2. When AskUserQuestion contains exactly 1 question, render it directly without stepper navigation (same as current single-question behavior).
- R3. Display a step position indicator (e.g., "1 of 3") in the header area when in stepper mode.

**Navigation**

- R4. Provide a Next button on every step except the last. Next is disabled until the current question has a valid answer (selected option, or Other with non-empty text).
- R5. Provide a Back button on every step except the first.
- R6. Preserve all answers (selected options, Other state, Other text) when navigating between steps.

**Confirmation**

- R7. The final step shows a Confirm button that submits all answers as a batch. When there is only 1 question, Confirm appears directly (no Next/Back).
- R8. Confirm is enabled only when every question has been answered.

**Preview pane**

- R9. When the current question's options include previews, show the preview pane for that question.
- R10. When the current question's options have no previews, hide the preview pane and give the question the full available width.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given a 3-question AskUserQuestion, the surface shows question 1 with a "1 of 3" indicator, Next and Back (Back disabled). Given a 1-question AskUserQuestion, the surface shows the question with Confirm and no step indicator.
- AE2. **Covers R4, R5.** Given the user is on step 2 of 3 with an unanswered question, Next is disabled and Back is enabled. After selecting an option, Next becomes enabled.
- AE3. **Covers R6.** Given the user answers question 1 as "Option A", taps Next, answers question 2 as "Option B", taps Back, question 1 still shows "Option A" selected.
- AE4. **Covers R9, R10.** Given question 1 has preview-bearing options and question 2 has none, step 1 shows the preview pane alongside the question, and step 2 hides the preview pane and uses the full width.

---

## Success Criteria

- A user faced with 4 questions never has to scroll past hidden content or lose sight of which question they're answering.
- Each question gets the full visual space it needs — no side-by-side cramming when previews aren't relevant.
- Existing single-question behavior is unchanged.
- A downstream plan can implement this without inventing navigation, state, or preview behavior.

---

## Scope Boundaries

- Out-of-order question navigation (jumping to any question freely)
- Changing the multi-PendingItem queue system (one-by-one processing of separate approvals/questions)
- Redesigning the approval (non-question) flow in ApprovalSurface
- Changing the AskUserQuestion API contract, data model, or QuestionPayload type
- Per-question confirm (each answer committed immediately)

---

## Key Decisions

- One-at-a-time stepper over scrollable container or accordion: stepper gives each question full space and a clear completion path without requiring the user to discover scroll.
- Final batch Confirm over per-question confirm: preserves the existing onAnswerQuestion contract (single call with all answers) and avoids partial-submission ambiguity.
- Per-question preview over always-side-by-side: wastes no space on a preview pane when the current question doesn't need it.

---

## Key Files

- `src/client/components/ApprovalSurface.tsx` — QuestionView component (lines 275-595)
- `src/client/types/message.ts` — QuestionPayload type
