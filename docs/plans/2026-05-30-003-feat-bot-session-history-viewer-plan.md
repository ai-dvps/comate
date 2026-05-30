---
title: Bot Session History Viewer
type: feat
status: active
date: 2026-05-30
origin: docs/brainstorms/2026-05-30-bot-session-history-viewer-requirements.md
---

# Bot Session History Viewer

## Summary

Modify the GUI so that WeCom bot sessions open as read-only history viewers instead of live SSE subscribers. Add a server endpoint that returns only messages newer than a given message UUID, and wire a manual refresh button into the disabled chat input area.

---

## Problem Frame

WeCom bot sessions share the same SSE subscription behavior as regular GUI sessions. When a GUI user opens a bot session, the client subscription conflicts with the WeCom bot service's event handling and breaks WeCom streaming. There is currently no way to view a bot conversation without disrupting the WeCom user's live experience. (see origin)

---

## Requirements

- R1. When a bot session (`source === 'wecom'`) is opened in the GUI, the client does not subscribe to the session's SSE stream.
- R2. When a regular (non-bot) session is opened, the client continues to subscribe to the SSE stream as it does today.
- R3. The client tracks the ID of the most recent message it has loaded for each bot session.
- R4. The server exposes an endpoint that returns messages newer than a given message ID for a session.
- R5. The refresh button in the GUI calls the latest-messages endpoint using the last-seen message ID and appends the returned messages to the local message list.
- R6. The initial load of a bot session continues to use the existing full-history endpoint to populate the message list from scratch.
- R7. The chat input area is disabled for bot sessions.
- R8. The disabled input area displays a tooltip or placeholder text indicating that replies must be sent from WeCom.
- R9. A manual refresh button is shown within or adjacent to the disabled input area.
- R10. The existing "WeCom bot session" label in the session list is preserved unchanged.

**Origin actors:** A1 (GUI User), A2 (WeCom User)
**Origin flows:** F1 (GUI user opens a bot session), F2 (GUI user refreshes to see new messages), F3 (WeCom user sends a message and receives a response)
**Origin acceptance examples:** AE1 (covers R1, R2), AE2 (covers R3, R4, R5), AE3 (covers R7, R8, R9)

---

## Scope Boundaries

- No auto-refresh or background polling in the GUI.
- No ability for GUI users to send messages into bot sessions.
- No changes to how the WeCom bot service connects, receives, or sends messages.
- No changes to session creation, session list ordering, or bot configuration.
- No support for message deletion, editing, or reordering in the history viewer.
- Automated tests are deferred to a separate task (the project currently has no test framework).

---

## Context & Research

### Relevant Code and Patterns

- `src/client/stores/chat-store.ts` — Zustand store managing session state, SSE subscriptions (`subscribeToSession`, `setActiveSession`), and message loading (`loadMessages`, `fetchOlderMessages`). `ChatSession.source?: 'gui' | 'wecom'` already identifies bot sessions.
- `src/server/services/chat-service.ts` — `loadMessages()` calls `sdkClient.getSessionMessages()` with `dir`, `offset`, `limit` options. The SDK does not support cursor-based fetching.
- `src/server/routes/chat.ts` — Express router with existing `GET /sessions/:sessionId/messages` endpoint.
- `src/server/services/session-runtime.ts` — `subscribe()` wires a single Express `Response` into the SSE emitter. `botEventHandlers` fire separately for WeCom.
- `src/client/components/ChatPanel.tsx` — Auto-calls `loadMessages()` when `activeSessionId` changes and fetches `activeSession` from the session list.
- `src/client/components/PromptInput.tsx` — Already supports `disabled` prop and `title` attributes for tooltips. Send/clear buttons render in the bottom-right corner.
- `src/server/services/message-normalizer.ts` — `normalizeSessionMessage()` maps `sessionMessage.uuid` to `ChatMessage.id`, giving messages stable, unique IDs.

### Institutional Learnings

- SSE clean-close retry: The client must detect clean SSE closes and retry with exponential backoff (`docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md`). Skipping subscription for bot sessions avoids this entirely.
- Commit docs alongside code: `docs/plans/` and `docs/brainstorms/` files should be committed with implementation changes.

### External References

- None required — local patterns are sufficient.

---

## Key Technical Decisions

- Server-side UUID filtering: The SDK's `getSessionMessages` supports `offset`/`limit` but not cursors. The server will fetch messages, find the index of the provided `afterMessageId`, and return the slice after it. This keeps the API contract clean while working within SDK constraints.
- `afterMessageId` query parameter: A single string parameter on the new endpoint. If omitted or not found, the endpoint falls back to returning all messages (same behavior as the existing endpoint).
- Client tracks last message ID from the local messages array: After any successful load or refresh, `lastMessageId` is derived from `messages[sessionId][messages.length - 1].id`. No separate persistence needed.
- `source === 'wecom'` as discriminator: Reuses the existing session source field set by `ChatService.listSessions()`.

---

## Open Questions

### Resolved During Planning

- **Cursor field:** `ChatMessage.id` (derived from SDK `SessionMessage.uuid`) is stable and unique, making it suitable as a cursor.
- **SDK filtering capability:** `GetSessionMessagesOptions` only supports `dir`, `offset`, `limit`, `includeSystemMessages`. No native after-ID filtering; server-side slicing is required.

### Deferred to Implementation

- **Exact i18n key names:** To be chosen during implementation to match existing `chat` namespace conventions.
- **Refresh button placement within PromptInput:** Exact DOM position (replacing send button, adjacent to it, or in the toolbar row) to be determined during implementation based on visual fit.

---

## Implementation Units

### U1. Server service: `loadMessagesAfter` method

**Goal:** Add a method to `ChatService` that returns messages appearing after a given message UUID in the session's ordered transcript.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `src/server/services/chat-service.ts`

**Approach:**
- Add `loadMessagesAfter(sessionId, workspaceId, afterMessageId?)` to `ChatService`.
- Call `sdkClient.getSessionMessages(sessionId, { dir })` without offset/limit to get the full ordered list.
- Find the index of the message whose `uuid === afterMessageId`.
- If found, slice from `index + 1` to the end; if not found, return all messages (fallback).
- Normalize sliced messages with `normalizeSessionMessage()` and return `{ messages, tasks }`.

**Patterns to follow:**
- Mirror the existing `loadMessages()` signature and error handling (`ChatError` for missing workspace).

**Test scenarios:**
- Happy path: Given a session with messages [M1, M2, M3], when `afterMessageId = M1.id`, then return [M2, M3].
- Edge case: Given `afterMessageId` is the last message, return empty array.
- Edge case: Given `afterMessageId` not found in session, return all messages (fallback).
- Error path: Given invalid workspaceId, throw `ChatError` with 404.

**Verification:**
- The new method compiles and returns correctly ordered, normalized messages for valid inputs.

---

### U2. Server route: latest messages endpoint

**Goal:** Expose `GET /sessions/:sessionId/messages/latest` that delegates to `ChatService.loadMessagesAfter`.

**Requirements:** R4

**Dependencies:** U1

**Files:**
- Modify: `src/server/routes/chat.ts`

**Approach:**
- Add `GET /sessions/:sessionId/messages/latest` route.
- Read `afterMessageId` from query string (`req.query.afterMessageId`).
- Call `chatService.loadMessagesAfter(sessionId, workspaceId, afterMessageId)`.
- Return `{ messages, tasks }` JSON.
- Use the same error handling pattern as the existing messages endpoint.

**Patterns to follow:**
- Follow existing route patterns in `chat.ts` for parameter extraction and error response formatting.

**Test scenarios:**
- Happy path: Request with valid `afterMessageId` returns only newer messages.
- Happy path: Request without `afterMessageId` returns all messages.
- Error path: Invalid session or workspace returns 404/500 with appropriate error body.

**Verification:**
- Endpoint responds correctly when called via curl or the GUI refresh action.

---

### U3. Client store: skip SSE subscription for bot sessions

**Goal:** Prevent the client from subscribing to the SSE stream when the active session is a bot session.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- In `setActiveSession`, before calling `subscribeToSession`, check if the session's `source === 'wecom'`.
- If bot session, skip `subscribeToSession` entirely.
- Ensure `sendMessage` also aborts or shows an error if called on a bot session (defensive guard, even though the UI will disable input).
- Add `isBotSession(workspaceId, sessionId)` helper or derive it from the session list in the store.

**Patterns to follow:**
- The store already accesses `state.sessions[workspaceId]` to find session metadata.

**Test scenarios:**
- Integration: Given a regular session, when `setActiveSession` is called, an SSE subscription is opened.
- Integration: Given a bot session, when `setActiveSession` is called, no SSE subscription is opened.
- Integration: Given switching from a bot session to a regular session, the regular session gets an SSE subscription.

**Verification:**
- Browser Network tab shows no `/stream` request when opening a bot session.
- Browser Network tab shows `/stream` request when opening a regular session.

---

### U4. Client store: `refreshBotMessages` action

**Goal:** Add a store action that fetches only new messages for a bot session and appends them to the local message list.

**Requirements:** R3, R5

**Dependencies:** U2

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- Add `refreshBotMessages(workspaceId, sessionId)` action.
- Derive `afterMessageId` from the last message in `state.messages[sessionId]`.
- Fetch `/api/workspaces/${workspaceId}/sessions/${sessionId}/messages/latest?afterMessageId=${lastId}`.
- Append returned messages to `state.messages[sessionId]`, avoiding duplicates by ID.
- Update any relevant loading flags.

**Patterns to follow:**
- Mirror `fetchOlderMessages` for fetch/merge logic, but append instead of prepend.
- Use `sanitizeMessages` to normalize server payloads.

**Test scenarios:**
- Happy path: Given bot session with messages [M1, M2], when refresh returns [M3], then messages become [M1, M2, M3].
- Happy path: Given no new messages, when refresh returns empty, then message list is unchanged.
- Edge case: Given duplicate message IDs in response, dedupe so list stays stable.

**Verification:**
- Clicking refresh appends only new messages without duplicates or reordering.

---

### U5. Client components: ChatPanel bot session wiring

**Goal:** Pass bot-session status into the chat UI so PromptInput can render the correct state.

**Requirements:** R7, R9

**Dependencies:** U3

**Files:**
- Modify: `src/client/components/ChatPanel.tsx`

**Approach:**
- Derive `isBotSession = activeSession?.source === 'wecom'`.
- Pass `isBotSession` to `PromptInput` as a new prop.
- Pass the `refreshBotMessages` action callback to `PromptInput` for the refresh button.
- Ensure `loadMessages` is still called on initial open for bot sessions (existing behavior).

**Patterns to follow:**
- Use existing `useChatStore` selectors for session metadata and actions.

**Test scenarios:**
- Happy path: Given a bot session is active, `isBotSession=true` is passed to PromptInput.
- Happy path: Given a regular session is active, `isBotSession=false` is passed.

**Verification:**
- ChatPanel renders without errors and passes the correct props for both session types.

---

### U6. Client components: PromptInput disabled state and refresh button

**Goal:** Show a disabled input area with a tooltip and a refresh button when viewing a bot session.

**Requirements:** R7, R8, R9

**Dependencies:** U4, U5

**Files:**
- Modify: `src/client/components/PromptInput.tsx`

**Approach:**
- Add `isBotSession?: boolean` and `onRefresh?: () => void` props.
- When `isBotSession` is true:
  - Set `disabled` on the textarea and command/file buttons.
  - Change textarea placeholder to an i18n key explaining WeCom-only replies.
  - Replace the send button with a refresh button (or add it adjacent).
  - Show a tooltip on the textarea or refresh button.
- Keep the existing layout and styling; use `disabled:opacity-40 disabled:cursor-not-allowed` classes.

**Patterns to follow:**
- Use existing `title` attributes for tooltips (no custom tooltip component needed).
- Use existing `t('key')` i18n pattern.
- Lucide icons: `RefreshCw` for the refresh button.

**Test scenarios:**
- Happy path: Given `isBotSession=true`, the textarea is disabled, placeholder explains WeCom replies, and refresh button is visible.
- Happy path: Given `isBotSession=false`, the component behaves exactly as before.
- Integration: Clicking refresh calls `onRefresh` and shows a loading state while fetching.

**Verification:**
- Bot sessions show the disabled input with refresh button.
- Regular sessions show the normal input with send button.
- Clicking refresh triggers the store action and new messages appear.

---

## System-Wide Impact

- **Interaction graph:** `setActiveSession` no longer unconditionally calls `subscribeToSession`. Any code that assumes an active session always has an open SSE connection must be reviewed. The `sendMessage` action should guard against bot sessions.
- **Error propagation:** If the latest-messages endpoint fails, the refresh button should surface the error without breaking the existing message list.
- **State lifecycle risks:** Switching between bot and regular sessions must cleanly close any existing subscription and not leak `AbortController` instances.
- **API surface parity:** The new endpoint follows the same pattern as the existing messages endpoint. No other interfaces require changes.
- **Unchanged invariants:** The WeCom bot service (`wecom-bot-service.ts`), session runtime SSE mechanics, and session list rendering remain untouched. Regular GUI sessions continue to subscribe and stream normally.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SDK `getSessionMessages` performance on very long sessions | Acceptable for typical bot conversations; monitor and consider adding server-side caching if needed |
| Client assumes active session always has SSE subscription | Audit `sendMessage` and other actions to guard against bot sessions |
| i18n key missing for tooltip/placeholder | Add keys during U6 implementation |

---

## Documentation / Operational Notes

- Update any developer docs that describe session streaming behavior to note the bot-session exception.
- No rollout or monitoring changes required.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-30-bot-session-history-viewer-requirements.md](../brainstorms/2026-05-30-bot-session-history-viewer-requirements.md)
- Related code: `src/server/services/session-runtime.ts` (SSE subscription mechanics)
- Related code: `src/server/services/wecom-bot-service.ts` (bot event handler registration)
- Related plan: `docs/plans/2026-05-21-009-feat-wecom-streaming-response-plan.md`
