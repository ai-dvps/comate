---
title: "feat: WeCom bot proactive file send with media cache"
type: feat
date: 2026-06-22
origin: docs/brainstorms/2026-06-22-wecom-bot-proactive-file-send-requirements.md
---

# feat: WeCom bot proactive file send with media cache

## Summary

Add a server API and `wecom` CLI subcommand that let the WeCom bot send a workspace file to a WeCom user. The implementation uploads the file to WeCom once, caches the returned `media_id` for 71 hours keyed by workspace + relative path + MD5, and reuses the cached id for subsequent sends. File paths are constrained to the workspace, and files under `data/<user-folder>` can only be sent to the matching user.

---

## Problem Frame

Today the WeCom bot can only send text and markdown messages proactively. Teams want to push files generated inside the workspace back to the user over the same WeCom channel. WeCom requires uploading a file to obtain a short-lived `media_id` before sending, so the implementation must handle upload, caching, workspace-scoped authorization, and per-user data isolation in one flow.

---

## Requirements

**API / CLI surface**

- R1. The server exposes `POST /api/workspaces/:workspaceId/wecom/send-file` accepting `sessionId`, `toUser`, and `filePath`.
- R2. The `wecom` CLI exposes a `send-file` subcommand with `--to-user`, `--file-path`, and `--session-id` flags.
- R3. Both entry points reject requests that are missing a session, a target user, or a file path.

**File upload and media caching**

- R4. Before uploading, compute the file's MD5 and query the cache for a matching record keyed by workspace, relative path, and MD5.
- R5. Reuse a cached `media_id` only when its upload timestamp is less than 71 hours old.
- R6. When the cache entry is missing or stale, upload the file to WeCom and persist the returned `media_id`, original filename, relative path, MD5, workspace, and upload timestamp.
- R7. Upload failures are returned to the caller as an error; no message is sent to the WeCom user.

**Security**

- R8. The resolved absolute file path must be inside the workspace folder; otherwise the request is rejected with a permission error.
- R9. If the resolved file path is inside `data/<user-folder>`, allow the send only when `<user-folder>` matches the target WeCom user's folder name under the existing per-user naming convention; otherwise reject the request and send an unauthorized text message to the target user.
- R10. Path validation resolves symlinks and guards against directory-traversal attempts.

**Message delivery**

- R11. After obtaining a valid `media_id`, the bot sends a WeCom `file` message to the target user.
- R12. Send failures are returned to the caller and surfaced to the user with a concise error message.

---

## Scope Boundaries

### In scope

- `POST /api/workspaces/:workspaceId/wecom/send-file` route.
- `wecom send-file` CLI subcommand.
- SQLite-backed temporary media cache keyed by workspace, relative path, and MD5 with a 71-hour TTL.
- Workspace boundary validation and `data/<user-folder>` isolation.
- WeCom `file` message delivery via the SDK's `sendMediaMessage`.

### Deferred to follow-up work

- Automatic cleanup of expired cache entries.
- Image, voice, or video proactive sends.
- Content-based deduplication beyond MD5 + path.
- Delivery scheduling or retries beyond the synchronous request.

### Outside scope

- Sending files outside the workspace.
- Changing inbound media handling or session streaming logic.
- GUI surface for file send.

---

## Context & Research

### Relevant code and patterns

- `src/server/services/wecom-bot-service.ts` — `sendDirectMessage` and `sendProactiveMessage` send markdown today; `handleMediaMessage` already downloads and saves inbound media. The service owns the `WSClient` connection used for upload and send.
- `src/server/routes/wecom-send.ts` — `POST /api/workspaces/:workspaceId/wecom/send` validates the caller session, resolves recipient identity, and either direct-sends or enqueues text messages.
- `src/server/storage/sqlite-store.ts` — table creation uses `CREATE TABLE IF NOT EXISTS`; migrations use `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`. Existing WeCom tables include `wecom_user_sessions`, `wecom_user_id_mappings`, `wecom_workspace_users`, `wecom_proactive_messages`.
- `src/server/services/wecom-file-storage.ts` — path validation pattern: `path.resolve` + `startsWith(resolvedWorkspacePath + path.sep)`.
- `src/server/services/bot-path-policy.ts` — resolves symlinks with `fs.realpathSync` and checks workspace escape, other-user dirs, and denylist. The proactive send path check can reuse the realpath helper but does not need the full tool-permission denylist.
- `packages/wecom-cli/src/commands/send.ts` and `packages/wecom-cli/src/index.ts` — oclif v4 explicit command registration pattern.
- WeCom SDK (`@wecom/aibot-node-sdk`) — `uploadMedia(fileBuffer, { type, filename })` returns `{ media_id, created_at }`; `sendMediaMessage(chatid, 'file', mediaId)` sends a file message.

### Research findings that shape the design

1. **The SDK expects the encrypted WeCom user id as `chatid`.** `sendDirectMessage` passes the stored `wecomUserId` (encrypted) directly to `client.sendMessage`. The route resolves the caller's plaintext id via `store.getEncryptedUserIdByPlaintext`; the same resolution is reused for send-file.
2. **Per-user folder naming is already centralized.** `handleMediaMessage` in `src/server/services/wecom-bot-service.ts` uses `workspaceStore.getWecomUserMapping(wecomUserId) ?? wecomUserId`. The proactive send isolation check uses the same resolution so folder names align.
3. **The `data/` prefix is a requirement-specific convention, distinct from inbound file storage.** The origin requirements refer to `data/<user-folder>` for files that should be isolated per user. Inbound media is saved directly under `workspaceFolder/<userFolderName>/` by `wecom-file-storage.ts`. For proactive send, the implementer should treat `data/<user-folder>` as the path prefix that triggers isolation, without changing the existing inbound storage layout.
4. **Existing text send differentiates same-user direct send from cross-user enqueue.** File send keeps the simpler model: it requires the bot to be connected and the recipient to be resolvable; failures return errors synchronously. Proactive file messages are not queued because the cache/upload lifecycle is tied to a single request. The route resolves the caller's identity via `store.getWecomUserIdBySession` so cross-user sends are auditable, but they are not blocked by the route itself; path isolation remains the primary authorization boundary.
5. **MD5 should be computed from the file buffer.** The cache key is workspace + relative path + MD5 so moving or renaming a file invalidates the cache, while an unchanged file at the same path can reuse the id.

---

## Key Technical Decisions

- **Dedicated send-file API/CLI instead of extending the text send command:** Text and file messages have different lifecycles (upload, caching, path authorization), so keeping them separate avoids a mixed-concern route. *(see origin: R1, R2)*
- **71-hour cache TTL:** WeCom's documented 3-day media lifetime is the upper bound; shaving off 1 hour reduces the risk of sending with an expired `media_id`. *(see origin: Key Decisions)*
- **Cache key = workspace + relative path + MD5:** This captures both the file identity and its location. Two files with the same content at different paths are cached separately; a file that is replaced at the same path gets a new MD5 and triggers re-upload.
- **Cache stored in SQLite alongside other WeCom tables:** The workspace store already persists WeCom state. Adding a `wecom_media_cache` table keeps the cache durable across server restarts and makes TTL queries simple.
- **Path validation resolves symlinks and uses separator-aware prefix checks:** This prevents `..` traversal and prefix-bypass attacks. The check is implemented as a testable helper rather than inline in the route.
- **Unauthorized `data/<user-folder>` access sends a text message to the recipient:** The requirement explicitly asks to notify the target user when they are not allowed to receive a file, rather than silently failing.
- **Reuse existing per-user folder naming convention for `data/<user-folder>`:** The folder name is the plaintext WeCom user ID when a mapping exists, otherwise the encrypted WeCom user ID, consistent with `src/server/services/wecom-file-storage.ts`. *(see origin: Key Decisions)*

---

## High-Level Technical Design

### Send-file flow

```
POST /api/workspaces/:workspaceId/wecom/send-file
  ├─ validate sessionId, toUser, filePath
  ├─ load workspace
  ├─ resolve toUser → encryptedUserId (return 400 if unresolvable)
  ├─ resolve targetUserFolderName = plaintext mapping ?? encryptedUserId
  ├─ resolve real absolute path and validate:
  │    inside workspace
  │    if under data/<folder>, <folder> == targetUserFolderName
  ├─ compute file MD5
  ├─ lookup cached media_id for (workspaceId, relativePath, md5)
  │    where now - createdAt < 71 hours
  ├─ cache miss/stale → uploadMedia(fileBuffer, { type: 'file', filename })
  │    → upsert cache row
  ├─ sendMediaMessage(encryptedUserId, 'file', media_id)
  └─ return { sent: true }
```

### Cache table

```sql
CREATE TABLE IF NOT EXISTS wecom_media_cache (
  workspace_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  md5 TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, relative_path, md5)
);
```

Rows are never automatically deleted in v1. The lookup always filters by `created_at`.

---

## Implementation Units

### U1. Media cache table and store methods

**Goal:** Add durable storage for uploaded WeCom temporary media with workspace/path/MD5 lookup and TTL filtering.

**Requirements:** R4, R5, R6

**Dependencies:** None

**Files:**
- Create: `src/server/models/wecom-media-cache.ts` (a small type-only model file matching existing conventions).
- Modify: `src/server/storage/sqlite-store.ts`

**Approach:**
- Define `WeComMediaCacheEntry` and `CreateWeComMediaCacheInput` interfaces in the new model file.
- In `SqliteStore` constructor, create `wecom_media_cache` with a composite primary key on `(workspace_id, relative_path, md5)`.
- Add methods:
  - `getWecomMediaCacheEntry(workspaceId: string, relativePath: string, md5: string): WeComMediaCacheEntry | null`
  - `createWecomMediaCacheEntry(input: CreateWeComMediaCacheInput): WeComMediaCacheEntry`
- `getWecomMediaCacheEntry` filters rows where `datetime(created_at) > datetime('now', '-71 hours')` and returns the newest if multiple exist (defensive).
- `createWecomMediaCacheEntry` writes with `INSERT OR REPLACE INTO` so a fresh upload for an existing `(workspace_id, relative_path, md5)` overwrites the previous `media_id` and `created_at`.
- Store timestamps as ISO 8601 strings consistent with the rest of the store.
- Add `DELETE FROM wecom_media_cache WHERE workspace_id = ?` to `SqliteStore.delete(workspaceId)` so workspace deletion does not orphan cache rows.
- New tables are created in the `SqliteStore` constructor with `CREATE TABLE IF NOT EXISTS`; `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` is reserved for adding columns to existing tables.

**Patterns to follow:**
- Table creation and migration patterns in `src/server/storage/sqlite-store.ts` (constructor table setup and `migrate*` methods).
- Model file pattern in `src/server/models/wecom-proactive-message.ts`.

**Test scenarios:**
- Create a cache entry and read it back.
- A 70-hour-old entry is returned.
- A 72-hour-old entry is not returned.
- Duplicate (workspace, path, md5) inserts overwrite the previous row.

**Verification:**
- `SqliteStore` tests or unit tests using `createIsolatedStore()` pass.
- The composite primary key prevents duplicate rows for the same lookup key.

---

### U2. Path validation helper for proactive file send

**Goal:** Provide a testable function that validates a workspace-relative file path for the send-file flow, including `data/<user-folder>` isolation.

**Requirements:** R8, R9, R10

**Dependencies:** None

**Files:**
- Create: `src/server/services/wecom-send-file-policy.ts`
- Test: `src/server/services/wecom-send-file-policy.test.ts`

**Approach:**
- Export a function with signature roughly:
  ```ts
  export type SendFileDenialReason =
    | 'outside-workspace'
    | 'other-user-dir'
    | 'not-a-file'
    | 'invalid-path';

  export function validateSendFilePath(
    workspaceFolderPath: string,
    targetUserFolderName: string,
    rawFilePath: string,
  ): { allowed: boolean; reason?: SendFileDenialReason; absolutePath: string; relativePath: string }
  ```
- Internally:
  1. Resolve `rawFilePath` against the workspace folder using `path.resolve`.
  2. Follow symlinks with `fs.realpathSync` where possible (parent-directory fallback for non-existent targets, matching `bot-path-policy.ts`).
  3. Verify the resolved path starts with the resolved workspace path plus `path.sep`.
  4. Verify the path points to a file, not a directory.
  5. If the resolved path is under `data/<folder>/`, normalize `<folder>` and `targetUserFolderName` to a consistent case and verify they match. This prevents case-insensitive filesystem bypasses.
- Return an object that includes both `absolutePath` and `relativePath` so the caller does not recompute them.

**Patterns to follow:**
- `resolveRealPath` helper in `src/server/services/bot-path-policy.ts` for symlink-aware resolution.
- Workspace prefix checks in `src/server/services/wecom-file-storage.ts`.

**Test scenarios:**
- Covers AE1: `docs/report.pdf` inside workspace → allowed.
- Covers AE5: `data/ZhangWei/private.pdf` sent to `ZhangWei` → allowed.
- Covers AE4: `data/ZhangWei/private.pdf` sent to `LiSi` → denied with reason `other-user-dir`.
- Path with `..` segments escaping workspace → denied with reason `outside-workspace`.
- Symlink pointing outside workspace → denied with reason `outside-workspace`.
- Directory path → denied with reason `not-a-file`.
- Absolute path outside workspace → denied with reason `outside-workspace`.

**Verification:**
- All test scenarios pass.
- The helper never returns an allowed result for a path outside the workspace.

---

### U3. WeCom bot service send-file method

**Goal:** Add a service method that validates the file, manages the media cache, uploads when necessary, and sends the file message.

**Requirements:** R4, R5, R6, R7, R11, R12

**Dependencies:** U1, U2

**Files:**
- Modify: `src/server/services/wecom-bot-service.ts`
- Test: `src/server/services/wecom-bot-service.send-file.test.ts`

**Approach:**
- Add `async sendFile(workspaceId: string, toUser: string, filePath: string): Promise<void>`.
- Steps:
  1. Load the workspace; throw if missing.
  2. Resolve `toUser` (plaintext) → encrypted user id via `workspaceStore.getEncryptedUserIdByPlaintext`. Throw if unresolvable.
  3. Resolve target user folder name: `workspaceStore.getWecomUserMapping(encryptedUserId) ?? encryptedUserId`.
  4. Call `validateSendFilePath(workspace.folderPath, targetUserFolderName, filePath)`. If denied and the reason is `other-user-dir`, send an unauthorized text message to the encrypted user id and throw a permission error. For other denials, just throw.
  5. Read the file into a `Buffer`. Reject files exceeding a maximum size (e.g., 20 MB) before reading into memory.
  6. Compute MD5 of the buffer.
  7. Look up cache entry by workspace id, relative path, and MD5. If found and fresh, use its `media_id`.
  8. If not found, call `conn.client.uploadMedia(buffer, { type: 'file', filename: path.basename(relativePath) })`. Store the returned `media_id` and `created_at` in the cache. Defensively normalize the SDK-returned `created_at` to ISO 8601 (e.g., `new Date(created_at).toISOString()`) before storing; use that normalized timestamp for TTL calculation.
  9. Call `conn.client.sendMediaMessage(encryptedUserId, 'file', mediaId)`.
- Connection checks: verify `conn` exists and `status === 'connected'`; throw `bot_not_connected` otherwise.
- Errors from upload or send propagate to the caller.

**Patterns to follow:**
- Connection and error handling from `sendDirectMessage` in `src/server/services/wecom-bot-service.ts`.
- User mapping resolution from `handleMediaMessage` in `src/server/services/wecom-bot-service.ts`.
- File reading with `fsPromises.readFile` (existing usage in server services).

**Test scenarios:**
- Covers AE1: valid file, no cache → upload, cache, send.
- Covers AE2: valid file, 70-hour-old cache → reuse `media_id`, no upload.
- Covers AE3: valid file, 72-hour-old cache → re-upload and refresh cache.
- Covers AE4: `data/ZhangWei/private.pdf` sent to `LiSi` → sends unauthorized text message, throws permission error, no upload.
- Covers AE5: `data/ZhangWei/private.pdf` sent to `ZhangWei` → upload and send.
- Bot not connected → throws error.
- File exceeds size limit → throws error before reading into memory.
- Upload fails → throws error, no message sent.
- Send fails → throws error.

**Verification:**
- Unit tests mock `WSClient.uploadMedia`, `WSClient.sendMediaMessage`, and `workspaceStore` methods.
- Cache lookup and writes are verified through `workspaceStore` spies or isolated store.

---

### U4. Server send-file route

**Goal:** Expose `POST /api/workspaces/:workspaceId/wecom/send-file` and wire it to the bot service.

**Requirements:** R1, R3, R7, R12

**Dependencies:** U3

**Files:**
- Create: `src/server/routes/wecom-send-file.ts`
- Modify: `src/server/index.ts`
- Test: `src/server/routes/wecom-send-file.test.ts`

**Approach:**
- Create a new Express router with `mergeParams: true`.
- Validate `sessionId`, `toUser`, and `filePath` are non-empty strings; return `400` if any are missing.
- Resolve the caller's WeCom identity via `store.getWecomUserIdBySession(workspaceId, sessionId)`. Return `400` if the session ID is unknown or not associated with this workspace (same caller validation as the text send route).
- Call `wecomBotService.sendFile(workspaceId, toUser.trim(), filePath.trim())`.
- On success return `200` with `{ sent: true }`.
- On error return an appropriate status:
  - `400` for validation/permission errors.
  - `503` for `bot_not_connected`.
  - `500` for upload/send failures.
- Register the route in `src/server/index.ts` with `app.use('/api/workspaces/:workspaceId/wecom/send-file', wecomSendFileRoutes);`.
  The new router must be created with `Router({ mergeParams: true })` so `req.params.workspaceId` is available.

**Patterns to follow:**
- Validation and response shapes from `src/server/routes/wecom-send.ts`.
- Route registration pattern from `src/server/index.ts` (`app.use('/api/workspaces/:workspaceId/wecom/send', wecomSendRoutes)`).

**Test scenarios:**
- Missing `sessionId`, `toUser`, or `filePath` → `400`.
- Unknown session → `400`.
- Valid request → `200` `{ sent: true }`.
- Bot service throws permission error → `400` with error message.
- Bot service throws connection error → `503`.
- Bot service throws upload error → `500`.

**Verification:**
- Route tests use a minimal Express app or the route handler directly.
- `wecomBotService.sendFile` is mocked.

---

### U5. `wecom send-file` CLI subcommand

**Goal:** Add a `send-file` command to the `wecom` CLI that calls the new server endpoint.

**Requirements:** R2, R3

**Dependencies:** U4

**Files:**
- Create: `packages/wecom-cli/src/commands/send-file.ts`
- Modify: `packages/wecom-cli/src/index.ts`

**Approach:**
- Create `SendFile` command extending `BaseCommand`.
- Flags:
  - `--to-user`: required string.
  - `--file-path`: required string.
  - `--session-id`: optional string, defaults to `CLAUDE_SESSION_ID` env var.
- In `run()`:
  1. Load context via `this.loadContext()`.
  2. Resolve `sessionId` from flag or env.
  3. POST to `${context.serverUrl}/api/workspaces/${context.workspaceId}/wecom/send-file` with `{ sessionId, toUser, filePath }`.
  4. On `200` log `File sent`.
  5. On error parse `{ error, message }` and `this.error(..., { exit: 3 })`.
- Register `SendFile` as `'send-file'` in `packages/wecom-cli/src/index.ts` `COMMANDS` export.

**Patterns to follow:**
- Command structure from `packages/wecom-cli/src/commands/send.ts`.
- HTTP helper from `packages/wecom-cli/src/lib/http.ts`.

**Test scenarios:**
- Successful send → logs `File sent` and exits 0.
- Missing `--to-user` or `--file-path` → oclif validation error.
- Server returns `400` → exits 3 with the server's message.
- Server returns `503` → exits 3 with a clear message.

**Verification:**
- Manual run or CLI integration test verifies the endpoint is reached with the correct payload.

---

### U6. CLI test (optional)

**Goal:** Add a test for the `wecom send-file` command if the CLI package already has a test harness.

**Requirements:** R2, R3

**Dependencies:** U5

**Files:**
- Create: `packages/wecom-cli/src/commands/send-file.test.ts` (only if a CLI test harness exists)

**Approach:**
- Mock `BaseCommand.loadContext` and the HTTP helper.
- Verify the command posts the correct payload and handles 200/400/503 responses.

**Verification:**
- `npm run test:server` or CLI package test script passes.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Stale `media_id` sent because TTL drifts against WeCom's clock. | 71-hour TTL is 1 hour inside WeCom's documented 3-day lifetime. Cache lookup filters at query time and the SDK `created_at` is normalized to ISO 8601 before storage. |
| Cache table grows unbounded because expired rows are not deleted. | Acceptable for v1 per scope boundaries. Add a periodic cleanup job later if needed. |
| Path validation misses a traversal vector. | Use `path.resolve`, `fs.realpathSync`, and separator-aware prefix checks. Normalize `data/<folder>` segment case. Unit-test `..`, absolute paths, symlinks, and case variations. |
| Recipient plaintext id cannot be resolved. | Return a clear `400` error; do not silently enqueue or send. |
| Large files cause memory pressure or DoS. | Add a maximum file size check (e.g., 20 MB) before reading into memory. Document the limit. Rate limiting is not in scope for v1 but should be added before exposing the API broadly. |
| File send races with cache refresh. | The composite primary key plus `INSERT OR REPLACE` prevents duplicate rows; concurrent uploads for the same file may upload twice but are harmless. |
| Unauthorized `data/<user-folder>` notification leaks information or enables harassment. | The requirement explicitly asks to notify the target user. Keep the message generic ("unauthorized file access") and send only on `data/<user-folder>` violations, not on other failures. |
| Cache poisoning via malicious `media_id` injection. | Trust the WeCom SDK as the sole source of `media_id` values. Cache rows are only writable through the upload path. Document this trust assumption. |

---

## Acceptance Criteria

- [ ] `POST /api/workspaces/:workspaceId/wecom/send-file` accepts `sessionId`, `toUser`, `filePath` and returns `{ sent: true }` on success.
- [ ] `wecom send-file --to-user ZhangWei --file-path docs/report.pdf` delivers the file.
- [ ] The same file sent twice within 71 hours triggers only one WeCom upload.
- [ ] A file sent after the cache has expired triggers a fresh upload.
- [ ] Files outside the workspace are rejected with a permission error.
- [ ] `data/ZhangWei/private.pdf` can only be sent to user `ZhangWei`; sending to `LiSi` sends a permission-denied text message.
- [ ] Upload failures return an error to the caller and do not send a message.
- [ ] Send failures return a clear error to the caller.
- [ ] All new code is covered by server tests and passes lint.

---

## Dependencies / Assumptions

- The WeCom SDK's `uploadMedia` and `sendMediaMessage` methods are available and behave as documented in `node_modules/@wecom/aibot-node-sdk/dist/index.d.ts`.
- Workspace folder paths and the per-user folder naming convention remain stable during a send request.
- The caller session ID maps to a WeCom user in the workspace; the route checks this via `store.getWecomUserIdBySession` and rejects unknown sessions.
- The existing user mapping resolution used by the text send route can be reused to identify the recipient.
- The WeCom SDK is the trusted source of `media_id` values; cache rows are only writable through the SDK upload path.
