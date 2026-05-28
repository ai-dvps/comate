---
title: Workspace Settings Section Tabs
type: feat
status: completed
date: 2026-05-28
origin: docs/brainstorms/2026-05-28-workspace-settings-section-tabs-requirements.md
---

# Workspace Settings Section Tabs

## Summary

Split the monolithic Workspace settings form into six horizontal section tabs (Basic Info, Model & API, WeCom Bot, Skills, MCP, Hooks) inside the Workspace tab. Remove the standalone Skills, MCP, and Hooks top-level tabs. The section tab state is local and resets to Basic Info on workspace switch.

---

## Problem Frame

The Workspace settings tab has grown into a long scrollable form as more fields were added: basic workspace info, model override, API key, and a full WeCom bot configuration with user lists. Users must scroll through unrelated settings to reach the section they want. Meanwhile, Skills, MCP, and Hooks occupy their own top-level tabs despite having no functional content, adding navigation overhead without value.

---

## Requirements

- R1. The Workspace tab displays horizontal section tabs at the top of the content area.
- R2. Section tab labels are: Basic Info, Model & API, WeCom Bot, Skills, MCP, Hooks.
- R3. Clicking a section tab switches the content area to show only that section's settings.
- R4. The active section tab is visually highlighted using existing accent styling conventions.
- R5. The Basic Info section is the default active section when opening Workspace settings.
- R6. Section tab labels are translatable via i18n keys in English and Chinese.
- R7. The Basic Info section contains: workspace name, description, and folderPath.
- R8. The Model & API section contains: modelOverride and apiKey.
- R9. The WeCom Bot section contains all existing WeCom configuration fields, connection status, and user list.
- R10. The Skills, MCP, and Hooks sections display the existing ComingSoonPlaceholder.
- R11. The top-level Skills, MCP, and Hooks tabs are removed from the settings modal tab bar.

**Origin actors:** End user configuring a workspace

---

## Scope Boundaries

- No changes to the workspace data model, server API, or persistence.
- No new functionality added to Skills, MCP, or Hooks — they remain placeholders.
- General and Appearance tabs stay unchanged.
- No changes to the WorkspaceTabShell two-column layout (workspace list on left, content on right).
- No test framework added — verification is manual.

### Deferred to Follow-Up Work

- Adding actual functionality to Skills, MCP, or Hooks sections.
- Persisting last-selected section per workspace.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/SettingsPanel.tsx` — Contains the settings modal, top-level tab state (`activeTab`), `WorkspaceTabShell`, and the monolithic `WorkspaceDetailsTab` inline component.
- Existing top-level tabs use a horizontal flex row with `border-b-2 border-accent` for active state and `text-[11px]` font size.
- `WorkspaceTabShell` renders a two-column layout: 256px workspace list (`w-64 border-r`) + scrollable right content area.
- Form state lives in `SettingsPanel` and is passed down via props; dirty tracking compares full state against a snapshot.
- `src/client/i18n/en/settings.json` and `zh-CN/settings.json` use dot-notation nested keys.

### Institutional Learnings

- The codebase commits plan and brainstorm files alongside code changes (`docs/solutions/conventions/commit-plan-and-brainstorm-files-with-code-changes.md`).
- Read-only fields are presented as plain text with helper text rather than disabled inputs.
- When scrollable content inside flex collapses, `absolute inset-0` is preferred over `h-full`, and `min-h-0` is often required.

---

## Key Technical Decisions

- Section tab state is local to `WorkspaceTabShell` and resets to Basic Info on workspace switch or settings reopen — no per-workspace persistence. This keeps the implementation simple and avoids surprising users with stale section state.
- `WorkspaceDetailsTab` is split into three focused section components rather than conditionally rendering parts of a monolithic component. This improves maintainability as each section grows independently.

---

## Implementation Units

### U1. Extract section components from WorkspaceDetailsTab

**Goal:** Split the monolithic `WorkspaceDetailsTab` into three focused section components without changing UI behavior.

**Requirements:** R7, R8, R9

**Dependencies:** None

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`

**Approach:**
- Extract `BasicInfoSection` (name, description, folderPath)
- Extract `ModelApiSection` (modelOverride, apiKey)
- Extract `WeComBotSection` (all WeCom config, status, users)
- Each component receives the same props pattern as existing tab components (`state`, `onUpdate`)
- Keep all styling identical — no visual changes at this stage
- Move the WeCom-specific `useEffect` hooks (bot status polling, user list fetching) into `WeComBotSection`
- Temporarily render all three extracted components in sequence inside `WorkspaceDetailsTab` so the UI is unchanged
- After U2, `WorkspaceDetailsTab` is replaced by the section tab system inside `WorkspaceTabShell`; the extracted section components become the direct children

**Patterns to follow:**
- Existing form field pattern in `WorkspaceDetailsTab`
- Existing read-only field pattern for `folderPath`
- Existing WeCom section layout with `border-t` dividers

**Test scenarios:**
- Happy path: All workspace fields render identically before and after extraction
- Integration: Form state updates propagate correctly through extracted components
- Integration: The Save action still persists all workspace fields correctly

**Verification:**
- Opening Workspace settings shows the exact same form as before
- TypeScript and ESLint pass

---

### U2. Add workspace section tabs

**Goal:** Add horizontal section tabs within the Workspace tab and wire all six sections.

**Requirements:** R1, R2, R3, R4, R5, R10

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`

**Approach:**
- Add `WorkspaceSection` type: `'basic' | 'model' | 'wecom' | 'skills' | 'mcp' | 'hooks'`
- Add local state for `activeSection` inside `WorkspaceTabShell`
- Render section tab bar at the top of the right content area using the existing top-level tab styling pattern (`border-b`, `border-accent` for active)
- Use a flex column layout so the section tab bar stays fixed and only the section content scrolls (`flex flex-col` wrapper, tabs as `flex-shrink-0`, content as `flex-1 overflow-y-auto`)
- Basic Info is the default active section
- Render the appropriate section component based on `activeSection`
- Skills, MCP, and Hooks sections reuse the existing `ComingSoonPlaceholder`

**Patterns to follow:**
- Existing top-level tab rendering pattern in `SettingsPanel`
- Existing `WorkspaceTabShell` two-column layout

**Test scenarios:**
- Happy path: Opening Workspace settings shows Basic Info section by default
- Happy path: Clicking each section tab switches to the correct content
- Edge case: Switching between workspaces resets the active section to Basic Info
- Edge case: Reopening the settings modal resets the active section to Basic Info
- Edge case: Section tabs are hidden when no workspace is selected (existing empty-state behavior)
- Edge case: Clicking Save while viewing a placeholder section persists any changes made in other sections
- Edge case: Closing settings with unsaved changes while on a placeholder section triggers the confirmation dialog normally

**Verification:**
- All six section tabs are visible and clickable
- Active tab is visually highlighted
- Content area switches correctly between sections
- TypeScript and ESLint pass

---

### U3. Remove top-level Skills/MCP/Hooks tabs and add i18n

**Goal:** Clean up the top-level tab bar and add translations for section labels.

**Requirements:** R6, R11

**Dependencies:** U2

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:**
- Remove `'skills'`, `'mcp'`, `'hooks'` from the `SettingsTab` type
- Remove them from the tabs array and `isWorkspaceTab` logic
- Add a guard in `useEffect` to reset `activeTab` to `'workspace'` if it holds a removed value (handles hot-reload / stale state)
- Add i18n keys for section tab labels (e.g., `workspaceSections.basic`, `workspaceSections.model`, etc.) in both English and Chinese
- Remove unused `tabs.skills`, `tabs.mcp`, `tabs.hooks` i18n keys from both translation files
- Update any conditional rendering that references the old tab IDs

**Patterns to follow:**
- Existing i18n key conventions (dot-notation, both languages updated together)
- Existing tab label pattern

**Test scenarios:**
- Happy path: Settings modal shows only General, Appearance, and Workspace tabs
- Happy path: Section tab labels display correctly in English and Chinese
- Edge case: No references to old top-level tab IDs remain in the component

**Verification:**
- Only three top-level tabs remain in the settings modal
- Section tab labels are translated in both languages
- TypeScript and ESLint pass

---

## System-Wide Impact

- **Interaction graph:** The settings modal tab state (`activeTab`) shrinks from 6 values to 3. `WorkspaceTabShell` gains a new local state layer for section tabs. No callbacks, middleware, or observers affected.
- **Error propagation:** No new error paths introduced — this is a pure UI reorganization.
- **State lifecycle risks:** None. Section tab state is ephemeral local state.
- **API surface parity:** No API changes.
- **Unchanged invariants:** The workspace form state shape, dirty tracking snapshot comparison, save/cancel behavior, and explicit-save confirmation dialog are all untouched.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Extracting the large inline `WorkspaceDetailsTab` introduces a subtle prop-drilling or state-update bug | Keep the same props interface for all extracted sections; verify Save still works after each unit |
| Horizontal section tabs feel crowded with 6 items | Use the same compact styling as top-level tabs (`text-[11px]`); if wrapping occurs on small screens, it is acceptable |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-28-workspace-settings-section-tabs-requirements.md](docs/brainstorms/2026-05-28-workspace-settings-section-tabs-requirements.md)
- Related code: `src/client/components/SettingsPanel.tsx`
- Related plans: `docs/plans/2026-05-28-006-feat-skills-mcp-hooks-placeholder-plan.md`
