---
date: 2026-07-01
topic: bot-provider-to-channel-per-channel-owner
title: "Rename bot Provider to Channel and scope ownership per channel"
---

## Summary

Rename the bot "Provider" concept to "Channel" across models, API, database, and UI. Each channel (WeCom, Feishu) manages its own membership: every channel has exactly one owner and can have multiple admins. Bot-level configuration (persona, role policy, active workspace) stays shared across channels, and bot deletion remains a GUI-only operation.

## Problem Frame

The current bot model calls WeCom and Feishu "providers" and enforces a single owner per bot. In practice, a bot is often connected to several independent user populations, each through its own channel. A WeCom administrator and a Feishu administrator may both need to administer the same bot, but each should only control membership for their own channel. The "provider" terminology is confusing, and the single-owner model forces one person to own all channels or blocks decentralized administration.

## Key Decisions

- **Channel is the new name for Provider.** WeCom and Feishu remain the supported channel identifiers; the concept, field names, and user-facing labels change.
- **Ownership is scoped to a channel.** Each `(bot, channel)` pair has exactly one owner. Admins are also per-channel, and a channel can have many admins.
- **Bot-level actions stay in the GUI.** Creating, deleting, and changing shared bot configuration remain GUI/system-actor operations. Channel owners manage only members within their own channel.
- **Existing owners migrate per channel.** A bot's current global owner becomes the owner of each channel the bot has configured.
- **Shared configuration remains shared.** Tool policy, skill allowlist, bash whitelist, persona, and active workspace are still bot-level, not per-channel.

## Actors

- A1. **GUI user** — creates and deletes bots and edits shared bot configuration in the GUI.
- A2. **Channel owner** — the single member with role `owner` for a specific channel; manages that channel's members.
- A3. **Channel admin** — a member with role `admin` for a channel; bypasses restrictions like an owner but cannot manage members.
- A4. **Channel normal user** — a member with role `normal` for a channel; subject to the bot's shared role policy.

## Requirements

### Terminology rename

- R1. Rename the `BotProvider` type to `BotChannel`; keep the values `'wecom'` and `'feishu'`.
- R2. Rename the `provider` field to `channel` on `BotMember`, in the `bot_members` table, in API payloads, and in UI props and state.
- R3. Rename `BotProviderSettings` to `BotChannelSettings`, `providerSettings` to `channelSettings`, and the `provider_settings_json` column to `channel_settings_json`.
- R4. Rename `WeComProviderConfig` to `WeComChannelConfig` and `FeishuProviderConfig` to `FeishuChannelConfig`.
- R5. Update user-facing labels, route names, and audit-log event types from "provider" to "channel" where they refer to WeCom/Feishu access.

### Ownership model

- R6. Each `(bot, channel)` pair has exactly one owner. Adding a second owner to the same channel fails.
- R7. A channel owner can add, remove, and change roles for members within their own channel.
- R8. A channel can have multiple admins. Admins receive the same runtime bypass as owners for tools, files, and skills.
- R9. Removing or demoting the only owner of a channel fails unless another owner for that channel is designated at the same time.
- R10. Bot-level operations (create, delete, switch active workspace, change shared configuration) are authorized by the GUI user or system actor, not by channel ownership.

### Runtime behavior

- R11. Runtime role resolution uses the renamed `channel` field; owner and admin roles bypass tool, file, and skill restrictions as they do today.
- R12. Users who interact with a channel but have no explicit member record are treated as `normal` for that channel.

### Migration

- R13. Existing bot owners are migrated to owner of each channel the bot has configured, determined from non-empty channel settings.
- R14. Existing `admin` and `normal` members keep their role and are associated with their original channel.

### UI

- R15. The bot member list groups members by channel and clearly shows the owner of each channel.
- R16. Adding or changing a role prevents creating a second owner in the same channel and warns before removing the last owner.

## Key Flows

- F1. **Add a channel owner**
  - **Trigger:** A channel owner adds a new member with role `owner` to their channel.
  - **Actors:** A2
  - **Steps:** The service verifies the channel has no existing owner; creates the member; records an audit log entry.
  - **Covered by:** R6, R7.

- F2. **Demote a channel owner**
  - **Trigger:** A channel owner changes an existing owner's role to `admin` or `normal`.
  - **Actors:** A2
  - **Steps:** The service verifies another owner exists for that channel; updates the role; records the change.
  - **Covered by:** R9.

- F3. **Delete a bot**
  - **Trigger:** A GUI user deletes the bot.
  - **Actors:** A1
  - **Steps:** The bot and all its channel members are removed; channel owners cannot perform this action.
  - **Covered by:** R10.

- F4. **Channel admin invokes a restricted tool**
  - **Trigger:** An admin sends a message that causes Claude to attempt a tool the shared role policy denies for normal users.
  - **Actors:** A3, chat-service
  - **Steps:** Runtime resolves the member's channel and role; the admin bypass applies; the tool executes.
  - **Covered by:** R8, R11.

## Acceptance Examples

- AE1. **Covers R1–R5.** After the change, the codebase, database schema, API, and UI no longer refer to WeCom/Feishu as a "provider" for bot access; user-facing labels say "Channel".
- AE2. **Covers R6, R7.** A WeCom channel owner adds a Feishu user as owner of the Feishu channel; both operations succeed because ownership is per-channel.
- AE3. **Covers R6.** A WeCom channel owner attempts to add a second owner to the WeCom channel; the request is rejected.
- AE4. **Covers R8.** A Feishu admin asks the bot to run a tool denied to normal users; the tool executes. A Feishu normal user asks the same thing and is denied.
- AE5. **Covers R9.** The only owner of the WeCom channel is demoted to admin without a replacement; the request is rejected.
- AE6. **Covers R10.** A WeCom channel owner attempts to delete the bot; the request is rejected because bot deletion is GUI-only.
- AE7. **Covers R13.** An existing bot with WeCom and Feishu configured is migrated; the previous global owner becomes owner of both the WeCom and Feishu channels.

## Scope Boundaries

### In scope

- Rename Provider to Channel across bot models, database, API, and UI.
- Make bot ownership per-channel with exactly one owner per channel.
- Keep admin and normal roles per-channel.
- Migrate existing members and owners to the new model.
- Update member-management UI to show channel-scoped ownership.

### Deferred for later

- Adding a WeChat channel (WeChat was only an example).
- Per-channel tool policies, personas, or active workspaces.
- Audit-log enhancements beyond the rename.

### Outside scope

- Changing what owner/admin bypass covers.
- Changing workspace-level legacy isolation settings beyond migration.
- Introducing non-GUI bot management permissions for channel owners.

## Dependencies / Assumptions

- The `bot_members` table can be migrated to rename the `provider` column to `channel` without breaking existing deployments.
- Existing bot owners can be identified and duplicated as owners of each configured channel.
- GUI users performing bot-level actions are already authenticated by the existing session/auth layer.

## Outstanding Questions

### Resolve before planning

_None._

### Deferred to planning

- Exact migration behavior for bots that have members but no configured channel settings.
- Whether the system actor or a specific GUI user is recorded as the actor for migration-generated members.

## Sources / Research

- `src/server/models/bot.ts`
- `src/server/services/bot-service.ts`
- `src/server/storage/sqlite-store.ts`
- `src/server/routes/bots.ts`
- `src/client/components/BotMemberList.tsx`
- `src/server/services/bot-migration-service.ts`
