---
title: Feishu Bot Auto-Create Session
type: feat
date: 2026-06-21
origin: docs/brainstorms/2026-06-21-feishu-auto-create-session-requirements.md
---

# Feishu Bot Auto-Create Session

## Summary

When a Feishu user sends a chat message without an active session, the bot creates one automatically, activates it, and tells the user how to switch (`/session`) or create another (`/new`). A new `/new` command is added so users can create sessions manually, with or without a custom title.

## Problem Frame

Today a Feishu user who has not selected or created a session is blocked by the message:

> 请先运行 /session 选择或创建一个会话，然后再发送消息。

The message does not guide the user toward creating a session. The work removes the blocker by auto-creating the session and surfacing the relevant commands.

## Requirements

- R1. When a Feishu user sends a non-command chat message in a workspace and has no active session there, the bot creates a new session automatically instead of rejecting the message.
- R2. The auto-created session receives a default title and is recorded with `source: 'feishu'`.
- R3. After auto-creating a session, the bot sends a one-time message telling the user they can send `/session` to switch sessions or `/new` to create a session manually.
- R4. A `/new` command is added to the Feishu bot. It creates a new session, activates it for the user, and confirms creation. When no title is supplied, it uses the default title; when a title is provided (e.g. `/new Project Planning`), the session uses that title.
- R5. Both auto-creation and `/new` set the newly created session as the active session for that Feishu user in the workspace.
- R6. Existing `/session` and `/stop` behavior remains unchanged.

## Key Technical Decisions

- **Mirror the WeCom `getOrCreateSession` helper.** `src/server/services/wecom-bot-service.ts` already centralizes session resolution for WeCom users. The Feishu bot should add an equivalent private helper that checks the active session, falls back to creating a new session via `chatService.createSession`, persists the user-session mapping, and activates the session. This keeps bot session lifecycle logic consistent across channels.
- **Default title is the Feishu user identifier.** Matching WeCom, sessions created from Feishu start with the bot-channel user ID as their name. A future Feishu-specific renamer can improve this later; for now consistency and simplicity win.
- **`/new` parses optional title from the remainder of the message.** The command format is `/new` or `/new <title>`. The bot splits on the first space; everything after `/new` (trimmed) becomes the session title, and an empty remainder falls back to the default title.
- **Command hint is posted only on auto-creation.** Manual `/new` gets its own confirmation reply; users with an active session who send normal messages do not see the hint.

## Implementation Units

### U1. Auto-create session on first chat message

- **Goal:** Remove the "no active session" blocker by creating and activating a session automatically when a Feishu user sends a normal message.
- **Requirements:** R1, R2, R3, R5
- **Dependencies:** None
- **Files:**
  - `src/server/services/feishu-bot-service.ts` (modify)
  - `src/server/services/feishu-bot-service.test.ts` (create)
- **Approach:**
  - Add a private `getOrCreateSession(workspace, feishuUserId)` helper that returns the active session ID or creates a new Feishu session, records it via `workspaceStore.addFeishuUserSession`, activates it via `workspaceStore.setFeishuActiveSession`, and returns the new session ID.
  - Update `handleChatMessage` to call this helper instead of returning the "请先运行 /session..." reply.
  - When a session is created during this flow, post a one-time hint: `已为你创建新会话。发送 /session 可切换会话，发送 /new 可创建新会话。`
  - Continue processing the user's message through the existing streaming reply path.
- **Patterns to follow:** `src/server/services/wecom-bot-service.ts` (`getOrCreateSession`), existing `handleChatMessage` streaming reply flow.
- **Test scenarios:**
  - Covers AE1. First normal message from a user with no active session creates a Feishu session, activates it, posts the hint, and forwards the message to `chatService.pushMessage`.
  - Covers AE3. A normal message from a user with an active session does not create a new session and does not post the hint.
  - Auto-created session is persisted with `source: 'feishu'`.
  - Session-creation failure surfaces a friendly error reply instead of crashing the dispatch queue.
- **Verification:** Sending the first message to the Feishu bot results in a new session, the command hint, and a streamed reply; subsequent messages reuse the same session without extra hints.

### U2. Add `/new` command with optional title

- **Goal:** Let users create a new Feishu session explicitly, with or without a custom title.
- **Requirements:** R4, R5
- **Dependencies:** U1 (reuse the session-creation helper where appropriate)
- **Files:**
  - `src/server/services/feishu-bot-service.ts` (modify)
  - `src/server/services/feishu-bot-service.test.ts` (modify)
- **Approach:**
  - Register `/new` in the dispatch handler before the generic chat-message branch.
  - Parse `/new` and optional title: split the message text on the first space; if there is a remainder, use it as the session name; otherwise use the default title.
  - Create the session via `chatService.createSession`, record it via `workspaceStore.addFeishuUserSession`, and activate it via `workspaceStore.setFeishuActiveSession`.
  - Reply with a confirmation such as `已创建新会话：<title>`.
- **Patterns to follow:** Existing `/session` and `/stop` command handlers in `src/server/services/feishu-bot-service.ts`.
- **Test scenarios:**
  - Covers AE2. `/new` alone creates a session with the default title and activates it.
  - Covers AE4. `/new Project Planning` creates a session named "Project Planning" and activates it.
  - `/new` with only whitespace falls back to the default title.
  - `/new` replies with a confirmation that includes the session title.
  - Session-creation failure during `/new` surfaces a friendly error reply instead of crashing the dispatch queue (mirrors U1).
- **Verification:** `/new` and `/new Custom Title` both create and activate sessions; `/session` lists the newly created sessions.

## Scope Boundaries

- WeCom bot session behavior is unchanged.
- GUI session creation flows are unchanged.
- Session renaming based on resolved user info is out of scope; only the default title is required.
- No new persistence schema is required; existing Feishu session tables are sufficient.

## Sources / Research

- `src/server/services/feishu-bot-service.ts` — existing dispatch, command handling, and streaming reply flow.
- `src/server/services/wecom-bot-service.ts` — `getOrCreateSession` pattern and session-source handling.
- `src/server/storage/sqlite-store.ts` — Feishu user-session and active-session persistence methods.
