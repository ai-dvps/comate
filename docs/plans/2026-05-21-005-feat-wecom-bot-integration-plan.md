---
title: WeCom Bot Integration
type: feat
status: active
date: 2026-05-21
origin: docs/brainstorms/2026-05-21-wecom-bot-integration-requirements.md
---

# WeCom Bot Integration

## Summary

Add per-workspace WeCom bot integration. A workspace can be configured with bot credentials and an enable toggle. When enabled, the server maintains a websocket connection to WeCom; incoming messages are routed through the existing `SessionRuntime` and SSE pipeline, with an independent bot event consumer that collects assistant text and sends it back to WeCom users. Bot sessions are distinguished in the GUI session list with a badge.

---

## Problem Frame

Teams using WeChat Work currently have no bridge between their chat app and Claude Code sessions. This plan implements that bridge by treating a workspace as a WeCom bot endpoint, reusing the existing session and streaming infrastructure rather than building a parallel message path.

---

## Requirements

- R1. The workspace settings panel includes a WeCom Bot section with fields for bot ID and bot secret.
- R2. The WeCom Bot section includes an enable/disable toggle.
- R3. Bot credentials are persisted with the workspace settings.
- R4. When the bot is enabled and credentials are present, the server establishes a websocket connection to WeCom.
- R5. When the bot is disabled or credentials are removed, the websocket disconnects.
- R6. Connection status (connected, disconnected, error) is visible in the workspace settings.
- R7. When a message is received from WeCom, the system looks up the sender's user ID in the user-to-session mapping.
- R8. If no session exists for the user, a new session is created in the workspace.
- R9. The message is sent to the corresponding Claude Code session.
- R10. Claude's response is sent back to the WeCom user via the bot API.
- R11. A database table tracks the mapping between WeCom user ID and Claude Code session ID per workspace.
- R12. Bot-created sessions appear in the GUI session list with a visual indicator (badge or label).
- R13. Bot sessions can be opened and interacted with in the GUI like regular sessions.
- R14. On server restart, enabled bots automatically reconnect.
- R15. Websocket disconnects trigger reconnection attempts with backoff.

**Origin actors:** A1 (Admin), A2 (WeCom User), A3 (GUI User)

**Origin flows:** F1 (Admin enables bot), F2 (WeCom user sends message), F3 (GUI user views bot session)

**Origin acceptance examples:** AE1 (Covers R1–R4), AE2 (Covers R7–R10), AE3 (Covers R7, R9, R10), AE4 (Covers R12–R13)

---

## Scope Boundaries

- No admin messaging WeCom users from the GUI.
- No session expiry or automatic cleanup.
- No support for non-text messages (images, files, voice) in the initial version.
- No multi-bot per workspace.
- No bot usage analytics or reporting.
- Tool approvals in bot sessions are auto-allowed (user-confirmed decision).

### Deferred to Follow-Up Work

- Credential encryption or server-only secret storage.
- Rate limiting for inbound WeCom messages.
- Group chat support (currently 1:1 direct messages only).

---

## Context & Research

### Relevant Code and Patterns

- `src/server/models/workspace.ts` — `WorkspaceSettings` interface uses optional fields for nested config (`model`, `apiKey`).
- `src/server/storage/sqlite-store.ts` — `SqliteStore` uses `CREATE TABLE IF NOT EXISTS` in the constructor for schema management; no formal migration framework.
- `src/server/services/session-runtime.ts` — `SessionRuntime` creates an `SseEmitter` with an `onEvent` callback for the ring buffer. The `canUseTool` callback is set at construction time via SDK `Options`.
- `src/server/services/chat-service.ts` — `ChatService` manages session lifecycle via `getOrCreateRuntime`, `createSession`, and `buildSdkOptions`.
- `src/server/services/sse-emitter.ts` — `SseEmitter` supports a swappable `Response` and an `onEvent` callback that fires for every event regardless of SSE subscriber state.
- `src/client/components/SettingsPanel.tsx` — Settings uses a two-column layout for workspace tabs, explicit Save with dirty-state tracking, and a tab union type.
- `src/client/components/SessionList.tsx` — Session rows already show draft badges; can follow the same pattern for a WeCom badge.
- `src/server/index.ts` — Express app bootstrap; no background services currently initialized after `server.listen()`.

### Institutional Learnings

- The draft-to-SDK session lifecycle (create draft → first message promotes to SDK via `options.sessionId`) should be followed for bot-created sessions to keep session IDs aligned.
- `SessionRuntime.subscribe()` overwrites `activeRes`; concurrent GUI and bot access must not both rely on SSE subscription. The `onEvent` callback fires independently and is the right hook for bot consumption.
- Auto-reconnect uses exponential backoff (2s base, 30s max, 5 attempts) in the SSE client; bot websocket reconnection should follow a similar pattern.

### External References

- WeCom AI bot SDK (`@wecom/aibot-node-sdk`) provides websocket connection and send-message APIs. Exact method signatures will be discovered during implementation.

---

## Key Technical Decisions

- **Bot sessions reuse SessionRuntime:** Rather than a parallel SDK query path, bot sessions use the same `SessionRuntime` as GUI sessions. This ensures GUI visibility, approval state sharing, and message history alignment. The bot consumes assistant text via an independent callback on `SessionRuntime`, not via SSE.
- **Auto-allow all tools for bot sessions:** The `canUseTool` callback for bot sessions returns `{ behavior: 'allow' }` unconditionally. This avoids hanging bot conversations on tool approvals, at the cost of unsupervised tool execution. Chosen by user confirmation.
- **User-to-session mapping in SQLite:** A dedicated `wecom_user_sessions` table with `(workspaceId, wecomUserId)` primary key and `sessionId` column. This is cleaner than encoding the mapping in session titles or SDK metadata.
- **Bot config in WorkspaceSettings JSON:** `wecomBotId`, `wecomBotSecret`, and `wecomBotEnabled` live inside the existing `settings` JSON column. No schema migration is required for the workspaces table.
- **WeComBotService as singleton:** A single server-side service manages all bot websocket connections, keyed by `workspaceId`. Initialized after `server.listen()` and disconnected on graceful shutdown.

---

## Open Questions

### Resolved During Planning

- **Tool approvals in bot sessions:** Auto-allow all tools, confirmed by user.

### Deferred to Implementation

- **[Affects R10][Technical]** Exact WeCom SDK method for sending text responses back to users. Will be discovered when `@wecom/aibot-node-sdk` API is inspected.
- **[Affects R14–R15][Technical]** Exact websocket reconnection backoff parameters. Will follow the same exponential backoff pattern used for SSE reconnect (2s base, 30s max).
- **[Affects R12][Technical]** Whether `ChatSession.source` should be stored in the draft JSON, derived from the user-mapping table at list time, or both. Will be decided based on which layer can most reliably distinguish bot sessions.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
sequenceDiagram
    participant W as WeCom User
    participant WS as WeCom WebSocket
    participant BS as WeComBotService
    participant CS as ChatService
    participant RT as SessionRuntime
    participant SE as SseEmitter
    participant GUI as GUI Client

    W->>WS: Send message
    WS->>BS: onMessage(userId, text)
    BS->>BS: Lookup wecom_user_sessions;<br/>create session if missing
    BS->>CS: getOrCreateRuntime(sessionId, wsId, {isBot:true})
    CS->>RT: open with bot event callback
    BS->>RT: pushMessage(text)
    RT->>SE: SDK messages → events
    SE-->>GUI: SSE events (if subscribed)
    SE-->>BS: bot callback events
    BS->>BS: Aggregate text deltas
    BS->>WS: sendResponse(userId, text)
    WS->>W: Claude's reply
```

The bot event consumer is registered when `SessionRuntime` is opened with a bot flag. It receives the same `SseEvent` stream that the SSE emitter produces, but through a direct callback rather than HTTP streaming. This allows a GUI client and the bot to observe the same session simultaneously without fighting over the single `activeRes` SSE subscriber slot.

---

## Implementation Units

### U1. Database and model changes for bot config and user-session mapping

**Goal:** Add WeCom bot configuration to the workspace model and create a persistent user-to-session mapping table.

**Requirements:** R1, R2, R3, R11

**Dependencies:** None

**Files:**
- Modify: `src/server/models/workspace.ts`
- Modify: `src/server/storage/sqlite-store.ts`
- Test expectation: none — schema and type changes; behavioral verification happens in downstream units

**Approach:**
- Extend `WorkspaceSettings` with optional `wecomBotId`, `wecomBotSecret`, and `wecomBotEnabled` fields.
- Add `CREATE TABLE IF NOT EXISTS wecom_user_sessions (workspaceId TEXT NOT NULL, wecomUserId TEXT NOT NULL, sessionId TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY (workspaceId, wecomUserId))` in the `SqliteStore` constructor.
- Add CRUD methods in `SqliteStore` for the mapping table: `getWecomSession`, `setWecomSession`, `listWecomSessions`.
- Ensure the mapping table is included in workspace deletion cleanup.

**Patterns to follow:**
- Existing `WorkspaceSettings` shape with optional nested fields.
- Existing `CREATE TABLE IF NOT EXISTS` schema management pattern in `sqlite-store.ts`.

**Verification:**
- `sqlite-store.ts` can create, read, and delete WeCom user session mappings.
- Workspaces with bot config round-trip through the store correctly.

---

### U2. Extend SessionRuntime for bot event consumption and auto-allow tools

**Goal:** Allow bot sessions to consume assistant events independently of SSE subscribers, and automatically approve all tool requests.

**Requirements:** R9, R10

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/session-runtime.ts`
- Modify: `src/server/services/chat-service.ts`
- Test expectation: none — infrastructure extension; verified via U3 integration

**Approach:**
- Add an optional `botEventHandler` callback to `SessionRuntime.open()` and the constructor. This callback receives `(id: number, event: SseEvent)` and fires for every event independently of SSE subscribers.
- In `ChatService.buildSdkOptions`, accept an optional `isBotSession` flag. When true, set `canUseTool` to a callback that immediately resolves `{ behavior: 'allow' }` instead of emitting pending approvals.
- In `ChatService.getOrCreateRuntime`, accept an optional `isBotSession` flag and pass it through to `buildSdkOptions`.
- Ensure the bot event handler is wired through the `SseEmitter`'s existing `onEvent` callback mechanism.

**Patterns to follow:**
- Existing `SseEmitter` constructor callback pattern used for the ring buffer.
- Existing `Options.canUseTool` override pattern (currently set in `SessionRuntime.start()`).

**Verification:**
- A session opened with `isBotSession: true` auto-allows tools without emitting `pending_approval` events.
- A bot event handler receives `text_delta` and `assistant_done` events when a message is pushed.

---

### U3. WeCom bot service

**Goal:** Core bot logic — manage websocket connections, route messages, collect responses, and send them back to WeCom.

**Requirements:** R4, R7, R8, R9, R10, R14, R15

**Dependencies:** U1, U2

**Files:**
- Create: `src/server/services/wecom-bot-service.ts`
- Modify: `src/server/services/chat-service.ts` (add `createBotSession` or equivalent if needed)

**Approach:**
- Implement `WeComBotService` as a singleton class.
- Maintain a `Map<string, WebSocketConnection>` keyed by `workspaceId`.
- Each connection tracks its workspace, websocket instance, reconnection timer, and connection state.
- `connect(workspace)`:
  - Validate that `wecomBotEnabled`, `wecomBotId`, and `wecomBotSecret` are present.
  - Establish websocket to WeCom using the SDK.
  - On open: set status to `connected`.
  - On message: parse the WeCom message payload, extract `userid` and text content, look up or create a session via `chatService`, get or create a bot runtime, push the message, and begin collecting the response.
  - On close/error: set status to `disconnected` or `error`, schedule reconnection with exponential backoff.
- `disconnect(workspaceId)`: close websocket, clear reconnection timer, remove from map.
- `handleIncomingMessage(workspaceId, wecomUserId, content)`:
  - Query `wecom_user_sessions` for an existing mapping.
  - If none exists, create a new session via `chatService.createSession({ workspaceId, name: 'WeCom: ' + wecomUserId })`, then store the mapping.
  - Call `chatService.getOrCreateRuntime(sessionId, workspaceId, { isBotSession: true })`.
  - Register a one-time bot event handler that aggregates `text_delta` events until `assistant_done`, then sends the collected text to WeCom.
  - Push the message via `runtime.pushMessage(content)`.
- `sendResponse(wecomUserId, text)`: use the WeCom SDK/API to send the response text back.

**Technical design:**
The bot event handler for a single turn should be stateful across the turn:
1. Initialize an empty text buffer.
2. On each `text_delta`, append `event.text` to the buffer.
3. On `assistant_done` or `error_note`, send the buffer content via WeCom and unregister the handler.
4. On `interrupted`, send what has been collected so far.

**Patterns to follow:**
- `ChatService` singleton pattern.
- SSE client reconnection backoff (2s base, 30s max, cap attempts).

**Test scenarios:**
- **Happy path:** WeCom user sends first message → new session created → response collected and sent back.
- **Happy path:** WeCom user sends follow-up → existing session reused → response collected and sent back.
- **Edge case:** Websocket disconnects during idle → reconnection scheduled and succeeds.
- **Edge case:** Websocket disconnects mid-stream → in-flight response may be truncated; next message creates a new turn.
- **Error path:** Invalid bot credentials → connection fails, status shows `error`.
- **Integration:** Server restart → enabled bots reconnect automatically.

**Verification:**
- Bot service connects to WeCom when credentials are valid and enabled.
- Messages from WeCom users result in responses sent back through WeCom.
- Reconnection occurs after websocket disconnects.

---

### U4. Server integration and status API

**Goal:** Wire the bot service into server lifecycle and expose connection status to clients.

**Requirements:** R4, R5, R6, R14

**Dependencies:** U3

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/server/routes/workspaces.ts`

**Approach:**
- In `src/server/index.ts`, after `server.listen()`, call `wecomBotService.initialize()` which iterates all workspaces and connects enabled bots.
- On `SIGTERM` / `SIGINT`, call `wecomBotService.disconnectAll()` before shutting down.
- Add `GET /api/workspaces/:id/bot/status` to return the current connection status (`connected`, `disconnected`, `error`) for the workspace's bot.
- In the `PUT /api/workspaces/:id` route, after updating the workspace, notify `wecomBotService` to connect or disconnect based on the new `wecomBotEnabled` value.

**Patterns to follow:**
- Existing Express route error handling (`console.error` + 500 JSON).
- Existing workspace route parameter pattern (`req.params.id`).

**Test scenarios:**
- **Happy path:** Server starts with an enabled bot → websocket connects.
- **Happy path:** Admin disables bot via settings update → websocket disconnects.
- **Edge case:** Status endpoint returns `disconnected` when bot is not configured.
- **Integration:** Workspace update triggers connect/disconnect dynamically.

**Verification:**
- Status endpoint accurately reflects connection state.
- Enabling/disabling a bot in settings causes connect/disconnect without server restart.

---

### U5. Bot settings UI

**Goal:** Add a WeCom Bot tab to the workspace settings panel for configuring credentials and viewing connection status.

**Requirements:** R1, R2, R3, R6

**Dependencies:** U1, U4

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`
- Create: `src/client/components/settings/WeComBotTab.tsx`
- Modify: `src/client/stores/workspace-store.ts` (if type updates are needed)

**Approach:**
- Add `'wecom'` to the `SettingsTab` union type.
- Add WeCom bot fields to the workspace form state type.
- Create `WeComBotTab` component following the pattern of `McpTab` / `HooksTab`:
  - Bot ID input field.
  - Bot secret input field (type="password").
  - Enable/disable toggle.
  - Connection status indicator (fetched from `GET /api/workspaces/:id/bot/status`).
- Register the tab in `SettingsPanel`'s tab rendering.
- Include bot fields in the Save payload sent to `PUT /api/workspaces/:id`.

**Patterns to follow:**
- Existing two-column workspace settings layout.
- Explicit Save with dirty-state tracking (`snapshotRef`, deep comparison).
- Existing `McpTab` form field and list patterns.

**Test scenarios:**
- **Happy path:** Admin enters credentials, enables bot, clicks Save → status updates to connected.
- **Edge case:** Invalid credentials → status shows error after connection attempt.
- **Edge case:** Unsaved changes trigger confirmation dialog on close.
- **Edge case:** Bot secret is masked in the input field.

**Verification:**
- Settings UI allows configuring bot ID, secret, and enable toggle.
- Connection status is visible and updates after Save.

---

### U6. Bot session badge in GUI

**Goal:** Distinguish bot-created sessions from regular GUI sessions in the session list.

**Requirements:** R12, R13

**Dependencies:** U1, U2

**Files:**
- Modify: `src/server/models/session.ts`
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/client/stores/chat-store.ts`
- Modify: `src/client/components/SessionList.tsx`

**Approach:**
- Add optional `source?: 'gui' | 'wecom'` to the `ChatSession` interface.
- In `ChatService.listSessions`, after merging SDK and draft sessions, join with `wecom_user_sessions` to identify bot sessions and set `source: 'wecom'` where a mapping exists.
- In `ChatService.createSession`, accept an optional `source` parameter; bot service passes `source: 'wecom'` when creating sessions.
- In `SessionList.tsx`, render a "WeCom" badge (similar to the "Draft" badge) for sessions where `source === 'wecom'`.
- Ensure clicking a bot session opens it in the chat panel normally (SSE subscription, message loading, etc.).

**Patterns to follow:**
- Existing draft badge rendering in `SessionList.tsx`.
- Existing session type definitions in `src/server/models/session.ts` and `src/client/stores/chat-store.ts`.

**Test scenarios:**
- **Happy path:** A bot-created session appears in the session list with a WeCom badge.
- **Happy path:** A GUI-created session has no WeCom badge.
- **Integration:** Clicking a bot session opens the chat panel and loads messages correctly.
- **Edge case:** A bot session and GUI session for the same workspace are both visible and correctly distinguished.

**Verification:**
- Bot sessions are visually distinct in the session list.
- Bot sessions can be opened and viewed in the chat panel.

---

## System-Wide Impact

- **Interaction graph:** `WeComBotService` calls into `ChatService` and `SqliteStore`. `SessionRuntime` gains an optional bot event callback. `SettingsPanel` gains a new tab. The server startup sequence invokes `WeComBotService.initialize()`.
- **Error propagation:** WeCom connection errors are logged and surfaced via the status API; they do not crash the server. Bot message handling errors are caught and logged; failed responses are silently dropped (no retry to WeCom in v1).
- **State lifecycle risks:** If a bot session is deleted via the GUI, the `wecom_user_sessions` mapping becomes orphaned. The next message from that WeCom user will try to use the deleted session ID, fail, and should create a new session automatically. This cleanup should be handled in `WeComBotService.handleIncomingMessage`.
- **API surface parity:** No changes to existing client-facing APIs beyond the new `GET .../bot/status` endpoint. Existing workspace CRUD, session CRUD, and SSE endpoints are unchanged.
- **Integration coverage:** Cross-layer scenarios that unit tests alone will not prove:
  - GUI user opens a bot session while the bot is actively streaming a response — both should see events.
  - Server restart reconnects bots and resumes sessions correctly.
- **Unchanged invariants:**
  - The SSE streaming protocol and event types are unchanged.
  - GUI session creation and messaging behavior is unchanged.
  - Workspace settings persistence format is unchanged (bot config is additive within the JSON settings blob).

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| WeCom SDK API is undocumented or unstable in English | Abstract behind `WeComBotService` interface; inspect package at implementation time; fall back to REST API if SDK fails |
| Bot auto-allow exposes workspace to unsupervised tool execution | User explicitly accepted this trade-off; document that bot sessions have full tool access |
| Concurrent GUI and bot access to SessionRuntime causes event loss | Bot uses independent `onEvent` callback, not SSE subscription, so it does not compete with GUI for `activeRes` |
| Credential exposure via workspace API | Follows existing API key pattern; deferred to follow-up work for encryption |
| Websocket reconnection storm on server restart | Stagger reconnections or use exponential backoff per connection |

---

## Documentation / Operational Notes

- Bot sessions have full tool auto-approval. Admin should be aware that enabling a bot grants unsupervised file and command access within the workspace directory.
- Connection status is visible in workspace settings but does not auto-update without a refresh or status poll.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-21-wecom-bot-integration-requirements.md](docs/brainstorms/2026-05-21-wecom-bot-integration-requirements.md)
- Related code: `src/server/services/session-runtime.ts`, `src/server/services/chat-service.ts`, `src/server/storage/sqlite-store.ts`, `src/client/components/SettingsPanel.tsx`
- External docs: WeCom AI bot developer documentation at https://developer.work.weixin.qq.com/document/path/101463
