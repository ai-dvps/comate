---
date: 2026-05-28
topic: wecom-config-into-workspace-tab
---

# Move WeCom Bot Config into Workspace Settings Tab

## Summary

Consolidate the standalone "WeCom Bot" settings tab into the existing "Workspace" tab. The WeCom configuration fields (enable toggle, Bot ID, Bot Secret, Corp ID, Corp Secret, status, and user list) currently live in a separate tab and should appear as an additional section within the workspace details panel.

## Problem Frame

The WeCom bot configuration is workspace-scoped — every field (`wecomBotEnabled`, `wecomBotId`, `wecomBotSecret`, `wecomCorpId`, `wecomCorpSecret`) already lives on `WorkspaceSettings`. Presenting it as a separate top-level tab creates an extra navigation step and fragments the workspace configuration experience. Users expect all per-workspace settings to be discoverable in one place.

## Requirements

- R1. Remove the "WeCom Bot" top-level tab from the settings panel.
- R2. Add the WeCom bot configuration section to the bottom of the existing "Workspace" tab content.
- R3. Preserve all existing WeCom fields and behaviors: enable toggle, Bot ID/Secret inputs (with show/hide), Corp ID/Secret inputs (with show/hide), live connection status polling, and the workspace user list.
- R4. Preserve dirty-state tracking: changes to WeCom fields contribute to the global unsaved-changes indicator and confirmation dialog.
- R5. Preserve save behavior: WeCom fields are persisted via the existing `updateWorkspace` call alongside other workspace fields.

## Scope Boundaries

- No changes to the workspace data model or server API.
- No changes to WeCom bot service logic, routes, or polling behavior.
- No changes to the workspace tabs bot-status indicators.

## Key Decisions

- **Append to Workspace tab rather than interleave:** The WeCom section appears after the existing workspace fields (name, description, model override, API key) with a visual separator, keeping the primary workspace metadata at the top.
- **Keep live status and user list:** The status polling and user list that currently exist in `WeComBotTab` move together as a unit into the workspace tab.

## Dependencies

- The existing workspace settings page refactor (2026-05-21) is complete and stable.
