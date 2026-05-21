---
title: Workspace Settings Page
type: feat
status: active
date: 2026-05-21
origin: docs/brainstorms/2026-05-21-workspace-settings-page-requirements.md
---

# Workspace Settings Page

## Summary

Refactor the existing `SettingsPanel` modal into a full-screen settings overlay with top-tab navigation. App-level settings (default model, startup behavior, theme) use a new localStorage-backed hook. Workspace-specific tabs (Workspace, Skills, MCP, Hooks) share a two-column layout with an independent workspace selector. All changes require explicit Save, with dirty-state tracking and an unsaved-changes confirmation on close.

---

## Problem Frame

The current `SettingsPanel` is a cramped modal that struggles to fit five tabs of dense configuration. Workspace list management (Skills, MCP, Hooks) needs more vertical space, and there is no place for app-level preferences such as a default AI model or startup behavior. Users also cannot edit a non-active workspace's settings without switching the main view context. (see origin: docs/brainstorms/2026-05-21-workspace-settings-page-requirements.md)

---

## Requirements

- R1. Settings opens as a full-screen overlay covering the entire app.
- R2. A close button returns to the main app view.
- R3. Top tabs: General, Appearance, Workspace, Skills, MCP, Hooks.
- R4. Active tab is visually indicated.
- R6. General tab contains default AI model input and startup behavior toggle.
- R7. Appearance tab contains theme selection (light / dark / system).
- R9. Workspace, Skills, MCP, and Hooks tabs show a two-column layout.
- R10. Left column lists all workspaces; selected workspace is highlighted.
- R11. Clicking a workspace loads its settings in the right column.
- R12. Right column shows workspace-specific settings for the selected workspace.
- R13. Empty state when no workspaces exist.
- R15. All tabs follow explicit Save pattern.
- R16. Save button commits changes; Cancel discards.
- R17. Close with unsaved changes shows confirmation dialog.
- R18. App-level settings persist across sessions.
- R20. Header gear icon opens the settings overlay.
- R21. Settings accessible even when no workspace is active.
- R22. Header theme toggle remains functional and synced with Appearance tab.

**Origin flows:** F1 (Open and edit app-level settings), F2 (Edit workspace MCP without switching main view), F3 (Close with unsaved changes)

**Origin acceptance examples:** AE1 (General tab on open), AE2 (Skills two-column edit), AE3 (Empty state for no workspaces), AE4 (Unsaved changes confirmation)

---

## Scope Boundaries

- No routing or URL changes.
- No keyboard shortcuts configuration.
- No CLI path or custom API endpoint settings.
- No data management features (export, import, clear cache, reset).
- No per-workspace appearance overrides.
- No workspace creation from within the settings page.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/SettingsPanel.tsx` — Existing modal with 5 tabs, local form state, explicit save via `updateWorkspace`. Uses `fixed inset-0 z-50` overlay, `bg-surface border border-border rounded-xl shadow-2xl` card shell.
- `src/client/hooks/use-theme.ts` — App-level theme hook using `localStorage` under key `theme`. Exposes `theme`, `isFollowingSystem`, `setTheme`, `toggleTheme`, `resetToSystem`.
- `src/client/App.tsx` — Conditionally renders `SettingsPanel` when `activeWorkspaceId` is truthy. `showSettings` boolean controls visibility.
- `src/client/components/HeaderToolbar.tsx` — Gear icon calls `onOpenSettings`; disabled when `!canOpenSettings`.
- `src/client/stores/workspace-store.ts` — Zustand store with `workspaces`, `activeWorkspaceId`, `updateWorkspace`.
- `src/server/models/workspace.ts` — `WorkspaceSettings` holds `model?`, `apiKey?`, `maxTokens?`, `temperature?`.
- `src/server/storage/sqlite-store.ts` — JSON columns for flexible nested data (settings, skills, mcpServers, hooks).
- `src/client/components/CreateWorkspaceModal.tsx` — Modal shell pattern with `Escape` to close, `Enter` to submit, backdrop click to close.

### Institutional Learnings

- Theme is kept app-scoped and client-local (not in Zustand) because no existing Zustand store uses persistence. A lightweight `useState` + `localStorage` + `matchMedia` listener is the established pattern.
- The existing `SettingsPanel` demonstrates the team's form-state pattern: local `useState` mirrors workspace data loaded via `useEffect`, with explicit save calling `updateWorkspace`.
- List management for Skills, MCP, and Hooks uses inline add/remove with local state arrays, converted to API-compatible shapes on save (e.g., `args` string split into array).

---

## Key Technical Decisions

- **App-level settings use localStorage:** Consistent with the existing `useTheme` hook. No server-side user model exists, and these are personal preferences that do not need cross-device sync in a single-user desktop app.
- **Form state lives in the settings shell component, passed to tabs via props:** Enables global dirty tracking across all tabs and a single Save action that commits everything. Each tab receives its slice of state and a setter.
- **Refactor `SettingsPanel.tsx` in place rather than creating a new component:** Minimizes churn. The existing file already contains the tab content logic for Skills, MCP, and Hooks, which can be preserved and reorganized.
- **Workspace selection in settings is local state, not tied to `activeWorkspaceId`:** Satisfies the requirement to edit any workspace without switching the main app's context.
- **Dirty tracking uses deep comparison of the full settings state object:** A simple deep-equal check between current state and the last saved (or initial) state is sufficient. The state shape is bounded and not deeply nested beyond arrays of objects.

---

## Open Questions

### Resolved During Planning

- **App-level settings persistence mechanism:** localStorage, mirroring the `useTheme` hook pattern.

### Deferred to Implementation

- **Validation rules for settings fields:** The current modal has no validation. Whether to add minimal validation (e.g., required workspace name) is deferred to the implementing agent's judgment.
- **Behavior when switching workspaces within settings while dirty:** The requirements do not specify. The implementing agent should choose between warning before switch or silently carrying unsaved changes per-workspace. Either is acceptable; consistency with the close behavior (warn) is preferred.

---

## Implementation Units

### U1. Create app-level settings hook

**Goal:** Create a reusable hook for app-level settings with localStorage persistence.

**Requirements:** R6, R18

**Dependencies:** None

**Files:**
- Create: `src/client/hooks/use-app-settings.ts`

**Approach:**
- Mirror the `useTheme` hook pattern: `useState` for in-memory state, `useEffect` to hydrate from `localStorage` on mount, and a setter that writes to `localStorage`.
- Settings to persist: `defaultModel` (string, empty means "use system default") and `reopenLastWorkspace` (boolean).
- Expose: `defaultModel`, `setDefaultModel`, `reopenLastWorkspace`, `setReopenLastWorkspace`.
- Handle corrupt/missing localStorage gracefully with safe defaults.

**Patterns to follow:**
- `src/client/hooks/use-theme.ts`

**Test scenarios:**
- Test expectation: none -- no test infrastructure exists in the project

**Verification:**
- Hook reads `localStorage` key on mount and falls back to safe defaults when absent or corrupt.
- Setter updates `localStorage` immediately.
- State persists across browser reloads.

---

### U2. Build full-screen settings overlay shell with form state, dirty tracking, and save behavior

**Goal:** Refactor the existing modal into a full-screen overlay with tab navigation, global form state, dirty tracking, and explicit save/cancel/close behavior.

**Requirements:** R1, R2, R3, R4, R5, R15, R16, R17

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`

**Approach:**
- Replace the centered `max-w-lg max-h-[80vh]` card with a full-viewport layout: the overlay fills the screen, the content area fills available space.
- Keep the tab bar at the top but extend it to full width. Keep the close X in the header.
- Add a persistent footer with Cancel and Save buttons.
- Hold all form state in the shell: app settings (from `useAppSettings`) and workspace settings (from the Zustand store). Initialize on open.
- Track dirty state by deep-comparing current state against the initial/saved snapshot.
- Intercept close actions (X click, backdrop click, Escape key) when dirty: show a confirmation dialog with "Save changes", "Discard", and "Cancel" options.
- Save handler commits app settings to localStorage and workspace settings via `updateWorkspace`, then resets the dirty snapshot.
- Cancel handler discards all changes by resetting state to the snapshot, then closes.

**Patterns to follow:**
- Existing `SettingsPanel` tab rendering and `handleSave` logic
- `CreateWorkspaceModal` Escape key handling

**Test scenarios:**
- Happy path: Open settings, edit a field, click Save. Changes persist and overlay closes.
- Happy path: Open settings, edit a field, click Cancel. Changes are discarded and overlay closes.
- Edge case: Close (X) with dirty state shows confirmation dialog.
- Edge case: Clicking backdrop with dirty state shows confirmation dialog.
- Edge case: Pressing Escape with dirty state shows confirmation dialog.
- Edge case: Dialog "Cancel" returns to settings without closing.

**Verification:**
- Overlay opens full-screen and returns to the main app on close.
- Tab switching works without triggering dirty confirmation (only close actions do).
- Save/Cancel buttons behave correctly for both app-level and workspace-level changes.

---

### U3. Implement General and Appearance app-level tabs

**Goal:** Build the General and Appearance tab content using the shell's app-settings state.

**Requirements:** R6, R7, R8

**Dependencies:** U2

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`

**Approach:**
- General tab: default model text input (bound to shell's app state), startup behavior toggle (`reopenLastWorkspace` boolean).
- Appearance tab: theme selection buttons (light / dark / system) using `useTheme()`. Show current selection. Include "Reset to system" link when manual override is active, mirroring the existing `ThemeSettings` subcomponent.
- Both tabs receive their state slice and setter from the shell via props or context.
- The header's theme quick-toggle and the Appearance tab must remain in sync because both read from the same `useTheme` hook.

**Patterns to follow:**
- Existing `ThemeSettings` subcomponent in `SettingsPanel.tsx`
- Input styling: `w-full px-3 py-2 text-sm bg-bg border border-border rounded-lg focus:outline-none focus:border-accent text-text-primary`

**Test scenarios:**
- Happy path: General tab shows current default model and startup toggle values.
- Happy path: Appearance tab shows the active theme (light/dark/system) correctly.
- Happy path: Changing theme in Appearance updates the app theme immediately (or on Save, depending on chosen behavior -- recommend on Save for consistency).
- Edge case: Empty default model field is valid and means "use system default."

**Verification:**
- General and Appearance tabs render correctly when no workspace is active.
- Changes to these tabs contribute to the global dirty state.
- Theme selection in Appearance matches the header toggle state.

---

### U4. Build two-column workspace settings with workspace-specific tabs

**Goal:** Create the two-column layout for workspace tabs and port the existing tab content (Workspace, Skills, MCP, Hooks) into it.

**Requirements:** R9, R10, R11, R12, R13, R14

**Dependencies:** U2

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`

**Approach:**
- For workspace-specific tabs, render a two-column layout: a fixed-width left sidebar listing all workspaces, and a flexible right panel for the active tab's content.
- The workspace list reads from the Zustand `workspaces` array. The selected workspace ID is local state within the settings component, defaulting to the first workspace or the main app's `activeWorkspaceId` when available.
- Clicking a workspace in the left column selects it and loads its settings into the right panel.
- When no workspaces exist, show an empty state message instead of the two-column layout.
- Right panel content:
  - **Workspace:** name input, description textarea, folder path (read-only), model override input, API key input (with show/hide toggle).
  - **Skills:** add input + button, list with remove buttons.
  - **MCP:** name input, command input, args input, add button, list with remove buttons. Convert args between space-separated string (UI) and string array (API) at the component boundary, preserving existing behavior.
  - **Hooks:** name input, script path input, add button, list with remove buttons.
- Preserve all existing list-management logic from the current `SettingsPanel` tabs.

**Patterns to follow:**
- Existing `SettingsPanel` skills/mcp/hooks tab content
- `Sidebar` two-column layout in `App.tsx`
- Empty state pattern: centered text with `text-text-tertiary`

**Test scenarios:**
- Happy path: Left column shows all workspaces; clicking one highlights it and shows its settings.
- Happy path: Adding a skill in the Skills tab and saving persists it to the selected workspace.
- Happy path: Editing workspace name and saving updates the workspace.
- Edge case: No workspaces exist -- workspace tabs show "No workspaces yet" empty state.
- Edge case: Selected workspace in settings differs from main app's active workspace; saving does not switch the main view.
- Edge case: MCP args field accepts space-separated string and converts to array on save.

**Verification:**
- All four workspace tabs display correctly with the two-column layout.
- Workspace selection is independent from the main app's active workspace.
- List add/remove works for Skills, MCP, and Hooks.
- Save persists workspace changes correctly.

---

### U5. Update App.tsx and HeaderToolbar integration

**Goal:** Remove the active-workspace restriction so settings opens at any time, and ensure the header theme toggle stays functional.

**Requirements:** R20, R21, R22

**Dependencies:** U2

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/HeaderToolbar.tsx`

**Approach:**
- In `App.tsx`: Always render `SettingsPanel` when `showSettings` is true, regardless of `activeWorkspaceId`. Remove the `activeWorkspaceId &&` guard on the `SettingsPanel` render.
- In `HeaderToolbar.tsx`: Remove the `canOpenSettings` prop (or make it always true). The gear icon should always be clickable. Remove the `disabled={!canOpenSettings}` logic.
- The `SettingsPanel` component signature changes: instead of requiring `workspaceId: string`, it may accept no workspace prop since it manages its own workspace selection internally. Alternatively, keep the prop as an optional hint for the default selected workspace.
- Verify the header theme toggle (`toggleTheme` from `useTheme`) still works and the Appearance tab reflects the change.

**Patterns to follow:**
- Existing conditional rendering in `App.tsx`

**Test scenarios:**
- Happy path: Clicking the gear icon opens settings when no workspace is active.
- Happy path: App-level tabs (General, Appearance) are functional with no workspaces.
- Happy path: Header theme toggle changes theme; opening settings shows the updated theme in Appearance.
- Edge case: Workspace tabs show empty state when no workspaces exist.

**Verification:**
- Settings opens with or without an active workspace.
- Header gear icon is never disabled.
- Theme toggle and Appearance tab remain in sync.

---

## System-Wide Impact

- **Interaction graph:** `App.tsx` removes the `activeWorkspaceId` guard for `SettingsPanel`. `HeaderToolbar` removes the `canOpenSettings` restriction. The `useTheme` hook gains a second consumer (Appearance tab) but its contract is unchanged.
- **Error propagation:** Save failures from `updateWorkspace` should surface in the UI (e.g., a toast or inline error) without closing the settings overlay. The current modal closes on save regardless of success; this should be improved.
- **State lifecycle risks:** The settings overlay holds a snapshot of workspace data at open time. If another process modifies a workspace while settings is open, the save could overwrite those changes. This is acceptable for a single-user desktop app and matches current behavior.
- **Unchanged invariants:** The workspace data model (`WorkspaceSettings`, `skills`, `mcpServers`, `hooks`) and the server API (`PUT /api/workspaces/:id`) remain unchanged. The SQLite schema is untouched.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Large refactor of `SettingsPanel.tsx` (~440 lines) risks regressing existing tab content | Preserve existing Skills/MCP/Hooks list logic during reorganization; verify all tabs manually |
| No test infrastructure exists to catch regressions | Manual verification of all tabs, save/cancel, dirty state, and empty states |
| Dirty tracking with nested array state (skills, MCP, hooks) may miss changes or produce false positives | Use structured deep comparison (e.g., `JSON.stringify` or a deep-equal helper) for the bounded state shape |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-21-workspace-settings-page-requirements.md](docs/brainstorms/2026-05-21-workspace-settings-page-requirements.md)
- Related code: `src/client/components/SettingsPanel.tsx`, `src/client/hooks/use-theme.ts`, `src/client/App.tsx`, `src/client/stores/workspace-store.ts`
