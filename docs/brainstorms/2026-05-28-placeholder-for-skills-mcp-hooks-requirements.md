---
date: 2026-05-28
topic: placeholder-for-skills-mcp-hooks-tabs
---

# Placeholder for Skills, MCP, and Hooks Settings Tabs

## Summary

Replace the current functional content of the Skills, MCP, and Hooks tabs in the settings panel with a "coming soon" placeholder. Include a message directing users to contact spearwang with ideas or requirements.

## Requirements

- R1. The **Skills** tab displays a placeholder instead of the current skill list management UI.
- R2. The **MCP** tab displays a placeholder instead of the current MCP server list management UI.
- R3. The **Hooks** tab displays a placeholder instead of the current hook list management UI.
- R4. Each placeholder communicates that the feature is coming soon and invites users to contact spearwang with ideas or requirements.
- R5. The placeholder uses existing styling conventions and fits within the two-column workspace settings layout.

## Scope Boundaries

- No changes to the data model, server API, or workspace store.
- No changes to tab navigation or tab labels.
- The existing list-management components (SkillsTab, McpTab, HooksTab) may be kept or removed at the implementer's discretion.

## Key Decisions

- **Reuse the existing tab shell:** The left-hand workspace list and right-hand content area remain. Only the inner content of the right-hand area changes.
- **Consistent placeholder across all three tabs:** A single visual pattern reused for Skills, MCP, and Hooks keeps the experience predictable.
