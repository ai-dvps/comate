---
date: 2026-06-21
topic: feishu-auto-create-session
---

# Feishu Bot Auto-Create Session

## Summary

When a Feishu user sends a chat message without an active session, the bot creates a session automatically and tells the user how to switch (`/session`) or create another (`/new`). A new `/new` command lets users create sessions manually.

## Problem Frame

Today a Feishu user who has not selected or created a session sees only:

> 请先运行 /session 选择或创建一个会话，然后再发送消息。

This blocks the conversation without guiding the user to create a session. The fix removes the blocker by creating the session automatically and surfaces the available commands so users know how to manage sessions later.

## Requirements

- R1. When a Feishu user sends a non-command chat message in a workspace and has no active session there, the bot creates a new session automatically instead of rejecting the message.
- R2. The auto-created session receives a default title and is recorded with `source: 'feishu'`.
- R3. After auto-creating a session, the bot sends a one-time message telling the user they can send `/session` to switch sessions or `/new` to create a session manually.
- R4. A `/new` command is added to the Feishu bot. It creates a new session, activates it for the user, and confirms creation. When the user does not supply a title, it uses the same default title as auto-created sessions; when a title is provided (e.g. `/new Project Planning`), the session uses that title.
- R5. Both auto-creation and `/new` set the newly created session as the active session for that Feishu user in the workspace.
- R6. Existing `/session` and `/stop` behavior remains unchanged.

## Key Decisions

- **Default title mirrors the WeCom pattern.** Following `src/server/services/wecom-bot-service.ts`, new Feishu sessions start with a default title derived from the bot channel user identifier. This keeps session naming consistent across bot integrations and leaves room for a future Feishu-specific renamer.
- **Notification is sent once, on auto-creation.** Users who already have an active session do not see the command hint. Manual `/new` confirms creation with a separate toast-style reply.
- **`/new` is a first-class command.** Mentioning `/new` in the hint without implementing it would be misleading, so the command is added alongside `/session`.

## Acceptance Examples

- AE1. **First message auto-creates.** Given a Feishu user with no active session in the current workspace, when they send "hello", then a new Feishu session is created, set as active, the command hint is posted, and "hello" is processed as the first turn.
- AE2. **`/new` creates manually without a title.** Given a Feishu user with an active session, when they send `/new`, then a second Feishu session is created with the default title, activated, and a confirmation is posted.
- AE3. **Existing active session skips auto-creation.** Given a Feishu user with an active session, when they send a normal message, then no new session is created and no command hint is posted.
- AE4. **`/new <title>` creates with a custom title.** Given a Feishu user, when they send `/new Project Planning`, then a session named "Project Planning" is created and activated.

## Scope Boundaries

- WeCom bot session behavior is unchanged.
- GUI session creation flows are unchanged.
- Session renaming after user info resolution is out of scope; only the default title is required.

## Dependencies / Assumptions

- The Feishu bot already has access to `chatService.createSession` and workspace-store methods for active-session tracking, following the existing WeCom pattern in `src/server/services/wecom-bot-service.ts`.
