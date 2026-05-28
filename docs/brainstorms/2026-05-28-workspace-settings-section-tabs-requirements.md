---
date: 2026-05-28
topic: workspace-settings-section-tabs
---

# Workspace Settings Section Tabs

## Summary

Consolidate all workspace-related settings into a single Workspace tab with horizontal section tabs for Basic Info, Model & API, WeCom Bot, Skills, MCP, and Hooks. The existing top-level Skills, MCP, and Hooks tabs are removed.

---

## Problem Frame

The Workspace settings tab has grown into a long scrollable form as more fields were added: basic workspace info, model override, API key, and a full WeCom bot configuration with user lists. Users must scroll through unrelated settings to reach the section they want. Meanwhile, Skills, MCP, and Hooks occupy their own top-level tabs despite having no functional content, adding navigation overhead without value. A flatter, section-based organization inside the Workspace tab would let users jump directly to the settings they need while removing dead tabs.

---

## Requirements

**Section Tabs**

- R1. The Workspace tab displays horizontal section tabs at the top of the content area.
- R2. Section tab labels are: Basic Info, Model & API, WeCom Bot, Skills, MCP, Hooks.
- R3. Clicking a section tab switches the content area to show only that section's settings.
- R4. The active section tab is visually highlighted using existing accent styling conventions.
- R5. The Basic Info section is the default active section when opening Workspace settings.
- R6. Section tab labels are translatable via i18n keys in English and Chinese.

**Section Content**

- R7. The Basic Info section contains: workspace name, description, and folderPath.
- R8. The Model & API section contains: modelOverride and apiKey.
- R9. The WeCom Bot section contains all existing WeCom configuration fields, connection status, and user list.
- R10. The Skills, MCP, and Hooks sections display the existing ComingSoonPlaceholder.

**Top-Level Tab Cleanup**

- R11. The top-level Skills, MCP, and Hooks tabs are removed from the settings modal tab bar.

---

## Success Criteria

- Users can open Workspace settings and immediately navigate to any section without scrolling.
- The settings modal has only three top-level tabs: General, Appearance, Workspace.
- The section tab UI feels consistent with the existing top-level tab styling.

---

## Scope Boundaries

- No changes to the workspace data model, server API, or persistence.
- No new functionality added to Skills, MCP, or Hooks — they remain placeholders.
- General and Appearance tabs stay unchanged.
- No changes to the WorkspaceTabShell two-column layout (workspace list on left, content on right).

---

## Key Decisions

- Six explicit section tabs rather than fewer grouped ones: each logical concern gets its own tab for direct findability.
- Skills/MCP/Hooks remain placeholder-only and move into workspace section tabs rather than having standalone top-level tabs.
