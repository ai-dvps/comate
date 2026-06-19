---
title: "feat: Rename input-box Commands button to Skills"
type: feat
date: 2026-06-19
---

## Summary

Rename the top-of-input command picker button from **Commands** to **Skills** by introducing a new `chat:skills` i18n key. The underlying slash-command data source, the `/`-trigger picker, and the approval-surface command button remain unchanged.

## Problem Frame

The product now exposes a dedicated Skills page, but the input toolbar still labels the slash-command picker as "Commands". Aligning the toolbar label with the Skills branding reduces user confusion while preserving the existing slash-command behavior.

## Requirements

- R1. The top-of-input picker button in the main chat input displays **Skills** in English and **技能** in Chinese.
- R2. The approval-surface command button continues to display **Commands** / **命令**.
- R3. The slash-trigger picker behavior, command data source, and `CommandPicker` component remain unchanged.
- R4. Existing `PromptInput` browser tests reflect the new button label.

## Key Technical Decisions

- KTD1. Use a new `chat:skills` i18n key instead of reusing `chat:commands`. `chat:commands` is shared with `src/client/components/ApprovalSurface.tsx`; a separate key lets us scope the rename to the input box without touching the approval surface.
- KTD2. Keep the `SlashSquare` icon and the `CommandPicker` component name. The picker still surfaces slash commands, and the user explicitly chose to rename only the button label.

## Implementation Units

### U1. Add `skills` translation strings

- **Goal:** Provide the new label copy in both supported locales.
- **Requirements:** R1.
- **Dependencies:** None.
- **Files:** `src/client/i18n/en/chat.json`, `src/client/i18n/zh-CN/chat.json`.
- **Approach:** Add a top-level `"skills"` entry adjacent to the existing `"commands"` entry. Leave `"commands"` untouched so `ApprovalSurface` keeps its current label.
- **Patterns to follow:** Existing flat key structure in `chat.json`; do not introduce a nested namespace for a single label.
- **Test scenarios:**
  - Test expectation: none — string correctness is exercised by the `PromptInput` render test in U2.
- **Verification:** Both locale files load without JSON syntax errors, and the new key is available under the `chat` namespace.

### U2. Update PromptInput to use the new label

- **Goal:** Surface the "Skills" label on the top-of-input command picker button.
- **Requirements:** R1, R3, R4.
- **Dependencies:** U1.
- **Files:** `src/client/components/PromptInput.tsx`, `src/client/components/PromptInput.browser.test.tsx`.
- **Approach:** In `PromptInput.tsx`, replace the two `t('commands')` calls inside the `CommandPicker` anchor (visible `<span>` and `title` attribute) with `t('skills')`. In `PromptInput.browser.test.tsx`, update the toolbar render assertion from `/Commands/i` to `/Skills/i`.
- **Patterns to follow:** Keep the same button styling, disabled logic, and `CommandPicker` props; this is a label-only change.
- **Test scenarios:**
  - Happy path: `PromptInput` renders a toolbar button accessible by name `/Skills/i`.
  - Integration: clicking the button still opens the existing `CommandPicker` and selecting a command inserts `/command-name ` into the editable input.
  - Edge case: the `title` tooltip reads "Skills" (verified implicitly by the accessible name assertion).
- **Verification:** `test:browser` passes for the updated `PromptInput` render test and the slash-command insertion test.

### U3. Verify ApprovalSurface remains unchanged

- **Goal:** Confirm the approval-surface command button keeps the "Commands" label.
- **Requirements:** R2.
- **Dependencies:** None (verification-only unit).
- **Files:** `src/client/components/ApprovalSurface.tsx` (read-only).
- **Approach:** Ensure `ApprovalSurface.tsx` still references `t('commands')` and does not import or use the new `skills` key. No code change is required.
- **Patterns to follow:** Use the existing `chat:commands` key; do not couple the approval surface to the input-box rename.
- **Test scenarios:**
  - Test expectation: none — existing `ApprovalSurface` tests continue to assert the current "Commands" label.
- **Verification:** `ApprovalSurface` still renders a button named "Commands" / "命令" after U2 lands.

## Scope Boundaries

- **Out of scope:** Renaming the `CommandPicker` component, `commands-store`, `CommandsService`, or related type names.
- **Out of scope:** Switching the picker data source to the Skills API or listing installed skills.
- **Out of scope:** Updating the `common:commandPicker.*` picker-internal strings (placeholder, loading, no-match messages).
- **Out of scope:** Renaming the approval-surface command button.

## Risks & Dependencies

- Low risk. The change is localized to one button label and one test assertion. The main hazard is accidentally updating the shared `chat:commands` value, which is mitigated by introducing a separate key.

## Sources & Research

- Local inspection of `src/client/components/PromptInput.tsx`, `src/client/components/ApprovalSurface.tsx`, `src/client/stores/commands-store.ts`, and the `src/client/i18n/*/chat.json` files.
- Prior plan `docs/plans/2026-05-17-011-feat-slash-command-discovery-plan.md` documented the `CommandPicker` "one picker, two anchors" pattern.
- Prior plan `docs/plans/2026-06-12-004-feat-skills-page-vercel-vendoring-plan.md` established the boundary between the Skills page and slash commands.
