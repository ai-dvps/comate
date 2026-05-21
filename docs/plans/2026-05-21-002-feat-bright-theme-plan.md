---
title: "Bright Theme Support"
type: feat
status: completed
date: 2026-05-21
origin: docs/brainstorms/bright-theme-requirements.md
---

# Bright Theme Support

## Summary

Replace the hardcoded dark-only color system with a CSS custom properties foundation that supports both dark and warm off-white light themes. Add app-level theme state (system-preference default, manual override, localStorage persistence) and surface it via a header quick-toggle and a Settings panel control. Clean up hardcoded absolute colors by introducing semantic tokens.

---

## Problem Frame

The application is permanently dark with no theming mechanism. `tailwind.config.js` defines static hex values, `index.html` hardcodes `class="dark"`, and ~200 component class usages reference custom tokens like `bg-bg` and `text-text-primary`. Users who prefer light UIs or run their OS in light mode have no way to align the app with their preference. The lack of a dynamic theming foundation also blocks any future visual variations.

(see origin: docs/brainstorms/bright-theme-requirements.md)

---

## Requirements

- R1. Detect OS `prefers-color-scheme` on initial load and apply matching theme.
- R2. Follow OS preference dynamically when no manual override is saved.
- R3. User action (header toggle or Settings selection) overrides OS preference immediately.
- R4. Persist manual override in localStorage and restore on next load.
- R5. Switch themes without page reload.
- R6. Theme toggle visible in header with sun/moon icon.
- R7. Settings panel displays current theme state and provides switch control.
- R8. Settings panel indicates whether theme is following system preference or manually overridden.
- R9. Light theme uses warm off-white palette (not pure white).
- R10. All existing color tokens have light equivalents preserving contrast and hierarchy.
- R11. Orange accent preserved; may be adjusted for light-mode readability.
- R12. Hardcoded absolute colors become theme-aware.
- R13. Syntax-highlighted code blocks use light highlighting theme in light mode.

**Origin actors:** End user
**Origin flows:** F1 (First-load theme selection), F2 (Manual toggle from header), F3 (Manual toggle from Settings), F4 (OS preference change while open)
**Origin acceptance examples:** AE1, AE2, AE3, AE4, AE5

---

## Scope Boundaries

- Additional color themes beyond dark and light (high-contrast, sepia, custom).
- Accent color picker or brand color customization.
- Animated transitions between themes.
- Per-component theme overrides or granular user tuning.

---

## Context & Research

### Relevant Code and Patterns

- `tailwind.config.js` — `darkMode: 'class'` with static custom color tokens (`bg`, `surface`, `text-primary`, `accent`, etc.)
- `index.html` — hardcoded `<html lang="en" class="dark">`
- `src/client/index.css` — global CSS with Tailwind directives, hardcoded scrollbar colors (`#333`, `#444`), `.ai-shimmer` with dark hex values
- `src/client/components/ui/button.tsx` and `badge.tsx` — use `bg-accent text-white`, `bg-red-700 text-white`
- `src/client/components/ai-elements/code-block.tsx` — Shiki already bundles `github-light` and `github-dark`; currently forces dark with `dark:!bg-[var(--shiki-dark-bg)]`
- `src/client/components/HeaderToolbar.tsx` — header action buttons
- `src/client/components/SettingsPanel.tsx` — modal with workspace-scoped tabs; no app-level settings storage exists
- `src/client/stores/*` — four Zustand stores, none use persistence

### Institutional Learnings

- `docs/design/ui-ux-design.md` explicitly lists "Light mode theme" as deferred future work
- Current design doc defines static dark CSS custom properties (`--color-bg`, `--color-surface`, etc.) that can be extended to support dual values
- Shiki dual-theme infra is already in place; only the forced-dark override needs removal

---

## Key Technical Decisions

- **CSS custom properties + existing Tailwind token names:** Map `tailwind.config.js` colors to `var(--color-*)` instead of static hex. Define dark values under `.dark` and light values under `:root`/`.light` in `index.css`. This preserves all ~200 existing `bg-bg`, `text-text-primary`, etc. usages without touching every component.
- **App-level React hook, not Zustand store:** Theme preference is client-local and app-scoped (not workspace-scoped). A `useTheme()` hook with `useState` + `localStorage` + `matchMedia` listener is simpler than introducing a new Zustand store or persistence middleware.
- **Semantic token expansion:** Introduce `accent-foreground` (replaces `text-white` on accent surfaces), `overlay` (replaces `bg-black/60` and `bg-black/40`), and `destructive`/`success`/`warning` tokens (replace hardcoded Tailwind semantic colors). This creates a maintainable boundary for future theme work.
- **Single-theme Shiki rendering:** Switch `codeToTokens` from dual `themes: { dark, light }` to a single `theme` parameter based on active app theme, removing the forced `dark:` CSS overrides entirely.

---

## Open Questions

### Resolved During Planning

- **Orange accent in light mode:** Keep identical initially; defer adjustment to implementation if contrast feels off.
- **Header toggle form:** Simple icon button (sun/moon) rather than segmented control.
- **Error/success/warning reds in light mode:** Create semantic tokens (`destructive`, `success`, `warning`) with distinct light values rather than reusing the same Tailwind reds.

### Deferred to Implementation

- **Exact light palette hex values:** Tuned during implementation against actual components; warm off-white direction is fixed.
- **Settings tab placement for theme control:** Likely a new "Appearance" section or within the "general" tab; exact UI determined during component work.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Theme State Lifecycle

```
[App boot]
  └─> Read localStorage theme override key
       ├─> Exists → apply stored theme ('dark' | 'light')
       └─> Missing → read matchMedia('prefers-color-scheme')
              └─> Apply 'dark' or 'light' based on OS

[Runtime]
  ├─> matchMedia listener fires on OS change
  │    └─> If no localStorage override → switch theme
  │    └─> If override exists → ignore
  │
  └─> User clicks toggle
       └─> Toggle theme, write to localStorage, remove system-follow state
```

### CSS Variable Architecture

`tailwind.config.js` colors map to CSS variables:

```
bg: 'var(--color-bg)'
surface: 'var(--color-surface)'
...
```

`index.css` defines values:

```css
:root {
  --color-bg: #f5f0e8;          /* warm off-white example */
  --color-surface: #faf6f0;
  ...
}

.dark {
  --color-bg: #0d0d0d;
  --color-surface: #141414;
  ...
}
```

The `<html>` element carries either `class="dark"` for dark mode or no class for light mode (light values are defined under `:root`). Tailwind's `darkMode: 'class'` continues to work because the `.dark` class is still the trigger.

---

## Implementation Units

### U1. CSS Custom Properties Foundation

**Goal:** Convert the static Tailwind color system to CSS custom properties with dark and light palettes, and make the root `<html>` class dynamic.

**Requirements:** R9, R10, R12

**Dependencies:** None

**Files:**
- Modify: `tailwind.config.js`
- Modify: `src/client/index.css`
- Modify: `index.html`

**Approach:**
- Replace each static hex in `tailwind.config.js` `theme.extend.colors` with `var(--color-<token>)` references.
- Add new semantic tokens: `accent-foreground`, `overlay`, `destructive`, `destructive-foreground`, `success`, `warning`.
- In `index.css`, define the full light palette under `:root` and the dark palette under `.dark`. Define colors as `hsl()` values so Tailwind opacity modifiers (e.g., `bg-bg/50`) continue to work.
- Remove hardcoded `class="dark"` from `index.html` and add a small inline script that reads localStorage/system preference and sets the class before render, preventing a flash of unstyled content.
- Update scrollbar CSS in `index.css` to use theme tokens instead of hardcoded `#333`/`#444`.

**Patterns to follow:**
- Existing custom token naming convention (`text-primary`, `surface-hover`, etc.)

**Test scenarios:**
- Happy path: App loads with `<html class="dark">`; all colors render identically to before the change.
- Happy path: App loads with `<html class="light">`; backgrounds, surfaces, borders, and text shift to light palette values.
- Edge case: Verify that `bg-bg`, `text-text-primary`, and all other existing Tailwind class usages continue to compile and render correctly.

**Verification:**
- Running the app in dark mode is visually unchanged from pre-change state.
- Temporarily setting `<html class="light">` shows the light palette across the app.

---

### U2. Theme State Management

**Goal:** Create the theme state hook with system preference detection, manual override, localStorage persistence, and dynamic OS following.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** U1

**Files:**
- Create: `src/client/hooks/use-theme.ts`
- Modify: `src/client/App.tsx`

**Approach:**
- Create a `useTheme()` hook that manages `'dark' | 'light'` state.
- On mount, check localStorage for a saved preference. If present and valid, apply it. If absent or invalid, clear the corrupt key, read `window.matchMedia('(prefers-color-scheme: dark)')`, and apply the result.
- Add a `matchMedia` change listener that updates theme only when no localStorage override exists. Clean up the listener on unmount.
- Provide `toggleTheme()` and `setTheme()` functions. Calling either writes to localStorage and marks state as overridden.
- Provide `isFollowingSystem` boolean for UI indication.
- In `App.tsx`, call `useTheme()` at the top level and set the `<html>` class dynamically via a `useEffect`.

**Patterns to follow:**
- Existing hook patterns in `src/client/hooks/` (if any); otherwise follow standard React hook conventions used in the codebase.

**Test scenarios:**
- Happy path (F1): Fresh session with OS light → app renders light.
- Happy path (F1): Fresh session with OS dark → app renders dark.
- Happy path (F2): User clicks header toggle → theme switches immediately and localStorage is updated.
- Happy path (F3): User toggles from Settings → theme switches immediately and localStorage is updated.
- Integration (F4): OS changes while app is open + no override → app switches to match.
- Edge case: OS changes while app is open + override exists → app stays on overridden theme.
- Edge case: Invalid/corrupted localStorage value → clear the key and fall back to system preference.

**Verification:**
- localStorage key is written on manual toggle and read correctly on reload.
- System preference changes are reflected live when no override is set.
- `document.documentElement.className` contains `'dark'` or `'light'` matching the active theme.

---

### U3. Header Theme Toggle

**Goal:** Add a sun/moon icon toggle to the header toolbar.

**Requirements:** R6

**Dependencies:** U2

**Files:**
- Modify: `src/client/components/HeaderToolbar.tsx`

**Approach:**
- Import `useTheme()` and Lucide `Sun`/`Moon` icons.
- Add an icon button next to the existing Settings button that shows the icon of the *other* mode (e.g., `Sun` when in dark mode, `Moon` when in light mode) to indicate what clicking will do.
- Call `toggleTheme()` on click.

**Patterns to follow:**
- Existing icon button styling in `HeaderToolbar.tsx` (`text-text-tertiary`, `hover:bg-surface-hover`, etc.)

**Test scenarios:**
- Happy path: Toggle click switches theme and icon updates.

**Verification:**
- Toggle is visible in the header and functional.

---

### U4. Settings Panel Theme Control

**Goal:** Add an explicit theme control to the Settings panel that shows current state and allows switching, with an indicator for system-follow vs override.

**Requirements:** R7, R8

**Dependencies:** U2

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`

**Approach:**
- Import `useTheme()` into the Settings panel.
- Add a theme section (new "Appearance" tab or within existing "general"/"settings" tab) with:
  - Current theme label (Dark / Light)
  - A switch or button group to select theme
  - A "Reset to system preference" option/button visible when overridden
  - Text indicating "Following system preference" vs "Manual selection"
- Theme choice writes via `setTheme()` or `toggleTheme()` from the hook.

**Patterns to follow:**
- Existing Settings panel form patterns (tabs, buttons, labels)

**Test scenarios:**
- Happy path: User sees current theme in Settings.
- Happy path: User switches theme from Settings; UI updates immediately.
- Happy path: After manual override, "Reset to system preference" is visible and functional.

**Verification:**
- Settings panel accurately reflects theme state and system-follow status.

---

### U5. Semantic Token Cleanup

**Goal:** Replace hardcoded absolute colors with theme-aware semantic tokens across the component tree.

**Requirements:** R10, R11, R12

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/ui/button.tsx`
- Modify: `src/client/components/ui/badge.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/SettingsPanel.tsx`
- Modify: `src/client/components/CreateWorkspaceModal.tsx`
- Modify: `src/client/components/MessageList.tsx`
- Modify: `src/client/components/PromptInput.tsx`
- Modify: `src/client/components/FileExplorer.tsx`
- Modify: `src/client/components/FileDrawer.tsx`
- Modify: `src/client/components/SubagentDrawer.tsx`
- Modify: `src/client/components/ai-elements/tool.tsx`
- Modify: `src/client/components/SubagentBriefStatus.tsx`
- Modify: `src/client/components/StatusIndicator.tsx`
- Modify: `src/client/components/ai-elements/message.tsx`
- Modify: `src/client/components/SessionList.tsx`
- Modify: `src/client/components/ApprovalSurface.tsx`
- Modify: `src/client/components/TaskPanel.tsx`
- Modify: `src/client/components/FilePicker.tsx`
- Modify: `src/client/components/Sidebar.tsx`

**Approach:**
- Replace `text-white` on accent/destructive surfaces with `text-accent-foreground` / `text-destructive-foreground`.
- Replace `bg-black/60` and `bg-black/40` modal/drawer overlays with `bg-overlay`.
- Replace hardcoded `red-400`, `red-700`, `green-400`, `amber-500`, `yellow-500` semantic colors with `text-destructive`, `bg-destructive`, `text-success`, `text-warning`, `bg-warning`.
- Replace hardcoded file icon colors (`text-blue-400`, `text-yellow-400`, `text-yellow-600`) with theme-aware tokens or verify they work in both modes.

**Patterns to follow:**
- Existing `cn()` utility for conditional classes
- Existing token naming convention

**Test scenarios:**
- Happy path: All accent buttons remain readable in both themes.
- Happy path: Modal overlays are visible but appropriately tinted in both themes.
- Happy path: Error/success/warning states are clearly distinguishable in both themes.
- Edge case: Verify logo gradient and avatar gradients still look acceptable in light mode.

**Verification:**
- Visual inspection of key components in both dark and light modes shows no broken colors.

---

### U6. Shiki Syntax Highlighting Theme Switching

**Goal:** Make Shiki-rendered code blocks use the light highlighting theme when the app is in light mode.

**Requirements:** R13

**Dependencies:** U1, U2

**Files:**
- Modify: `src/client/components/ai-elements/code-block.tsx`

**Approach:**
- Import the active theme from `useTheme()`.
- Change `codeToTokens` to use a single `theme` parameter (`github-dark` or `github-light`) instead of the dual `themes` object.
- Update the tokens cache key to include the theme name so that switching themes invalidates cached highlighted tokens.
- Remove the `dark:!bg-[var(--shiki-dark-bg)]` and `dark:!text-[var(--shiki-dark)]` forced overrides from `TokenSpan` and `CodeBlockBody`.
- Let Shiki's natural token `color` and `bgColor` values render directly.

**Patterns to follow:**
- Existing Shiki integration in `code-block.tsx`

**Test scenarios:**
- Covers AE5: App in light mode → code block renders with `github-light` colors.
- Happy path: App in dark mode → code block renders with `github-dark` colors.
- Edge case: Verify code block background and text remain readable in both themes.

**Verification:**
- Code blocks display appropriate syntax highlighting in both dark and light modes.

---

### U7. Scrollbar and Animation Theming

**Goal:** Ensure scrollbar styles and the AI shimmer animation respect the active theme.

**Requirements:** R10, R12

**Dependencies:** U1

**Files:**
- Modify: `src/client/index.css`

**Approach:**
- Update the custom scrollbar CSS (`::-webkit-scrollbar-track`, `::-webkit-scrollbar-thumb`) to use theme tokens (`bg-surface-hover`, `border-border`, etc.) instead of hardcoded `#333` and `#444`.
- Update `.ai-shimmer` background gradient to use theme tokens for both the base and shimmer colors.

**Patterns to follow:**
- Existing `index.css` scrollbar and animation definitions

**Test scenarios:**
- Happy path: Scrollbars are visible and styled appropriately in both themes.
- Happy path: AI shimmer animation is visible and styled appropriately in both themes.

**Verification:**
- Scrollbars and shimmer animation look correct in both dark and light modes.

---

## System-Wide Impact

- **Interaction graph:** `useTheme()` is called from `App.tsx` (root), `HeaderToolbar.tsx`, `SettingsPanel.tsx`, and `code-block.tsx`. Changes to the hook's API affect all consumers.
- **Error propagation:** No cross-layer error propagation; theme state is purely client-side UI.
- **State lifecycle risks:** localStorage write on every toggle is safe. Ensure the hook handles SSR/hydration safely if the app ever adds server rendering — currently client-only, so no risk.
- **API surface parity:** No API changes.
- **Integration coverage:** Theme switching while code blocks are rendered must update Shiki highlighting without re-mounting.
- **Unchanged invariants:** Workspace settings (model, API key, skills, MCP, hooks) remain server-persisted and workspace-scoped. Theme is explicitly app-level and client-local.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Mass visual regression from CSS variable migration | Verify dark mode is pixel-identical before shipping light mode; test key components systematically |
| Tailwind opacity modifiers break with CSS variables (e.g., `bg-bg/50`) | Define CSS variables as `hsl()` values so Tailwind opacity modifiers work correctly |
| FOUC on initial load after removing `class="dark"` from `index.html` | Add inline script to `index.html` that reads localStorage/system pref and sets class before React hydrates |
| Shiki theme switching shows stale cached tokens | Include theme name in the tokens cache key so theme changes invalidate the cache |
| Hardcoded color inventory is incomplete | Audit via grep for `text-white`, `bg-black/`, `red-`, `green-`, `amber-`, `yellow-`, `blue-` in `src/client/components` |

---

## Documentation / Operational Notes

- Update `docs/design/ui-ux-design.md` to remove "Light mode theme" from deferred work and document the dual palette.
- Consider adding a brief theming note to any contributor docs explaining the CSS custom property pattern.

---

## Sources & References

- **Origin document:** [docs/brainstorms/bright-theme-requirements.md](docs/brainstorms/bright-theme-requirements.md)
- Related code: `tailwind.config.js`, `src/client/index.css`, `src/client/components/ai-elements/code-block.tsx`
- Related design doc: `docs/design/ui-ux-design.md`
