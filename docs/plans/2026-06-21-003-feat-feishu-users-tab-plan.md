---
date: 2026-06-21
type: feat
origin: docs/brainstorms/2026-06-21-feat-feishu-users-tab-requirements.md
---

# Feishu Bot Users Tab

## Summary

Add a read-only **Users** sub-tab to the Feishu Bot settings section. The tab lists every Feishu user who has sent a direct message to the workspace's bot, showing their `open_id`, a cached display name resolved from Feishu, and first/last seen timestamps. The implementation mirrors the existing WeCom Users tab pattern: a workspace-scoped directory table, a cache-first display-name resolver, a `GET /api/workspaces/:id/feishu/users` endpoint, and a polling React UI.

---

## Problem Frame

Admins can configure the Feishu bot and manage admin users, but they have no visibility into which Feishu users have actually interacted with the bot. The WeCom bot already surfaces this via a Users tab. Feishu should have parity so admins can see reach, pending names, and activity timestamps without leaving Comate.

---

## Requirements

This plan advances every requirement from the origin brainstorm:

- **R1–R3 (data model and storage):** Create `feishu_workspace_users`, upsert on inbound direct message, and cache the resolved display name locally.
- **R4–R6 (display-name resolution):** Resolve names through Feishu's contact API using the workspace's app credentials; fall back to `open_id` with a pending indicator when resolution fails or is incomplete.
- **R7–R9 (server API):** Expose `GET /api/workspaces/:id/feishu/users`, returning `open_id`, optional `user_id`, optional `name`, `first_seen_at`, `last_seen_at`, and `name_pending`.
- **R10–R14 (UI):** Add a `users` sub-tab to `FeishuBotSection`, poll every 10 seconds, render cards with name/`open_id`/timestamps, show an empty state, and leave the Connection tab admin editor unchanged.
- **R15 (permissions):** Only workspace members who can view workspace settings may access the Feishu Users tab; reuse the same authorization as the WeCom Users tab.

---

## Key Technical Decisions

1. **Single user-directory table with optional name cache.** `feishu_workspace_users` stores `open_id`, optional `user_id`, optional `name`, and first/last seen timestamps. Co-locating the cached name with the directory keeps reads simple and matches the WeCom `wecom_workspace_users` pattern. A separate profile cache table would add a join for no current benefit.
2. **Cache-first, fire-and-forget resolver.** A new `FeishuUserResolver` checks the local cache, then calls Feishu's `contact.user.basicBatch` (with `user_id_type: 'open_id'`) for uncached users. The call is asynchronous and swallows errors so message handling is never blocked. A batched queue resolver like WeCom's is deferred; per-message resolution is acceptable for the initial directory and can be upgraded later.
3. **Upsert on every inbound DM.** `FeishuBotService.createDispatchHandler` records the user in the directory before routing commands or chat messages. This naturally discovers users on first contact and refreshes `last_seen_at` on every subsequent message.
4. **Names are served from cache; the UI polls for updates.** The `/feishu/users` endpoint returns the cached state and a `name_pending` boolean. The UI refreshes every 10 seconds, so names appear asynchronously once the resolver stores them. The endpoint does not wait for live resolution.

---

## Implementation Units

### U1. SQLite schema and store methods for Feishu workspace users

**Goal:** Create the persistent directory of Feishu users per workspace and the store methods to read and write it.

**Requirements:** R1, R2, R3.

**Files:**
- `src/server/storage/sqlite-store.ts` (modify)
- `src/server/storage/sqlite-store.test.ts` (modify)

**Approach:**
- Add a `CREATE TABLE IF NOT EXISTS feishu_workspace_users` block in the `SqliteStore` constructor with columns `workspaceId`, `openId`, `userId`, `name`, `firstSeenAt`, `lastSeenAt`, and primary key `(workspaceId, openId)`.
- Add `setFeishuWorkspaceUser(workspaceId, openId)` to upsert a row with `firstSeenAt` preserved on conflict and `lastSeenAt` updated to `now`.
- Add `getFeishuWorkspaceUser(workspaceId, openId)` and `listFeishuWorkspaceUsers(workspaceId)` (ordered by `lastSeenAt DESC`).
- Add `setFeishuWorkspaceUserName(workspaceId, openId, name, userId?)` to cache resolver results.
- Add `DELETE FROM feishu_workspace_users WHERE workspaceId = ?` to the workspace `delete` cascade.
- Document a data-retention policy for Feishu user records (e.g., prune after N days of inactivity) and consider encrypting sensitive columns (`openId`, `userId`, `name`) or restricting filesystem permissions on the SQLite database, because these fields are PII from a third-party identity provider.

**Patterns to follow:** `wecom_workspace_users` table and `setWecomWorkspaceUser` / `listWecomWorkspaceUsers` methods in `src/server/storage/sqlite-store.ts`.

**Test scenarios:**
- Insert a row, then call `setFeishuWorkspaceUser` again and assert `firstSeenAt` is unchanged while `lastSeenAt` advances.
- `listFeishuWorkspaceUsers` returns rows ordered by most recent `lastSeenAt`.
- `setFeishuWorkspaceUserName` updates the `name` and optional `userId` fields.
- Workspace deletion removes the workspace's rows.
- `getFeishuWorkspaceUser(workspaceId, openId)` returns the matching row after an upsert and `null` when no row exists.

**Verification:** The store methods exist, the table is created, upserts behave correctly, and the delete cascade removes rows.

---

### U2. Feishu display-name resolver

**Goal:** Resolve and cache human-readable display names for Feishu users without blocking message processing.

**Requirements:** R4, R5, R6.

**Files:**
- `src/server/services/feishu-user-resolver.ts` (create)
- `src/server/services/feishu-user-resolver.test.ts` (create)

**Approach:**
- Export a singleton `feishuUserResolver` with a method `resolveOnMessage(workspaceId: string, openId: string, larkClient: lark.Client): Promise<void>`.
- The method checks `store.getFeishuWorkspaceUser(...).name` (or a dedicated cache lookup). If a name is already cached, return immediately.
- Otherwise, call `larkClient.contact.user.basicBatch({ data: { user_ids: [openId] }, params: { user_id_type: 'open_id' } })` and store the returned `name` and `user_id` via `store.setFeishuWorkspaceUserName`.
- Catch and log errors without throwing so that a Feishu scope error or network failure leaves the user pending instead of breaking the bot.
- Redact sensitive values (`open_id`, `user_id`, app credentials, tokens) from Feishu API errors before logging, mirroring the `redactedError` helper in `wecom-user-resolver.ts`.
- Keep the resolver free of Express concerns and independent of `FeishuBotService` to avoid circular dependencies.

**Technical design:** Directional pseudo-code for the happy path:
```
resolveOnMessage(workspaceId, openId, larkClient):
  if store already has a name for (workspaceId, openId): return
  try:
    response = await larkClient.contact.user.basicBatch({ user_ids: [openId], user_id_type: 'open_id' })
    user = response.data?.users?.[0]
    if user:
      store.setFeishuWorkspaceUserName(workspaceId, openId, user.name, user.user_id)
  catch err:
    log diagnostic warning; do not throw
```

**Patterns to follow:** `src/server/services/wecom-user-resolver.ts` for the cache-first, fire-and-forget shape, but simplified to a single synchronous/await call rather than a batched queue.

**Test scenarios:**
- Cached name exists: resolver does not call `larkClient`.
- Uncached user: resolver calls `contact.user.basicBatch` and stores `name` and `user_id`.
- Feishu API returns an error: resolver swallows the error, leaves the name unset, and logs a redacted message that does not contain `open_id`, `user_id`, or credentials.
- Missing `larkClient`: resolver returns without throwing.

**Verification:** A unit test can inject a fake `larkClient` and assert store state after resolution.

---

### U3. Upsert Feishu user on inbound direct message

**Goal:** Discover users and refresh activity timestamps whenever the bot receives a direct message.

**Requirements:** R1, R2.

**Files:**
- `src/server/services/feishu-bot-service.ts` (modify)
- `src/server/services/feishu-bot-service.test.ts` (modify)

**Approach:**
- In `createDispatchHandler`, after `if (!thread.isDM) return`, call `store.setFeishuWorkspaceUser(workspace.id, feishuUserId)`.
- Then call `feishuUserResolver.resolveOnMessage(workspace.id, feishuUserId, this.connection!.larkClient)` as a fire-and-forget promise.
- Pass the workspace (from `requireActiveWorkspace`) down to the dispatch handler so the workspace ID is available without re-fetching. If that refactor is risky, fetch the active workspace inside the handler after confirming an active binding exists.

**Patterns to follow:** `WeComUserIdResolver.resolveOnMessage` is invoked from the WeCom bot service in a similar fire-and-forget way.

**Test scenarios:**
- A direct message creates a `feishu_workspace_users` row with matching `open_id`.
- A second message from the same user updates `lastSeenAt` without changing `firstSeenAt`.
- A group mention is ignored (no row created).
- The resolver is triggered only when the user is uncached.
- Resolver failure does not cause the message handler to throw.

**Verification:** The existing Feishu bot service tests already exercise DMs; add assertions against the store and the resolver invocation.

---

### U4. `GET /api/workspaces/:id/feishu/users` endpoint

**Goal:** Serve the Feishu user directory to the settings UI.

**Requirements:** R7, R8, R9.

**Files:**
- `src/server/routes/workspaces.ts` (modify)
- `src/server/routes/workspaces-feishu.test.ts` (modify)

**Approach:**
- Add `router.get('/:id/feishu/users', ...)` immediately after the WeCom users route.
- Reuse the workspace-settings authorization model: validate that the caller is authorized to view settings for the requested workspace before returning the list. If the project does not yet have a shared auth middleware, add an inline check that returns `403`/`404` for unauthorized callers, matching the behavior expected for the WeCom users route.
- Return `404` if `store.get(req.params.id)` is missing.
- Call `store.listFeishuWorkspaceUsers(req.params.id)` and map each row to `{ openId, userId, name, firstSeenAt, lastSeenAt, namePending: !name }`.
- Return `{ users: result }` with `200`; return `{ users: [] }` when no users exist yet.
- Reuse the existing error shape `{ error: '...' }` for unexpected failures.

**Patterns to follow:** `GET /api/workspaces/:id/wecom/users` in `src/server/routes/workspaces.ts`.

**Test scenarios:**
- Missing workspace returns `404`.
- Unauthorized caller is rejected (return `403` or `404` consistent with the WeCom users route).
- Workspace exists with no users returns `{ users: [] }`.
- Workspace with users returns them ordered by `lastSeenAt DESC` and includes `namePending: true` for users with no cached name.
- A cached name is returned and `namePending` is `false`.

**Verification:** The route handler passes its unit tests and returns the expected JSON shape.

---

### U5. Feishu Users tab UI

**Goal:** Render the user directory in the Feishu Bot settings section.

**Requirements:** R10, R11, R12, R13, R14.

**Files:**
- `src/client/components/SettingsPanel.tsx` (modify)
- `src/client/components/SettingsPanel.test.tsx` (create)

**Approach:**
- Expand `type FeishuSubTab = 'connection' | 'users'`.
- Add a local `FeishuWorkspaceUser` interface matching the endpoint shape (`openId`, `userId?`, `name?`, `firstSeenAt`, `lastSeenAt`, `namePending`).
- Add `users`, `isLoading`, and `error` state. Add a `useEffect` that fetches `/api/workspaces/${workspaceId}/feishu/users` on mount and every 10 seconds, mirroring the WeCom section. When `workspaceId` changes, clear `users`, reset `error`, and reset `activeSubTab` to `connection` so stale data from the previous workspace is not shown.
- Render a secondary tab bar with `connection` and `users` labels from i18n. Use the same accessibility pattern as the existing WeCom sub-tabs; if the project has an accessibility standard, add `role="tab"`, `aria-selected`, and arrow-key handling to both Feishu and WeCom sub-tab bars.
- Render the users list as a vertical stack of cards (naturally responsive, no additional breakpoints). While the first fetch is in flight, show a loading skeleton or spinner. If the fetch fails, show a retryable error message. On success, render cards showing the resolved name (or `openId` fallback), raw `openId`, a `namePending` pill badge when appropriate, and first/last seen timestamps.
- Style the pending badge as a small inline pill matching the WeCom pattern (`text-[10px] px-1.5 py-0.5 rounded bg-warning/10 text-warning`), positioned next to the fallback `openId` display, with no tooltip.
- Show the empty state when `users.length === 0` and the fetch succeeded.
- Leave the existing Connection tab content unchanged.
- The users list is not sortable or searchable in this iteration; sort is fixed to `lastSeenAt DESC`.

**Patterns to follow:** The WeCom Users tab render block in `src/client/components/SettingsPanel.tsx`.

**Test scenarios:**
- `FeishuBotSection` renders the `users` tab button.
- Switching to the users tab shows fetched users with resolved names.
- Users without a cached name display `openId` and the pending badge with the WeCom pill classes.
- Empty state renders when the endpoint returns no users.
- Polling re-fetches every 10 seconds.
- A loading indicator renders during the initial fetch and disappears after data arrives.
- An error state renders on a failed fetch and the retry button re-triggers the fetch.
- Changing `workspaceId` clears the users list and resets the active sub-tab to `connection`.

**Verification:** A new component test file renders `FeishuBotSection` with mocked `fetch` responses and asserts the above behaviors.

---

### U6. i18n keys for Feishu Users tab

**Goal:** Provide localized labels for the new tab and list states.

**Requirements:** R10, R12, R13.

**Files:**
- `src/client/i18n/en/settings.json` (modify)
- `src/client/i18n/zh-CN/settings.json` (modify)

**Approach:**
- Under `feishu.tabs`, add `users: "Users"` / `users: "用户"`.
- Under `feishu`, add `usersTitle`, `usersEmpty`, `userPending`, `firstSeen`, and `lastSeen`, matching the WeCom key set.
- Add `usersLoading`, `usersError`, and `usersRetry` for the loading and error states introduced in U5.

**Patterns to follow:** Existing `wecom.usersTitle`, `wecom.usersEmpty`, etc.

**Test expectation:** none — pure i18n addition. The UI tests in U5 will exercise the keys indirectly.

---

## Scope Boundaries

### Deferred for later

- Batched/queue-based resolver with rate-limit-aware flushing, similar to `WeComUserIdResolver`.
- Group-chat member discovery.
- Admin toggles, bulk import/export, or editing/deleting discovered users.
- Triggering live resolution from the endpoint when the UI polls pending users.

### Not supported in this iteration

- Sort, search, or filter controls for the users list. The list is always ordered by `lastSeenAt DESC`.

### Outside this product's identity

- Turning the Feishu bot settings into a full Feishu user-management console.

---

## Risks & Dependencies

- **Feishu contact scope.** Display-name resolution only works if the Feishu custom app has permission to read user basic info. Without it, every user remains in the `namePending` state. This is expected and surfaced in the UI.
- **Authorization.** The new `/feishu/users` endpoint must reuse the workspace-settings authorization model. If the Express server does not yet have a shared auth middleware, the route handler should include an inline authorization check so that only workspace members who can view settings can enumerate Feishu users.
- **PII handling.** The `feishu_workspace_users` table stores Feishu `open_id`, optional `user_id`, and display name. The workspace delete cascade removes rows when a workspace is deleted, but a data-retention policy and at-rest encryption for these sensitive columns should be evaluated separately.
- **Rate limits.** Resolving one user per inbound message is acceptable at low volume but may need batching if the bot receives high traffic. The resolver design in U2 makes it easy to swap in a queue later.
- **Workspace deletion.** The new table must be included in the workspace delete cascade; otherwise rows will orphan. U1 covers this explicitly.
- **Test isolation.** Any test touching `SqliteStore` must set `COMATE_DATA_DIR` to a temp directory, per the project's backend-testing convention.

---

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-21-feat-feishu-users-tab-requirements.md`
- WeCom Users tab UI and types: `src/client/components/SettingsPanel.tsx` (`WeComWorkspaceUser`, `WeComSubTab`, users-list render block)
- WeCom users route: `src/server/routes/workspaces.ts` (`GET /api/workspaces/:id/wecom/users`)
- WeCom user storage: `src/server/storage/sqlite-store.ts` (`wecom_workspace_users` table, `setWecomWorkspaceUser`, `listWecomWorkspaceUsers`)
- Feishu bot message dispatch: `src/server/services/feishu-bot-service.ts` (`createDispatchHandler`, `message.author.userId`, `larkClient` on the connection)
- WeCom resolver pattern: `src/server/services/wecom-user-resolver.ts`
- Feishu SDK contact API: `node_modules/@larksuiteoapi/node-sdk/types/index.d.ts` (`contact.user.basicBatch`)
- Institutional learnings: `docs/solutions/conventions/use-isolated-test-database-for-comate.md`
