---
title: Move WeCom Bot Config into Workspace Tab
type: refactor
status: completed
date: 2026-05-28
origin: docs/brainstorms/2026-05-28-wecom-config-into-workspace-tab-requirements.md
---

# Move WeCom Bot Config into Workspace Tab

## Summary

Remove the standalone "WeCom Bot" settings tab and move its contents into the existing "Workspace" tab within `SettingsPanel.tsx`.

## Problem Frame

The WeCom bot configuration is workspace-scoped but currently presented as a separate top-level tab, fragmenting the workspace configuration experience. Consolidating it into the Workspace tab keeps all per-workspace settings in one place.

## Requirements

- R1. Remove the "WeCom Bot" top-level tab from the settings panel.
- R2. Add the WeCom bot configuration section to the bottom of the existing "Workspace" tab content.
- R3. Preserve all existing WeCom fields and behaviors.
- R4. Preserve dirty-state tracking for WeCom fields.
- R5. Preserve save behavior for WeCom fields.

## Scope Boundaries

- No data model or API changes.
- No WeCom service logic changes.
- No workspace tab bot-status indicator changes.

## Implementation Units

### U1. Consolidate WeCom config into Workspace tab

**Goal:** Remove the standalone `wecom` tab and move its UI into the `WorkspaceDetailsTab` component.

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`

**Approach:**
- Remove `'wecom'` from the `SettingsTab` union type.
- Remove the `wecom` entry from the `tabs` array.
- Update `isWorkspaceTab` to no longer include `'wecom'`.
- Inline the WeCom configuration section (enable toggle, Bot ID/Secret, Corp ID/Secret, status, user list) into `WorkspaceDetailsTab`, placed after the existing fields with a visual separator.
- Preserve all live polling logic (status and users fetching) within the combined component.
- Remove the now-unused `WeComBotTab` component.

**Test scenarios:**
- Happy path: Opening the Workspace tab shows name, description, model, API key, and the WeCom section below.
- Happy path: Editing WeCom fields and clicking Save persists them correctly.
- Edge case: Dirty tracking detects changes to WeCom fields and prompts on close.
- Edge case: Status polling and user list still update live.

**Verification:**
- The settings panel has no "WeCom Bot" top-level tab.
- The Workspace tab contains all former WeCom fields and behaviors.
- Save/Cancel/Dirty behavior works end-to-end.
