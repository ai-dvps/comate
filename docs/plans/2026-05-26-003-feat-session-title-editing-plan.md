---
title: "feat: Session title editing"
type: feat
status: completed
date: 2026-05-26
---

# feat: Session title editing

## Summary

Add inline session title editing to the GUI session list. Changes are persisted through the existing Claude Code SDK `renameSession` API for active sessions and through the local draft store for draft sessions, ensuring the title is reflected in Claude Code's native session history.

## Requirements

- R1. Developer can edit a session title directly from the session list.
- R2. Title changes for SDK-managed sessions are persisted via the Claude Code SDK to the native session store under `~/.claude`.
- R3. Title changes for draft sessions are persisted to the local draft store.
- R4. The UI updates optimistically after a successful rename.
- R5. Renaming respects the existing i18n structure.

## Scope Boundaries

- Editing is limited to the session list component; the chat panel header does not show or edit session titles.
- Only the session `name` field is editable; other metadata (summary, git branch, first prompt) remains read-only.
- No bulk rename, AI-generated titles, or title history/undo.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/routes/chat.ts` — existing session routes (GET list, POST create, GET messages, GET stream, POST message, POST approval, POST interrupt). No PUT update route exists.
- `src/server/services/chat-service.ts` — `updateSession(id, input, workspaceId)` already exists and handles both draft sessions (`draftStore.updateDraft`) and SDK sessions (`sdkClient.renameSession`).
- `src/server/services/sdk-client.ts` — wraps the SDK's `renameSession` function.
- `src/server/storage/json-store.ts` — `DraftSessionStore.updateDraft` already supports renaming drafts.
- `src/client/stores/chat-store.ts` — session state management via Zustand. Has `fetchSessions`, `createSession`, `setActiveSession`, but no `renameSession` action.
- `src/client/components/SessionList.tsx` — displays sessions and already implements an inline input pattern for creating new sessions (autoFocus, Enter to confirm, Escape to cancel).
- `src/client/i18n/en/chat.json` and `src/client/i18n/zh-CN/chat.json` — existing translation keys for session UI.

### External References

- `@anthropic-ai/claude-agent-sdk` `renameSession` API — the SDK writes session metadata to Claude Code's internal store (under `~/.claude/projects/`). The `history.jsonl` file in `~/.claude` is command history, not session metadata, and is not directly modified.

---

## Key Technical Decisions

- **Reuse the existing create-session inline input pattern**: The session list already has an inline input with Enter/Escape behavior for creating sessions. Extending this pattern to editing keeps the UX consistent and avoids introducing modals.
- **Optimistic UI update in the client store**: After a successful API call, update the local `sessions` array immediately so the list reflects the new title without waiting for the next `fetchSessions` poll.
- **Single editing surface (session list only)**: The chat panel header does not currently display the session name. Adding rename there would require new UI layout work that is out of scope.

---

## Implementation Units

### U1. Add HTTP route for session rename

**Goal:** Expose the existing `chatService.updateSession` method via a PUT endpoint.

**Requirements:** R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/server/routes/chat.ts`

**Approach:**
- Add `PUT /api/workspaces/:id/sessions/:sessionId` that accepts `{ name: string }` in the body.
- Validate that `name` is a non-empty string.
- Call `chatService.updateSession(sessionId, { name }, workspaceId)`.
- Return the updated session as JSON on success.
- Return 404 if the session is not found, 400 for invalid input, and 500 for unexpected errors.

**Patterns to follow:**
- Follow the existing route error-handling pattern in `chat.ts` using `ChatError` for typed error responses.

**Test scenarios:**
- Happy path: PUT with valid name returns updated session with new name.
- Edge case: PUT with empty name returns 400.
- Error path: PUT for non-existent session returns 404.
- Integration scenario: Renaming an SDK session calls through to `sdkClient.renameSession` and the title is visible on the next `listSessions` call.

**Verification:**
- The PUT endpoint responds with the updated session and correct status codes.
- Renaming an SDK session is reflected when calling `GET /api/workspaces/:id/sessions`.

---

### U2. Add client store action for session rename

**Goal:** Add a `renameSession` action to the chat store that calls the new PUT endpoint and updates local state.

**Requirements:** R1, R4

**Dependencies:** U1

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**
- Add `renameSession: (workspaceId: string, sessionId: string, name: string) => Promise<void>` to the `ChatState` interface.
- Send a PUT request to `/api/workspaces/${workspaceId}/sessions/${sessionId}` with `{ name }`.
- On success, update the local `sessions[workspaceId]` array by replacing the session's `name` (and `customTitle` if present) with the new value.
- On error, log to console and leave local state unchanged.

**Patterns to follow:**
- Follow the existing `createSession` pattern in `chat-store.ts` for fetch, error handling, and optimistic state updates.

**Test scenarios:**
- Happy path: after rename, the session's displayed name updates immediately in the store.
- Error path: if the API returns an error, the local session name remains unchanged.
- Edge case: renaming a session that is not in the local store is a no-op for local state (the API still handles it).

**Verification:**
- The store action updates the session name locally after a successful API response.
- The UI re-renders with the new name without requiring a full session list refresh.

---

### U3. Add inline session title editing UI

**Goal:** Enable inline editing of session titles in the session list.

**Requirements:** R1, R5

**Dependencies:** U2

**Files:**
- Modify: `src/client/components/SessionList.tsx`
- Modify: `src/client/i18n/en/chat.json`
- Modify: `src/client/i18n/zh-CN/chat.json`

**Approach:**
- Track editing state per session using a map or local state (`editingSessionId` and `editingName`).
- Add a right-click context menu or an edit icon that appears on hover for each session row to trigger edit mode. (Using an edit icon on hover is simpler and more discoverable than right-click.)
- When in edit mode, render an `<input>` (similar to the create-session input) pre-filled with the current display name.
- On Enter: call `renameSession` and exit edit mode.
- On Escape: discard changes and exit edit mode.
- On blur without Enter: behave like Escape (cancel) to match the conservative pattern.
- Add i18n keys for the edit affordance if needed (e.g., `renameSession` tooltip). Reuse existing `cancel` key where applicable.

**Patterns to follow:**
- Mirror the inline input behavior from the existing create-session flow in `SessionList.tsx` (autoFocus, Enter/Escape key handling, styling classes).

**Test scenarios:**
- Happy path: clicking the edit icon shows an input with the current name; pressing Enter updates the title.
- Edge case: pressing Escape or blurring the input cancels the edit and restores the original display.
- Edge case: submitting an empty name should either be ignored or fall back to the original name.
- Integration scenario: renaming an active SDK session updates both the local UI and the native Claude Code session store; the new name is visible after refreshing the session list.

**Verification:**
- Users can trigger edit mode, modify the title, and save or cancel.
- The renamed title appears immediately in the list and persists across session list refreshes.

---

## System-Wide Impact

- **API surface parity:** The new PUT route is a single additive endpoint; no existing routes are modified.
- **Unchanged invariants:** `GET /api/workspaces/:id/sessions`, `POST /api/workspaces/:id/sessions`, and all message/stream/approval routes remain unchanged.
- **State lifecycle risks:** The client store's optimistic update only mutates the `name` field. If the server returns a different `customTitle`, the client may show a stale computed display name until the next `fetchSessions`. This is acceptable for a lightweight feature.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SDK `renameSession` fails silently or writes to an unexpected location | Rely on the existing SDK abstraction; verify via integration test that `listSessions` returns the new title after rename. |
| Concurrent edits from multiple clients | Last-write-wins via the SDK; acceptable for a personal GUI tool. |

## Documentation / Operational Notes

- No rollout or migration steps required.
- If users have existing draft sessions, renaming them will migrate their `name` field in the local draft store.
