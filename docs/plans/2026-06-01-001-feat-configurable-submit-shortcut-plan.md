---
title: Configurable Submit Shortcut
type: feat
status: active
date: 2026-06-01
origin: docs/brainstorms/2026-06-01-configurable-submit-shortcut-requirements.md
---

# Configurable Submit Shortcut

## Summary

Extend the existing `useAppSettings` hook with a `useModifierToSubmit` toggle (default `true`), expose it in the Settings General tab, and wire it into all main-app inputs through a shared keyboard helper. When enabled, Ctrl+Enter (Windows) or Cmd+Enter (Mac) submits; plain Enter inserts newlines in textareas. An IME composition guard prevents accidental sends during CJK character input, and a platform-aware shortcut hint appears near the prompt send button.

---

## Problem Frame

Currently, pressing Enter in the prompt input, new session name field, or todo edit area immediately submits the form. This causes frequent accidental sends when users intend to insert a line break or when they are composing non-English characters via an Input Method Editor (IME). In CJK and other non-Latin input systems, Enter is used to confirm character selection during composition, which currently triggers an unintended submit. (see origin: docs/brainstorms/2026-06-01-configurable-submit-shortcut-requirements.md)

---

## Requirements

- R1. Add `useModifierToSubmit` (boolean) to `AppSettings` with default `true`.
- R2. Expose the setting as a toggle in Settings > General.
- R3. Persist and restore the setting via the existing localStorage `app-settings` key.
- R4. When `useModifierToSubmit` is `true`, main-app inputs submit only on Ctrl+Enter (Windows) or Cmd+Enter (Mac).
- R5. When `useModifierToSubmit` is `true`, plain Enter in textareas inserts a newline.
- R6. When `useModifierToSubmit` is `false`, restore legacy behavior: Enter submits, Shift+Enter inserts newline in textareas.
- R7. During IME composition (`e.nativeEvent.isComposing`), Enter must never trigger submit.
- R8. Show a platform-aware shortcut hint near the prompt send button when the modifier setting is enabled.

**Origin acceptance examples:**
- AE1 (IME guard): CJK composition confirmed with Enter inserts characters without sending.
- AE2 (toggle behavior): Prompt input switches between newline-on-Enter and send-on-Enter as the setting changes.
- AE3 (consistency): Todo quick-add, new-session, rename, and todo-edit all respect the same modifier rule.

---

## Scope Boundaries

- Settings panel form inputs (window cap, path config, workspace fields) remain on Enter — out of scope.
- Custom keybinding beyond the binary toggle is out of scope.
- No onboarding walkthrough or migration prompt — the shortcut hint is the only discovery aid.

### Deferred to Follow-Up Work

- Component-level tests for PromptInput, TodoList, and SessionList — deferred until the project adds client-side component testing infrastructure.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/hooks/use-app-settings.ts` — localStorage-backed settings with typed `AppSettings`, per-field setters, and validation on init. Follow the existing `reopenLastWorkspace` toggle pattern for the new setting.
- `src/client/components/SettingsPanel.tsx` — General tab holds app-level behavioral toggles. Add the new toggle alongside `reopenLastWorkspace`.
- `src/client/components/PromptInput.tsx` — Current behavior: `Enter && !e.shiftKey` triggers `handleSend()`. When modifier mode is on, this condition is replaced with the helper.
- `src/client/components/TodoList.tsx` — Todo edit textarea and quick-add input both use bare `Enter` for submit.
- `src/client/components/SessionList.tsx` — New session input and rename input both use bare `Enter` for submit.
- No shared keyboard utility exists; each component handles `onKeyDown` inline.
- Only one client-side test exists: `src/client/lib/summarize-tool-input.test.ts`. No component tests.

### Institutional Learnings

- Plan `2026-05-31-004-fix-todo-edit-enter-shortcut-plan.md` previously aimed to align TodoList with PromptInput's Enter-to-send pattern. This plan supersedes that direction by making the behavior configurable.
- No IME composition guards currently exist anywhere in the codebase.

---

## Key Technical Decisions

- **Shared helper over inline duplication:** A pure function in `src/client/lib/keyboard.ts` centralizes the submit-or-newline decision. This avoids repeating the same IME + modifier logic across five components and establishes a place for future keyboard utilities.
- **Default `true`:** New users get the modifier behavior immediately, solving the IME pain point without requiring manual configuration. Existing users without the setting inherit `true` on next load.
- **Platform hint uses `navigator.platform`:** Simple `/Mac|iPod|iPhone|iPad/.test(navigator.platform)` check to decide between "Ctrl+Enter" and "Cmd+Enter" labels.

---

## Open Questions

### Resolved During Planning

- Inline vs. shared helper: resolved to shared helper to keep the change DRY and establish a keyboard utility pattern.

### Deferred to Implementation

- Exact placement and styling of the shortcut hint in PromptInput — depends on seeing the send button layout at implementation time.

---

## Implementation Units

### U1. Extend useAppSettings with useModifierToSubmit

**Goal:** Add the new boolean setting to the app settings store with persistence and default `true`.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `src/client/hooks/use-app-settings.ts`

**Approach:**
- Add `useModifierToSubmit: boolean` to the `AppSettings` interface.
- Set default to `true` in `getInitialSettings()`.
- Add `setUseModifierToSubmit` setter following the existing atomic update + localStorage pattern.
- Export the new field and setter from the hook return.

**Patterns to follow:**
- Existing `setReopenLastWorkspace` implementation in the same file.

**Test scenarios:**
- Happy path: `getInitialSettings()` returns `useModifierToSubmit: true` when no localStorage entry exists.
- Happy path: stored `true`/`false` values are restored correctly.
- Edge case: stored invalid/non-boolean value falls back to `true`.
- Integration: calling `setUseModifierToSubmit` updates state and writes to localStorage.

**Verification:**
- The hook returns the new field and setter.
- localStorage round-trip works for true, false, and missing values.

---

### U2. Add settings toggle UI

**Goal:** Expose the new setting as a toggle in Settings > General with i18n labels.

**Requirements:** R2

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:**
- Consume `useModifierToSubmit` and `setUseModifierToSubmit` from `useAppSettings()` in `SettingsPanel`.
- Add a toggle row in the General tab, grouped near `reopenLastWorkspace`.
- Add i18n keys under `general.useModifierToSubmit` and `general.useModifierToSubmitHint` in both English and Chinese translation files.

**Patterns to follow:**
- The `reopenLastWorkspace` toggle row in `SettingsPanel.tsx`.

**Test scenarios:**
- Happy path: toggle appears in General tab with correct label and hint.
- Happy path: toggling the switch immediately calls `setUseModifierToSubmit`.

**Verification:**
- Toggle is visible in Settings > General.
- Switching it on/off changes the persisted setting.

---

### U3. Create shared keyboard submit helper

**Goal:** Centralize the submit decision logic with IME guard and modifier detection.

**Requirements:** R7

**Dependencies:** None

**Files:**
- Create: `src/client/lib/keyboard.ts`
- Create: `src/client/lib/keyboard.test.ts`

**Approach:**
- Export `shouldSubmitOnEnter(event, useModifierToSubmit): boolean`.
- Return `false` immediately if `event.nativeEvent.isComposing` is `true`.
- When `useModifierToSubmit` is `true`, return `true` only if `event.ctrlKey || event.metaKey`.
- When `useModifierToSubmit` is `false`, return `true` for plain Enter (respecting the existing `!event.shiftKey` semantics from PromptInput).

**Technical design:**

> *Directional guidance, not implementation specification.*
>
> The helper is a pure function taking a React keyboard event and the setting boolean. It answers one question: "given this keydown event and the user's preference, should the host component treat Enter as submit?" All newline insertion logic stays in the host components — the helper only decides submission.

**Patterns to follow:**
- Existing pure utility `src/client/lib/font-size.ts`.

**Test scenarios:**
- Covers AE1. IME composing: returns `false` regardless of setting or modifier keys.
- Happy path (modifier on): Ctrl+Enter or Cmd+Enter returns `true`.
- Happy path (modifier on): plain Enter returns `false`.
- Happy path (modifier off): plain Enter returns `true`.
- Edge case (modifier off): Shift+Enter returns `false`.
- Edge case: non-Enter keys return `false`.

**Verification:**
- All test scenarios pass.

---

### U4. Update PromptInput with new shortcut behavior and hint

**Goal:** Wire the configurable submit behavior into the prompt textarea and show a platform-aware shortcut hint.

**Requirements:** R4, R5, R6, R8

**Dependencies:** U1, U3

**Files:**
- Modify: `src/client/components/PromptInput.tsx`

**Approach:**
- Consume `useModifierToSubmit` from `useAppSettings`.
- In `handleKeyDown`, use the helper to decide whether Enter should submit.
- When `useModifierToSubmit` is `true` and plain Enter is pressed in the textarea, do not call `e.preventDefault()` — allow the native newline insertion.
- Add a subtle text hint near the send button showing "Ctrl+Enter" or "Cmd+Enter" based on platform detection when the modifier setting is enabled.

**Patterns to follow:**
- Existing `handleKeyDown` structure in the same file.

**Test scenarios:**
- Covers AE2. Modifier on: Ctrl/Cmd+Enter sends; plain Enter inserts newline.
- Covers AE2. Modifier off: Enter sends; Shift+Enter inserts newline.
- Happy path: IME composition during modifier-on mode does not send.
- Happy path: shortcut hint shows the correct platform label.
- Edge case: hint is hidden when modifier setting is off.

**Verification:**
- Prompt input respects the setting toggle without page reload.
- Newline insertion works correctly in both modes.
- Hint is visible and accurate.

---

### U5. Update TodoList with new shortcut behavior

**Goal:** Apply the configurable submit behavior to todo edit and quick-add inputs.

**Requirements:** R4, R5

**Dependencies:** U1, U3

**Files:**
- Modify: `src/client/components/TodoList.tsx`

**Approach:**
- Consume `useModifierToSubmit` from `useAppSettings`.
- In the todo edit textarea `onKeyDown`, use the helper to decide submission.
- In the quick-add input `onKeyDown`, use the helper to decide submission.
- When modifier mode is on, allow native newline in the edit textarea on plain Enter.

**Patterns to follow:**
- Existing `onKeyDown` handlers in the same file.

**Test scenarios:**
- Covers AE3. Modifier on: todo edit requires Ctrl/Cmd+Enter to commit.
- Covers AE3. Modifier on: quick-add requires Ctrl/Cmd+Enter to create.
- Happy path: plain Enter in todo edit textarea inserts newline when modifier is on.
- Happy path: IME composition does not trigger submit.

**Verification:**
- Todo edit and quick-add respect the setting toggle.

---

### U6. Update SessionList with new shortcut behavior

**Goal:** Apply the configurable submit behavior to new session and rename inputs.

**Requirements:** R4

**Dependencies:** U1, U3

**Files:**
- Modify: `src/client/components/SessionList.tsx`

**Approach:**
- Consume `useModifierToSubmit` from `useAppSettings`.
- In the new session input `onKeyDown`, use the helper to decide submission.
- In the rename input `onKeyDown`, use the helper to decide submission.

**Patterns to follow:**
- Existing `onKeyDown` handlers in the same file.

**Test scenarios:**
- Covers AE3. Modifier on: new session requires Ctrl/Cmd+Enter to create.
- Covers AE3. Modifier on: rename requires Ctrl/Cmd+Enter to commit.
- Happy path: IME composition does not trigger submit.

**Verification:**
- New session and rename inputs respect the setting toggle.

---

## System-Wide Impact

- **Interaction graph:** `useAppSettings` is already consumed by `SettingsPanel`, `App`, `MessageList`, and `VirtualizedMessageList`. Adding one more consumer in `PromptInput`, `TodoList`, and `SessionList` is a trivial extension of the existing pattern.
- **Unchanged invariants:** Settings panel form inputs (window cap, path config, workspace fields) keep their existing Enter behavior. The `useAppSettings` storage key and shape remain backward-compatible — missing `useModifierToSubmit` defaults to `true`.
- **API surface parity:** No server-side or API changes.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Users accustomed to Enter-to-send may be surprised by the new default. | The shortcut hint near the send button aids discovery; the setting can be disabled in Settings > General. |
| IME guard behavior varies across browsers and IME implementations. | The `isComposing` check is the standard web API for this; test with a major CJK IME during implementation verification. |

---

## Documentation / Operational Notes

- No operational or rollout changes required — this is a pure client-side behavior change.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-01-configurable-submit-shortcut-requirements.md](docs/brainstorms/2026-06-01-configurable-submit-shortcut-requirements.md)
- Related code: `src/client/hooks/use-app-settings.ts`, `src/client/components/PromptInput.tsx`, `src/client/components/TodoList.tsx`, `src/client/components/SessionList.tsx`, `src/client/components/SettingsPanel.tsx`
- Related plan: `docs/plans/2026-05-31-004-fix-todo-edit-enter-shortcut-plan.md` (superseded direction)
