---
title: WeCom User ID Resolution
origin: docs/brainstorms/2026-05-26-wecom-user-id-resolution-requirements.md
type: feat
date: 2026-05-26
---

# WeCom User ID Resolution

## Summary

Add a hybrid resolver that converts encrypted WeCom user IDs (`openuserid`) to plaintext enterprise IDs. Unseen IDs queue for periodic batch conversion via the WeChat Work enterprise API; consumers can force an immediate single-ID lookup when needed. Two workspace settings fields (`corpid`, `corpsecret`) enable the API, and resolved mappings persist in SQLite.

The original resolver units (U1–U5) are already implemented. This plan adds the settings user-list enhancements from the updated requirements: always-visible encrypted IDs, inline plaintext `userId` editing with Save/Cancel, duplicate validation, a manual reload button, and a workspace-scoped "Resolve pending now" button.

---

## Problem Frame

The existing WeCom bot integration stores encrypted user IDs as the canonical session key. This works for routing messages to sessions, but encrypted IDs cannot be used for downstream permission control, file access decisions, or admin visibility. The WeChat Work enterprise API provides a conversion endpoint, but calling it individually per user is inefficient at scale. A batched background resolver with an immediate escape hatch balances API efficiency with latency sensitivity.

Admins also need visibility into the raw encrypted identifier and a way to bridge the gap when automatic resolution is delayed or temporarily failing. Manual entry is intended as a stopgap, not a replacement for the API.

---

## Requirements

**Workspace settings**

- R1. Workspace settings include a `wecomCorpId` field.
- R2. Workspace settings include a `wecomCorpSecret` field.
- R3. Both fields are optional and independent of existing bot credentials.
- R4. The `corpsecret` is treated with the same sensitivity as the existing bot secret.

**Queue and batch resolution**

- R5. Unseen encrypted user IDs are queued for batch resolution on message arrival.
- R6. The mapping table is checked on every incoming message; hits return the plaintext ID immediately.
- R7. A background process flushes the queue periodically and when a size threshold is reached.
- R8. On flush, the system obtains a valid access token and calls the batch `openuserid_to_userid` API.
- R9. The system exposes an immediate resolution API for urgent consumers.
- R10. The encrypted user ID remains the canonical session key.
- R11. Successful batch mappings are persisted.
- R12. Batch-failed IDs are re-queued with exponential backoff.

**Immediate lookup**

- R13. The immediate resolution API checks the mapping table first, then falls back to a single-ID API call.
- R14. Immediate lookup stores the result and removes the ID from the pending queue if present.
- R15. Immediate lookup failures are surfaced to the caller; the ID is not re-queued.

**Access token management**

- R16. The access token is cached in memory and refreshed before expiry.
- R17. Expired or absent tokens trigger a `gettoken` fetch using `corpid` + `corpsecret`.
- R18. Token fetch failures are logged and surfaced as workspace-level errors.

**Storage**

- R19. The mapping is keyed by `(workspaceId, encryptedUserId)` and survives restarts.

**Settings user list**

- R20. The WeCom users tab displays the encrypted `openuserid` for every user in the list, in addition to the plaintext userId.
- R21. Each existing user row has an inline editable plaintext userId cell; the admin can type or change the value for users already known to the workspace.
- R22. Inline edits use explicit Save and Cancel controls per row; changes are not committed until the admin confirms.
- R23. Saving a manual plaintext userId rejects duplicates within the same workspace and surfaces a clear validation error.
- R24. The WeCom users tab provides a reload button that fetches the latest user list and mappings on demand.
- R25. The WeCom users tab provides a "Resolve pending now" button that triggers an immediate flush of all pending IDs for the workspace.
- R26. Manual plaintext entries are not authoritative; auto-resolution may overwrite them when the WeChat Work API returns a different value.
- R27. The plaintext userId cell shows a static placeholder while the plaintext ID is unresolved.

---

## System-Wide Impact

- **End users:** No direct impact under normal operation. Encrypted IDs remain the session key; plaintext IDs are an internal resolved attribute. If the resolver fails during message handling, the bot service degrades gracefully to the encrypted ID rather than dropping the message.
- **Admins:** The WeCom users tab now shows the encrypted ID for every user and allows manual plaintext entry when auto-resolution is slow. The reload and "Resolve pending now" buttons give admins direct control without removing the automatic 10-second poll.
- **Developers:** A new manual-mapping route and a workspace-scoped flush route extend the existing workspace API. The resolver gains a public workspace flush method.
- **Operations:** No new persistent timers. The manual flush button and auto-flush share the same resolver path and rate-limit defenses.
- **Failure propagation:**
  - Manual mapping validation failures return a 400 with a clear message; the UI keeps the row in edit mode.
  - Resolver flush failures from the "Resolve pending now" button are surfaced as workspace-level errors and logged with credentials redacted.
  - Auto-resolution can overwrite a manual value; the UI reflects the latest mapping on the next poll or reload.

---

## Key Technical Decisions

- **Separate resolver service over embedding in `WeComBotService`:** Keeps queue management, token caching, and REST API logic decoupled from websocket message handling. The bot service calls the resolver as a dependency. *(Already implemented in U3.)*
- **Node.js built-in `fetch` over adding an HTTP client:** The project has no existing REST HTTP client dependency. Node 20+ `fetch` is sufficient for two simple JSON endpoints. *(Already implemented.)*
- **In-memory queue + `setInterval` over a background job framework:** No job framework exists in the project. The `setInterval` pattern is already used by `SessionRuntime` and `WeComBotService`. *(Already implemented.)*
- **Lazy credential validation:** Credentials are validated on first API call rather than on save. This avoids blocking the settings save path and aligns with the existing bot connection pattern. *(Already implemented.)*
- **Use the existing global `wecom_user_id_mappings` table for manual entries:** The current table has `encryptedUserId` as a global primary key. Migrating to a workspace-scoped key is out of scope, so manual entries use the same global upsert and duplicate validation is enforced at the workspace level in application code.
- **Workspace-scoped duplicate check in the save route:** Because the mapping table is global, the route checks the workspace's user list and their mappings to reject a plaintext ID that is already assigned to another user in the same workspace.
- **Click-to-edit inline cell with explicit Save/Cancel:** Keeps the list readable and avoids accidental changes during the 10-second auto-refresh.
- **New workspace-scoped flush route reuses the resolver's existing batch logic:** A public `flushWorkspaceNow(workspaceId)` method exposes the existing private `flushWorkspace` behavior; the route delegates to it so the button and the timer follow the same code path.
- **Reload button triggers an immediate re-fetch without resetting the auto-poll timer:** Simple to implement and matches the Feishu users tab retry pattern.

---

## High-Level Technical Design

```
┌─────────────────────────┐     ┌─────────────────────┐     ┌──────────────────┐
│ SettingsPanel           │────▶│ workspaces routes   │────▶│ WeComUserIdResolver│
│ (WeCom users tab)       │     │                     │     │                  │
│ - encrypted ID display  │     │ - GET /wecom/users  │     │ - flushWorkspaceNow│
│ - inline plaintext edit │     │ - POST /wecom/users │     │ - resolveImmediate │
│ - reload / flush buttons│     │   /:eid/plaintext   │     └──────────────────┘
└─────────────────────────┘     │ - POST /wecom/      │              │
                                │   resolve-pending   │              ▼
                                └─────────────────────┘     ┌──────────────────┐
                                          │                   │   SqliteStore    │
                                          ▼                   │ (global mapping  │
                                   ┌──────────────┐          │  table)          │
                                   │ Workspace    │          └──────────────────┘
                                   │ users +      │
                                   │ mappings     │
                                   └──────────────┘
```

*This diagram illustrates the intended approach and is directional guidance for review, not implementation specification.*

**Data flow:**
1. The WeCom users tab fetches the workspace user list and current mappings from `GET /api/workspaces/:id/wecom/users`.
2. The admin clicks into a plaintext cell, types a value, and saves. The UI calls `POST /api/workspaces/:id/wecom/users/:encryptedUserId/plaintext`.
3. The route validates the encrypted user exists in the workspace, validates that the plaintext ID is not already used by another user in the same workspace, and stores the mapping via `SqliteStore.setWecomUserMapping`.
4. The admin clicks "Resolve pending now". The UI calls `POST /api/workspaces/:id/wecom/resolve-pending`, which calls `wecomUserResolver.flushWorkspaceNow(workspaceId)`.
5. The resolver obtains a token and calls the WeChat Work batch API; successful mappings are stored globally. The UI reflects them on the next poll or reload.

---

## Implementation Units

### U1. Add workspace settings fields for enterprise API credentials

*(Implemented in the original plan. Kept for context.)*

**Goal:** Allow admins to configure `corpid` and `corpsecret` in workspace settings.

**Requirements:** R1, R2, R3, R4

**Files:**
- `src/server/models/workspace.ts`
- `src/client/components/SettingsPanel.tsx`

---

### U2. Add SQLite mapping table and CRUD methods

*(Implemented in the original plan. Kept for context.)*

**Goal:** Persist encrypted-to-plaintext user ID mappings.

**Requirements:** R6, R11, R19

**Files:**
- `src/server/storage/sqlite-store.ts`

---

### U3. Create WeComUserIdResolver service

*(Implemented in the original plan. Kept for context.)*

**Goal:** Implement the core resolver logic: token cache, queue, batch flush, and immediate lookup.

**Requirements:** R5, R7, R8, R9, R12, R13, R14, R15, R16, R17, R18

**Files:**
- `src/server/services/wecom-user-resolver.ts`

---

### U4. Integrate resolver into WeComBotService message handling

*(Implemented in the original plan. Kept for context.)*

**Goal:** Queue unseen user IDs on every incoming WeCom message.

**Requirements:** R5, R6, R10

**Files:**
- `src/server/services/wecom-bot-service.ts`

---

### U5. Expose immediate resolution API

*(Implemented in the original plan. Kept for context.)*

**Goal:** Allow consumers (skills, permission checks) to force an immediate single-ID lookup.

**Requirements:** R9, R13, R14, R15

**Files:**
- `src/server/services/wecom-user-resolver.ts`
- `src/server/routes/wecom-resolver.ts` (optional)

---

### U6. Add workspace-scoped plaintext duplicate check to the store

**Goal:** Enable the save route to reject a plaintext `userId` that is already assigned to another user in the same workspace.

**Requirements:** R23

**Dependencies:** None

**Files:**
- `src/server/storage/sqlite-store.ts`
- `src/server/storage/sqlite-store.test.ts`

**Approach:**
Add `isPlaintextUserIdUsedInWorkspace(workspaceId: string, plaintextUserId: string, excludeEncryptedUserId?: string): boolean` to `SqliteStore`. The method selects all `encryptedUserId` values from `wecom_workspace_users` for the workspace, looks up each mapping in the global `wecom_user_id_mappings` table, and returns `true` if any mapping (other than the excluded encrypted ID) equals the requested plaintext.

**Patterns to follow:**
- Existing `listWecomWorkspaceUsers` and `getWecomUserMapping` methods in `sqlite-store.ts`.
- Existing server test isolation: import `'../test-utils/test-env.js'` as the first statement; use `createIsolatedStore()` or `new SqliteStore(':memory:')` and reset with `store.resetData()`.

**Test scenarios:**
- Given workspace `ws1` with users `E123 → U456` and `E789` unmapped, when checking `U456` excluding `E123`, it returns `false`.
- Given workspace `ws1` with users `E123 → U456` and `E789 → U456`, when checking `U456` excluding `E123`, it returns `true`.
- Given workspace `ws2` with user `E999 → U456`, when checking `U456` for `ws1`, it returns `false` (duplicate scope is per-workspace).
- Given an unmapped user `E789`, when checking `U456`, it returns `false`.

**Verification:**
- `npm run test:server` passes for the new store method tests.

---

### U7. Add manual plaintext mapping update route

**Goal:** Let admins save a manually entered plaintext `userId` for an existing workspace user.

**Requirements:** R21, R22, R23, R26, R27

**Dependencies:** U6

**Files:**
- `src/server/routes/workspaces.ts`
- `src/server/routes/workspaces.test.ts`

**Approach:**
Add `POST /api/workspaces/:id/wecom/users/:encryptedUserId/plaintext` with JSON body `{ plaintextUserId }`.

Validation steps:
1. Load the workspace; return 404 if missing.
2. Verify `encryptedUserId` exists in `wecom_workspace_users` for this workspace; return 400 if not.
3. Trim and reject empty `plaintextUserId`.
4. Call `isPlaintextUserIdUsedInWorkspace(workspaceId, plaintextUserId, encryptedUserId)`; return 409 with a clear error if duplicated.
5. Store the mapping with `setWecomUserMapping(encryptedUserId, plaintextUserId)`.
6. Return `{ encryptedUserId, plaintextUserId }`.

This route intentionally does not require corp credentials, because it is a manual override.

**Patterns to follow:**
- Existing route error shapes: `res.status(400).json({ error: '...' })` and `res.status(404).json({ error: 'Workspace not found' })`.
- Existing workspace route tests in `src/server/routes/workspaces.test.ts`.

**Test scenarios:**
- Covers AE6. Given a workspace with user `E123` and no mapping, when the route is called with `U456`, then `getWecomUserMapping('E123')` returns `U456`.
- Given a workspace with users `E123` and `E789 → U456`, when saving `U456` for `E123`, the route returns 409 and the mapping for `E123` is not changed.
- Given a workspace without `E123`, when the route is called for `E123`, it returns 400.
- Given an empty `plaintextUserId`, the route returns 400.

**Verification:**
- `npm run test:server` passes for the new route tests.

---

### U8. Expose a public workspace-scoped flush method on the resolver

**Goal:** Allow the settings UI to trigger a single-workspace flush without flushing all workspaces.

**Requirements:** R25

**Dependencies:** None

**Files:**
- `src/server/services/wecom-user-resolver.ts`
- `src/server/services/wecom-user-resolver.test.ts` (new)

**Approach:**
Add a public async method `flushWorkspaceNow(workspaceId: string): Promise<{ resolved: number; failed: number }>` to `WeComUserIdResolver`. The method delegates to the existing private `flushWorkspace` logic (or extracts it), catches errors, and returns counts of resolved and failed IDs. If the workspace has no credentials or an empty queue, it returns `{ resolved: 0, failed: 0 }`.

**Patterns to follow:**
- Singleton `WeComUserIdResolver` in `src/server/services/wecom-user-resolver.ts`.
- Existing `flushWorkspace` private method for token handling and batch API calls.

**Test scenarios:**
- Given a workspace with credentials and queued IDs, when `flushWorkspaceNow` is called, the batch API is invoked, mappings are stored, and returned counts match the result.
- Given a workspace without credentials, when `flushWorkspaceNow` is called, it returns `{ resolved: 0, failed: 0 }` and clears the queue.
- Given a workspace with an empty queue, when `flushWorkspaceNow` is called, it returns `{ resolved: 0, failed: 0 }` without API calls.

**Verification:**
- `npm run test:server` passes for the new resolver method tests.

---

### U9. Add workspace-scoped resolve-pending route

**Goal:** Surface the resolver flush to the settings UI.

**Requirements:** R25

**Dependencies:** U8

**Files:**
- `src/server/routes/workspaces.ts`
- `src/server/routes/workspaces.test.ts`

**Approach:**
Add `POST /api/workspaces/:id/wecom/resolve-pending`. It loads the workspace, calls `wecomUserResolver.flushWorkspaceNow(workspaceId)`, and returns `{ resolved, failed }`. On error, return 500 with a redacted error message.

**Patterns to follow:**
- Existing workspace route error handling.
- Do not expose raw resolver errors to the client; log them server-side with redacted credentials.

**Test scenarios:**
- Covers AE8. Given a workspace with two pending IDs and valid credentials, when the route is called, it returns `{ resolved: 2, failed: 0 }` and the mappings are stored.
- Given a workspace without corp credentials, when the route is called, it returns `{ resolved: 0, failed: 0 }`.

**Verification:**
- `npm run test:server` passes for the new route tests.

---

### U10. Update the WeCom users tab UI

**Goal:** Display encrypted IDs, support inline plaintext editing, and add reload and resolve-pending controls.

**Requirements:** R20, R21, R22, R24, R25, R26, R27

**Dependencies:** U7, U9

**Files:**
- `src/client/components/SettingsPanel.tsx`
- `src/client/components/SettingsPanel.test.tsx`

**Approach:**
Update the `WeComBotSection` users tab (`activeSubTab === 'users'`):

1. **State:** Add per-row edit state (`editingEncryptedUserId`, `draftPlaintextUserId`), a save-in-flight flag, an optional validation error, and a refresh key/state to trigger immediate reload.
2. **Display:** Restructure each user row to show:
   - The plaintext `userId` (or placeholder) in a click-to-edit field.
   - The encrypted `openuserid` always visible below it.
   - "Pending resolution" badge when plaintext is absent.
   - First seen / last seen timestamps.
3. **Inline edit:** Clicking the plaintext cell enters edit mode with an input and Save/Cancel buttons. Save calls the manual mapping route. Cancel reverts to the last fetched value. On success, refetch the user list. On validation error, show the error inline and keep edit mode.
4. **Reload button:** A button above the list calls `fetchUsers` immediately.
5. **Resolve pending button:** A button above the list calls `POST /api/workspaces/:id/wecom/resolve-pending`, then refetches the list after completion.
6. **Loading / error:** Add loading and error states modeled on the Feishu users tab.

**Patterns to follow:**
- Feishu users tab loading/error/retry UI in the same file.
- Existing `cn()` and Tailwind utility classes.
- `useTranslation('settings')` for all user-facing strings.

**Test scenarios:**
- Covers AE6. Given a user row with no plaintext ID, when the admin clicks the cell, types `U456`, and clicks Save, then the manual mapping route is called and the row updates after reload.
- Given a duplicate plaintext ID, when Save is clicked, the route returns 409 and the error is displayed inline.
- Covers AE7. Given the list is displayed, when the reload button is clicked, the users endpoint is fetched again.
- Covers AE8. Given pending users, when the resolve-pending button is clicked, the flush endpoint is called and the list is refetched.
- Given the plaintext cell is in edit mode, when Cancel is clicked, the input reverts to the original value and edit mode exits.

**Verification:**
- `npm run test:client` passes for the updated SettingsPanel tests.
- Manual check: open workspace settings WeCom users tab, edit a plaintext ID, reload, and trigger resolve-pending.

---

### U11. Add i18n strings

**Goal:** Provide translated labels for the new UI controls.

**Requirements:** R20, R21, R24, R25, R27

**Dependencies:** U10

**Files:**
- `src/client/i18n/en/settings.json`
- `src/client/i18n/zh-CN/settings.json`

**Approach:**
Add new keys under the `wecom` namespace:
- `usersReload` / `usersResolvePending` / `usersResolvePendingLoading` / `usersResolvePendingError`
- `userIdPlaceholder` (for the inline input)
- `userIdSave` / `userIdCancel`
- `userIdDuplicateError` / `userIdEmptyError`
- `userIdUnresolvedPlaceholder` (static placeholder text)
- `usersLoading` / `usersError` / `usersRetry` (to align with Feishu)

**Patterns to follow:**
- Existing `wecom.usersTitle`, `wecom.userPending`, etc.
- Both `en` and `zh-CN` files must be updated.

**Test expectation:** none — pure translation strings.

**Verification:**
- No missing keys when rendering the WeCom users tab in English and Chinese.

---

## Scope Boundaries

- Permission control logic — deferred to a later phase.
- File read/write approval routing — deferred.
- Pre-populating user mappings from an external directory.
- UI changes to session list or admin dashboards beyond the resolved ID being available.
- CorpSecret rotation workflow.
- Multi-corp support per workspace.
- Creating brand-new WeCom user records from manual input; manual input only edits existing users.
- Bulk import or CSV paste of plaintext IDs.
- Per-row "resolve this user" action; only a global flush control is in scope.
- Migrating the global `wecom_user_id_mappings` table to a workspace-scoped key.

---

## Deferred to Follow-Up Work

- **HTTP route for remote consumers:** The immediate resolution API defaults to an internal service method. An Express route can be added if skills running outside the server process need access.
- **Session name update after resolution:** Sessions are currently named with the encrypted user ID. A follow-up could rename sessions to the plaintext ID once resolved, or store the plaintext ID as session metadata.
- **Admin visibility into resolution status:** A settings panel indicator showing "X users resolved / Y pending" could be added later.
- **Per-row resolve button:** Resolve a single pending user without flushing the whole workspace queue.

---

## Deferred Implementation Notes

- Exact inline edit interaction timing (debounce, focus handling) can be settled during implementation.
- Exact error message wording for duplicate validation can be finalized during implementation.
- Whether the resolve-pending button should be disabled while a flush is in flight can be decided based on UX testing.

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| WeChat Work API rate limits | Medium | High | Batch calls, deduplicated queue, 30s flush interval. Request-deduplicated token refresh. The manual flush button uses the same batch path. |
| Access token expiry mid-flush | Low | Medium | Check token before each flush; refresh if within 5-minute buffer. |
| Queue loss on server restart | High | Low | Accepted trade-off. Only persisted mappings survive. Unseen users re-queue on next message. |
| Invalid corp credentials blocking resolution | Medium | Medium | Lazy validation surfaces error on first flush, not on save. Clear error logging with credentials redacted. |
| Partial batch failure | Medium | Low | Retry individual failed IDs with exponential backoff. Drop after max attempts. |
| Credential leakage in logs | Medium | High | Redact `corpid`, `corpsecret`, `access_token`, `openid`, and `userid` from all log output. Log only status codes, error codes, queue depth, and timing. |
| Queue flooding / memory exhaustion | Low | High | Enforce max queue depth per workspace. Reject new items with logging when limit is reached. |
| Concurrent token refresh hitting rate limit | Medium | Medium | Request deduplication for `gettoken`: concurrent callers await a single in-flight promise. |
| Resolver timeout blocking message handling | Medium | Medium | Bounded timeout on resolver calls in `handleTextMessage` with fallback to encrypted ID. |
| Unauthenticated access to immediate resolution API | Low | High | Immediate resolution is an internal service method only. Any future HTTP route must enforce authentication and per-caller rate limits. |
| Manual value silently overwritten by auto-resolution | Medium | Low | Documented behavior (R26). The UI always shows the current mapping; admins can re-enter if needed. |
| Duplicate validation race condition | Low | Low | Application-level check before upsert. Two near-simultaneous saves for the same plaintext ID in the same workspace could both pass the check; the global table's `encryptedUserId` primary key prevents storing the same encrypted ID twice, but could allow two encrypted IDs mapping to the same plaintext. This is accepted within the current global-table constraint. |
| UI state conflict with auto-poll | Low | Low | Save/Cancel state is local to the row. Auto-poll does not interrupt an active edit; it updates only non-editing rows. |

---

## Output Structure

```
src/server/
  services/
    wecom-user-resolver.ts          (modify — add flushWorkspaceNow)
    wecom-user-resolver.test.ts     (new)
  routes/
    workspaces.ts                   (modify — add manual mapping + resolve-pending routes)
    workspaces.test.ts              (modify — add route tests)
  storage/
    sqlite-store.ts                 (modify — add isPlaintextUserIdUsedInWorkspace)
    sqlite-store.test.ts            (modify — add store method tests)
src/client/
  components/
    SettingsPanel.tsx               (modify — WeCom users tab UI)
    SettingsPanel.test.tsx          (modify — add WeCom users tab tests)
  i18n/
    en/settings.json                (modify — add wecom keys)
    zh-CN/settings.json             (modify — add wecom keys)
```
