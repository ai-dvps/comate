---
title: Remove Approval-Mode Badge from Session List - Plan
type: feat
date: 2026-07-14
topic: remove-session-list-approval-badge
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Remove Approval-Mode Badge from Session List - Plan

## Goal Capsule

- **Objective:** Declutter the session list by removing the per-row approval-mode badge, since the same state is already visible and controllable in the prompt-input area.
- **Product authority:** UI/UX polish within the existing chat workspace.
- **Open blockers:** None.

## Product Contract

### Summary

Remove the approval-mode badge that currently appears on each row in the session list when a session is in `auto` or `readonly` mode. The approval-mode toggle in the prompt-input area stays in place, so users retain the ability to view and change the current session's approval mode.

### Requirements

- R1. The session-list row no longer renders a badge for the session's `approvalMode` value.
- R2. The session-list row continues to render its other metadata: draft/WIP/archived badges, source icon, and timestamp.
- R3. The `ApprovalModeToggle` in the prompt-input area remains unchanged and continues to display and update the active session's approval mode.

### Scope Boundaries

- Removing or changing the `ApprovalModeToggle` component is out of scope.
- Changing approval-mode behavior, persistence, or API is out of scope.
- Removing i18n keys still used by the toggle is out of scope.
- Approval mode is intentionally not shown for inactive sessions in the list; users must select a session to view or change it via the prompt-input toggle.

## Planning Contract

### Key Technical Decisions

- **Keep approval-mode state and control surface untouched.** `approvalMode` is still read by `ApprovalModeToggle` in the prompt-input area, so the data model, store actions, and server API remain as-is.
- **Make the change in `SessionListItem` only.** The badge lives entirely in the session-list row component, so removing it is a localized UI change.
- **Add a regression test for the removed badge.** `SessionListItem.test.tsx` already covers badge rendering for draft status and bot icons; extend it to assert that approval-mode badges are absent for `auto` and `readonly` sessions.

## Implementation Units

### U1. Remove the approval-mode badge from `SessionListItem`

- **Goal:** Stop rendering the colored approval-mode badge on each session-list row.
- **Requirements:** R1, R2
- **Dependencies:** None
- **Files:**
  - `src/client/components/SessionListItem.tsx`
- **Approach:** Remove the conditional badge block that renders when `session.approvalMode` is `auto` or `readonly`, along with the `Shield` and `ShieldAlert` imports if they become unused. Leave all other row metadata (draft/WIP/archived badges, source icons, timestamp) unchanged.
- **Patterns to follow:** The component uses `cn()` for conditional Tailwind classes and passes a `t` function for i18n; preserve those patterns for the remaining badges.
- **Test scenarios:**
  - Happy path: a session with `approvalMode: 'auto'` does not display the `Auto` badge text.
  - Happy path: a session with `approvalMode: 'readonly'` does not display the `Readonly` badge text.
  - Edge case: a session with `approvalMode: 'manual'` continues to show no approval-mode badge (same as before).
- **Verification:** The `auto` and `readonly` badges are no longer visible in `SessionListItem`, and the row still renders the name, preview, draft/WIP/archived badges, source icon, and timestamp.

### U2. Add regression coverage for absent approval-mode badges

- **Goal:** Prevent accidental re-introduction of the approval-mode badge in the session list.
- **Requirements:** R1
- **Dependencies:** U1
- **Files:**
  - `src/client/components/SessionListItem.test.tsx`
- **Approach:** Add tests that render `SessionListItem` with `approvalMode` set to `auto` and `readonly` and assert that the badge text is not present. Mirror the existing test structure for draft and bot-icon badges.
- **Patterns to follow:** The test file uses `vitest`, `@testing-library/react`, a `makeSession` helper, and `renderWithI18n`; follow the same setup.
- **Test scenarios:**
  - Happy path: `approvalMode: 'auto'` does not render the `Auto` badge.
  - Happy path: `approvalMode: 'readonly'` does not render the `Readonly` badge.
- **Verification:** The new tests pass, and existing `SessionListItem` tests continue to pass.

## Verification Contract

- Run `npm run lint` and confirm no new lint errors or unused-import warnings in `src/client/components/SessionListItem.tsx`.
- Run `npm run test:client` and confirm `SessionListItem.test.tsx` passes.
- Manually verify that sessions in `auto` or `readonly` approval mode no longer show the colored badge in the session list, while the `ApprovalModeToggle` in the prompt-input area still shows the current mode.

## Definition of Done

- `src/client/components/SessionListItem.tsx` no longer renders an approval-mode badge for any `approvalMode` value.
- `Shield` and `ShieldAlert` imports are removed if they are no longer used.
- `SessionListItem.test.tsx` includes regression tests confirming the badge is absent for `auto` and `readonly` modes.
- Lint and client tests pass.
- The `ApprovalModeToggle` in the prompt-input area remains fully functional.
