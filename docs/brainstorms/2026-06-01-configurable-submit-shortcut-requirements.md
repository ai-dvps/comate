---
date: 2026-06-01
topic: configurable-submit-shortcut
---

# Configurable Submit Shortcut

## Summary

Add a user-facing setting that toggles submit behavior between Enter and Ctrl+Enter (Windows) / Cmd+Enter (Mac), defaulting to the modifier key. Applies to all main-app inputs — prompt input, new session creation, session rename, todo edit, and todo quick add. Enter alone inserts newlines in textareas and is protected during IME composition so it does not interrupt non-English character input.

---

## Problem Frame

Currently, pressing Enter in the prompt input, new session name field, or todo edit area immediately submits the form. This causes frequent accidental sends when users intend to insert a line break or when they are composing non-English characters via an Input Method Editor (IME). In CJK and other non-Latin input systems, Enter is used to confirm character selection during composition, which currently triggers an unintended submit. The result is fragmented messages, lost drafts, and a frustrating input experience for a significant portion of users.

---

## Requirements

**Settings and persistence**

- R1. A new app-level setting `useModifierToSubmit` (boolean) is added to the existing `AppSettings` store in `src/client/hooks/use-app-settings.ts`.
- R2. The setting defaults to `true` for new users, so Ctrl+Enter (Windows) / Cmd+Enter (Mac) becomes the default submit shortcut.
- R3. Existing users without the setting in localStorage inherit the default `true` on next app load.
- R4. The setting is exposed as a toggle in the Settings panel under the General tab, labeled "Use Ctrl/Cmd + Enter to send".
- R5. The setting persists to and restores from localStorage via the existing `STORAGE_KEY` mechanism.

**Input behavior**

- R6. When `useModifierToSubmit` is `true`, the prompt input textarea (`PromptInput.tsx`) submits only on Ctrl+Enter (Windows) or Cmd+Enter (Mac). Plain Enter inserts a newline.
- R7. When `useModifierToSubmit` is `false`, the prompt input textarea restores the current behavior: Enter submits, Shift+Enter inserts a newline.
- R8. When `useModifierToSubmit` is `true`, the todo edit textarea (`TodoList.tsx`) submits only on Ctrl/Cmd+Enter. Plain Enter inserts a newline.
- R9. When `useModifierToSubmit` is `true`, the new-session name input (`SessionList.tsx`) submits only on Ctrl/Cmd+Enter.
- R10. When `useModifierToSubmit` is `true`, the session rename input (`SessionList.tsx`) submits only on Ctrl/Cmd+Enter.
- R11. When `useModifierToSubmit` is `true`, the todo quick-add input (`TodoList.tsx`) submits only on Ctrl/Cmd+Enter.

**IME and accessibility guards**

- R12. During IME composition (`e.nativeEvent.isComposing === true`), pressing Enter must never trigger submit regardless of the setting. It must allow the IME to commit the composed characters.
- R13. When `useModifierToSubmit` is `true` and the prompt input has focus, a subtle keyboard shortcut hint is shown near the send button (e.g., "Ctrl+Enter" or "Cmd+Enter" depending on platform) to help users discover the new default.

---

## Acceptance Examples

- AE1. **Covers R6, R12.** Given `useModifierToSubmit` is enabled and the user is typing in the prompt input with a CJK IME active, when the user presses Enter to confirm a character composition, the composed characters are inserted into the textarea and the message is not sent.
- AE2. **Covers R6, R7.** Given the prompt input contains the text "Hello", when `useModifierToSubmit` is `true` and the user presses Enter, a newline is inserted. When the user then toggles the setting to `false` and presses Enter, the message is sent.
- AE3. **Covers R8, R9, R10, R11.** Given `useModifierToSubmit` is `true`, when the user presses Enter in the todo quick-add input, new-session input, session rename input, or todo edit textarea without holding Ctrl/Cmd, nothing is submitted.

---

## Success Criteria

- Users can type multi-line prompts without accidentally sending on Enter.
- Users composing CJK or other IME-based characters can press Enter to confirm character selection without triggering submit.
- Users who prefer the legacy Enter-to-send behavior can disable the setting in Settings.
- All main-app inputs behave consistently under the same setting.

---

## Scope Boundaries

- Settings panel form inputs (window cap, path config, workspace fields) are out of scope — they continue to use Enter for submission.
- Custom keybinding beyond the binary Enter vs Ctrl/Cmd+Enter toggle is out of scope.
- No migration prompt or onboarding walkthrough for the new default — the shortcut hint near the send button is the only discovery aid.

---

## Key Decisions

- Single-line inputs also require the modifier: opted for full consistency across all main-app inputs rather than preserving native Enter behavior for single-line fields.
- Settings panel inputs excluded: bounded scope to main chat/todo/session flows; settings modal fields remain unchanged.
- Default to modifier-on: aligns with modern chat apps (Discord, Slack, ChatGPT) and solves the stated IME pain point for new users without requiring manual configuration.

---

## Dependencies / Assumptions

- Assumes `useAppSettings` hook and localStorage persistence mechanism remain the primary app-level settings channel.
- Assumes platform detection for showing "Ctrl" vs "Cmd" in the UI hint can use `navigator.platform` or a simple `/Mac|iPod|iPhone|iPad/.test(navigator.platform)` check.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Needs research] Whether to extract a shared `useSubmitShortcut` hook or keep logic inline in each component. The codebase currently uses inline `onKeyDown` handlers; planning should evaluate whether a shared helper reduces duplication without adding unnecessary abstraction.
