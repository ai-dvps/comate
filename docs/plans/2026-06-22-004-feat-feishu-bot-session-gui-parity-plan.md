---
title: "feat: Treat Feishu-bound sessions as bot sessions in the GUI"
type: feat
date: 2026-06-22
origin: docs/brainstorms/2026-06-21-feishu-lark-integration-requirements.md
---

# Feishu Bot Session GUI Parity

## Summary

Make Feishu-bound sessions read-only in the GUI by extending the existing WeCom bot-session checks to include `source === 'feishu'`. This suppresses the chat input, blocks local send attempts, skips SSE subscription, and surfaces a Feishu-branded bot bar with user info and a refresh control.

---

## Problem Frame

The Feishu bot integration already creates sessions with `source: 'feishu'` and renders a Feishu badge in the session list. However, the GUI still treats these sessions as regular GUI sessions: the chat input is editable, `sendMessage` can post to them, and the client subscribes to their SSE streams. WeCom-bound sessions already disable all of this via hardcoded `source === 'wecom'` checks. The same guard must apply to Feishu so users cannot accidentally chat in a bot channel from the desktop client.

---

## Requirements

### Bot-session detection

- R1. A session whose `source` is `'feishu'` or `'wecom'` is considered a bot session.
- R2. Bot-session detection is centralized so future bot channels do not require scattered string checks.

### GUI behavior

- R3. When the active session is a Feishu bot session, `PromptInput` renders the read-only bot bar instead of the chat input.
- R4. The Feishu bot bar displays the configured Feishu bot name, the bound Feishu user identifier, and a refresh control, mirroring the WeCom bar.
- R5. The client blocks `sendMessage` for Feishu bot sessions with the same warning behavior used for WeCom.
- R6. The client skips SSE subscription for Feishu bot sessions when switching to them.
- R7. The client allows `refreshBotMessages` for Feishu bot sessions to poll for new bot messages.

### Server support

- R8. Expose `GET /api/workspaces/:id/sessions/:sessionId/feishu-user` that returns the Feishu user bound to the session, mirroring the existing WeCom user route.

### Settings

- R9. Workspace settings support a `feishuBotName` field that the chat panel can display in the Feishu bot bar.

---

## Key Technical Decisions

- **Centralize bot detection in `src/client/lib/session-filter.ts`.** Add `isBotSession(source)` alongside the existing session display helpers so `ChatPanel`, `PromptInput`, and `chat-store` share one definition of "bot session."
- **Parameterize the bot bar by channel rather than duplicate it.** Reuse the existing compact bar in `PromptInput` by passing channel-specific icon, bot name, and user info props instead of adding a parallel Feishu-only implementation.
- **Add a dedicated Feishu user route.** The WeCom route relies on encrypted user IDs and a mapping table; Feishu uses `open_id` and a workspace user cache, so a separate route keeps the response shapes simple and channel-appropriate.
- **Store `feishuBotName` in workspace settings.** This mirrors `wecomBotName` and keeps the display name configurable per workspace without changing the session model.

---

## High-Level Technical Design

The change is a cross-component extension of the existing WeCom bot-session treatment. A single `isBotSession` helper funnels all channel checks, and the chat panel fetches channel-specific user metadata only when needed.

```mermaid
flowchart TB
  A[User selects Feishu session] --> B{isBotSession(source)?}
  B -->|yes| C[Skip SSE subscription]
  B -->|yes| D[Fetch /feishu-user]
  B -->|no| E[Normal GUI session flow]
  C --> F[PromptInput renders Feishu bot bar]
  D --> F
  F --> G[Refresh polls /messages/latest]
  E --> H[Render normal chat input]
```

---

## Implementation Units

### U1. Centralize bot-session detection and update client guards

- **Goal:** Make `'feishu'` a first-class bot session source and update every client site that currently checks only `'wecom'`.
- **Requirements:** R1, R2, R3, R5, R6, R7.
- **Dependencies:** None.
- **Files:**
  - `src/client/lib/session-filter.ts`
  - `src/client/lib/session-filter.test.ts`
  - `src/client/components/ChatPanel.tsx`
  - `src/client/stores/chat-store.ts`
- **Approach:** Add `isBotSession(source?: string): boolean` that returns true for `'wecom'` and `'feishu'`. Replace the hardcoded checks in `ChatPanel` (`isBotSession` derivation), `chat-store.setActiveSession` (SSE skip), `chat-store.sendMessage` (send block), and `chat-store.refreshBotMessages` (refresh allow).
- **Patterns to follow:** The existing `getSessionDisplayName` helper in `session-filter.ts` already imports `ChatSession` from `chat-store` and performs source-specific string handling.
- **Test scenarios:**
  - `isBotSession('wecom')` and `isBotSession('feishu')` return true; `isBotSession('gui')`, `isBotSession(undefined)`, and `isBotSession('other')` return false.
  - `ChatPanel` passes `isBotSession={true}` to `PromptInput` when the active session source is `'feishu'`.
  - `setActiveSession` does not call `subscribeToSession` for a Feishu session.
  - `sendMessage` returns early without posting when the target session source is `'feishu'`.
  - `refreshBotMessages` proceeds instead of warning when the target session source is `'feishu'`.
- **Verification:** All existing WeCom bot-session behaviors continue to work, and the new Feishu checks are covered by tests.

### U2. Add Feishu user info route

- **Goal:** Give the chat panel a way to fetch the Feishu user bound to a session.
- **Requirements:** R8.
- **Dependencies:** None.
- **Files:**
  - `src/server/routes/chat.ts`
  - `src/server/routes/chat.test.ts` (if present; otherwise add server/lib test as appropriate)
- **Approach:** Add `GET /api/workspaces/:id/sessions/:sessionId/feishu-user`. Use `store.getFeishuSessionOwner` to resolve the `open_id` for the session, then `store.getFeishuWorkspaceUser` to read cached name and `lastSeenAt`. Return `{ userId, name, lastSeenAt }` with a 404 when the session has no Feishu owner.
- **Patterns to follow:** Mirror the existing `/sessions/:sessionId/wecom-user` route in the same file.
- **Test scenarios:**
  - Happy path: a session mapped to a Feishu user returns `userId`, optional `name`, and `lastSeenAt`.
  - Error path: a session not mapped to any Feishu user returns 404.
  - Error path: a missing workspace or session returns the same 404 shape used by the WeCom route.
- **Verification:** The route returns the expected JSON shape and is reachable from the client.

### U3. Add `feishuBotName` workspace setting

- **Goal:** Provide a configurable display name for the Feishu bot in the chat panel bar.
- **Requirements:** R9, R4.
- **Dependencies:** None.
- **Files:**
  - `src/server/models/workspace.ts`
  - `src/client/components/SettingsPanel.tsx`
  - `src/client/i18n/en/settings.json`
  - `src/client/i18n/zh-CN/settings.json`
  - `src/client/components/SettingsPanel.test.tsx` (or related settings test)
- **Approach:** Add `feishuBotName?: string` to `WorkspaceSettings`. Thread it through the Feishu settings form state in `SettingsPanel`, placing the input in the existing Feishu connection tab near the credentials. Add i18n keys for label, placeholder, and hint, following the `wecom.botName` pattern.
- **Patterns to follow:** The `wecomBotName` field and its UI in `SettingsPanel` already define the shape and placement.
- **Test scenarios:**
  - Happy path: saving workspace settings persists a non-empty `feishuBotName`.
  - Edge case: leaving the field empty saves `undefined` or an empty string without breaking the form.
  - Happy path: `ChatPanel` reads `feishuBotName` from workspace settings for a Feishu session.
- **Verification:** The setting round-trips through the settings UI and API.

### U4. Render Feishu bot bar in the chat panel

- **Goal:** Show the read-only Feishu bot bar with channel branding, user info, and refresh.
- **Requirements:** R3, R4.
- **Dependencies:** U1, U2, U3.
- **Files:**
  - `src/client/components/PromptInput.tsx`
  - `src/client/components/ChatPanel.tsx`
  - `src/client/components/PromptInput.browser.test.tsx`
  - `src/client/components/ChatPanel.test.tsx`
- **Approach:** Refactor `PromptInput` to accept channel-agnostic bot bar props (`botIcon`, `botName`, `botUser`) instead of hardcoding `/wecom-icon.svg` and `wecomUser`. In `ChatPanel`, when the active session is a Feishu bot session, fetch the Feishu user from the new route and pass `feishuBotName` as the bot name; for WeCom, continue passing the existing WeCom data. Keep the refresh button wired to `refreshBotMessages`, which now allows Feishu sessions thanks to U1.
- **Patterns to follow:** The existing WeCom bar layout and refresh meta behavior in `PromptInput`.
- **Test scenarios:**
  - Happy path: a Feishu bot session renders the Feishu icon, configured bot name, and Feishu user identifier in the bot bar.
  - Happy path: a WeCom bot session continues to render the WeCom icon, WeCom bot name, and WeCom user identifier.
  - Happy path: clicking Refresh in a Feishu bot session calls `refreshBotMessages` and shows refresh meta.
  - Edge case: when the Feishu user route returns 404, the bar falls back to showing the user identifier as pending or hidden without crashing.
- **Verification:** Feishu and WeCom bot bars are visually distinct and functionally equivalent.

### U5. Add end-to-end bot-session parity tests

- **Goal:** Prevent regression of the bot-session guard behavior across channels.
- **Requirements:** R1, R3, R5, R6, R7.
- **Dependencies:** U1.
- **Files:**
  - `src/client/components/ChatPanel.test.tsx`
  - `src/client/stores/chat-store.test.ts` (if present; otherwise add store-level test file)
- **Approach:** Add focused tests that verify the full switch-to-bot-session flow: selecting a Feishu session skips SSE subscription, hides the normal input, blocks send, and enables refresh. Keep the existing `PromptInput` mock in `ChatPanel.test.tsx` for unit isolation; rely on `PromptInput.browser.test.tsx` for the bar rendering details from U4.
- **Patterns to follow:** Existing `ChatPanel.test.tsx` setup with mocked stores.
- **Test scenarios:**
  - Integration: switching the active session from a GUI session to a Feishu session unsubscribes from the GUI session and does not subscribe to the Feishu session.
  - Integration: `sendMessage` is a no-op for Feishu sessions even when the user has typed a draft.
  - Integration: `refreshBotMessages` succeeds for Feishu sessions and updates the message list.
- **Verification:** The test suite passes and the new tests fail if the `source === 'feishu'` guard is removed.

---

## Scope Boundaries

### In scope

- Client-side detection of Feishu bot sessions and the resulting GUI suppression.
- Server route to expose Feishu user info for a session.
- Workspace setting for Feishu bot display name.
- Tests for the new behavior and existing WeCom parity.

### Deferred to follow-up work

- Server-side `POST /sessions/:sessionId/messages` guard for bot sessions (the existing WeCom pattern relies on client-side suppression; adding server-side enforcement is a separate security hardening item).
- `feishuBotName` safe-preset auto-application when enabling the Feishu bot (security policy parity with WeCom enablement).
- Session-list display-name prefix stripping for Feishu, if a consistent Feishu naming prefix is introduced later.

### Outside scope

- Changing Feishu bot behavior inside Feishu itself.
- Changing WeCom bot behavior or isolation policies.
- Adding new bot channels beyond Feishu and WeCom.

---

## Risks & Dependencies

- **Regression in WeCom bot sessions.** Centralizing `isBotSession` changes the code path for WeCom. Tests in U5 must cover both channels.
- **`PromptInput` prop API change.** Refactoring the bot bar props is a small breaking change for any call site; `ChatPanel` is the only consumer, but the type change should be reviewed.
- **Feishu user info route depends on store methods that are already present.** If `getFeishuSessionOwner` or `getFeishuWorkspaceUser` change, the route must be updated.
- **Settings UI translation drift.** New i18n keys must be added to both English and Chinese files before the settings change ships.

---

## Sources / Research

- WeCom bot-session GUI precedent: `docs/plans/2026-05-30-003-feat-bot-session-history-viewer-plan.md` and `docs/brainstorms/2026-06-19-wecom-bot-user-isolation-requirements.md`.
- Feishu integration origin: `docs/brainstorms/2026-06-21-feishu-lark-integration-requirements.md`.
- Existing client source checks: `src/client/components/ChatPanel.tsx`, `src/client/components/PromptInput.tsx`, `src/client/stores/chat-store.ts`.
- Existing WeCom user route: `src/server/routes/chat.ts` (`GET /sessions/:sessionId/wecom-user`).
- Existing Feishu storage methods: `src/server/storage/sqlite-store.ts` (`getFeishuSessionOwner`, `getFeishuWorkspaceUser`).
- Existing session display helpers: `src/client/lib/session-filter.ts`.
