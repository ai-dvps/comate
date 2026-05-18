---
title: Delegate Session Management to Claude Code Agent SDK
type: feat
status: active
date: 2026-05-16
origin: docs/brainstorms/claude-code-gui-workspace-manager-requirements.md
---

# Delegate Session Management to Claude Code Agent SDK

## Summary

Upgrade the Claude Code Agent SDK to a stable 0.2.x release and replace the local JSON session store with SDK-native session APIs. Sessions are discovered via `listSessions({ dir })`, message history loaded via `getSessionMessages`, and draft sessions kept locally only until the first chat message creates the real SDK session.

---

## Problem Frame

The app currently stores session metadata in a local JSON file (`~/.claude-code-gui/sessions.json`) and only links to the SDK via the `sdkSessionId` field after the first chat message. This means sessions created outside the app (e.g., via the Claude Code CLI) are invisible, and the session list does not reflect the SDK's actual session state. Requirement R9 states that session history should be delegated to and managed by the Claude Code SDK. (see origin: docs/brainstorms/claude-code-gui-workspace-manager-requirements.md)

---

## Requirements

- R1. Workspace sessions are listed from the Claude Code SDK via `listSessions({ dir })` rather than a local JSON store.
- R2. Session message history is loaded from the SDK via `getSessionMessages`.
- R3. Sessions can be renamed via the SDK `renameSession` API.
- R4. Sessions can be deleted via the SDK `deleteSession` API.
- R5. New sessions remain creatable from the UI; they exist as lightweight local drafts until the first chat message initializes the SDK session.
- R6. The SDK upgrade does not break existing chat streaming behavior.

**Origin actors:** A1 (Developer)
**Origin flows:** F2 (Open workspace and start chat), F3 (Switch between workspace tabs)

---

## Scope Boundaries

- No changes to workspace storage (already SQLite) or workspace CRUD endpoints.
- No changes to file explorer behavior.
- No changes to chat streaming protocol or SSE event handling.
- Session search/filtering remains deferred.

### Deferred to Follow-Up Work

- Session tagging via `tagSession`.
- Session forking via `forkSession`.
- Loading partial message history with pagination/offset.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/storage/json-store.ts` — `JsonStore` class with session CRUD methods (`listSessions`, `getSession`, `createSession`, `updateSession`, `deleteSession`). Sessions stored in `~/.claude-code-gui/sessions.json`.
- `src/server/services/chat-service.ts` — `ChatService` delegates all session operations to `JsonStore`. `sendMessage` calls `sdkClient.createQuery()` with `resume: sdkSessionId` when present.
- `src/server/services/sdk-client.ts` — thin wrapper around SDK `query()`.
- `src/server/routes/chat.ts` — Express routes for session CRUD and chat streaming.
- `src/client/stores/chat-store.ts` — Zustand store with `fetchSessions`, `createSession`, `deleteSession`, `sendMessage`.
- `src/client/components/SessionList.tsx` — renders sessions, supports create/delete.
- `src/client/components/ChatPanel.tsx` — fetches sessions on mount, renders `MessageList`.

### External References

- [Claude Code Agent SDK TypeScript Docs — listSessions](https://code.claude.com/docs/en/agent-sdk/typescript#listsessions)
- [SDK Changelog — session API additions in 0.2.53–0.2.75](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)

---

## Key Technical Decisions

- **SDK target version: `^0.2.141`**: Latest stable 0.2.x with all required session APIs (`listSessions`, `getSessionMessages`, `getSessionInfo`, `renameSession`, `deleteSession`). Avoiding 0.3.142 which removes V2 APIs and changes MCP connection behavior, reducing migration risk.
- **Draft sessions kept in lightweight local storage**: The SDK has no standalone "create empty session" API — sessions are created when `query()` is first called. To preserve the "New Session" UX, drafts are stored locally (JSON or SQLite) until first message, then linked to the SDK via `query()` `sessionId` and `title` options.
- **Session ID alignment**: Draft sessions use app-generated UUIDs. When `query()` is called for the first message, the draft UUID is passed as `options.sessionId` so the SDK session shares the same ID, eliminating dual-ID complexity.
- **Message history loaded on demand**: `getSessionMessages` is called when a user switches to an SDK-discovered session, populating the chat panel with past conversation state.

---

## Open Questions

### Resolved During Planning

- **Which SDK version has `listSessions`?** 0.2.53 added `listSessions`, 0.2.58 added `getSessionMessages`, 0.2.74 added `renameSession`, 0.2.75 added `getSessionInfo`/`tagSession`, 0.2.113 added `deleteSession`. Targeting 0.2.141 covers all.
- **Does `query()` behavior change between 0.1 and 0.2?** No breaking changes to `query()` signature. `options.env` behavior changed in 0.2.113 from "overlay" to "replace", but current code already spreads `process.env` explicitly so it is compatible.

### Deferred to Implementation

- **Exact local storage for drafts**: whether to keep a minimal JSON file, add a SQLite `sessions` table, or use an in-memory Map. Decision depends on whether draft persistence across server restarts is desired.
- **Final mapping of `SDKSessionInfo` fields to `ChatSession`**: exact field names and optional handling to be settled when reading the upgraded SDK types.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Draft Session Lifecycle

```
User clicks "New Session"
  -> Frontend: POST /api/workspaces/:id/sessions { name }
  -> Backend: ChatService.createSession() inserts draft into local storage (isDraft: true)
  -> Frontend: Session appears in sidebar with "Draft" indicator

User sends first message to draft
  -> Backend: ChatService.sendMessage() sees isDraft: true
  -> Backend: SdkClient.createQuery(message, { sessionId: draftId, title: draftName, ... })
  -> SDK: Creates real session with the provided ID and title
  -> Backend: Stream returns via SSE to client
  -> Backend: After stream, clear isDraft flag (route-level callback)
  -> Frontend: Session badge changes from "Draft" to normal

User switches to existing SDK session
  -> Frontend: setActiveSession(sessionId)
  -> Frontend: GET /api/workspaces/:id/sessions/:sessionId/messages
  -> Backend: ChatService.loadMessages() calls getSessionMessages(sessionId, { dir })
  -> Frontend: Chat panel populates with past messages

User sends subsequent messages
  -> Backend: ChatService.sendMessage() sees non-draft session
  -> Backend: SdkClient.createQuery(message, { resume: sessionId, ... })
  -> SDK: Resumes existing session
```

### Session Storage Architecture

| Source | Purpose | API |
|--------|---------|-----|
| SDK `listSessions({ dir })` | Primary session discovery | `ChatService.listSessions()` |
| SDK `getSessionInfo(id, { dir })` | Single session metadata | `ChatService.getSession()` |
| SDK `getSessionMessages(id, { dir })` | Conversation history | `ChatService.loadMessages()` |
| SDK `renameSession(id, title, { dir })` | Rename operation | `ChatService.updateSession()` |
| SDK `deleteSession(id, { dir })` | Remove session | `ChatService.deleteSession()` |
| Local storage (JSON/SQLite) | Draft sessions only | `ChatService.createSession()`, draft CRUD |

---

## Implementation Units

### U1. Upgrade Claude Code Agent SDK and Validate Compatibility

**Goal:** Update the SDK dependency to `^0.2.141`, install, and verify the build still passes.

**Requirements:** R6

**Dependencies:** None

**Files:**
- Modify: `package.json`

**Approach:**
- Change `@anthropic-ai/claude-agent-sdk` from `^0.1.0` to `^0.2.141`.
- Run `npm install`.
- Verify `npm run build` and `npm run build:server` succeed.
- If type errors surface (e.g., `Options`, `SDKMessage` changes), fix them. Based on changelog analysis, `query()` signature is stable.

**Patterns to follow:**
- Keep `options.env` spread pattern `{ ...process.env }` — compatible with 0.2.113's replacement behavior.

**Test scenarios:**
- **Happy path:** `npm install` succeeds, server and client build without type errors.
- **Error path:** If build fails, diagnose SDK type changes and fix before proceeding.

**Verification:**
- `npm run build` completes successfully.
- `npm run dev:server` starts without runtime errors.

---

### U2. Replace Session Listing with SDK `listSessions`

**Goal:** Make `ChatService.listSessions()` discover sessions from the SDK instead of the JSON store.

**Requirements:** R1

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/server/storage/json-store.ts`
- Modify: `src/server/models/session.ts`

**Approach:**
- In `ChatService.listSessions(workspaceId)`: look up the workspace's `folderPath`, then call SDK `listSessions({ dir: folderPath })`.
- Map `SDKSessionInfo` to `ChatSession`, preserving the app's expected fields (`id`, `name`, `workspaceId`, `createdAt`, `updatedAt`). Use `sessionId` as `id`, `summary` or `customTitle` as `name`.
- Merge SDK-discovered sessions with any local draft sessions for the workspace.
- Repurpose `JsonStore` session methods for draft-only storage (rename to `DraftSessionStore` or keep as `JsonStore` but scope to drafts). The full session listing no longer reads from JSON.
- Update `ChatSession` model to drop `sdkSessionId` since session IDs will now align directly with SDK session IDs.

**Patterns to follow:**
- Keep existing REST response shape (`{ sessions: ChatSession[] }`) so frontend requires no immediate changes.

**Test scenarios:**
- **Happy path:** `listSessions` returns SDK sessions for a workspace directory.
- **Happy path:** Sessions created outside the app (via CLI) appear in the list.
- **Edge case:** No SDK sessions for workspace → returns empty array (plus any drafts).
- **Edge case:** Draft session exists alongside SDK sessions → both appear in merged list.
- **Error path:** SDK `listSessions` throws → return 500 with appropriate error message.

**Verification:**
- `GET /api/workspaces/:id/sessions` returns sessions from the SDK for that workspace's folder path.
- Frontend session list populates with SDK-discovered sessions.

---

### U3. Refactor Session CRUD to Use SDK APIs

**Goal:** Replace JSON-store-backed /session create/update/delete with SDK-native operations.

**Requirements:** R3, R4, R5

**Dependencies:** U2

**Files:**
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/server/models/session.ts`

**Approach:**
- `ChatService.createSession(workspaceId, name)` → insert a draft session into lightweight local storage with `isDraft: true`.
- `ChatService.getSession(id)` → try SDK `getSessionInfo(id, { dir })`; fall back to local draft lookup.
- `ChatService.deleteSession(id)` → if draft, remove from local storage; if SDK session, call SDK `deleteSession(id, { dir })`.
- `ChatService.updateSession(id, input)` → if draft, update local storage; if SDK session, call `renameSession(id, name, { dir })`.
- Update `ChatSession` model to add `isDraft?: boolean`.

**Technical design:**
> Draft sessions are a temporary bridge. When `query()` is called with `options.sessionId: draftId`, the SDK creates a real session using that ID. After the first successful message, the draft flag is cleared. Subsequent `listSessions` calls will discover it naturally.

**Patterns to follow:**
- Keep route handler signatures unchanged to minimize frontend churn.

**Test scenarios:**
- **Happy path:** Create session → returns draft session with `isDraft: true`.
- **Happy path:** Delete draft → removed from local storage, no SDK call.
- **Happy path:** Rename SDK session → `renameSession` called, next `listSessions` reflects new name.
- **Happy path:** Delete SDK session → `deleteSession` called, session no longer appears in list.
- **Edge case:** Rename draft → updates local storage only.
- **Error path:** SDK `deleteSession` fails → propagate error to client.

**Verification:**
- `POST /api/workspaces/:id/sessions` creates a draft.
- `DELETE /api/workspaces/:id/sessions/:sessionId` removes draft or SDK session appropriately.

---

### U4. Link Draft Sessions to SDK on First Message

**Goal:** When a user sends the first message to a draft session, initialize the SDK session with the draft's ID and name.

**Requirements:** R5

**Dependencies:** U3

**Files:**
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/server/routes/chat.ts`

**Approach:**
- In `ChatService.sendMessage(sessionId, message)`:
  1. Look up the session (try SDK `getSessionInfo` first, then local draft).
  2. If draft (`isDraft: true`):
     - Call `sdkClient.createQuery(message, { sessionId: session.id, title: session.name, cwd, env, model, ... })`.
     - Do NOT pass `resume` since there is no prior SDK session.
     - Return a flag or callback alongside the stream so the route knows to clear the draft flag after streaming ends.
  3. If not draft:
     - Call `sdkClient.createQuery(message, { resume: session.id, cwd, env, model, ... })` as before.
- In `chat.ts` SSE route: after the stream loop finishes (successfully or with error), if the session was a draft, call a service method to clear the `isDraft` flag.
- Remove the old `sdkSessionId` capture-and-persist logic since `session.id` is now the SDK session ID.

**Technical design:**
> The service layer initiates the query but does not own the streaming lifecycle — the Express route does. The draft-to-SDK transition must be signaled back to the route so it can clear the flag after the SSE stream closes. Options: (a) return a `wasDraft` boolean from `sendMessage` that the route checks, or (b) have the route always call `chatService.clearDraftIfNeeded(sessionId)` after streaming. Either approach keeps the service stateless.

**Patterns to follow:**
- Keep existing SSE streaming loop structure in `chat.ts` unchanged beyond the post-stream callback.

**Test scenarios:**
- **Happy path:** First message to draft → `query()` called with `sessionId` and `title`; stream succeeds; draft flag cleared.
- **Happy path:** Subsequent messages → `query()` called with `resume: session.id`.
- **Integration:** After first message, `listSessions` discovers the session.
- **Error path:** `query()` fails for draft → draft remains draft, error returned to client.
- **Edge case:** Client disconnects mid-stream → draft flag may or may not clear; acceptable since next `listSessions` will still discover the session if the SDK persisted it.

**Verification:**
- Sending first message to a new session creates an SDK session with the same ID.
- Subsequent messages resume the same SDK session.
- Session appears in `listSessions` after first message.

---

### U5. Add Session Message History Loading

**Goal:** Load past conversation history from SDK sessions when a user selects them.

**Requirements:** R2

**Dependencies:** U2, U4

**Files:**
- Create: new endpoint in `src/server/routes/chat.ts`
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- Add `ChatService.loadMessages(sessionId, workspaceId)` that calls SDK `getSessionMessages(sessionId, { dir: workspace.folderPath })`.
- Add `GET /api/workspaces/:id/sessions/:sessionId/messages` route.
- Map `SessionMessage` from SDK to app's `ChatMessage` format.
- Update `chat-store.ts`: when `setActiveSession` is called for an SDK session (not a draft), call the new endpoint and populate `messages[sessionId]`.
- Skip history loading for draft sessions (no messages yet).

**Patterns to follow:**
- Map SDK `SessionMessage.type` (`"user" | "assistant"`) to app's `ChatMessage.role`.
- Extract text content from the SDK message payload.

**Test scenarios:**
- **Happy path:** Switch to SDK session with history → messages load and display in chat panel.
- **Happy path:** SDK session with no messages → returns empty array, chat panel empty.
- **Edge case:** Draft session selected → no history load call, empty chat panel.
- **Error path:** `getSessionMessages` fails → error state in chat panel.

**Verification:**
- Selecting an SDK session with prior messages populates the chat panel.
- Messages from SDK sessions are rendered correctly.

---

### U6. Update Frontend Session Types and Components

**Goal:** Adapt the frontend to handle SDK session shapes and the draft/SDK distinction.

**Requirements:** R1, R2, R5

**Dependencies:** U2, U5

**Files:**
- Modify: `src/client/stores/chat-store.ts`
- Modify: `src/client/components/SessionList.tsx`
- Modify: `src/client/components/ChatPanel.tsx`
- Modify: `src/client/components/MessageList.tsx` (if needed)

**Approach:**
- Update `ChatSession` type to include `isDraft?: boolean` and optional SDK fields (`summary`, `lastModified`, `firstPrompt`).
- In `SessionList.tsx`:
  - Display draft sessions with a subtle indicator (e.g., "Draft" badge).
  - Use `lastModified` from SDK for relative timestamps when available.
  - Use `summary` or `customTitle` as the session name for SDK sessions.
- In `ChatPanel.tsx`:
  - Ensure `fetchSessions` triggers on workspace change.
  - When `activeSessionId` changes to an SDK session, trigger message history loading.

**Patterns to follow:**
- Match existing Tailwind styling for badges and timestamps.

**Test scenarios:**
- **Happy path:** SessionList shows SDK sessions with correct names and timestamps.
- **Happy path:** Draft sessions are visually distinguished.
- **Happy path:** Switching sessions loads the correct message history.
- **Edge case:** No sessions → empty state with "Create your first session" prompt.

**Verification:**
- Visual inspection: SDK sessions and draft sessions render correctly.
- Session switching updates chat content appropriately.

---

## System-Wide Impact

- **Session lifecycle change:** Sessions are no longer auto-created as empty JSON records. Drafts exist only locally; real sessions are created by the SDK on first message.
- **Cross-session visibility:** Sessions created via the Claude Code CLI (outside the app) will now appear in the workspace's session list.
- **Error propagation:** SDK session API failures (`listSessions`, `getSessionMessages`, `deleteSession`, etc.) will surface as 500 errors from existing route handlers.
- **API surface additions:** One new endpoint (`GET /api/workspaces/:id/sessions/:sessionId/messages`). Existing session endpoints remain with same request/response shapes.
- **Unchanged invariants:** Chat streaming protocol, file explorer, workspace CRUD, and settings panel are unaffected.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SDK 0.2.x introduces unexpected type or runtime changes | Validate build and dev server start after upgrade (U1) before touching session logic |
| `listSessions` returns different fields than assumed | Map defensively in `ChatService`; log unexpected shapes |
| Draft session lost if server restarts before first message | Use persistent local storage (JSON or SQLite) for drafts rather than in-memory |
| Message history loading is slow for large sessions | Load on demand when session is selected; defer pagination to follow-up |
| User has no `claude` CLI binary (0.2.113+ spawns native binary) | Document requirement; app already requires SDK which depends on CLI |

---

## Documentation / Operational Notes

- The SDK upgrade requires `npm install` after package.json change.
- If the user does not have the Claude Code CLI installed, the SDK may fail at runtime (0.2.113+ spawns a native binary). Ensure the development environment has `claude` available.
- The `~/.claude-code-gui/sessions.json` file will become obsolete after this change and can be removed or archived.

---

## Sources & References

- **Origin document:** [docs/brainstorms/claude-code-gui-workspace-manager-requirements.md](docs/brainstorms/claude-code-gui-workspace-manager-requirements.md)
- **Related code:** `src/server/storage/json-store.ts`, `src/server/services/chat-service.ts`, `src/server/services/sdk-client.ts`, `src/client/stores/chat-store.ts`
- **External docs:** [Claude Code Agent SDK TypeScript Docs](https://code.claude.com/docs/en/agent-sdk/typescript#listsessions)
- **SDK Changelog:** [anthropics/claude-agent-sdk-typescript/CHANGELOG.md](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md)
