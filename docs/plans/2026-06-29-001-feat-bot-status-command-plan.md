---
title: Add /status command to Feishu and WeCom bots
type: feat
date: 2026-06-29
origin: docs/brainstorms/2026-06-29-feishu-wecom-bot-status-command-requirements.md
---

# Add /status command to Feishu and WeCom bots

## Summary

Add a `/status` command to the Feishu and WeCom bot services. When a user sends `/status`, the bot replies with the current workspace name and the user's active session name in plain text.

---

## Problem Frame

Operators and end-users interacting with Comate through Feishu or WeCom cannot see which workspace and session the bot is serving without leaving the chat app. A lightweight active-query command closes this visibility gap without cluttering normal chat.

---

## Requirements

R1. The Feishu bot recognizes `/status` in direct messages and group mentions.

R2. The WeCom bot recognizes `/status` in single and group chats.

R3. The bot replies with a single plain-text message containing the current workspace name and the user's active session name.

R4. The response shape is consistent between Feishu and WeCom.

R5. When no workspace is bound or no active session exists, the reply uses plain language instead of empty values or internal IDs.

R6. The command requires no special permissions.

---

## Key Technical Decisions

- **User-level active session, not a bot-level session.** The current architecture binds a bot instance to one workspace and tracks sessions per user. The `/status` reply therefore shows the user's active session in the current workspace.
- **Plain-text reply in Chinese.** Existing bot messages in both services are hard-coded Chinese; the status reply follows that convention rather than introducing server-side i18n.
- **Parallel implementation in each service.** Feishu and WeCom use different SDKs and connection models, so the command is added independently in each service while keeping the response format identical.

---

## Implementation Units

### U1. Feishu `/status` command

- **Goal:** Add `/status` handling to `FeishuBotService`.
- **Requirements:** R1, R3, R4, R5, R6.
- **Dependencies:** None.
- **Files:**
  - `src/server/services/feishu-bot-service.ts`
  - `src/server/services/feishu-bot-service.test.ts`
- **Approach:**
  - Add a `text === '/status'` branch in `createDispatchHandler()` before the default chat path.
  - Implement `handleStatusCommand(thread, feishuUserId)` that calls `requireActiveWorkspace()` to obtain the current workspace.
  - Read the user's active session via `workspaceStore.getFeishuActiveSession(workspace.id, feishuUserId)`.
  - If a session ID exists, fetch the session via `chatService.getSession(sessionId, workspace.id)` to obtain its display name (`customTitle ?? name`).
  - Post a plain-text reply with `safePostText()` in the form "当前工作空间：{workspaceName}\n当前会话：{sessionName}". When no session exists, say so in plain language.
- **Patterns to follow:** Mirror the existing `/stop` command branch and `requireActiveWorkspace()` guard. Use `safePostText()` for text replies.
- **Test scenarios:**
  - **Happy path:** `/status` returns the workspace name and the user's active session name.
  - **Edge case:** `/status` with no active session returns a plain-language "no active session" message.
  - **Edge case:** `/status` when no workspace is bound returns the existing `requireActiveWorkspace()` message.
  - **Error path:** `chatService.getSession` failure is caught and a fallback message is posted.
- **Verification:** `npm run test:server` passes for the Feishu bot service; manual `/status` in Feishu returns the expected text.

### U2. WeCom `/status` command

- **Goal:** Add `/status` handling to `WeComBotService`.
- **Requirements:** R2, R3, R4, R5, R6.
- **Dependencies:** None.
- **Files:**
  - `src/server/services/wecom-bot-service.ts`
  - `src/server/services/wecom-bot-service.test.ts`
- **Approach:**
  - Add a `parseWecomStatusCommand(content)` helper that matches the exact `/status` token or a prefix followed by a space, consistent with existing command parsers.
  - Add a branch in `handleTextMessage()` that calls `handleStatusCommand(workspaceId, wecomUserId, conn)` when the command is detected.
  - In `handleStatusCommand`, load the workspace via `workspaceStore.get(workspaceId)` and read the user's active session via `workspaceStore.getActiveWecomSession(workspaceId, wecomUserId)`.
  - If a session ID exists, fetch the session via `chatService.getSession(sessionId, workspaceId)` to obtain its display name.
  - Send a markdown message via `conn.client.sendMessage()` with the same Chinese text shape as Feishu.
- **Patterns to follow:** Mirror `parseWecomStopCommand` / `handleStopCommand` for parsing, branching, and markdown replies.
- **Test scenarios:**
  - **Happy path:** `/status` returns the workspace name and the user's active session name.
  - **Edge case:** `/status` with no active session returns a plain-language "no active session" message.
  - **Edge case:** `/status` when the workspace cannot be loaded returns a plain-language "not bound" message.
  - **Error path:** `chatService.getSession` failure is caught and a fallback message is sent.
- **Verification:** `npm run test:server` passes for the WeCom bot service; manual `/status` in WeCom returns the expected text.

---

## Scope Boundaries

- Switching or modifying the workspace or session from chat is out of scope.
- Persistent status display on every message, pinned messages, or bot profile is out of scope.
- Additional metadata such as workspace path, model, provider, or approval settings is out of scope.
- Per-user or per-role response differences are out of scope.
- Server-side i18n is out of scope; replies follow the existing hard-coded Chinese convention.

---

## Acceptance Examples

- AE1. Bound Feishu bot
  - **Covers:** R1, R3, R4.
  - **Given:** The Feishu bot is active in workspace "Backend" and the user has active session "Deploy Q&A".
  - **When:** The user sends `/status`.
  - **Then:** The bot replies with a message containing "Backend" and "Deploy Q&A".

- AE2. Bound WeCom bot
  - **Covers:** R2, R3, R4.
  - **Given:** The WeCom bot is active in workspace "Backend" and the user has active session "Deploy Q&A".
  - **When:** The user sends `/status`.
  - **Then:** The bot replies with a message containing "Backend" and "Deploy Q&A".

- AE3. No active session
  - **Covers:** R5.
  - **Given:** The bot is bound to a workspace but the user has no active session.
  - **When:** The user sends `/status`.
  - **Then:** The bot replies with a plain-language message indicating no active session.

---

## Risks & Dependencies

- **Risk:** The Feishu and WeCom test suites mock `workspaceStore` and `chatService` differently. Ensure the new tests stub `getSession` for the status path.
- **Risk:** Workspace and session names may be missing or empty in edge cases. Fall back to plain-language "未命名" or "未绑定" labels rather than exposing raw IDs.
- **Dependency:** The existing command-parsing and text-sending patterns in both services remain stable.

---

## Sources / Research

- Origin requirements: `docs/brainstorms/2026-06-29-feishu-wecom-bot-status-command-requirements.md`
- Feishu bot service and existing command dispatch: `src/server/services/feishu-bot-service.ts`
- WeCom bot service and existing command parsers: `src/server/services/wecom-bot-service.ts`
