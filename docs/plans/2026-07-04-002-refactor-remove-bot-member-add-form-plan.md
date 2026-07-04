---
title: Remove Bot Member Add Form - Plan
type: refactor
date: 2026-07-04
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
---

# Remove Bot Member Add Form

## Goal Capsule

- Objective: Remove the manual "Add member" form from the bot member management UI while preserving the backend `addMember` capability used by bot creation and channel auto-add.
- Stop condition: The `BotMemberList` component no longer renders add-member controls; existing member list, role editing, removal, plaintext resolution, and refresh features continue to work.

## Product Contract

### Summary

Remove the add-member controls (channel selector, user ID input, role selector, and Add member button) from the bot settings members tab. Keep the backend service, store action, and API route intact because bot creation still assigns initial channel owners and WeCom/Feishu still auto-add members on first message.

### Problem Frame

The bot member interface currently exposes a manual "Add member" form that lets users directly add members by channel user ID. Product direction is to remove this manual path so member management flows through bot creation (initial owner) and channel-driven auto-add rather than ad-hoc UI entry.

### Requirements

- R1. The add-member form is no longer rendered in the bot members tab.
- R2. The `BotMemberList` component no longer accepts or calls an `onAddMember` prop.
- R3. Existing member list, role editing, member removal, resolve-pending, and plaintext editing features remain functional.
- R4. Bot creation still assigns initial WeCom/Feishu owners through the existing `addMember` store action and backend API.
- R5. Unused add-member UI strings are removed from i18n files.

### Scope Boundaries

- In scope: `BotMemberList` UI, `BotManagementPage` prop wiring, `BotMemberList` tests, `en`/`zh-CN` i18n cleanup.
- Deferred to follow-up work: Removing the backend `POST /api/bots/:id/members` route, `botService.addMember`, or the store `addMember` action would require redesigning bot creation owner initialization and channel auto-add and is intentionally out of scope.

## Planning Contract

### Key Technical Decisions

- KTD1. UI-only removal. The backend `addMember` capability is kept because it is shared by bot creation (initial owner assignment) and WeCom/Feishu message handlers (auto-add on first interaction). Removing the API would force a broader refactor outside this scope.
- KTD2. Empty state simplified. The empty-state `UserPlus` icon is removed alongside the add form to avoid implying an add action that no longer exists; the "No members yet." text remains.

## Implementation Units

### U1. Remove add-member form from BotMemberList

- **Goal:** Strip the manual add-member UI and related local state from `BotMemberList`.
- **Requirements:** R1, R2, R3
- **Dependencies:** None
- **Files:** `src/client/components/BotMemberList.tsx`
- **Approach:** Remove the `onAddMember` prop from the interface and destructuring. Delete the channel, user ID, and role form states and the `handleAdd` handler. Remove the form JSX (selects, input, Add member button). Remove the `UserPlus` icon from the empty state. Keep `formError` because it is still used for plaintext validation errors.
- **Patterns to follow:** Existing component uses functional `setState` and Tailwind utility classes; preserve remaining member list rendering and grouped channel layout.
- **Test scenarios:**
  - Happy path: `BotMemberList` renders without the channel selector, user ID input, role selector, or Add member button when members are present.
  - Edge case: Empty-state rendering still shows "No members yet." text without the `UserPlus` icon.
  - Error path: Existing store-level error messages still render in the component.
- **Verification:** Visual inspection or test confirms no add-member controls are present and existing controls (role selects, remove buttons, resolve pending, refresh) still render.

### U2. Update BotManagementPage prop wiring

- **Goal:** Stop passing `onAddMember` to `BotMemberList`.
- **Requirements:** R2, R4
- **Dependencies:** U1
- **Files:** `src/client/components/BotManagementPage.tsx`
- **Approach:** Remove the `onAddMember` prop from the `BotMemberList` JSX in the members section. Keep the `addMember` store action in scope and its use in `handleSaveBasic` for initial channel owner assignment during bot creation.
- **Patterns to follow:** `BotManagementPage` already selects store actions via `useBotStore` destructuring; do not remove `addMember` from the destructuring because it is still used for new bot creation.
- **Test scenarios:**
  - Integration scenario: Creating a new bot with WeCom enabled and an owner user ID still calls `addMember` for the initial owner after `createBot` succeeds.
  - Happy path: Rendering the members tab does not throw after removing the prop.
- **Verification:** `BotManagementPage.test.tsx` "creates a bot and adds initial channel owners when saving a new bot" still passes.

### U3. Clean up tests and i18n strings

- **Goal:** Remove now-unused add-member tests and i18n keys.
- **Requirements:** R5
- **Dependencies:** U1
- **Files:** `src/client/components/BotMemberList.test.tsx`, `src/client/i18n/en/settings.json`, `src/client/i18n/zh-CN/settings.json`
- **Approach:** Remove `onAddMember` from test `baseProps` and delete test cases that exercise add-member form submission, validation, and owner-option disabling. Remove unused i18n keys: `bots.memberUserIdPlaceholder`, `bots.memberUserIdRequired`, `bots.ownerAlreadyExists`, `bots.addMember`. Keep `bots.noMembers` because the empty-state text remains.
- **Patterns to follow:** Co-located component tests use Vitest and React Testing Library; i18n namespaces are kept in sync across `en` and `zh-CN`.
- **Test scenarios:**
  - Happy path: Remaining `BotMemberList` tests pass (grouping, role update, owner badge, owner-less warning, last-owner removal confirmation, plaintext save).
  - Edge case: No tests reference removed props or strings.
- **Verification:** `npm run test:client` and `npm run lint` pass.

## Verification Contract

- Run `npm run test:client` to validate `BotMemberList` and `BotManagementPage` client tests.
- Run `npm run lint` to catch unused imports or variables after removing add-member code.

## Definition of Done

- `BotMemberList` no longer renders add-member controls and no longer references `onAddMember`.
- `BotManagementPage` no longer passes `onAddMember` to `BotMemberList`, and bot creation still adds initial channel owners.
- Client tests pass and lint is clean.
- Unused add-member i18n keys are removed from both locales.
