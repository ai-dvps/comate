---
title: Placeholder for Skills, MCP, and Hooks Settings Tabs
type: feat
status: active
date: 2026-05-28
origin: docs/brainstorms/2026-05-28-placeholder-for-skills-mcp-hooks-requirements.md
---

# Placeholder for Skills, MCP, and Hooks Settings Tabs

## Summary

Replace the current functional content of the Skills, MCP, and Hooks tabs in the settings panel with a "coming soon" placeholder that invites users to contact spearwang with ideas or requirements.

## Requirements

- R1. Skills tab shows a placeholder instead of skill list management.
- R2. MCP tab shows a placeholder instead of MCP server list management.
- R3. Hooks tab shows a placeholder instead of hook list management.
- R4. Each placeholder communicates "coming soon" and invites contact with spearwang.

## Scope Boundaries

- No data model or API changes.
- No tab navigation changes.

## Implementation Units

### U1. Replace Skills, MCP, and Hooks tabs with placeholder

**Goal:** Replace the three tab components with a shared placeholder pattern.

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:**
- Replace `SkillsTab`, `McpTab`, and `HooksTab` component bodies with a centered placeholder: an icon or heading + "Coming soon" message + contact instruction.
- Add i18n keys for the placeholder text in English and Chinese.

**Test scenarios:**
- Happy path: Opening Skills/MCP/Hooks tabs shows the placeholder with correct text.
- Edge case: Placeholder renders correctly when no workspace is selected.

**Verification:**
- All three tabs display the placeholder consistently.
- TypeScript and ESLint pass.
