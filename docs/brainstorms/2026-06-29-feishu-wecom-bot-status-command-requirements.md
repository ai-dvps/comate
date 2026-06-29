---
date: 2026-06-29
topic: feishu-wecom-bot-status-command
---

# Bot status command for Feishu and WeCom

## Summary

Add a `/status` command to both the Feishu and WeCom bots. When a user sends `/status` in a chat with the bot, the bot replies with a plain-text message showing the names of the Comate workspace and session it is currently bound to.

---

## Problem Frame

Operators and end-users currently have no reliable way to know which Comate workspace and session a Feishu or WeCom bot is serving. The binding is configured in Comate, but people interacting with the bot in Feishu or WeCom cannot see it without switching applications or asking an administrator. This makes debugging, onboarding, and handoff harder, especially when multiple bots or workspaces are in use.

---

## Actors

- A1. End-user — a person chatting with the bot in Feishu or WeCom who wants to confirm which workspace/session they are talking to.
- A2. Bot administrator — a person who manages bot configuration and needs to verify the current binding quickly.
- A3. Feishu bot — the Comate Feishu bot service.
- A4. WeCom bot — the Comate WeCom bot service.

---

## Requirements

R1. The Feishu bot recognizes a `/status` command in both group chats and direct messages.

R2. The WeCom bot recognizes a `/status` command in both group chats and direct messages.

R3. When `/status` is received, the bot replies with a single plain-text message containing the current Comate workspace name and session name.

R4. The response format is consistent between Feishu and WeCom.

R5. If the bot is not currently bound to a workspace or session, the response says so in plain language instead of showing empty or internal identifiers.

R6. The command works for both end-users and administrators without requiring special permissions.

---

## Key Decisions

- **Plain-text over card.** The reply is plain text, not an interactive card. This keeps the implementation simple and consistent across Feishu and WeCom.
- **Active query over persistent display.** The information is shown only when requested via `/status`, not on every message or as a pinned status. This avoids cluttering normal chat.
- **Cross-platform parity.** Feishu and WeCom get the same command and response shape, so users and administrators have one consistent behavior.
- **Names over IDs.** The response shows workspace and session names, not internal IDs, because names are meaningful to humans.

---

## Key Flows

- F1. User sends `/status`
  - **Trigger:** User types `/status` and sends it in a Feishu or WeCom chat where the bot is present.
  - **Actors:** A1 or A2, A3 or A4.
  - **Steps:**
    1. Bot receives the message.
    2. Bot recognizes `/status` as the status command.
    3. Bot reads the current workspace and session binding for this bot instance.
    4. Bot formats a plain-text reply with the workspace name and session name.
    5. Bot sends the reply to the chat.
  - **Outcome:** User sees a message like "Current workspace: X, session: Y."

- F2. Bot has no binding
  - **Trigger:** User sends `/status` but the bot is not bound to a workspace or session.
  - **Actors:** A1 or A2, A3 or A4.
  - **Steps:**
    1. Bot receives the message.
    2. Bot recognizes `/status`.
    3. Bot detects no workspace/session binding.
    4. Bot replies with a plain-language message such as "This bot is not bound to a workspace or session yet."
  - **Outcome:** User understands the bot is unconfigured.

---

## Scope Boundaries

- Switching or modifying the workspace/session binding from within Feishu or WeCom is out of scope.
- Persistent display of status on every bot message, pinned messages, or bot profile description is out of scope.
- Showing additional metadata such as workspace path, model, provider, or approval settings is out of scope.
- Per-user or per-role response differences are out of scope.

---

## Acceptance Examples

- AE1. Bound bot
  - **Covers:** R1–R4.
  - **Given:** The Feishu bot is bound to workspace "Backend" and session "Deploy Q&A".
  - **When:** A user sends `/status`.
  - **Then:** The bot replies with a message containing "Backend" and "Deploy Q&A".

- AE2. Unbound bot
  - **Covers:** R5.
  - **Given:** The WeCom bot has no workspace or session binding.
  - **When:** A user sends `/status`.
  - **Then:** The bot replies with a plain-language message indicating it is not bound.

- AE3. Command in group chat
  - **Covers:** R1, R2.
  - **Given:** The bot is in a Feishu or WeCom group chat.
  - **When:** A user sends `/status` in the group.
  - **Then:** The bot replies in the group thread with the current status.

---

## Dependencies / Assumptions

- The bot services can already read the current workspace and session binding for a bot instance. This likely uses existing workspace/session storage.
- The command parser for bot messages already exists or will be extended to recognize `/status` alongside existing commands.
- The response will be in the same language used for other bot messages, matching the existing i18n approach.

---

## Sources / Research

- Feishu group top-notice API exists but is not used here because the chosen design is active query.
- Feishu app description / bot profile is static configuration and does not support runtime updates for dynamic session information.
- WeCom bot service: `src/server/services/wecom-bot-service.ts`
- Feishu bot service: `src/server/services/feishu-bot-service.ts`
