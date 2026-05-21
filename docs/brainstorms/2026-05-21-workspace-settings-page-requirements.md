---
date: 2026-05-21
topic: workspace-settings-page
---

# Workspace Settings Page

## Summary

Replace the workspace settings modal with a full-screen settings overlay. Top tabs organize app-level settings (General, Appearance) and workspace-specific settings (Workspace, Skills, MCP, Hooks). Workspace tabs use a two-column layout with a workspace list and a settings panel. All changes require an explicit Save.

---

## Problem Frame

The current `SettingsPanel` is a small modal with five tabs of dense configuration. Workspace-specific tabs — Skills, MCP, and Hooks — each need vertical space for list management with add/remove flows, and the modal feels cramped. There is also no place for app-level settings such as a default AI model or startup behavior. Theme configuration currently lives only as a quick toggle in the header with no explanation or system-preference option visible in the UI. Users need a dedicated, spacious settings experience that separates global preferences from per-workspace configuration and supports editing any workspace without switching the main app's context.

---

## Key Flows

- F1. Open and edit app-level settings
  - **Trigger:** User clicks the gear icon in the header toolbar
  - **Actors:** User
  - **Steps:** Settings overlay opens on the General tab. User switches to Appearance. User selects a theme option. User clicks Save. Overlay closes.
  - **Outcome:** Theme preference is saved and applied immediately
  - **Covered by:** R1, R3, R7, R15, R16, R20

- F2. Edit a workspace's MCP servers without switching the main view
  - **Trigger:** User opens settings and clicks the MCP tab
  - **Actors:** User
  - **Steps:** Left column shows all workspaces. User clicks a non-active workspace. Right column shows its MCP servers. User adds a new server with name, command, and args. User clicks Save.
  - **Outcome:** The MCP server is added to the selected workspace; the main app's active workspace remains unchanged
  - **Covered by:** R9, R10, R11, R12, R14, R19

- F3. Close settings with unsaved changes
  - **Trigger:** User edits a field and clicks the X close button
  - **Actors:** User
  - **Steps:** A confirmation dialog appears with "Save changes" and "Discard" options. User clicks "Save changes." Changes are persisted and the overlay closes.
  - **Outcome:** Changes are saved; if the user clicked "Discard," changes are lost and the overlay closes
  - **Covered by:** R15, R17

---

## Requirements

**Page structure and navigation**

- R1. Settings opens as a full-screen overlay covering the entire app.
- R2. A close button (X) in the header area returns to the main app view.
- R3. Top tabs across the page: General, Appearance, Workspace, Skills, MCP, Hooks.
- R4. The active tab is visually indicated.
- R5. Tab state persists for the duration of the settings session.

**App-level settings**

- R6. General tab contains: default AI model input and a startup behavior toggle (reopen last workspace on launch).
- R7. Appearance tab contains: theme selection (light / dark / system) with the current selection indicated.
- R8. Changes in app-level tabs follow the explicit Save pattern defined in R15–R17.

**Workspace settings**

- R9. Workspace, Skills, MCP, and Hooks tabs each show a two-column layout.
- R10. Left column lists all workspaces by name; the selected workspace is highlighted.
- R11. Clicking a workspace in the left column loads its settings in the right column.
- R12. The right column shows the relevant settings for the selected workspace:
  - Workspace: name, description, folder path (read-only), model override, API key.
  - Skills: list with add/remove.
  - MCP: list with add/remove (name, command, args).
  - Hooks: list with add/remove (name, script path).
- R13. When no workspaces exist, workspace tabs show an empty state prompting workspace creation.
- R14. Workspace settings in the right column are independent from the main app's active workspace selector.

**Save behavior**

- R15. All settings tabs follow an explicit Save pattern.
- R16. A Save button at the bottom of the page commits changes; a Cancel button discards them.
- R17. Attempting to close settings with unsaved changes shows a confirmation dialog.
- R18. Saved app-level settings persist across sessions.
- R19. Saved workspace settings update the workspace data model.

**Integration**

- R20. The header toolbar gear icon opens the full settings overlay.
- R21. Settings is accessible even when no workspace is active; app-level tabs remain functional.
- R22. The header theme quick-toggle remains functional and its state is reflected in the Appearance tab.

---

## Acceptance Examples

- AE1. **Covers R1, R3, R6.** Given the user clicks the gear icon, the full-screen settings overlay opens with the General tab active, showing default model and startup behavior fields.
- AE2. **Covers R9, R10, R11.** Given the user is on the Skills tab, they see a list of all workspaces on the left. Clicking a workspace loads its skills list on the right. Adding a skill and clicking Save persists it to that workspace.
- AE3. **Covers R13.** Given no workspaces exist, the user opens settings and clicks the Workspace tab. They see an empty state such as "No workspaces yet" instead of a workspace list.
- AE4. **Covers R15, R17.** Given the user edits a workspace name and clicks the X to close, a confirmation dialog asks whether to save or discard changes.

---

## Success Criteria

- Settings page provides enough space for comfortable editing of MCP servers, hooks, and skills lists.
- Users can access and modify app-level settings without an active workspace.
- Workspace settings can be edited without switching the main app's active workspace.
- No accidental data loss: unsaved changes trigger a confirmation before closing.

---

## Scope Boundaries

- No routing or URL changes.
- No keyboard shortcuts configuration.
- No CLI path or custom API endpoint settings.
- No data management features (export, import, clear cache, reset).
- No per-workspace appearance overrides.
- No workspace creation from within the settings page.

---

## Key Decisions

- **Full-screen overlay instead of expanding the modal:** The two-column workspace layout needs horizontal and vertical space that a modal cannot comfortably provide.
- **Explicit Save instead of auto-save:** Avoids accidental workspace configuration changes, especially for API keys and MCP server definitions.
- **Workspace list in settings is independent from the main app's active workspace:** Lets users edit any workspace without context-switching the main view.
- **App-level and workspace settings coexist in one overlay:** Eliminates the need for separate settings entry points and keeps the mental model simple.

---

## Dependencies / Assumptions

- The existing workspace data model (name, description, settings, skills, mcpServers, hooks) persists as-is.
- The existing `useTheme` hook and localStorage-based theme storage continue to work.
- App-level settings need a new persistence mechanism (localStorage or server-side storage).
