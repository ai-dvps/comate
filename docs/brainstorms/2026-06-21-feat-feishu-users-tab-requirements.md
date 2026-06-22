---
date: 2026-06-21
topic: feat-feishu-users-tab
origin: docs/plans/2026-06-21-001-feat-feishu-lark-integration-plan.md
---

# Feishu Bot Users Tab

## Summary

Add a read-only Users tab to the Feishu bot settings page that lists every Feishu user who has sent a direct message to the workspace's bot. The tab shows each user's open_id, a cached display name resolved from Feishu, and first/last seen timestamps, mirroring the existing WeCom Users tab.

---

## Problem Frame

The Feishu bot already tracks per-user sessions in `feishu_user_sessions`, but admins have no visibility into which Feishu users have interacted with the bot. The WeCom bot settings page already provides this with a Users tab; Feishu admins should have the same operational visibility without leaving Comate.

---

## Key Decisions

- **Users tab is discovery-only.** Admin management stays in the Connection tab's existing `feishuAdminUserIds` editor. Mixing directory discovery with permission editing would make the tab heavier without adding value for the common case.
- **Resolve display names via the Feishu API and cache them.** Feishu users are identified by `open_id` (`ou_*`), which is opaque. Showing names requires calling Feishu's contact API; caching avoids repeated lookups and keeps the UI responsive.
- **Discover users on first inbound message.** Unlike WeCom, Feishu does not expose a roster of users who have not yet messaged the bot. The directory builds itself as users interact.

---

## Requirements

### Data model and storage

- R1. Create a workspace-scoped directory of Feishu users with at minimum: `open_id`, optional `user_id`, optional cached display `name`, `first_seen_at`, and `last_seen_at`.
- R2. Upsert a user record on every inbound direct message from a Feishu user, setting `first_seen_at` on insert and updating `last_seen_at` on each message.
- R3. Store the cached display name locally once resolved; do not re-fetch on every page load.

### Display-name resolution

- R4. Provide a resolver that looks up a user's display name through the Feishu API using the bot's configured app credentials for the workspace.
- R5. If the resolver cannot determine a name, the UI falls back to showing the `open_id` and a pending indicator.
- R6. Resolution may happen asynchronously; the UI should tolerate pending names and update when they become available.

### Server API

- R7. Expose `GET /api/workspaces/:id/feishu/users` that returns the Feishu user directory for the workspace, ordered by most recent `last_seen_at`.
- R8. The endpoint returns the same fields the UI needs: `open_id`, optional `user_id`, optional `name`, `first_seen_at`, `last_seen_at`, and a `name_pending` boolean when resolution is incomplete.
- R9. Return `404` if the workspace does not exist; return an empty list (not an error) when no users have been discovered.

### UI

- R10. Add a `users` sub-tab to the Feishu bot settings section, alongside the existing `connection` tab.
- R11. The tab fetches the user list on mount and refreshes every 10 seconds, matching the WeCom Users tab refresh cadence.
- R12. Render each user as a card showing the resolved name (or `open_id` if pending), the raw `open_id`, and first/last seen timestamps.
- R13. Show an empty state when no users have messaged the workspace yet.
- R14. Keep the existing inline admin-user editor in the Connection tab unchanged.

### Permissions

- R15. Only workspace members who can view workspace settings may access the Feishu Users tab; reuse the same authorization as the WeCom Users tab.

---

## Scope Boundaries

- **Deferred for later:** admin toggles inside the user list, group-chat user discovery, bulk import/export, and editing or deleting discovered users.
- **Outside this product's identity:** turning the Feishu bot settings into a full user-management console for Feishu.

---

## Dependencies / Assumptions

- The workspace has a working Feishu bot configuration with valid app credentials for display-name resolution to succeed.
- The Feishu app has permission to read user profile/contact information; otherwise names remain pending.
- The existing `feishu_user_sessions` table continues to own session binding; the new user directory is independent but may share the same `open_id` values.

---

## Sources / Research

- WeCom Users tab UI: `src/client/components/SettingsPanel.tsx` (WeComSubTab `'users'`, `WeComWorkspaceUser` interface, and the users-list render block).
- WeCom user directory API: `src/server/routes/workspaces.ts` (`GET /api/workspaces/:id/wecom/users`).
- WeCom user storage: `src/server/storage/sqlite-store.ts` (`listWecomWorkspaceUsers`, `setWecomWorkspaceUser`, `listWecomUserMappings`).
- Feishu bot settings section: `src/client/components/SettingsPanel.tsx` (`FeishuBotSection`, currently only `FeishuSubTab = 'connection'`).
- Feishu message handling: `src/server/services/feishu-bot-service.ts` (where inbound direct messages are dispatched and `open_id` is available).
- Feishu SDK client: `src/server/services/feishu-bot-service.ts` (`larkClient` created per workspace for API calls).
