---
title: Bot Member Plaintext Management - Plan
type: feat
date: 2026-07-04
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Bot Member Plaintext Management - Plan

## Goal Capsule

- **Objective:** Improve the bot member settings UI so that WeCom/Feishu users are auto-added as bot members on first contact, the member list shows both encrypted and plaintext IDs, missing plaintext IDs can be filled in manually as a temporary fallback, and operators can refresh the list or trigger automatic ID resolution independently.
- **Authority:** Product request from the bot settings UX stream; technical decisions reuse existing WeCom/Feishu resolver and mapping tables.
- **Stop conditions:** The feature is done when the member list displays plaintext state, manual fallback and resolution triggers work for both channels, first-message auto-add is wired, and all related tests pass.
- **Tail ownership:** Implementation and QA live in the bot service, resolver, route, store, and `BotMemberList` component layers.

## Product Contract

### Summary

Bot members today are managed through `src/client/components/BotMemberList.tsx`, but the list only shows the encrypted/channel user ID, cannot surface resolution status, and cannot trigger the existing WeCom/Feishu ID resolvers from the settings page. This plan closes those gaps by enriching the member model with computed plaintext fields, adding a refresh control and a global "resolve pending" control, allowing inline manual plaintext entry when automatic resolution has not yet produced a value, and auto-enrolling first-time messengers as normal members in the bot bound to their workspace.

### Requirements

**Auto-add**

- R1. When a WeCom or Feishu user sends their first message to a workspace that has a bound bot, the user is added to that bot's member list with channel `wecom`/`feishu`, `channelUserId` set to the encrypted/open ID, and role `normal`.
- R2. Auto-add must never block message handling; failures are logged and the conversation continues.

**Member list display**

- R3. The member list displays the original encrypted/channel user ID for every member.
- R4. The member list also displays the plaintext user ID and, for Feishu, the display name when they are available.
- R5. When no plaintext ID is available, the row shows a "pending" indicator and a manual input field.

**Manual plaintext fallback**

- R6. When a member has no plaintext ID, an operator can type a plaintext ID inline and save it.
- R7. For Feishu, the same inline action also stores a display name (the UI may default the display name to the entered plaintext ID if the operator leaves it empty).
- R8. Automatic resolution always wins over manual input: if the channel resolver later returns a value, it overwrites the manually entered one.

**Refresh and resolution controls**

- R9. A refresh button reloads the member list without invoking any resolver.
- R10. A separate "resolve pending" button triggers automatic resolution for every member that currently lacks a plaintext ID.
- R11. The resolution action reports how many IDs were resolved and how many failed, and the UI refreshes the list afterward.

### Scope Boundaries

- **In scope:** Bot member model enrichment, bot service/routes, WeCom and Feishu message-handler auto-add hooks, client store/component/i18n, and tests.
- **Deferred:** Workspace-level WeCom/Feishu users tabs already exist and are not being redesigned; this plan only reuses their mapping tables.
- **Out of scope:** Bulk import, role auto-promotion, per-member resolve buttons, and offline queue behavior changes.

## Planning Contract

### Key Technical Decisions

- KTD1. **Computed plaintext fields instead of new `bot_members` columns.** `BotMember` gains `plaintextUserId`, `displayName`, and `resolutionStatus` at runtime, but these are computed from `wecom_user_id_mappings` and `feishu_workspace_users`. This avoids a schema migration, keeps the workspace users tabs and bot member list in sync, and lets automatic resolution overwrite a manual fallback transparently.
- KTD2. **List-level controls.** Refresh is a pure list reload. Resolution is triggered by a single global "resolve pending" button. Per-member manual input is the only per-row editing affordance, matching the confirmed scope.
- KTD3. **Auto-add uses `systemActor()`.** Message handlers call `botService.addMember(..., systemActor())` so the existing channel-owner authorization rule is bypassed only for system-initiated enrollment, not for arbitrary channel users.
- KTD4. **Feishu immediate resolution is factored out.** `FeishuUserResolver.resolveOnMessage` is split so a new `resolveImmediate` method can return the resolved name/userId synchronously for the manual trigger; if the bot is not connected and no `larkClient` is available, the resolution attempt is counted as a failure in the `resolve-pending` tally.

### Assumptions

- A bot is bound to at most one active workspace at a time (`bot.activeWorkspaceId`).
- `wecom_user_id_mappings` is global; `feishu_workspace_users` is per workspace.
- The settings UI user is trusted, so the new route handlers can use the existing `systemActor()` pattern used by other member routes.

### Risks & Dependencies

- **Inherited authorization model.** The `/api/bots` route tree currently runs without authentication middleware and uses `systemActor()` for settings-driven mutations. This plan follows that existing convention; it does not introduce a new auth layer. If the project later hardens API access, these endpoints must be included.
- **Global WeCom mapping table.** Because `wecom_user_id_mappings` is global, a manually entered plaintext ID could theoretically collide with another workspace. U2 mitigates this by adding the same workspace-scoped duplicate check the existing WeCom users tab uses.
- **External API rate limits.** `resolve-pending` may call WeCom/Feishu for every pending member; U2 caps/batches the work and surfaces failures so operators cannot accidentally exhaust quotas.
- **Feishu client encapsulation.** Rather than exposing the raw `lark.Client` to `bot-service.ts`, the Feishu bot service exposes a narrow `resolveFeishuUserName(botId, workspaceId, openId)` helper.

### Sequencing

1. Enrich the member model and service resolution helpers (U1).
2. Add resolution and manual-plaintext APIs (U2) and wire auto-add hooks (U3) in parallel.
3. Update the client store, component, and page wiring (U4).
4. Add i18n strings (U5) and run the verification suite.

## Implementation Units

### U1. Enrich the `BotMember` model and service resolution helpers

- **Goal:** Make plaintext state a first-class property of bot members without changing the database schema.
- **Requirements:** R3, R4, R5.
- **Files:**
  - `src/server/models/bot.ts` — add optional `plaintextUserId: string | null`, `displayName: string | null`, and `resolutionStatus: 'resolved' | 'pending'` to `BotMember`.
  - `src/client/stores/bot-store.ts` — mirror the same `BotMember` shape.
  - `src/server/services/bot-service.ts` — add a private `resolveMemberPlaintext(botId, member)` helper that:
    - for `wecom`, reads `workspaceStore.getWecomUserMapping(member.channelUserId)`;
    - for `feishu`, reads `workspaceStore.getFeishuWorkspaceUser(bot.activeWorkspaceId, member.channelUserId)` and returns `userId` as plaintext and `name` as display name.
  - Update `listMembers` to map raw members through the helper and set `resolutionStatus` to `'resolved'` when plaintext exists, otherwise `'pending'`.
  - Update `addMember` to return the enriched member (it may already be resolved if the user has messaged before).
- **Approach:** Keep storage methods unchanged; perform the join in the service so channel-specific mapping knowledge stays out of the generic `SqliteStore.listBotMembers` implementation.
- **Test scenarios:**
  - A WeCom member with a stored mapping returns `plaintextUserId` and `resolutionStatus: 'resolved'`.
  - A Feishu member with a stored `feishu_workspace_users` row returns `plaintextUserId`, `displayName`, and `resolutionStatus: 'resolved'`.
  - A member with no mapping returns `null` plaintext and `resolutionStatus: 'pending'`.
  - Adding a member whose ID already has a mapping returns the enriched member immediately.
- **Verification:** `npm run test:server -- src/server/services/bot-service.test.ts`

### U2. Add on-demand resolution and manual plaintext APIs

- **Goal:** Give the settings UI backend endpoints to trigger resolution and to save a temporary manual plaintext ID.
- **Requirements:** R6, R7, R8, R10, R11.
- **Files:**
  - `src/server/services/feishu-user-resolver.ts` — extract the API-call and store-update logic from `resolveOnMessage` into a new `resolveImmediate(workspaceId, openId, larkClient)` method that returns `{ userId, name }` or throws; keep `resolveOnMessage` fire-and-forget by awaiting `resolveImmediate` and swallowing errors.
  - `src/server/services/feishu-bot-service.ts` — expose `resolveFeishuUserName(botId: string, workspaceId: string, openId: string): Promise<{ userId: string; name: string } | null>` (do not expose the raw lark client).
  - `src/server/services/bot-service.ts` — add:
    - `resolvePendingMembers(botId): { resolved: number; failed: number }` — iterates `listMembers(botId)`, skips resolved members, and for each pending member calls the appropriate resolver using the bot's `activeWorkspaceId`. For WeCom use `wecomUserResolver.resolveImmediate`; for Feishu call `feishuBotService.resolveFeishuUserName(botId, activeWorkspaceId, channelUserId)`. Count successes and failures, catching errors per ID and logging them with `diagLog`. Process members sequentially to avoid hammering upstream APIs; if batching is added later, cap concurrency to 4.
    - `setMemberPlaintext(botId, channel, channelUserId, plaintextUserId, displayName?)` — validates the bot and member exist, then writes the fallback to `workspaceStore.setWecomUserMapping` (WeCom) or `workspaceStore.setFeishuWorkspaceUserName` (Feishu). Returns the enriched member.
  - `src/server/routes/bots.ts` — add:
    - `POST /api/bots/:id/members/resolve-pending` returning `{ resolved, failed }`.
    - `PUT /api/bots/:id/members/:channelUserId/plaintext?channel=` with body `{ plaintextUserId, displayName? }` returning `{ member }`.
- **Approach:** Reuse existing resolver singletons and storage methods. Validate `plaintextUserId` is non-empty. Return 400 if the bot has no active workspace for Feishu, if the channel is unsupported, or if the member does not exist. For WeCom, before saving a manual mapping in `setMemberPlaintext`, check whether the requested `plaintextUserId` is already mapped to a different encrypted ID within the same workspace's bound bots; if so, return 409 with code `duplicate-plaintext` to prevent accidental collisions (a single encrypted ID may map to only one plaintext ID; the same plaintext ID re-submitted for the same encrypted ID is idempotent).
- **Test scenarios:**
  - `resolve-pending` resolves a pending WeCom member when a mapping is returned by the API.
  - `resolve-pending` counts a Feishu member as failed when no lark client is available.
  - `plaintext` endpoint stores a manual WeCom mapping and returns the enriched member.
  - `plaintext` endpoint rejects empty plaintext IDs and unknown members.
  - `plaintext` endpoint rejects a WeCom plaintext ID already mapped to a different encrypted user in the same workspace.
  - After a manual plaintext is saved, a subsequent resolver flush still overwrites it (covered by resolver storage behavior plus service re-read).
- **Verification:** `npm run test:server -- src/server/routes/bots.test.ts src/server/services/feishu-user-resolver.test.ts`

### U3. Auto-add bot members on first inbound message

- **Goal:** Eliminate the need to manually add members before a user can talk to the bot.
- **Requirements:** R1, R2.
- **Files:**
  - `src/server/services/wecom-bot-service.ts` — after `wecomUserResolver.trackWorkspaceUser(workspaceId, wecomUserId)` in both `handleTextMessage` and `handleMediaMessage`, call a new private `ensureBotMember(workspaceId, wecomUserId, 'wecom')` method. This method looks up the bot for the workspace, checks `botService.getMemberRole(botId, 'wecom', wecomUserId)`, and if null calls `botService.addMember(botId, { channel: 'wecom', channelUserId: wecomUserId, role: 'normal' }, systemActor())`, catching and logging errors.
  - `src/server/services/feishu-bot-service.ts` — in `createDispatchHandler`, after `workspaceStore.setFeishuWorkspaceUser(workspaceId, feishuUserId)`, call a similar `ensureBotMember(workspaceId, feishuUserId, 'feishu')` using `this.getBotIdForWorkspace(workspaceId)`.
- **Approach:** Both services already maintain `workspaceIdToBotId` maps, so the lookup is local. Before calling `addMember`, call `botService.getMemberRole(botId, channel, channelUserId)`; add only when the role is `null` to keep idempotency explicit and independent of the storage layer's conflict handling. Wrap the whole flow in a try/catch so a member-lookup or add failure never bubbles up to the message handler.
- **Test scenarios:**
  - A WeCom text message from a new user creates a `normal` bot member for the bound bot.
  - A second message from the same user does not create a duplicate or change role.
  - If no bot is bound to the workspace, message handling continues without error.
  - A Feishu DM from a new user creates a `normal` bot member when a bot is connected to the active workspace.
- **Verification:** `npm run test:server -- src/server/services/wecom-bot-service.test.ts src/server/services/feishu-bot-service.test.ts`

### U4. Update the client store and `BotMemberList` UI

- **Goal:** Surface plaintext state and the new controls in the settings page.
- **Requirements:** R3–R11.
- **Files:**
  - `src/client/stores/bot-store.ts` — add actions:
    - `resolvePendingMembers(botId)` → `POST /api/bots/${botId}/members/resolve-pending`, then call `fetchMembers(botId)`.
    - `setMemberPlaintext(botId, channel, channelUserId, plaintextUserId, displayName?)` → `PUT .../plaintext`, then update the local member record.
  - `src/client/components/BotMemberList.tsx` — extend props with `onRefresh`, `onResolvePending`, `onSetPlaintext`; add header buttons for refresh and "resolve pending"; render each row with encrypted ID, plaintext ID, display name, and a pending badge; show an inline plaintext input + save/cancel when plaintext is missing.
    - **Interaction details:** The inline input is shown only while `resolutionStatus === 'pending'`; clicking "Save" calls `onSetPlaintext`; clicking "Cancel" discards local edits and reverts to the read-only pending row. After a successful save, the service returns the enriched member and the parent refreshes local state (the component itself does not optimistically update). Show a non-blocking inline error if `onSetPlaintext` rejects.
    - **Resolve-pending feedback:** After `onResolvePending` resolves, display a toast/inline notice with the counts returned by the API (e.g. "Resolved 3, failed 1"); failures remain visible as pending rows so the operator can retry or enter plaintext manually.
    - **Button states:** Disable "resolve pending" while resolution is in flight; also disable it when no member has `resolutionStatus === 'pending'`. The refresh button remains enabled during resolution.
    - **Responsive layout:** Each row keeps the existing grouped channel list structure; plaintext/display-name columns use `min-w-0 truncate` with a `title` attribute so long IDs remain readable on hover. Pending badge and input use `shrink-0` to avoid wrapping artifacts.
    - **Accessibility:** Header buttons have `aria-label` keys (`refreshMembers`, `resolvePending`), and the inline plaintext input has an `aria-label` bound to `memberPlaintextId`.
  - `src/client/components/BotManagementPage.tsx` — wire the new props to the store actions; pass a stable `onRefresh` that only calls `fetchMembers(botId)`.
- **Test scenarios:**
  - A pending WeCom row shows the input field; saving calls `onSetPlaintext` and updates the row.
  - A resolved row shows plaintext and no input field.
  - Clicking refresh calls `onRefresh` without calling `onResolvePending`.
  - Clicking "resolve pending" calls `onResolvePending` and refreshes.
  - Role changes and removals continue to work.
- **Verification:** `npm run test:client -- BotMemberList` and `npm run test:client -- SettingsPanel.bots`

### U5. Add i18n strings

- **Goal:** Provide English and Chinese labels for the new UI text.
- **Requirements:** R6, R7, R9, R10.
- **Files:**
  - `src/client/i18n/en/settings.json` — add under `bots`: `refreshMembers`, `refreshMembersAria`, `resolvePending`, `resolvePendingAria`, `resolvePendingResult`, `memberEncryptedId`, `memberPlaintextId`, `memberPlaintextAria`, `memberDisplayName`, `memberDisplayNamePlaceholder`, `memberDisplayNameRequired`, `memberPending`, `memberPlaintextPlaceholder`, `memberPlaintextRequired`, `memberPlaintextSave`, `memberPlaintextCancel`.
  - `src/client/i18n/zh-CN/settings.json` — add the corresponding Chinese translations.
- **Approach:** Reuse the translation style already used by `wecom.usersReload` and `wecom.usersResolvePending` where appropriate, but keep the keys under `bots` because the UI lives in the bot member list.
- **Verification:** Visual inspection and `npm run lint`.

## Verification Contract

| Command | Purpose | When to run |
|---|---|---|
| `npm run lint` | ESLint/type-check gate | Before every commit and after all units |
| `npm run test:server -- src/server/services/bot-service.test.ts` | Service-level member enrichment | After U1 |
| `npm run test:server -- src/server/routes/bots.test.ts src/server/services/feishu-user-resolver.test.ts` | New route endpoints and Feishu immediate resolver | After U2 |
| `npm run test:server -- src/server/services/wecom-bot-service.test.ts src/server/services/feishu-bot-service.test.ts` | First-message auto-add hooks | After U3 |
| `npm run test:client -- BotMemberList` | Component rendering and interactions | After U4 |
| `npm run test:client -- SettingsPanel.bots` | Integration with settings panel dirty guard | After U4 |

### Quality gates

- All server tests pass with isolated SQLite (`COMATE_DATA_DIR`) and no regressions in existing bot route/service tests.
- All client tests pass, including existing bot settings tests.
- `npm run lint` reports zero errors.
- New i18n keys are present in both `en` and `zh-CN`.
- `CHANGELOG.md` is updated with a user-facing entry following Keep a Changelog format.

## Definition of Done

- [ ] U1: `BotMember` includes `plaintextUserId`, `displayName`, and `resolutionStatus`; `listMembers` and `addMember` return enriched members.
- [ ] U2: `POST /api/bots/:id/members/resolve-pending` and `PUT /api/bots/:id/members/:channelUserId/plaintext` are implemented and tested.
- [ ] U3: WeCom and Feishu message handlers auto-add new users as `normal` members without blocking message processing.
- [ ] U4: The settings UI shows plaintext IDs, pending badges, inline manual input, refresh, and resolve-pending controls.
- [ ] U5: English and Chinese translations for all new UI strings are added.
- [ ] All tests in the Verification Contract pass and `npm run lint` is clean.
- [ ] `CHANGELOG.md` has a new entry under the Unreleased section describing the improved bot member management.
- [ ] Any experimental or dead-end code introduced during implementation is removed before the final diff.
