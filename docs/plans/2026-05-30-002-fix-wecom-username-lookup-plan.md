# Fix WeCom Username Lookup

**Status:** active  
**Created:** 2026-05-30  
**Scope:** Bug fix for the WeCom bot session username retrieval endpoint.

## Problem Frame

The `/api/workspaces/:id/sessions/:sessionId/wecom-user` endpoint incorrectly uses `session.name` as the encrypted WeCom user ID. However, `session.name` is overwritten by the SDK session's `customTitle` or `summary` shortly after creation, so it no longer contains the encrypted user ID. This causes the username lookup to fail or return garbage data.

The encrypted WeCom user ID is actually stored in the `wecom_user_sessions` table, keyed by `(workspaceId, sessionId)`.

## Requirements Traceability

| # | Requirement | Origin |
|---|-------------|--------|
| R1 | WeCom username endpoint must return the correct plaintext user ID | User bug report |
| R2 | Endpoint must continue to return `lastSeenAt` from `wecom_workspace_users` | Existing behavior |

## Decisions

### Query `wecom_user_sessions` directly by sessionId
- **Rationale:** The `wecom_user_sessions` table already maintains the `(workspaceId, wecomUserId) -> sessionId` mapping. We need the inverse lookup: `sessionId -> wecomUserId`.
- **Approach:** Add a `getWecomUserIdBySession` method to the SQLite store.

### Skip SDK session fetch in the endpoint
- **Rationale:** We no longer need `session.name`. We only need the `sessionId` from the URL params to query `wecom_user_sessions`.
- **Approach:** Remove `chatService.getSession()` call from the endpoint. Query the store directly.

## Implementation Units

### U1. Add inverse lookup store method (`src/server/storage/sqlite-store.ts`)

**Goal:** Add a method to retrieve `wecomUserId` by `(workspaceId, sessionId)`.

**Files:**
- `src/server/storage/sqlite-store.ts`

**Approach:**
- Add `getWecomUserIdBySession(workspaceId: string, sessionId: string): string | null`
- Query: `SELECT wecomUserId FROM wecom_user_sessions WHERE workspaceId = ? AND sessionId = ?`

**Test Scenarios:**
- [ ] Returns `wecomUserId` when a matching row exists
- [ ] Returns `null` when no matching row exists

### U2. Fix the endpoint (`src/server/routes/chat.ts`)

**Goal:** Update `/sessions/:sessionId/wecom-user` to resolve the encrypted user ID through the store instead of `session.name`.

**Files:**
- `src/server/routes/chat.ts`

**Approach:**
- Replace `const session = await chatService.getSession(sessionId, workspaceId)` and `const encryptedUserId = session.name` with `const encryptedUserId = store.getWecomUserIdBySession(workspaceId, sessionId)`
- If `encryptedUserId` is null, return 404 `{ error: 'Not a WeCom bot session' }`
- Otherwise proceed with existing mapping and workspace user lookups

**Test Scenarios:**
- [ ] Valid WeCom session: returns `{ userId, lastSeenAt }` with correct plaintext user ID
- [ ] Non-WeCom session (no row in `wecom_user_sessions`): returns 404
- [ ] WeCom session with no mapping yet: returns `userId` as the encrypted ID fallback

## Dependencies & Sequencing

1. **U1** must land before **U2** (the endpoint depends on the new store method).

## Risks

| Risk | Mitigation |
|------|------------|
| `wecom_user_sessions` row missing for legacy sessions | Return 404; this correctly indicates the session is not a WeCom bot session |
