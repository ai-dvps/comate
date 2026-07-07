---
title: Bot Channel Connection Status - Plan
type: feat
date: 2026-07-06
topic: bot-channel-connection-status
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Bot Channel Connection Status

## Goal Capsule

- **Objective:** Surface WeCom and Feishu connection status directly on the Bot Channels configuration section, and make the Save button drive credential/toggle-driven reconnects while reserving a Reconnect button for recovery-only cases.
- **Product authority:** The bot settings unified layout already places channel configuration in a dedicated section tab; this work adds status visibility and connection affordances without changing the surrounding settings navigation.
- **Execution profile:** Standard client/server feature; changes are localized to the bot settings UI, the bot store's channel-status slice, and the bot routes/service layer. Tail ownership: implementer.
- **Open blockers:** None.

---

## Product Contract

*Product Contract preservation: unchanged from the upstream brainstorm.*

### Summary

Add per-channel connection status to the Bot Channels configuration section. The Save button reconnects when credentials have changed, connects when a channel is newly enabled while disconnected, and disconnects when a channel is disabled while connected. A Reconnect button appears only when credentials are unchanged yet the channel is disconnected. Status updates use the existing polling infrastructure.

### Problem Frame

Channel credentials and the enable toggle are currently edited in `BotChannelsSection`, but the page gives no feedback about whether the channel is actually connected. Admins have to leave the bot settings and look at workspace tabs or server logs to know if a configuration change succeeded. This adds a visible status indicator and a clear reconnect path so admins can confirm and recover channel connectivity without leaving the channel configuration page.

### Key Decisions

- **Save is the single action for config-driven connection changes.** Credential edits and toggle changes both take effect through the page-level Save button. This keeps the edit→apply flow in one action and avoids asking users to save credentials and then click a separate Reconnect control.
- **The channel enable toggle is a value control only.** Flipping the toggle changes the form value; it does not immediately connect or disconnect the channel. The Save button reads the final form state and decides whether to connect, reconnect, or disconnect each channel.
- **Reconnect button is a recovery-only control.** It appears only when the saved configuration has not changed and the channel is disconnected. When credentials are edited, the Reconnect button is hidden and Save handles the reconnect.
- **Status belongs to the channel, not the bot.** Each WeCom and Feishu channel carries its own connection status. The bot entity has no aggregated status field; any bot-level status view is derived from its channels.

### Requirements

#### Status display

- R1. Each channel card (WeCom and Feishu) in the Bot Channels section displays the current connection status.
- R2. Status uses the existing channel-status values (`connected`, `connecting`, `disconnected`, `error`, `not_configured`) and the existing dot/label styling. The `BotStatus` value type in `src/client/hooks/use-bot-statuses.ts` is renamed to `ChannelStatus`, and the bot-scoped `BotStatus` aggregate interface in `src/client/stores/bot-store.ts` is deleted. `GET /api/bots/:id/status` returns `{ wecom, feishu, errors?: { wecom?: string; feishu?: string } }`, where `errors` carries a sanitized error message for any channel whose status is `error`. The UI displays the sanitized message or a channel-specific fallback so the admin knows why the connection failed.
- R3. The status indicator is positioned inside the same card as the channel's toggle and credential fields so it stays visually tied to the controls that affect it.
- R4. Status refreshes automatically without requiring the user to reload the page.

#### Save-driven connection behavior

- R5. When the Save button is clicked and a channel's credentials have changed, the system persists the config first, then attempts to reconnect that channel.
- R6. While a Save-triggered reconnect or connect is in progress, the affected channel card shows an optimistic client-side reconnecting hint (not a new `ChannelStatus` value); the hint is driven by the pending-action state described in U4 and clears once polling reports `connected`, `error`, or `disconnected`. When Save disables a connected channel, the card shows a disconnecting hint or no optimistic hint instead.
- R7. When the Save button is clicked and a channel toggle changes from disabled to enabled while the channel is disconnected and credentials are present, Save triggers a connect attempt.
- R8. When the Save button is clicked and a channel toggle changes from enabled to disabled while the channel is connected, Save triggers a disconnect.
- R9. If credentials changed and the channel is currently disconnected, no Reconnect button is shown; the Save button is responsible for reconnecting.

#### Reconnect button

- R10. A Reconnect button appears in a channel card only when the channel's saved credentials are unchanged and the channel status is `disconnected`.
- R11. Clicking the Reconnect button attempts to reconnect the channel using the currently saved credentials.
- R12. The Reconnect button is hidden when credentials are dirty, when the channel is disabled, or when the channel status is `connected`, `connecting`, `error`, or `not_configured`.

### Key Flows

- F1. **Owner edits credentials and saves**
  - **Trigger:** Owner changes WeCom or Feishu credentials and clicks Save.
  - **Actors:** Bot owner / admin.
  - **Steps:** Config is persisted; the channel attempts to reconnect; the card shows a reconnecting hint; status updates to `connected` or `error`.
  - **Covered by:** R5, R6.

- F2. **Owner enables a disabled channel and saves**
  - **Trigger:** Owner flips the toggle from disabled to enabled and clicks Save.
  - **Actors:** Bot owner / admin.
  - **Steps:** Config is persisted; if the channel was disconnected and credentials are present, the channel connects.
  - **Covered by:** R7.

- F3. **Owner disables an enabled channel and saves**
  - **Trigger:** Owner flips the toggle from enabled to disabled and clicks Save.
  - **Actors:** Bot owner / admin.
  - **Steps:** Config is persisted; if the channel was connected, it disconnects.
  - **Covered by:** R8.

- F4. **Channel disconnects on its own; owner recovers**
  - **Trigger:** The channel status becomes `disconnected` without any config change.
  - **Actors:** Bot owner / admin.
  - **Steps:** The card shows a Reconnect button; the owner clicks it; the channel reconnects using saved credentials.
  - **Covered by:** R10, R11.

### Acceptance Examples

- AE1. **Credentials change reconnects on Save**
  - **Covers:** R5, R6.
  - **Given:** WeCom is connected and the owner edits the bot secret.
  - **When:** The owner clicks Save.
  - **Then:** The card shows a reconnecting hint; after the attempt, status is `connected` or `error`.

- AE2. **Enabling a disconnected channel connects on Save**
  - **Covers:** R7.
  - **Given:** WeCom is disabled, credentials are present, and status is `disconnected`.
  - **When:** The owner enables the toggle and clicks Save.
  - **Then:** The channel connects and status becomes `connected` or `error`.

- AE3. **Disabling a connected channel disconnects on Save**
  - **Covers:** R8.
  - **Given:** WeCom is enabled and connected.
  - **When:** The owner disables the toggle and clicks Save.
  - **Then:** The channel disconnects and status becomes `disconnected`.

- AE4. **Reconnect button appears only for unchanged config + disconnected**
  - **Covers:** R10, R12.
  - **Given:** WeCom credentials are unchanged and status is `disconnected`.
  - **When:** The owner views the channel card.
  - **Then:** A Reconnect button is visible.

- AE5. **Reconnect button hidden when credentials are dirty**
  - **Covers:** R9, R12.
  - **Given:** WeCom is disconnected and the owner has edited credentials but not saved.
  - **When:** The owner views the channel card.
  - **Then:** No Reconnect button is shown; the Save button reconnects when clicked.

### Scope Boundaries

#### In scope

- Per-card connection status in the Bot Channels configuration section.
- Save-driven reconnect, connect, and disconnect behavior.
- Conditional Reconnect button for the unchanged-config + disconnected case.
- Migration of the bot-scoped `BotStatus` aggregate to per-channel status storage; the `BotStatus` value type is renamed to `ChannelStatus` and the `BotStatus` aggregate interface is deleted. Reuse the existing channel-status value set and dot/label styling; update the endpoint envelope so it returns channel statuses directly (no bot-level wrapper).

#### Deferred for later

- Detailed error logs or a diagnostic panel inside the Channel UI.
- Connection-drop notifications or toasts.
- Changes to how status is displayed on the Workspace tabs or elsewhere.

> Note: Workspace tabs are deferred only for display changes; the migration of the bot-scoped `BotStatus` aggregate to per-channel status must not break existing Workspace tab consumers or their tests.

#### Outside this product's identity

- Adding new bot channels beyond WeCom and Feishu.
- Changing the bot settings layout or navigation model.

### Dependencies / Assumptions

- The existing `BotChannelsSection` component remains in place; the `BotStatus` value type is renamed to `ChannelStatus` and the bot-scoped `BotStatus` aggregate interface is deleted.
- `GET /api/bots/:id/status` currently returns `{ status: { wecom, feishu } }`; KTD1 migrates it to return `{ wecom, feishu, errors?: { wecom?: string; feishu?: string } }`, where each value is a channel status and `errors` carries a sanitized message for channels in `error`.
- The bot update route continues to call `reconcileChannelConnections` after saving.
- The reconnect endpoint follows the existing bot route authorization model (`systemActor()`); adding per-route owner/admin authentication is out of scope for this plan and would need to be applied consistently across all bot routes.
- The page-level Save button persists the full `BotFormData`, including channel toggles and credentials. The client must send an `enabled: false` payload for disabled channels (with unchanged secrets represented by sentinels) so the server can persist the toggle change and trigger disconnect when appropriate.

### Outstanding Questions

- None.

### Sources / Research

- `src/client/components/BotChannelsSection.tsx` — existing WeCom/Feishu channel cards with toggle and credential inputs.
- `src/client/hooks/use-channel-statuses.ts` (renamed from `use-bot-statuses.ts`) — defines the `ChannelStatus` value type and dot/label styling; the workspace-scoped polling hook is not reused for bot channel status.
- `src/server/routes/bots.ts` — `GET /api/bots/:id/status` returns channel-level status and `reconcileChannelConnections` is triggered after bot update.
- `src/server/services/wecom-bot-service.ts` — `updateConnectionForBot` is routing-only and does not re-authenticate; credential changes require a disconnect+connect cycle.
- `src/client/stores/bot-store.ts` — `fetchStatus(botId)` and `statusByBotId` currently expose bot-scoped status and will be migrated to per-channel status storage.
- `src/client/components/BotStatusIcon.tsx` — existing status-dot component used in workspace tabs.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Migrate the status endpoint to return per-channel status directly, treating status as channel-owned data.** `GET /api/bots/:id/status` should return `{ wecom, feishu, errors?: { wecom?: string; feishu?: string } }` (no bot-level `status` wrapper), with each value being a channel status. The optional `errors` map carries a sanitized, human-readable message for any channel whose status is `error`; it is empty/absent when no channel is in error. The bot store migrates from `statusByBotId` (bot-scoped aggregate) to per-channel status storage keyed by bot and channel. Update existing consumers of the old `{ status: { wecom, feishu } }` shape accordingly.
- **KTD2. Add a dedicated reconnect route for the explicit Reconnect button.** Reusing `PUT /api/bots/:id` with an unchanged payload would still call `reconcileChannelConnections`, but it would not force a fresh disconnect+connect cycle. A `POST /api/bots/:id/channels/:channelKey/reconnect` endpoint gives clean semantics and a clear return value.
- **KTD3. Detect credential changes server-side by comparing effective persisted channel settings.** The client sends secret sentinels for unchanged secrets, so the server is the source of truth for the effective credential values. Comparing before-and-after effective values avoids false positives and false negatives. This pattern is already implemented: `buildSecretValue` in `src/client/components/bot-form-utils.ts:71-78` returns `true` when a secret input is left empty but a secret is already persisted, and `resolveSentinelCredentials` in `src/server/routes/bots.ts:110` resolves that sentinel back to the persisted value before comparison.
- **KTD4. Force reconnect on credential change with disconnect+connect.** `WeComBotService.updateConnectionForBot` and its Feishu equivalent only update workspace routing; they do not re-authenticate with new credentials. A full disconnect+connect cycle is required to apply credential changes.
- **KTD5. Guard reconnect teardown by connection identity.** When a disconnect handler fires, only clear state if the closing connection is still the active one. This prevents a stale close from wiping out a newer connection during rapid save/reconnect cycles.
- **KTD6. Sanitize channel error messages at the API boundary.** Error strings returned in `GET /api/bots/:id/status` and the reconnect endpoint must redact secrets, webhook URLs, IP addresses, and stack traces. Only a short, human-readable description is exposed to the client; full diagnostic details are written server-side via `diagLog()`.

### Assumptions

- The existing channel-status value set (`connected`, `connecting`, `disconnected`, `error`, `not_configured`) and dot/label styling are sufficient; the `BotStatus` value type is renamed to `ChannelStatus`, the bot-scoped `BotStatus` aggregate interface is deleted, and no new status states are introduced.
- A 5-second status polling interval is acceptable for freshness; optimistic local hints cover the gap during reconnect.
- The page-level Save button continues to call `updateBot` with the full channel form data.

### Dependencies and Sequencing

- U1 (server-side reconnect orchestration) must land before U2 (client status availability) because U2 parses the new `{ wecom, feishu, errors? }` response shape.
- U1 must land before U4 (client reconnect button) because the button calls the new endpoint.
- U2 (client status availability) must land before U3 (status UI) because the UI renders the passed-in status.
- U3 and U4 can be developed together, but the Reconnect button tests require both U1 and U3.

---

## Implementation Units

### U1. Server-side reconnect orchestration

**Goal:** Add an explicit reconnect endpoint and ensure the bot update flow reconnects when credentials change or when a disabled channel is enabled.

**Requirements:** R5, R7, R8.

**Dependencies:** None.

**Files:**
- `src/server/routes/bots.ts`
- `src/server/services/bot-service.ts`
- `src/server/services/bot-audit-logger.ts`
- `src/server/services/wecom-bot-service.ts`
- `src/server/services/feishu-bot-service.ts`
- `src/server/routes/bots.test.ts`

**Approach:**
- Introduce channel-scoped `connectChannel(botId, channelKey)` and `disconnectChannel(botId, channelKey)` methods in `WeComBotService` and `FeishuBotService`, then use them in the reconnect endpoint and in `reconcileChannelConnections` so each channel is connected and disconnected independently. Add `POST /api/bots/:id/channels/:channelKey/reconnect`. Validate that the bot exists, `channelKey` is `wecom` or `feishu`, the channel is enabled, and the required credentials are present. Apply per-bot/channel rate limiting using an in-memory `Map(botId+channelKey -> lastReconnectAt)` with a 30-second window; return `429` when the limit is exceeded. Call `disconnectChannel(botId, channelKey)` then `connectChannel(botId, channelKey)` for the requested channel. After the calls, read the resulting channel status; if it is `error`, return `{ wecom, feishu, errors }` with HTTP `502` and include the sanitized error message. On success return `{ wecom, feishu, errors }` reflecting the updated channel statuses. Return `400` if the channel key is invalid, the channel is disabled, or credentials are missing. Extend `BotAuditEventType` in `src/server/services/bot-audit-logger.ts` to include `channel_reconnect_requested`, `channel_reconnect_succeeded`, and `channel_reconnect_failed`. Expose a public `getAuditLogger()` method on `BotService` and have the route call `botService.getAuditLogger().log(event, details)`; use the existing logger sink (SQLite audit table via `store.recordAuditLog` plus `diagLog` mirror). Retention and read access follow the existing bot audit-log policy; do not introduce a separate retention rule for these events. Never include raw error bodies or credential values in audit logs.
- Update `WeComBotService.getBotStatus` and `getStatus` to expose the `connecting` state instead of collapsing it to `disconnected`, aligning WeCom with Feishu and the plan's status vocabulary. Add a `lastError: string` field to each service's connection object, set it when a connection attempt fails, clear it on a successful connect, and expose it through the status getter so `GET /api/bots/:id/status` can populate the `errors` map after sanitization. Verify existing workspace WeCom status callers tolerate the new value.
- In the bot update flow, capture a `preUpdate` snapshot of **non-sensitive comparison data** (e.g., credential fingerprints or a comparator returned by the service) before persisting any channel settings. Do not store decrypted secrets in the snapshot; if plaintext values are used for comparison, zero or overwrite them immediately afterward and never log them. Resolve sentinels and persist each channel's settings as today. Pass the `preUpdate` snapshot into `reconcileChannelConnections` so it can compare pre- and post-persistence effective credentials; make the snapshot parameter optional so routes such as the active-workspace switch can still call `reconcileChannelConnections` without forcing a credential-change reconnect. For each enabled channel:
  - If the channel was previously disabled or the service reports `not_configured`, call `connectChannel(botId, channelKey)`.
  - If the effective credentials changed compared to `preUpdate`, call `disconnectChannel(botId, channelKey)` then `connectChannel(botId, channelKey)`.
  - If only the active workspace changed, call `updateConnectionForBot`.
- For disabled channels, call `disconnectChannel(botId, channelKey)`.
- Apply the connection-identity guard from KTD5 when clearing connection state in disconnect handlers.

**Patterns to follow:**
- Existing `reconcileChannelConnections` shape in `src/server/routes/bots.ts:461-489`.
- Existing service-stubbing pattern in `src/server/routes/bots.test.ts`.

**Test scenarios:**
- **Happy path:** Reconnect endpoint with enabled WeCom channel and valid credentials → disconnects then connects, returns new status.
- **Happy path:** Reconnect endpoint with enabled Feishu channel and valid credentials → disconnects then connects, returns new status.
- **Error path:** Reconnect endpoint with disabled channel → returns `400`.
- **Error path:** Reconnect endpoint with invalid channel key → returns `400`.
- **Error path:** Reconnect endpoint with enabled channel but missing credentials → returns `400`.
- **Error path:** Rapid repeated reconnect calls for the same bot/channel → returns `429` after rate limit is exceeded.
- **Error path:** Status endpoint for a channel whose connection object holds a `lastError` returns the sanitized message in the `errors` map.
- **Integration:** Bot update with changed WeCom secret → effective credentials differ → disconnect+connect called.
- **Integration:** Bot update with unchanged WeCom credentials → no forced reconnect.
- **Integration:** Bot update enabling a previously disabled WeCom channel with credentials → connect called.
- **Integration:** Bot update disabling a connected WeCom channel → disconnect called.

**Verification:**
- `npm run test:server` passes, including the new bot route tests.

### U2. Client channel-status availability

**Goal:** Make per-channel status available to `BotChannelsSection` and keep it fresh.

**Requirements:** R1, R4.

**Dependencies:** U1.

**Files:**
- `src/client/components/BotManagementPage.tsx`
- `src/client/stores/bot-store.ts`
- `src/client/stores/bot-store.test.ts`
- `src/client/hooks/use-bot-statuses.ts` → `src/client/hooks/use-channel-statuses.ts`
- `src/client/components/BotStatusIcon.tsx`
- `src/client/components/WorkspaceTabs.tsx`
- `src/client/components/WorkspaceSwitcher.tsx`
- `src/client/components/SettingsPanel.bots.test.tsx`
- `src/client/components/SettingsPanel.workspace.test.tsx`
- `src/client/components/BotManagementPage.test.tsx`
- `src/client/components/WorkspaceTabs.test.tsx`
- `src/client/components/WorkspaceSwitcher.test.tsx`

**Approach:**
- Audit all client consumers of `statusByBotId` and the bot-scoped `BotStatus` aggregate interface (`src/client/stores/bot-store.ts`). Update any test mocks or components that depend on the old aggregate shape so the migration does not break `npm run test:client` or Workspace tab status consumers.
- Rename `src/client/hooks/use-bot-statuses.ts` to `src/client/hooks/use-channel-statuses.ts` and rename its exported `BotStatus` value type to `ChannelStatus`. Update all imports and, for consistency, rename `BOT_STATUS_DOT` → `CHANNEL_STATUS_DOT`, `BOT_STATUS_CLASS` → `CHANNEL_STATUS_CLASS`, and `getBotStatusLabel` → `getChannelStatusLabel`.
- Migrate the bot store from `statusByBotId: Record<string, BotStatus>` to a channel-scoped shape such as `channelStatusByBotId: Record<string, { wecom: ChannelStatus; feishu: ChannelStatus }>` (or equivalent per-channel storage). Update `fetchStatus(botId)` to store channel statuses under that shape.
- In `BotManagementPage`, when the selected section is `channels`, call `botStore.fetchStatus(selectedBotId)` on mount and after each successful save or reconnect.
- Pass the channel-status map for `wecom` and `feishu` and the optional per-channel `errors` map into `BotChannelsSection`.
- Keep polling lightweight: a single `setInterval` that calls `fetchStatus` while the channels section is active, or refresh explicitly around save/reconnect actions. If two consecutive polls fail, surface a transient “Status unavailable; retrying…” hint next to the status dot and pause optimistic reconnect/disconnect hints until the next successful refresh.

**Patterns to follow:**
- Existing `statusByBotId` usage and `fetchStatus` in `src/client/stores/bot-store.ts:392-403`, migrated to per-channel storage.
- Existing `useEffect` + interval patterns in `src/client/hooks/use-channel-statuses.ts`.

**Test scenarios:**
- **Happy path:** Selecting the channels tab fetches per-channel status for the selected bot.
- **Happy path:** Status values for `wecom` and `feishu` are passed into `BotChannelsSection`.
- **Edge case:** Status refreshes after a successful save.
- **Regression guard:** All client tests that mock `statusByBotId` — including `SettingsPanel.bots.test.tsx`, `SettingsPanel.workspace.test.tsx`, `bot-store.test.ts`, and `BotManagementPage.test.tsx` — are updated to the new channel-scoped shape and still pass.

**Verification:**
- `npm run test:client` passes, including the updated `SettingsPanel.bots.test.tsx`, `SettingsPanel.workspace.test.tsx`, `bot-store.test.ts`, and `BotManagementPage` tests.

### U3. Per-channel status UI

**Goal:** Render the connection status inside each channel card in `BotChannelsSection`.

**Requirements:** R1, R2, R3.

**Dependencies:** U2.

**Files:**
- `src/client/components/BotChannelsSection.tsx`
- `src/client/i18n/en/settings.json`
- `src/client/i18n/zh-CN/settings.json`
- `src/client/components/BotChannelsSection.test.tsx`

**Approach:**
- Extend `BotChannelsSectionProps` to accept a channel-status map such as `channelStatus?: { wecom?: ChannelStatus; feishu?: ChannelStatus }` instead of bot-scoped status props.
- Render a status row near each card header using `CHANNEL_STATUS_DOT` and `getChannelStatusLabel` from `src/client/hooks/use-channel-statuses.ts`. Wrap each status label in a `<span role="status" aria-live="polite" aria-atomic="true" aria-describedby="{channel}-error">` so assistive technologies announce status updates.
- Before the first status fetch completes, render a neutral loading state such as `Loading status…` with a subtle pulse dot; do not prematurely render `not_configured` or `disconnected`. Add an i18n key under `settings.bots` (e.g., `channelStatusLoading`).
- When the channel status is `error`, display the sanitized message from the per-channel `errors` map (or a channel-specific fallback) beneath the status row. Link the message to the status label via `aria-describedby`.
- Add channel-specific i18n keys under `settings.bots` for all status values including `not_configured` (e.g., `wecomStatusConnected`, `wecomStatusDisconnected`, `wecomStatusNotConfigured`) if the existing `workspaceTabs` keys are not semantically appropriate; otherwise reuse them.
- When a channel toggle is disabled, visually distinguish the status row by reducing opacity to ~60% **and** appending a “(disabled)” descriptor to the status label so users do not mistake an intentionally disabled channel for a broken one.

**Patterns to follow:**
- Existing `BotStatusIcon` dot/label styling in `src/client/components/BotStatusIcon.tsx` and `src/client/hooks/use-channel-statuses.ts`.
- Existing card layout in `src/client/components/BotChannelsSection.tsx`.

**Test scenarios:**
- **Happy path:** WeCom card renders the correct status label and dot for `connected`.
- **Happy path:** Feishu card renders the correct status label and dot for `error`.
- **Edge case:** When status is `error`, the card displays the sanitized error message from the `errors` map (or fallback) under the status row.
- **Edge case:** Disabled channel shows the current server-reported status (e.g., `not_configured` or `disconnected`) with a dimmed treatment and/or a “(disabled)” descriptor.

**Verification:**
- `npm run test:client` passes, including the updated `BotChannelsSection` tests.

### U4. Reconnect button and save-triggered reconnect UX

**Goal:** Add the conditional Reconnect button, wire it to the new endpoint, and show reconnecting hints after a Save that changes credentials or enables a channel.

**Requirements:** R5, R6, R9, R10, R11, R12.

**Dependencies:** U1, U2, U3.

**Files:**
- `src/client/components/bot-form-utils.ts`
- `src/client/components/BotChannelsSection.tsx`
- `src/client/components/BotManagementPage.tsx`
- `src/client/components/BotChannelsSection.test.tsx`
- `src/client/components/BotManagementPage.test.tsx`

**Approach:**
- Update `buildUpdateBotInput` in `src/client/components/bot-form-utils.ts` to emit an `enabled: false` channel config for disabled channels, preserving existing credentials via `buildSecretValue(..., original?.channelSettings[channel].secret)` so stored secrets are not erased.
- In `BotChannelsSection`, compare the current form's channel fields to the persisted snapshot to decide whether credentials are dirty for that channel.
- Show the Reconnect button only when the channel is enabled, the form is clean for that channel, and the channel status is `disconnected`. Place the button immediately to the right of the status row (or directly under it on narrow viewports) and right-align it within the card header so it stays close to the status indicator.
- On Reconnect click, disable the button and show a loading spinner while the POST is in flight. On success, refresh channel status via `fetchStatus` and return focus to the Reconnect button; on failure, surface the sanitized error message inline under the status row (or via a toast), re-enable the button, and move focus to the error message.
- In `BotManagementPage`, the page-level Save button is disabled and shows a loading state while `updateBot` and any server-side reconnect side effects are in flight. Channel credential inputs remain editable so the optimistic reconnecting/disconnecting hints can be displayed.
- After Save or Reconnect failures, present client-side feedback matched to the HTTP status: `400`/`422` show the field-level or inline error message; `429` shows a retry hint with the remaining cooldown; `5xx`/`502` shows a generic "Connection failed" message and offers a retry.
- In `BotManagementPage`, before calling `updateBot`, capture the current channel form values as a pre-save snapshot. After a successful save, compare the returned bot's channel settings to that snapshot to determine which channels had credential or toggle changes. Track those channels in a local pending-action state keyed by channel (e.g., `pendingChannelActions: Record<BotChannelKey, 'connect' | 'disconnect' | null>`) and pass it to `BotChannelsSection`.
- In `BotChannelsSection`, overlay a reconnecting hint (`Reconnecting…`) on channels whose pending action is `connect` and a disconnecting hint (`Disconnecting…`) or no hint on channels whose pending action is `disconnect`, until polling reports a terminal channel status (`connected`, `error`, or `disconnected`). The hint must be non-blocking: place a 16px spinner plus the localized label adjacent to the status dot, keep credential inputs editable, and announce the change with `aria-live="polite"`. Add i18n keys under `settings.bots` (e.g., `channelReconnecting`, `channelDisconnecting`).

**Patterns to follow:**
- Existing dirty detection with `JSON.stringify` comparison in `src/client/components/BotManagementPage.tsx:161-168`.
- Existing `handleSaveBasic` success callback in `src/client/components/BotManagementPage.tsx:200-272`.

**Test scenarios:**
- **Happy path:** Reconnect button is shown when WeCom is disconnected and credentials are unchanged.
- **Edge case:** Reconnect button is hidden when WeCom credentials are dirty.
- **Edge case:** Reconnect button is hidden when WeCom status is `connected`, `connecting`, `error`, or `not_configured`.
- **Edge case:** Reconnect button is hidden when the channel is disabled.
- **Happy path:** Clicking Reconnect calls the reconnect endpoint and refreshes status.
- **Error path:** Reconnect endpoint returns `5xx`/`502` → Reconnect button re-enables and the card displays the sanitized error message.
- **Edge case:** Saving a change that affects both WeCom and Feishu simultaneously results in independent per-channel pending/error states; a failure on one channel does not block the optimistic hint or error display on the other.
- **Happy path:** After saving changed credentials, a reconnecting hint appears on the affected channel.
- **Happy path:** After enabling a disconnected channel, a reconnecting hint appears until status settles.
- **Happy path:** After disabling a connected channel, a disconnecting hint appears (or no optimistic hint) until status settles at `disconnected`.
- **Regression guard:** Disabling an enabled channel and saving persists `enabled: false` and triggers disconnect.

**Verification:**
- `npm run test:client` passes, including the updated `BotManagementPage` and `BotChannelsSection` tests.

---

## Verification Contract

- `npm run test:client` — all client tests pass, including new and updated tests for `BotChannelsSection` and `BotManagementPage`.
- `npm run test:server` — all server tests pass, including new tests in `src/server/routes/bots.test.ts`.
- `npm run lint` — no new lint errors.
- Manual smoke test: open Bot Settings → Channels, edit WeCom credentials, save, and observe an optimistic reconnecting hint on the WeCom card; verify polling eventually reports `connected` or `error`; verify the Reconnect button appears when the channel drops to `disconnected` with unchanged config.

---

## Definition of Done

- All requirements R1–R12 are implemented and traceable to code.
- All acceptance examples AE1–AE5 are covered by automated tests or manual verification.
- The `BotStatus` value type in `src/client/hooks/use-bot-statuses.ts` is renamed to `ChannelStatus`, the file is renamed to `src/client/hooks/use-channel-statuses.ts`, and the bot-scoped `BotStatus` aggregate interface in `src/client/stores/bot-store.ts` is deleted; no bot-level status field remains.
- Each implementation unit's test scenarios are implemented and passing.
- `npm run lint`, `npm run test:client`, and `npm run test:server` all pass.
- No regressions in existing bot settings behavior (save/cancel dirty detection, member management, role/persona sections).
- Any experimental or dead-end code from the implementation process is removed before the final diff.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Secret sentinel handling (`true` for unchanged secrets) could cause false credential-change detection if not resolved to effective values. | Compare effective persisted credentials, not raw payload values, in the server-side change detection. |
| Rapid save/reconnect cycles could create stale connection state if disconnect handlers unconditionally clear the active connection. | Apply connection-identity guards in teardown handlers (KTD5). |
| 5-second polling may feel slow after a reconnect. | Use optimistic `reconnectingChannels` state in the UI until polling reflects the new status. |
| `updateConnectionForBot` is routing-only; relying on it for credential changes would silently fail. | Use disconnect+connect for credential changes (KTD4). |
| Reconnect endpoint follows the same bot-route authorization model (`systemActor()`) without per-route owner/admin checks. | Documented as out-of-scope; treat as residual risk. If the project later requires fine-grained bot permissions, apply the same owner/admin middleware consistently across all bot routes, not just this endpoint. |

---

## Appendix: Research Notes

- `src/client/components/BotChannelsSection.tsx` renders WeCom/Feishu cards with enable toggles and credential inputs.
- `src/client/hooks/use-channel-statuses.ts` (renamed from `use-bot-statuses.ts`) defines `ChannelStatus` and the dot/label styling used by `WorkspaceTabs`; the workspace-scoped polling hook is not reused here.
- `src/client/components/BotStatusIcon.tsx` wraps the status dot language for icon-overlays in workspace tabs.
- `src/client/stores/bot-store.ts` exposes `fetchStatus(botId)` and `statusByBotId` as bot-scoped status and will be migrated to per-channel status storage.
- `src/server/routes/bots.ts:413-431` currently provides `GET /api/bots/:id/status` returning `{ status: { wecom, feishu } }`; KTD1 migrates this to return `{ wecom, feishu, errors?: { wecom?: string; feishu?: string } }` directly. Each status value is a channel status and `errors` carries a sanitized message for channels in `error`.
- `src/server/routes/bots.ts:461-489` contains `reconcileChannelConnections`, which currently skips forced reconnects when credentials change.
- `src/server/services/wecom-bot-service.ts:1127-1151` documents that `updateConnectionForBot` is routing-only and does not re-authenticate.
- Existing institutional learnings on SSE reconnects reinforce connection-identity guards and idempotent status updates.
