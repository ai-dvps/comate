---
date: 2026-05-23
topic: i18n-client-ui
---

# Client UI Internationalization (i18n)

## Summary

Add react-i18next-based internationalization to the client application, starting with English and Simplified Chinese (zh-CN). A language selector in Settings → Appearance, browser-locale auto-detection on first launch, and all hardcoded UI strings replaced with translation keys so additional languages can be added later without touching components.

---

## Problem Frame

The client application UI is entirely in English. Team members who speak Chinese as their primary language find the app harder to navigate and use day-to-day. This creates friction for a meaningful portion of the user base. The fix needs to be extensible — if a third or fourth language is needed later, the investment should compound rather than requiring a rewrite.

---

## Requirements

**Core infrastructure**

- R1. Add `react-i18next` with `i18next` as client-side dependencies.
- R2. Configure i18next with English as the fallback locale and `zh-CN` as a supported locale.
- R3. Organize translation files by namespace matching major UI areas (e.g., `common`, `settings`, `chat`, `workspace`).

**Language detection and switching**

- R4. On first app launch, detect the browser/system preferred language and set it if it matches a supported locale; otherwise default to English.
- R5. Persist the user's language preference in `localStorage` and restore it on subsequent launches.
- R6. Add a language selector in **Settings → Appearance** with supported locales listed by their native names (English, 简体中文).
- R7. Changing the language updates the UI immediately without requiring a page reload.

**String extraction**

- R8. Replace all hardcoded user-facing strings in client components with translation keys. This includes labels, buttons, placeholders, tooltips, empty states, and status text.
- R9. Replace `title` attributes on icon buttons with translated strings.
- R10. Translation keys follow a namespaced pattern: `namespace:key` (e.g., `settings:saveChanges`).

**Translations**

- R11. Provide a complete English translation catalog as the source of truth.
- R12. Provide a complete Simplified Chinese (`zh-CN`) translation catalog.

---

## Acceptance Examples

- AE1. **Covers R4, R5.** Given a fresh browser with `navigator.language` set to `zh-CN`, when the app loads for the first time, the UI displays in Chinese and the preference persists across reloads.
- AE2. **Covers R6, R7.** Given the app is running in English, when the user selects 简体中文 in Settings → Appearance and saves, all UI text switches to Chinese immediately.
- AE3. **Covers R8, R9.** Given the app is in `zh-CN`, when hovering over the theme toggle button in the header, the tooltip displays "切换主题" instead of "Toggle theme".

---

## Success Criteria

- A Chinese-speaking team member can navigate the entire client UI without encountering untranslated English strings.
- Adding a third language requires only creating a new translation file and registering the locale — no code changes to components.

---

## Scope Boundaries

- Server-side Express API error messages and status text remain in English.
- Chat message content (user prompts and AI responses) is not translated.
- RTL language layout support is not required.
- Console logs, debug messages, and developer-facing output remain in English.
- No per-workspace language preference; language is global to the app instance.

---

## Key Decisions

- **react-i18next over custom hook**: Ecosystem maturity, interpolation/pluralization support, and established patterns for adding languages later.
- **Global preference over per-workspace**: Aligns with desktop app conventions and avoids complexity in shared workspace scenarios.
- **zh-CN only for Chinese**: Covers the team's need without maintaining multiple Chinese variants.

---

## Dependencies / Assumptions

- The existing `useAppSettings` `localStorage` pattern can be extended or a parallel mechanism used for language persistence.
- All user-facing strings are statically analyzable in JSX (no dynamic string construction from variables for UI labels).

---

## Outstanding Questions

### Resolve Before Planning

(None — product decisions are clear.)

### Deferred to Planning

- [Affects R3][Technical] Determine optimal namespace granularity (per-component, per-feature, or flat).
- [Affects R8][Needs research] Identify whether any dynamic strings or template literals are used for UI labels that will need special handling.
- [Affects R1][Technical] Decide whether to lazy-load translation files or bundle them at build time.
