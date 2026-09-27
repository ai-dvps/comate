---
title: feat: Add client UI internationalization (i18n)
type: feat
status: active
date: 2026-05-23
origin: docs/brainstorms/2026-05-23-i18n-client-ui-requirements.md
---

# feat: Add client UI internationalization (i18n)

## Summary

Add react-i18next to the client application with English and Simplified Chinese (zh-CN) translations, bundled at build time. Extend the existing `useAppSettings` hook for language persistence, add a selector to Settings → Appearance, and systematically replace all hardcoded UI strings across components with namespaced translation keys.

---

## Problem Frame

The client UI is entirely English. Chinese-speaking team members experience daily friction navigating the app. The fix must be extensible so additional languages can be added later without touching components.

---

## Requirements

- R1. Add `react-i18next` with `i18next` and `i18next-browser-languagedetector` as client dependencies.
- R2. Configure i18next with English fallback and `zh-CN` as a supported locale.
- R3. Organize translations into three namespaces: `common`, `settings`, `chat`.
- R4. Detect browser preferred language on first launch; fall back to English if unsupported.
- R5. Persist language preference in `localStorage`; restore on subsequent launches.
- R6. Add a language selector in Settings → Appearance listing native names (English, 简体中文).
- R7. Language changes apply immediately without reload.
- R8. Replace all hardcoded user-facing strings in client components with `namespace:key` translation keys.
- R9. Translate `title` attributes on icon buttons.
- R10. Provide complete English and `zh-CN` translation catalogs.

**Origin acceptance examples:** AE1 (covers R4, R5), AE2 (covers R6, R7), AE3 (covers R8, R9)

---

## Scope Boundaries

- Server-side Express API messages remain in English.
- Chat message content (user prompts and AI responses) is not translated.
- RTL layout support is not required.
- Console logs and debug output remain in English.
- No per-workspace language preference.

### Deferred to Follow-Up Work

- Add a third or fourth language — blocked only on creating new translation files and registering the locale.
- Add basic client-side rendering tests for i18n integration — no existing test infrastructure for client code.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/main.tsx` — minimal entry point, no existing providers. The `I18nextProvider` (or initReactI18next global instance) will be the first provider wrapper.
- `src/client/hooks/use-theme.ts` — canonical localStorage + useState pattern for app-scoped preferences. Uses `matchMedia` for system-preference detection.
- `src/client/hooks/use-app-settings.ts` — persists `defaultModel` and `reopenLastWorkspace` under a single JSON localStorage key. Type-validated on hydration.
- `src/client/components/SettingsPanel.tsx` — Appearance tab (line ~463) is the target for the language selector. Follows the same label + control layout as the Theme section.
- `src/client/components/SessionList.tsx` — `formatRelativeDate()` has hardcoded English relative-time strings with manual pluralization (`hour`/`hours`, `day`/`days`).
- `src/client/components/StatusIndicator.tsx` — `buildTitle()` constructs pluralized status strings manually (`TITLE_SINGULAR` / `TITLE_PLURAL`).
- `src/client/components/CommandPicker.tsx` — constructs dynamic message strings with optional filter interpolation.

### Institutional Learnings

- The codebase deliberately avoids Zustand and React Context for app-scoped personal preferences. The established convention is lightweight hooks with `localStorage` persistence (see Bright Theme plan, `docs/plans/2026-05-21-002-feat-bright-theme-plan.md`).
- SettingsPanel uses explicit Save/Cancel — no auto-save. Global dirty tracking compares full state against a snapshot.

---

## Key Technical Decisions

- **Bundle translations at build time:** The app is a desktop build (Tauri) with only two languages initially. Bundling avoids lazy-load complexity and ensures instant language switching. Future languages can still be added by importing new JSON files and registering them.
- **Extend `useAppSettings` for language persistence:** Language is an app-level preference, not workspace-level. Adding a `language` field to the existing `AppSettings` interface and `localStorage` blob follows the established pattern and keeps settings centralized.
- **Three namespaces — `common`, `settings`, `chat`:** The flat component directory means a small number of namespaces covers everything. `common` holds shared UI (buttons, headers, generic states); `settings` holds SettingsPanel and tabs; `chat` holds all conversation-related components.
- **Use `i18next-browser-languagedetector` for auto-detection:** Standard plugin that handles `navigator.language`, `localStorage`, and query-string detection with configurable priority.
- **Use `initReactI18next` (global instance) rather than `I18nextProvider`:** Simpler for a single-locale app. The global instance is initialized once in `main.tsx` before render.

---

## Open Questions

### Resolved During Planning

- **Namespace granularity:** Three namespaces (`common`, `settings`, `chat`) strike the right balance between organization and simplicity for the flat component structure.
- **Lazy-load vs bundle:** Bundle at build time. The bundle overhead of two small JSON files is negligible, and it avoids async complexity.
- **Dynamic string handling:** `formatRelativeDate` and `StatusIndicator` pluralization will use i18next's built-in `count` interpolation. `CommandPicker` filter messages will use standard `{{var}}` interpolation.

### Deferred to Implementation

- Exact translation key naming conventions within each namespace — establish during U3–U5 string extraction.
- Whether any hidden dynamic strings exist in components not surveyed during research.

---

## Output Structure

```
src/client/
  i18n/
    index.ts              # i18next configuration + resource imports
    resources.ts          # central resource registry (optional — may inline in index.ts)
    en/
      common.json
      settings.json
      chat.json
    zh-CN/
      common.json
      settings.json
      chat.json
```

---

## Implementation Units

### U1. Scaffold i18n infrastructure

**Goal:** Add dependencies and initialize i18next with bundled English and zh-CN translations.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Create: `src/client/i18n/index.ts`
- Create: `src/client/i18n/en/common.json`
- Create: `src/client/i18n/en/settings.json`
- Create: `src/client/i18n/en/chat.json`
- Create: `src/client/i18n/zh-CN/common.json`
- Create: `src/client/i18n/zh-CN/settings.json`
- Create: `src/client/i18n/zh-CN/chat.json`
- Modify: `src/client/main.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`

**Approach:**
- Install `i18next`, `react-i18next`, `i18next-browser-languagedetector`.
- Create `src/client/i18n/index.ts` that imports translation JSONs, configures i18next with `initReactI18next` and `BrowserLanguageDetector`, sets `en` as fallback, and exports the initialized instance.
- Initialize the i18n instance before rendering in `main.tsx`.
- Create stub JSON files for all three namespaces in both languages (English populated with placeholder keys, zh-CN with empty objects or placeholder values to be filled in U6).

**Patterns to follow:**
- No existing i18n pattern — this establishes the convention.

**Test scenarios:**
- **Happy path:** App renders without errors after i18n initialization.
- **Edge case:** Browser locale is unsupported (e.g., `fr-FR`) — UI falls back to English.
- **Integration:** i18n instance is initialized before ReactDOM.createRoot render call.

**Verification:**
- App boots successfully in dev mode.
- `i18n.language` returns the detected or default locale.
- Unsupported browser locale defaults to English.

---

### U2. Add language preference to app settings and Settings UI

**Goal:** Wire language state into the existing settings persistence layer and expose a selector in the Appearance tab.

**Requirements:** R4, R5, R6, R7

**Dependencies:** U1

**Files:**
- Modify: `src/client/hooks/use-app-settings.ts`
- Modify: `src/client/components/SettingsPanel.tsx`

**Approach:**
- Add `language: string` to the `AppSettings` interface with default `'en'`.
- Add `setLanguage` setter that updates state and `localStorage` atomically.
- On hydration, validate that `language` is a supported locale string; if not, default to `'en'`.
- In `SettingsPanel.tsx` `AppearanceTab`, add a Language section following the Theme section layout.
- Render language options as buttons (English, 简体中文) with active-state styling matching the theme buttons.
- On selection, call `setLanguage` and `i18n.changeLanguage()` so the UI updates immediately.
- On first app launch (no stored preference), use the i18next-detected locale as the initial value.

**Patterns to follow:**
- `src/client/hooks/use-theme.ts` — system-preference detection pattern.
- `src/client/hooks/use-app-settings.ts` — localStorage JSON persistence with type validation.

**Test scenarios:**
- **Happy path:** User selects 简体中文 in Appearance tab; UI switches to Chinese immediately.
- **Happy path:** Covers AE2. User saves settings, reloads app; language preference persists.
- **Edge case:** Covers AE1. Fresh browser with `navigator.language = 'zh-CN'` loads app in Chinese.
- **Edge case:** Corrupt or missing localStorage entry defaults to English.

**Verification:**
- Language selector appears in Settings → Appearance.
- Selecting a language updates `i18n.language` and re-renders translated text.
- Preference survives page reload.
- Unsupported browser locale defaults to English.

---

### U3. Extract settings and workspace component strings

**Goal:** Replace all hardcoded strings in SettingsPanel, CreateWorkspaceModal, WorkspaceSwitcher, and related components with `settings:` namespace keys.

**Requirements:** R8, R9, R10

**Dependencies:** U1, U2

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`
- Modify: `src/client/components/CreateWorkspaceModal.tsx`
- Modify: `src/client/components/WorkspaceSwitcher.tsx`
- Modify: `src/client/components/WorkspaceTabs.tsx`
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:**
- Add `import { useTranslation } from 'react-i18next'` to each component.
- Use `const { t } = useTranslation('settings')` for SettingsPanel and related components.
- Replace every hardcoded user-facing string with a descriptive key: tab labels, form labels, button text, placeholder text, empty states, tooltip `title` attributes, and helper text.
- Populate `en/settings.json` with all extracted strings as the source of truth.
- Populate `zh-CN/settings.json` with corresponding translations.

**Patterns to follow:**
- Use descriptive dot-notation keys where helpful (e.g., `tabs.general`, `tabs.appearance`).
- Keep keys flat enough that adding a third language does not require structural changes.

**Test scenarios:**
- **Happy path:** SettingsPanel renders in English with all text visible.
- **Happy path:** Switching to zh-CN renders all settings text in Chinese.
- **Edge case:** Covers AE3. Hovering over the theme toggle shows the translated tooltip.

**Verification:**
- No hardcoded English strings remain in the modified components.
- All `title` attributes on icon buttons use translated strings.
- Both language versions display correctly.

---

### U4. Extract chat component strings

**Goal:** Replace all hardcoded strings in chat-related components with `chat:` namespace keys.

**Requirements:** R8, R9, R10

**Dependencies:** U1, U2

**Files:**
- Modify: `src/client/components/ChatPanel.tsx`
- Modify: `src/client/components/MessageList.tsx`
- Modify: `src/client/components/PromptInput.tsx`
- Modify: `src/client/components/ApprovalSurface.tsx`
- Modify: `src/client/components/SessionList.tsx`
- Modify: `src/client/components/VirtualizedMessageList.tsx`
- Modify: `src/client/components/SubagentDrawer.tsx`
- Modify: `src/client/components/SubagentBriefStatus.tsx`
- Modify: `src/client/components/SubagentConversation.tsx`
- Modify: `src/client/components/StreamingToolInputPreview.tsx`
- Modify: `src/client/i18n/en/chat.json`
- Modify: `src/client/i18n/zh-CN/chat.json`

**Approach:**
- Same pattern as U3: `useTranslation('chat')` in each component.
- Replace labels, buttons, placeholders, empty states, tooltips, and status text.
- Handle `SessionList.tsx` `formatRelativeDate` by replacing the hardcoded time strings with `t()` calls using i18next `count` for pluralization (`justNow`, `minutesAgo`, `hoursAgo`, `daysAgo`).
- Handle `ApprovalSurface.tsx` step counter (`X of Y`) with interpolation.

**Patterns to follow:**
- i18next pluralization: `t('hoursAgo', { count: diffHours })` where the translation uses `_one` and `_other` suffixes.

**Test scenarios:**
- **Happy path:** All chat components render correctly in English.
- **Happy path:** Switching to zh-CN renders all chat text in Chinese.
- **Edge case:** SessionList relative times display correct plural forms in both languages.
- **Edge case:** ApprovalSurface step counter displays correctly with interpolation.

**Verification:**
- No hardcoded English strings remain in chat components.
- Relative time formatting works with pluralization in both languages.
- Step counters and interpolated messages render correctly.

---

### U5. Extract file, tool, and task component strings

**Goal:** Replace remaining hardcoded strings in file explorer, tool renderers, task panel, and status indicators. Handle the remaining dynamic text patterns.

**Requirements:** R8, R9, R10

**Dependencies:** U1, U2

**Files:**
- Modify: `src/client/components/FilePanel.tsx`
- Modify: `src/client/components/FileDrawer.tsx`
- Modify: `src/client/components/FileExplorer.tsx`
- Modify: `src/client/components/FilePicker.tsx`
- Modify: `src/client/components/TaskPanel.tsx`
- Modify: `src/client/components/StatusIndicator.tsx`
- Modify: `src/client/components/HeaderToolbar.tsx`
- Modify: `src/client/components/Sidebar.tsx`
- Modify: `src/client/components/PreviewPane.tsx`
- Modify: `src/client/components/CommandPicker.tsx`
- Modify: `src/client/components/tool-renderers/**/*.tsx`
- Modify: `src/client/components/ai-elements/**/*.tsx`
- Modify: `src/client/i18n/en/common.json`
- Modify: `src/client/i18n/zh-CN/common.json`
- Modify: `src/client/i18n/en/chat.json`
- Modify: `src/client/i18n/zh-CN/chat.json`

**Approach:**
- Use `useTranslation('common')` for generic/shared UI elements (HeaderToolbar, Sidebar, CommandPicker, FilePicker, StatusIndicator).
- Use `useTranslation('chat')` for tool-renderers and ai-elements that are chat-contextual.
- Replace `StatusIndicator.tsx` manual pluralization with i18next `count` interpolation.
- Replace `CommandPicker.tsx` dynamic filter message with `t('noCommandsMatch', { filter })`.
- Handle `FilePicker.tsx` and `FileExplorer.tsx` empty states and labels.

**Patterns to follow:**
- `StatusIndicator.tsx` currently has `TITLE_SINGULAR` and `TITLE_PLURAL` maps. Replace with a single map of translation keys and use `t(key, { count })`.

**Test scenarios:**
- **Happy path:** All remaining components render correctly in both languages.
- **Edge case:** StatusIndicator displays correct singular/plural status text in both languages.
- **Edge case:** CommandPicker filter message interpolates correctly when filter is present or empty.
- **Integration:** Tool renderers and AI elements show translated labels in chat context.

**Verification:**
- No hardcoded English strings remain in any client component.
- StatusIndicator pluralization works for all three states in both languages.
- CommandPicker shows correct dynamic messages.

---

### U6. Create zh-CN translations and end-to-end verification

**Goal:** Populate all zh-CN translation files and do a final sweep to ensure nothing was missed.

**Requirements:** R10, R11, R12

**Dependencies:** U3, U4, U5

**Files:**
- Modify: `src/client/i18n/zh-CN/common.json`
- Modify: `src/client/i18n/zh-CN/settings.json`
- Modify: `src/client/i18n/zh-CN/chat.json`

**Approach:**
- Translate every key in all three zh-CN namespace files.
- Pay attention to context: button labels should be concise; helper text can be slightly more descriptive.
- Verify that interpolation placeholders (`{{var}}`) and count-based keys (`_one`, `_other`) are preserved in zh-CN.
- Do a final grep for remaining hardcoded English strings in `src/client/components/`.
- Run the app in dev mode, switch to zh-CN, and visually verify all major screens.

**Test scenarios:**
- **Happy path:** App displays fully in Chinese when zh-CN is selected.
- **Edge case:** Covers AE1. Fresh browser with zh-CN locale loads in Chinese without manual selection.
- **Edge case:** Switching back to English restores all English text.
- **Integration:** All three namespaces load correctly; no missing keys fall back to English unexpectedly.

**Verification:**
- All zh-CN translation files are complete (no empty values).
- No untranslated English strings visible in the UI when running in zh-CN.
- Language switcher works bidirectionally (en ↔ zh-CN).

---

## System-Wide Impact

- **Interaction graph:** i18n initialization happens before React render in `main.tsx`. The `useAppSettings` hook now hydrates language from localStorage and syncs it to the i18n instance.
- **Error propagation:** i18next missing-key fallback renders the key name itself. Ensure all keys are defined in English to avoid raw keys leaking to users.
- **State lifecycle risks:** Language change triggers a full React re-render. No partial-write risks — translation files are read-only JSON imports.
- **Unchanged invariants:** Server API routes, Express middleware, and server-side messages are untouched. Chat message content is not translated. Zustand stores remain unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Missed hardcoded strings in obscure components | Final grep sweep in U6; missing-key fallback makes gaps visible |
| zh-CN translations are inaccurate or lack context | Team member review; iterate on awkward phrasings |
| Dynamic string patterns (pluralization, interpolation) break in zh-CN | Test both languages during U4–U5; i18next plural rules handle Chinese correctly (no plural forms needed) |
| Bundle size increase from translation JSONs | Two small JSON files; negligible impact. Monitor if adding many languages later |

---

## Documentation / Operational Notes

- Document the `namespace:key` convention in a brief comment at the top of `src/client/i18n/index.ts` for future contributors.
- Adding a third language: create a new locale directory under `src/client/i18n/`, copy and translate the JSON files, import them in `src/client/i18n/index.ts`, and add the locale to the language selector.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-23-i18n-client-ui-requirements.md](docs/brainstorms/2026-05-23-i18n-client-ui-requirements.md)
- Related code: `src/client/hooks/use-theme.ts`, `src/client/hooks/use-app-settings.ts`, `src/client/components/SettingsPanel.tsx`
- Related plans: `docs/plans/2026-05-21-002-feat-bright-theme-plan.md` (theme state pattern)
