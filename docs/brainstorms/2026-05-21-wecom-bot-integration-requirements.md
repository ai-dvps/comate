---
date: 2026-05-21
topic: wecom-bot-integration
---

# WeCom Bot Integration

## Summary

Add WeCom bot integration to workspaces. A workspace can be configured as a bot with ID, secret, and an enable toggle. When enabled, a websocket connects to WeCom; incoming messages are routed into persistent Claude Code sessions (one per WeCom user), and responses are sent back through the bot API. Bot sessions appear in the GUI session list with a badge.

---

## Problem Frame

Teams that use WeChat Work need a way for multiple members to interact with Claude without each person installing and running the Claude Code GUI. Currently, there is no bridge between WeCom messages and Claude Code sessions. An admin configuring a workspace as a WeCom bot allows team members to message a bot and receive Claude's responses in their familiar chat app, while the admin retains visibility into conversations through the GUI.

---

## Actors

- A1. Admin: Configures the WeCom bot credentials and toggle in workspace settings, monitors bot sessions in the GUI.
- A2. WeCom User: Sends messages to the bot from WeChat Work; receives Claude's responses in chat.
- A3. GUI User: Opens and interacts with sessions in the GUI, including bot-created sessions.

---

## Key Flows

- F1. Admin enables a workspace as a WeCom bot
  - **Trigger:** Admin opens workspace settings, fills in bot ID and secret, toggles Enable, and clicks Save.
  - **Actors:** A1
  - **Steps:** Admin navigates to workspace settings. Enters bot ID and secret. Toggles bot to Enabled. Clicks Save. Server establishes a websocket connection to WeCom.
  - **Outcome:** Bot is active and listening for messages; connection status is visible.
  - **Covered by:** R1–R6

- F2. WeCom user sends a message and receives a response
  - **Trigger:** A WeCom user sends a text message to the bot.
  - **Actors:** A2
  - **Steps:** Bot receives message via websocket. System looks up the sender's user ID in the user-to-session mapping. Creates a new session if none exists. Sends the message to the corresponding Claude Code session. Streams Claude's response. Sends the response back to the WeCom user via the bot API.
  - **Outcome:** WeCom user sees Claude's reply in their chat.
  - **Covered by:** R7–R10

- F3. GUI user views a bot session
  - **Trigger:** GUI user opens the session list for a bot-enabled workspace.
  - **Actors:** A3
  - **Steps:** GUI user sees bot sessions with a visual indicator (badge or label). Clicks a bot session. Views the conversation history.
  - **Outcome:** GUI user can see and optionally interact with the bot conversation.
  - **Covered by:** R11–R13

---

## Requirements

**Bot configuration**

- R1. The workspace settings panel includes a WeCom Bot section with fields for bot ID and bot secret.
- R2. The WeCom Bot section includes an enable/disable toggle.
- R3. Bot credentials are persisted with the workspace settings.
- R4. When the bot is enabled and credentials are present, the server establishes a websocket connection to WeCom.
- R5. When the bot is disabled or credentials are removed, the websocket disconnects.
- R6. Connection status (connected, disconnected, error) is visible in the workspace settings.

**Message handling**

- R7. When a message is received from WeCom, the system looks up the sender's user ID in the user-to-session mapping.
- R8. If no session exists for the user, a new session is created in the workspace.
- R9. The message is sent to the corresponding Claude Code session.
- R10. Claude's response is sent back to the WeCom user via the bot API.

**Session tracking and visibility**

- R11. A database table tracks the mapping between WeCom user ID and Claude Code session ID per workspace.
- R12. Bot-created sessions appear in the GUI session list with a visual indicator (badge or label).
- R13. Bot sessions can be opened and interacted with in the GUI like regular sessions.

**Resilience**

- R14. On server restart, enabled bots automatically reconnect.
- R15. Websocket disconnects trigger reconnection attempts with backoff.

---

## Acceptance Examples

- AE1. **Covers R1–R4.** Given a workspace with no bot config, when the admin enters a bot ID and secret and enables the bot, then the connection status shows "connected" and the bot is listening.
- AE2. **Covers R7–R10.** Given an enabled bot with no prior messages from user U123, when U123 sends "hello", then a new session is created, Claude processes it, and U123 receives the response in WeCom.
- AE3. **Covers R7, R9, R10.** Given an enabled bot where user U123 already has session S456, when U123 sends "explain this", then session S456 is reused, Claude processes it, and U123 receives the response.
- AE4. **Covers R12–R13.** Given a workspace with an active bot, when the GUI user opens the session list, then bot sessions are shown with a WeCom badge and can be clicked to view.

---

## Success Criteria

- Team members can message the WeCom bot and receive Claude responses without using the GUI.
- Admin can configure and monitor the bot from the workspace settings.
- Bot sessions are distinguishable from regular GUI sessions.
- The bot reconnects automatically after server restarts or temporary disconnections.

---

## Scope Boundaries

- No admin messaging WeCom users from the GUI.
- No session expiry or automatic cleanup.
- No support for non-text messages (images, files, voice) in the initial version.
- No multi-bot per workspace.
- No bot usage analytics or reporting.

---

## Key Decisions

- Indefinite session reuse: Each WeCom user gets one persistent session that never expires. Simpler state management at the cost of unbounded history.
- Bot sessions are regular SDK sessions: They live in the same session pool as GUI-created sessions, distinguished only by a badge. This keeps the architecture simple and allows admin visibility.
- Toggle-managed connection: Explicit enable/disable rather than auto-connect gives admins control without deleting credentials.

---

## Dependencies / Assumptions

- The WeCom AI bot SDK provides websocket connection and send-message APIs.
- The WeCom bot API supports sending text responses to individual users.
- The Claude Agent SDK supports concurrent or interleaved queries on the same session ID.

---

## Outstanding Questions

### Resolve Before Planning

- None

### Deferred to Planning

- [Affects R10][Technical] Exact method for sending responses back to WeCom users via the SDK.
- [Affects R14–R15][Technical] Websocket reconnection strategy and backoff parameters.
- [Affects R12][Technical] How to distinguish bot sessions in the session list (SDK metadata vs. external tracking).
