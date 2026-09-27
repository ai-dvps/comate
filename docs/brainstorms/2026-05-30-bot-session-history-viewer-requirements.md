---
date: 2026-05-30
topic: bot-session-history-viewer
---

# Bot Session History Viewer

## Summary

When a WeCom bot session is opened in the GUI, the client stops subscribing to the live SSE stream and instead operates as a read-only history viewer. A new server endpoint supports fetching only messages newer than a given ID, which a manual refresh button in the disabled input area uses to load updates without disrupting WeCom's streaming.

---

## Problem Frame

WeCom bot sessions currently share the same SSE subscription behavior as regular GUI sessions. When a GUI user opens a bot session, the client subscribes to its stream. This subscription conflicts with the WeCom bot service's event handling and causes WeCom users to stop receiving streaming responses. There is no way for a GUI user to view a bot conversation's history without breaking the WeCom user's live experience.

Additionally, reloading the full message history on every refresh is wasteful for bot sessions that may accumulate long conversations over time. A lighter fetch mechanism is needed so refreshes remain fast.

---

## Actors

- A1. GUI User: Opens bot sessions in the GUI to view conversation history.
- A2. WeCom User: Sends messages to the bot and receives streaming responses in WeChat Work.

---

## Key Flows

- F1. GUI user opens a bot session
  - **Trigger:** GUI user clicks a WeCom bot session in the session list.
  - **Actors:** A1
  - **Steps:** Client recognizes the session source as `wecom`. Client loads message history via the existing history API. Client does NOT open an SSE subscription. Client renders the message list and disables the input area.
  - **Outcome:** GUI user sees the conversation history without interfering with the WeCom stream.
  - **Covered by:** R1, R2, R7, R8

- F2. GUI user refreshes to see new messages
  - **Trigger:** GUI user clicks the refresh button while viewing a bot session.
  - **Actors:** A1
  - **Steps:** Client sends the last-seen message ID to the latest-messages endpoint. Server returns only messages newer than that ID. Client appends them to the message list. Client updates the last-seen message ID.
  - **Outcome:** GUI user sees new messages from the WeCom conversation without reloading the full history.
  - **Covered by:** R3, R4, R5

- F3. WeCom user sends a message and receives a response
  - **Trigger:** WeCom user messages the bot.
  - **Actors:** A2
  - **Steps:** WeCom bot service receives the message. Bot service pushes it into the session runtime. Session runtime processes it and emits events through the bot event handler. WeCom user receives the streaming response.
  - **Outcome:** WeCom user gets a reply. The GUI user will see this new message only after clicking refresh.
  - **Covered by:** R1, R6

---

## Requirements

**Stream subscription behavior**

- R1. When a bot session (`source === 'wecom'`) is opened in the GUI, the client does not subscribe to the session's SSE stream.
- R2. When a regular (non-bot) session is opened, the client continues to subscribe to the SSE stream as it does today.
- R3. The client tracks the ID of the most recent message it has loaded for each bot session.

**History loading and refresh**

- R4. The server exposes an endpoint that returns messages newer than a given message ID for a session.
- R5. The refresh button in the GUI calls the latest-messages endpoint using the last-seen message ID and appends the returned messages to the local message list.
- R6. The initial load of a bot session continues to use the existing full-history endpoint to populate the message list from scratch.

**UI presentation**

- R7. The chat input area is disabled for bot sessions.
- R8. The disabled input area displays a tooltip or placeholder text indicating that replies must be sent from WeCom.
- R9. A manual refresh button is shown within or adjacent to the disabled input area.
- R10. The existing "WeCom bot session" label in the session list is preserved unchanged.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given a regular session, when the GUI user opens it, then the client subscribes to the SSE stream and shows the live chat. Given a bot session, when the GUI user opens it, then the client loads history but does not subscribe to the stream.
- AE2. **Covers R3, R4, R5.** Given a bot session with messages M1, M2 already loaded and a new message M3 from WeCom, when the GUI user clicks refresh, then only M3 is fetched and appended to the message list.
- AE3. **Covers R7, R8, R9.** Given a bot session open in the GUI, when the GUI user views the chat panel, then the input area is disabled, shows a tooltip explaining WeCom-only replies, and a refresh button is visible.

---

## Success Criteria

- Opening a bot session in the GUI never prevents a WeCom user from receiving streaming responses.
- A GUI user can view the full history of a bot session on open and load new messages with a single refresh action.
- Refreshing a bot session fetches only new messages, not the full conversation.
- Regular GUI sessions continue to work exactly as before.

---

## Scope Boundaries

- No auto-refresh or background polling in the GUI.
- No ability for GUI users to send messages into bot sessions.
- No changes to how the WeCom bot service connects, receives, or sends messages.
- No changes to session creation, session list ordering, or bot configuration.
- No support for message deletion, editing, or reordering in the history viewer.

---

## Key Decisions

- Read-only viewer: Bot sessions are view-only in the GUI to guarantee WeCom streaming is never disrupted by a competing SSE subscriber.
- Latest-messages endpoint: A dedicated lightweight fetch is preferred over reloading full history on refresh, keeping the UI responsive as bot conversations grow.
- Disabled input over hidden input: Preserves the familiar chat layout and makes the read-only boundary explicit without surprising the user.

---

## Dependencies / Assumptions

- The existing message-history API can be extended or duplicated to support an "after message ID" filter.
- Messages have stable, orderable IDs that the client can use as a cursor.
- The `source === 'wecom'` field is already available on session objects returned to the client.

---

## Outstanding Questions

### Resolve Before Planning

- None

### Deferred to Planning

- [Affects R4][Technical] Whether to extend the existing messages endpoint with a query parameter or create a separate endpoint for latest-only fetch.
- [Affects R4][Technical] Exact cursor field to use (message ID vs timestamp vs sequence number) based on what the SDK and storage layer support.
