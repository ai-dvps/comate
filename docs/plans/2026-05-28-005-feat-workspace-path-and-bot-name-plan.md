---
title: Workspace Path Display and WeCom Bot Name
type: feat
status: completed
date: 2026-05-28
origin: docs/brainstorms/2026-05-28-workspace-path-and-bot-name-requirements.md
---

# Workspace Path Display and WeCom Bot Name

## Summary

Add two small enhancements to the workspace settings panel: (1) show the workspace folder path as a read-only field with an explanation of why it cannot be changed, and (2) add a customizable bot name field to the WeCom bot configuration section.

## Requirements

- R1. The Workspace tab shows the workspace's `folderPath` as a read-only field with helper text explaining that changing it would reset Claude Code sessions.
- R2. Add a "Bot Name" text input to the WeCom bot configuration section, stored per-workspace as `wecomBotName`.

## Scope Boundaries

- No server API route changes.
- No data migration needed — `wecomBotName` is optional.
- No workspace creation flow changes.

## Implementation Units

### U1. Add wecomBotName to workspace data model

**Goal:** Add the optional `wecomBotName` field to `WorkspaceSettings` so it can be persisted.

**Files:**
- Modify: `src/server/models/workspace.ts`

**Approach:**
- Add `wecomBotName?: string` to the `WorkspaceSettings` interface.

**Test scenarios:**
- Test expectation: none -- type-only change, no behavioral change.

**Verification:**
- TypeScript compiles without errors.

---

### U2. Display read-only workspace path and add bot name field

**Goal:** Surface the workspace path in the Workspace tab and add the bot name input to the WeCom section.

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:**
- Add `folderPath` to `WorkspaceFormState` and `buildWorkspaceFormState`.
- Render `folderPath` as read-only text (e.g., `<code>` or disabled input) with helper text in `WorkspaceDetailsTab`.
- Add `wecomBotName` to `WorkspaceFormState` and `buildWorkspaceFormState`.
- Include `wecomBotName` in the save payload in `handleSave`.
- Add a "Bot Name" input in the WeCom section, above or near the "Bot ID" field.
- Add i18n keys for the new labels and helper text in both English and Chinese.

**Patterns to follow:**
- Existing read-only field pattern (if any) or disabled input pattern.
- Existing WeCom field layout and styling.

**Test scenarios:**
- Happy path: Opening the Workspace tab shows the folder path and the Bot Name field.
- Happy path: Editing Bot Name and saving persists the value.
- Edge case: Bot Name can be left empty.
- Edge case: Folder path displays correctly for all workspaces.

**Verification:**
- The Workspace tab shows the folder path with explanatory helper text.
- The WeCom section includes a Bot Name input that saves correctly.
- TypeScript and ESLint pass.
