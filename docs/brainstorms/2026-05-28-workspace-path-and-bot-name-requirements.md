---
date: 2026-05-28
topic: workspace-path-and-bot-name
---

# Workspace Path Display and WeCom Bot Name

## Summary

Two small enhancements to the workspace settings panel: (1) show the workspace folder path as a read-only field with an explanation of why it cannot be changed, and (2) add a customizable bot name field to the WeCom bot configuration section.

## Requirements

**R1. Display read-only workspace path**
- The Workspace tab shows the workspace's `folderPath` as a read-only field.
- Include helper text explaining that the path cannot be changed because Claude Code session history is bound to it, and changing it would reset sessions.

**R2. Add WeCom bot name field**
- Add a "Bot Name" text input to the WeCom bot configuration section in the Workspace tab.
- The bot name is stored per-workspace in `WorkspaceSettings` as `wecomBotName`.
- It is optional and editable like the other WeCom fields.

## Scope Boundaries

- No server API changes beyond adding `wecomBotName` to `WorkspaceSettings`.
- No data migration needed — `wecomBotName` is optional.
- No changes to workspace creation flow.

## Key Decisions

- **Read-only path with explanation rather than disabled input:** A plain text display with helper text is clearer than a disabled form field, which can look like a bug.
- **Bot name lives in `WorkspaceSettings` alongside other WeCom fields:** Keeps all bot configuration in one place.
