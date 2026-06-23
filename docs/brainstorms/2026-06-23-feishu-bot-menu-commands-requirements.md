---
date: 2026-06-23
topic: feishu-bot-menu-commands
---

# Feishu Bot Menu Commands

## Summary

Wire Feishu bot menu clicks to the same session-switching and new-session behaviors as the `/session` and `/new` text commands. When Feishu pushes an `application.bot.menu_v6` event, the app routes it to the existing command logic and sends the resulting card or confirmation back to the user's DM.

---

## Requirements

- R1. The app must handle Feishu `application.bot.menu_v6` events delivered to the existing Feishu callback endpoint.
- R2. A menu event whose `event_key` is `session` must produce the same session-list card as typing `/session`.
- R3. A menu event whose `event_key` is `new` must create a new session and notify the user the same way as typing `/new`.
- R4. Menu-triggered responses must be sent to the user's DM via the same Feishu message API used by existing card sends.
- R5. Menu event handling must respect the active Feishu workspace binding and fail gracefully when no workspace is bound or enabled.
- R6. The existing `/session` and `/new` text command behavior must remain unchanged.

---

## Key Decisions

- **Reuse the existing Feishu callback route for menu events.** Adding a separate endpoint would require operators to configure another URL in the Feishu developer console; extending the current route keeps the public surface unchanged and reuses signature verification.
- **Extract reusable command logic from the Thread-dependent handlers.** Menu events arrive without a chat-SDK `Thread`, so the session-list and new-session logic must be callable with only a workspace and user `open_id`. This avoids synthesizing a fake `Thread` and coupling menu handling to chat-SDK internals.

---

## Key Flows

- F1. User clicks the "session" bot menu
  - **Trigger:** Feishu sends `application.bot.menu_v6` with `event_key: "session"` and `operator.open_id`.
  - **Steps:** Verify the request signature; load the active Feishu workspace; invoke the same session-list logic used by `/session`; send the session-list card to the user's `open_id`.
  - **Outcome:** The user receives the session-list card.

- F2. User clicks the "new" bot menu
  - **Trigger:** Feishu sends `application.bot.menu_v6` with `event_key: "new"` and `operator.open_id`.
  - **Steps:** Verify the request signature; load the active Feishu workspace; invoke the same new-session logic used by `/new`; send the confirmation to the user's `open_id`.
  - **Outcome:** A new session is created and the user receives a confirmation message.

---

## Acceptance Examples

- AE1. **Session menu.** Given a workspace is bound and Feishu-enabled, when a user clicks the "session" menu, then the app sends the same session-list card that `/session` would send.
- AE2. **New menu.** Given a workspace is bound and Feishu-enabled, when a user clicks the "new" menu, then a new Feishu session is created and the user receives a confirmation message.
- AE3. **No workspace bound.** Given no Feishu workspace is bound, when a user clicks either menu, then the app returns an error response and sends no card or message.

---

## Scope Boundaries

- **Deferred for later:** A UI or settings field for mapping custom menu `event_key` values to command behavior. The first version uses the convention `session` and `new`.
- **Outside this change:** Group-chat menu handling (bot menus operate in DMs); any changes to WeCom bot behavior; changes to the existing `/session` and `/new` text commands.

---

## Dependencies / Assumptions

- The Feishu app is configured with two menus whose `event_key` values are `session` and `new`.
- The Feishu developer console subscribes the `application.bot.menu_v6` event and points it at the app's existing Feishu callback URL.
- The active Feishu workspace binding and credentials are already set up, as required by the existing `/session` and `/new` commands.

---

## Sources / Research

- Existing command dispatch for `/session` and `/new`: `src/server/services/feishu-bot-service.ts:175-185`
- Existing Feishu card callback route and `EventDispatcher` usage: `src/server/routes/feishu-card.ts`
- Feishu menu event type `application.bot.menu_v6` and payload shape: `@larksuiteoapi/node-sdk` type definitions
