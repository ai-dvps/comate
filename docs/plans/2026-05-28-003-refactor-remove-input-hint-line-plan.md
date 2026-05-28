---
title: Remove input hint line from chat input
type: refactor
status: completed
date: 2026-05-28
---

# Remove input hint line from chat input

## Summary

Remove the helper text displayed below the chat prompt input and clean up the associated i18n translation keys.

## Requirements

- R1. The hint line below the chat input is no longer rendered.
- R2. Unused `inputHint` translation keys are removed from all locale files.

## Scope Boundaries

- Does not change the textarea placeholder or any other input behavior.
- Does not modify the send/clear button logic or keyboard handling.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/PromptInput.tsx` — renders the input hint line at the bottom of the component.
- `src/client/i18n/en/chat.json` — English translation for `inputHint`.
- `src/client/i18n/zh-CN/chat.json` — Chinese translation for `inputHint`.

## Implementation Units

### U1. Remove input hint line and translations

**Goal:** Remove the visual hint line and its unused translation keys.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/client/components/PromptInput.tsx`
- Modify: `src/client/i18n/en/chat.json`
- Modify: `src/client/i18n/zh-CN/chat.json`

**Approach:**
- Remove the `<div>` block that renders `t('inputHint')` from `PromptInput.tsx`.
- Remove the `inputHint` key from both `en/chat.json` and `zh-CN/chat.json`.

**Patterns to follow:**
- Existing i18n key cleanup conventions in the repo.

**Test scenarios:**
- Test expectation: none — this is a pure UI removal with no behavioral change. Visual verification that the hint no longer appears below the chat input is sufficient.

**Verification:**
- The hint text is no longer visible below the chat input in either language.
- No console errors or missing-translation warnings occur.
