---
date: 2026-05-21
topic: bright-theme
---

# Bright Theme Support

## Summary

Add a warm off-white light theme as an alternative to the current dark theme. The app detects and respects the OS dark/light preference by default, with a manual override available via a quick-toggle in the header and a setting in the Settings panel. The existing orange accent is preserved, and the light palette is designed with a warm, minimal aesthetic rather than stark white.

---

## Problem Frame

The application is currently locked to a single dark theme with no theming system in place. Users who prefer light interfaces — or whose OS is set to light mode — have no way to align the app with their preference. This creates friction for users who find dark UIs fatiguing in well-lit environments or who simply expect their apps to respect system appearance settings. The current color system uses static Tailwind custom tokens with no dynamic theming mechanism, which blocks any theme variation without a foundational change.

---

## Key Flows

- F1. First-load theme selection
  - **Trigger:** User opens the app for the first time (no saved preference exists)
  - **Actors:** End user
  - **Steps:**
    1. App queries `prefers-color-scheme` media query
    2. If the OS is set to light, the app renders in light theme
    3. If the OS is set to dark, the app renders in dark theme
    4. Theme choice is not yet persisted (no localStorage entry)
  - **Outcome:** The UI matches the user's OS preference without any interaction
  - **Covered by:** R1, R2

- F2. Manual theme toggle from header
  - **Trigger:** User clicks the theme toggle in the header
  - **Actors:** End user
  - **Steps:**
    1. User clicks the sun/moon icon in the header
    2. The theme immediately switches between dark and light
    3. The preference is saved to localStorage
    4. The toggle icon updates to reflect the new active theme
  - **Outcome:** The UI is in the manually selected theme and will restore to it on next load
  - **Covered by:** R3, R4, R5

- F3. Manual theme toggle from Settings
  - **Trigger:** User opens Settings and changes the theme option
  - **Actors:** End user
  - **Steps:**
    1. User opens Settings panel
    2. User sees the current theme setting (with an indicator of whether it's following system or overridden)
    3. User clicks to switch theme
    4. The theme immediately updates and the preference is saved
  - **Outcome:** Same as F2 — manual override with persistence
  - **Covered by:** R3, R4, R5

- F4. OS preference change while app is open
  - **Trigger:** User changes their OS dark/light setting while the app is running
  - **Actors:** End user
  - **Steps:**
    1. OS setting changes
    2. App detects the change via media query listener
    3. If the user has NOT manually overridden the theme, the app switches to match the new OS preference
    4. If the user HAS manually overridden, the app stays on the overridden theme
  - **Outcome:** System-following users get live updates; overridden users stay in control
  - **Covered by:** R1, R2, R4

---

## Requirements

**Theme system foundation**

- R1. The app shall detect the OS `prefers-color-scheme` setting on initial load and apply the matching theme (dark or light).
- R2. When no manual override has been saved, the app shall continue to follow the OS preference dynamically — changing the OS setting while the app is open updates the theme.
- R3. A user action (header toggle or Settings selection) shall override the OS preference and immediately apply the selected theme.
- R4. The manually selected theme shall be persisted in localStorage and restored on next app load, taking precedence over the OS preference.
- R5. The user shall be able to switch between dark and light themes at any time without a page reload.

**UI surfaces**

- R6. A theme toggle shall be visible in the header/top bar, using a sun/moon (or equivalent) icon that indicates the current theme.
- R7. The Settings panel shall display the current theme state and provide a control to switch between dark and light.
- R8. The Settings panel shall indicate whether the current theme is following the system preference or has been manually overridden.

**Visual design**

- R9. The light theme shall use a warm off-white background palette (not pure white), inspired by apps like Bear and Notion.
- R10. All existing color tokens (backgrounds, surfaces, borders, text, messages) shall have light-theme equivalents that maintain readable contrast and visual hierarchy.
- R11. The orange accent color shall be preserved across both themes; it may be slightly adjusted for light-mode readability if necessary.
- R12. Hardcoded absolute colors currently in use (e.g., `text-white`, `bg-black/40`, red error tones) shall become theme-aware so they render appropriately in both themes.
- R13. Syntax-highlighted code blocks shall use a light highlighting theme when the app is in light mode, and a dark highlighting theme when in dark mode.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given a fresh browser session with OS set to light mode and no saved app preference, when the user opens the app, the UI renders in the light theme.
- AE2. **Covers R1, R2, R4.** Given the app is open in dark mode following the OS, when the user changes their OS to light mode, the app switches to light mode automatically.
- AE3. **Covers R3, R4, R5.** Given the app is following OS light mode, when the user clicks the header theme toggle, the app switches to dark mode, saves the preference, and will load in dark mode on next visit even if the OS is still set to light.
- AE4. **Covers R2, R4.** Given the user has manually selected dark mode, when they change their OS to light mode, the app remains in dark mode.
- AE5. **Covers R13.** Given the app is in light mode, when a message containing a code block is rendered, the code block uses the light syntax highlighting theme.

---

## Success Criteria

- Users can switch between dark and light themes smoothly with immediate visual feedback.
- The app correctly respects OS preference on first visit and dynamically when no override is set.
- The light theme feels intentionally designed (warm, readable, cohesive) rather than like an inverted afterthought.
- A downstream implementer can add the theme system without needing to redesign the color palette or invent interaction behavior.

---

## Scope Boundaries

- Additional color themes beyond dark and light (e.g., high-contrast, sepia, custom user themes).
- An accent color picker or any customization of the primary brand color.
- Animated transitions between themes (e.g., cross-fade on switch).
- Per-component theme overrides or granular color tuning by users.

---

## Key Decisions

- **Warm off-white over pure white:** Chosen for a more distinctive, premium feel that avoids the clinical starkness of pure white backgrounds.
- **Toggle in both header and Settings:** The header provides one-click convenience for frequent switchers; Settings provides context and clarity for users who want to understand the system-preference behavior.
- **System preference as default:** Aligns with modern OS conventions and avoids surprising users on first load.

---

## Dependencies / Assumptions

- The implementation will use CSS custom properties mapped through the existing Tailwind custom color tokens, avoiding a mass refactor of ~200 class usages across components.
- The existing `darkMode: 'class'` Tailwind configuration and hardcoded `class="dark"` on `<html>` will be replaced by a dynamic class-toggling mechanism.
- Shiki syntax highlighter already bundles both `github-dark` and `github-light` themes, so only the selection logic needs to change.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R11][Design] Should the orange accent be identical in both themes, or should it be slightly desaturated/darkened for light mode to maintain comfortable contrast?
- [Affects R10][Technical] Should error/destructive reds use the same hardcoded Tailwind reds in light mode, or should they shift to a slightly different red tone for warm-white backgrounds?
- [Affects R6][Technical] Should the header toggle be a simple icon button or a segmented control (e.g., [sun] [moon])?
