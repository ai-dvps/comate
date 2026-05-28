---
title: Fix AskUserQuestion tool header summary
type: fix
status: completed
date: 2026-05-28
---

# Fix AskUserQuestion tool header summary

## Summary

Fix the `summarizeToolInput` utility so `AskUserQuestion` tool headers display the actual question text instead of `questions: [object Object]`. Extract the duplicated function to a shared module and add unit test coverage.

## Requirements

- R1. `AskUserQuestion` tool headers show human-readable question text extracted from the `questions` array.
- R2. The `summarizeToolInput` function exists in a single shared location, imported by both `MessageList` and `VirtualizedMessageList`.
- R3. The extracted function has unit tests covering the `AskUserQuestion` shape and existing primary-key fallbacks.

## Scope Boundaries

- Does not change `AskUserQuestion` tool behavior, rendering, or the `AskUserQuestionRenderer` component.
- Does not add summary handling for other tools beyond fixing the array-shape fallback bug.
- Does not set up a project-wide test framework beyond what's needed for the extracted utility.

## Key Technical Decisions

- **Extract to shared utility**: `summarizeToolInput` is duplicated across two message-list components. Extracting to `src/client/lib/summarize-tool-input.ts` removes the duplication and gives the function a natural home for tests.
- **Handle `questions` array before fallback**: When the input object has a `questions` array, extract the first element's `question` string (falling back to `header`) instead of hitting the generic `Object.keys(obj)[0]` fallback that stringifies the array to `[object Object]`.

## Implementation Units

### U1. Extract and fix `summarizeToolInput`

**Goal:** Move the duplicated `summarizeToolInput` function to a shared module and add `AskUserQuestion`-specific handling.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Create: `src/client/lib/summarize-tool-input.ts`
- Modify: `src/client/components/MessageList.tsx`
- Modify: `src/client/components/VirtualizedMessageList.tsx`

**Approach:**
- Copy the existing `summarizeToolInput` implementation into the new shared module.
- Before the fallback branch that iterates `primaryKeys`, add a branch that checks for `questions` array:
  - Verify `Array.isArray(obj.questions)` and `obj.questions.length > 0`.
  - Extract the first question object, reading `question` (string) or falling back to `header` (string).
  - Truncate to 120 chars and return.
- Export the function from the new module.
- In both `MessageList.tsx` and `VirtualizedMessageList.tsx`, remove the local `summarizeToolInput` definition and import from `src/client/lib/summarize-tool-input`.

**Patterns to follow:**
- Existing truncation pattern (`value.length > 120 ? value.slice(0, 120) + '…' : value`).
- Existing `src/client/lib/` convention for shared client utilities.

**Test scenarios:**
- Test expectation: none — behavior will be verified in U2.

**Verification:**
- Both `MessageList.tsx` and `VirtualizedMessageList.tsx` compile and import from the shared module.
- The shared module exports `summarizeToolInput` with the new `questions` handling.

---

### U2. Add unit tests for `summarizeToolInput`

**Goal:** Provide test coverage for the extracted function, including the new `AskUserQuestion` path and existing behavior.

**Requirements:** R3

**Dependencies:** U1

**Files:**
- Create: `src/client/lib/summarize-tool-input.test.ts`

**Approach:**
- Add a minimal test file using Node's built-in `node:test` runner (no additional dependencies needed; the project already uses ESM via `"type": "module"`).
- Test the following scenarios:
  - `null` / `undefined` input returns `undefined`.
  - Object with `description` key returns the description string.
  - Object with a known `primaryKey` (e.g., `command`) returns that value.
  - Object with `questions` array containing question objects returns the first question's `question` text.
  - Object with `questions` array where the first element lacks `question` but has `header` returns the `header`.
  - Object with `questions` array where elements are malformed falls back gracefully (e.g., returns `undefined` or a safe fallback).
  - Generic object without known keys falls back to `firstKey: value` behavior.

**Patterns to follow:**
- ESM import style (`import { describe, it } from 'node:test'` and `import assert from 'node:assert'`).

**Test scenarios:**
- Happy path: input `{ questions: [{ question: "What would you like to do?" }] }` → returns `"What would you like to do?"`.
- Happy path: input `{ questions: [{ header: "Choose an action", question: "What next?" }] }` → returns `"What next?"` (prefers `question` over `header`).
- Edge case: input `{ questions: [{ header: "Choose an action" }] }` → returns `"Choose an action"` (falls back to `header`).
- Edge case: input `{ questions: [] }` → falls back to generic object handling (e.g., `"questions: "` or next available key).
- Edge case: input `{ questions: [{}] }` → falls back to generic object handling (no usable text in first question).
- Happy path (existing): input `{ command: "git status" }` → returns `"git status"`.
- Happy path (existing): input `{ description: "Run tests" }` → returns `"Run tests"`.

**Verification:**
- Tests can be executed with `node --test src/client/lib/summarize-tool-input.test.ts`.
- All assertions pass.

