---
title: "feat: Add Feishu icon to workspace tabs and session items"
type: feat
date: 2026-06-22
---

# feat: Add Feishu icon to workspace tabs and session items

## Summary

Surface the Feishu bot icon next to the existing WeCom indicator: a status-dot icon on each workspace tab (polling the existing Feishu status endpoint) and an icon replacing the text badge on Feishu-sourced session rows. The asset `public/feishu-icon.svg` already exists; this plan wires it into the two UI surfaces, mirroring WeCom.

## Problem Frame

WeCom bot status is already visible in two places — a status-dot icon on the workspace tab and a small icon on WeCom-sourced session rows. Feishu integration shipped without parity: the workspace tab shows no Feishu indicator at all, and Feishu sessions use a text "Feishu" badge instead of an icon. Users managing Feishu-enabled workspaces cannot tell at a glance whether the Feishu bot is connected, and the session row treatment is inconsistent with WeCom. This plan closes that parity gap by reusing the established WeCom pattern.

---

## Requirements

R1. A workspace tab whose `settings.feishuBotEnabled` is true renders the Feishu icon with a colored status dot, mirroring the WeCom tab indicator (icon, status dot overlay, hover title).

R2. The tab Feishu status reflects the value returned by `GET /api/workspaces/:id/feishu/status`, polled on the same cadence as WeCom (every 5s), and clears when the workspace is no longer Feishu-enabled or no longer open.

R3. The Feishu status union includes `connecting` (a state WeCom does not have); it maps to a distinct, non-error visual rather than being silently dropped.

R4. A session whose `source === 'feishu'` renders the Feishu icon on the metadata/timestamp row (the same row the WeCom icon was moved to), and no longer renders the top-row "Feishu" text badge.

R5. All new user-facing strings exist in both `en` and `zh-CN` locales; the existing `chat:feishuBotSession` key is reused for the session-row tooltip rather than duplicated.

R6. Both bot indicators can coexist on one workspace tab: a workspace with both `wecomBotEnabled` and `feishuBotEnabled` shows both icons. A session row renders at most one bot indicator, because a session has exactly one source — no mutual-exclusion gating is needed at the row level.

---

## Key Technical Decisions

- **Generalize the WeCom status maps rather than duplicate them.** `BotStatus`, `BOT_STATUS_CLASS`, and `BOT_STATUS_DOT` in `WorkspaceTabs.tsx` are WeCom-hardcoded today. Extract a small `BotStatusIcon` presentational helper (`{ iconSrc, alt, status, title }`) and add `'connecting'` to the shared status union. This serves both bots from one code path and avoids three copies of the icon+dot block. Rationale: research found the maps are the only thing standing between "mirror WeCom" and "duplicate WeCom"; one parameterized helper is the lower-debt choice and matches the per-workspace bot-config consolidation precedent.

- **`connecting` maps to `opacity-100` + a blue status dot.** Feishu's `connecting` is an active, in-flight state (adapter handshake), not an error or an absence of config. Treat it as active-liveliness with Feishu's brand-blue dot (`bg-blue-500`) so it reads as "working" rather than "broken." It gets its own tooltip key. Rationale: collapsing it to `disconnected`/`not_configured` would dim/grayscale an active connection and mislead users.

- **Add Feishu-prefixed tab-tooltip keys; do not repurpose the WeCom ones.** The existing `workspaceTabs.botConnected` strings are WeCom-branded in both locales. Repurposing them to generic "Bot connected" would be scope creep with re-translation risk. Add a parallel `workspaceTabs.feishuBotConnected / Disconnected / Error / NotConfigured / Connecting` set in both locales. Rationale: lowest-risk mirror; preserves existing WeCom strings untouched.

- **Reuse `chat:feishuBotSession` for the session-row tooltip.** The key already exists in both locales and is already wired to the current Feishu badge. No new session-row string is needed. Rationale: avoids a duplicate key for the same concept.

- **Session-row Feishu indicator moves to the metadata row.** Commit history recently relocated the WeCom icon to the timestamp/metadata row for alignment; leaving the Feishu badge on the title row would re-introduce the asymmetry that move fixed. Convert the badge to an icon in the same row.

---

## Implementation Units

### U1. Feishu status indicator on workspace tabs

**Goal:** Render a Feishu status-dot icon on tabs for Feishu-enabled workspaces, polled from the existing status endpoint, sharing the WeCom status-display mechanism.

**Requirements:** R1, R2, R3, R6

**Dependencies:** none

**Files:**

- `src/client/components/WorkspaceTabs.tsx` — modify
- `src/client/i18n/en/settings.json` — modify (add Feishu tab-tooltip keys)
- `src/client/i18n/zh-CN/settings.json` — modify (add Feishu tab-tooltip keys)
- `src/client/components/WorkspaceTabs.test.tsx` — create

**Approach:**

- Extend the local `WorkspaceItem.settings` interface to include `feishuBotEnabled?: boolean` (it currently only declares `wecomBotEnabled`).
- Add `'connecting'` to the shared `BotStatus` union and extend `BOT_STATUS_CLASS` (`connecting` → `opacity-100`) and `BOT_STATUS_DOT` (`connecting` → `bg-blue-500`).
- Extract a `BotStatusIcon` helper component (`{ iconSrc, alt, status, title }`) that renders the `<img>` plus the absolutely-positioned status dot. Replace the two existing inline WeCom icon+dot blocks (tab pill and dropdown row) with calls to it, then add parallel Feishu calls gated on `feishuBotEnabled`.
- Add a second polling effect (or extend the existing one) that fetches `/api/workspaces/${id}/feishu/status` for Feishu-enabled open workspaces on the same 5s interval, storing results in a `feishuBotStatuses` record. Clear statuses when no Feishu-enabled workspaces remain open, mirroring the WeCom effect's early return.
- Pass `feishuBotStatus` and a Feishu-branded title (from the new `workspaceTabs.feishuBot*` keys) into `TabPill` and the dropdown row alongside the existing WeCom props.
- Add the five `workspaceTabs.feishuBotConnected / Disconnected / Error / NotConfigured / Connecting` keys to both locale files, branded "Feishu bot …" / "飞书机器人…".

**Patterns to follow:** the existing WeCom polling effect and `BOT_STATUS_*` maps in `WorkspaceTabs.tsx`; the `cn()` utility for conditional classes; the `<img src="/…-icon.svg">` public-asset pattern.

**Test scenarios:**

- Happy path: a Feishu-enabled workspace with status `connected` renders the Feishu icon (`alt="Feishu"`) with a green status dot and the connected tooltip title.
- Both bots: a workspace with both `wecomBotEnabled` and `feishuBotEnabled` renders both icons.
- `connecting` state: status `connecting` renders the icon at full opacity with a blue dot and the connecting title (not dimmed, not warning-colored).
- Absence: a workspace without `feishuBotEnabled` renders no Feishu icon, even when other tabs are Feishu-enabled.
- Polling lifecycle: the fetch hits `/api/workspaces/:id/feishu/status` on mount and clears the status when the workspace is disabled/closed (assert the effect's cleanup, e.g., no lingering status after disable).

**Verification:** With a Feishu-enabled workspace open, the tab shows the Feishu icon whose dot color tracks the real bot status reported by `/api/workspaces/:id/feishu/status`; enabling both bots shows both icons side by side.

---

### U2. Feishu icon on session list items

**Goal:** Replace the Feishu text badge with the Feishu icon on the metadata row, matching the WeCom session-row treatment.

**Requirements:** R4, R5, R6

**Dependencies:** none

**Files:**

- `src/client/components/SessionListItem.tsx` — modify
- `src/client/components/SessionList.test.tsx` — modify

**Approach:**

- Remove the top-row Feishu text badge block (`session.source === 'feishu'` `<span>Feishu</span>`).
- Add a Feishu `<img src="/feishu-icon.svg" alt="Feishu" className="w-3 h-3 flex-shrink-0" title={t('feishuBotSession')} />` in the metadata/timestamp row, adjacent to the existing WeCom icon block. Both are gated on their respective `session.source` and render independently.
- Reuse the existing `chat:feishuBotSession` key for the title; no new i18n key.

**Patterns to follow:** the existing WeCom icon block in `SessionListItem.tsx` (same classes, same `title` pattern, same row).

**Test scenarios:**

- Happy path: a session with `source === 'feishu'` renders the Feishu icon (query by `alt="Feishu"`); the top-row "Feishu" text badge is absent.
- WeCom parity (retroactive coverage): a session with `source === 'wecom'` renders the WeCom icon (`alt="WeCom"`).
- Default source: a session with `source === 'gui'` (or unset) renders neither bot icon.
- Coexistence is not applicable at the row level (a session has one source), but assert only the matching source's icon appears.

**Verification:** A Feishu-sourced session shows the Feishu icon on the metadata row with the "Feishu bot session" / "飞书机器人会话" tooltip; no "Feishu" text badge remains on the title row.

---

## Scope Boundaries

### Deferred to Follow-Up Work

- Generalizing the session-row bot icon into a shared helper (the two-bot inline blocks are small enough that extraction is not worth it here; revisit if a third bot source is added).
- Adding a dedicated accessibility pass for the tab indicator cluster (current WeCom indicator uses `img alt` + `title` only; consistent but not a full a11y audit).
- Repurposing the WeCom-branded `workspaceTabs.bot*` keys to generic "Bot …" wording — out of scope; this plan adds parallel Feishu keys instead.

### Out of scope

- Any change to Feishu backend status semantics, the `/feishu/status` route, or `feishu-bot-service.ts`. The plan consumes the existing status values only.
- Changes to the Settings panel Feishu status display (`SettingsPanel.tsx` already shows Feishu status textually).
- The broader Feishu/Lark integration feature; this plan is UI-parity only.

---

## Risks & Dependencies

- **`connecting` is Feishu-only.** If future bots also report transient states, the shared union already accommodates it; the blue-dot mapping is Feishu-branded by coincidence (brand color), so revisit if a second bot wants a distinct transient color.
- **Polling cost doubles when both bots are enabled.** Each Feishu-enabled open tab adds one 5s fetch. Acceptable for the typical few-open-tabs usage; the WeCom effect already established this cadence as the product's tolerance.

---

## Sources / Research

- WeCom tab indicator and status maps: `src/client/components/WorkspaceTabs.tsx` (polling effect, `BOT_STATUS_CLASS`, `BOT_STATUS_DOT`, `WorkspaceItem.settings`).
- WeCom + Feishu session-row badges: `src/client/components/SessionListItem.tsx`.
- Feishu status values and endpoint: `src/server/services/feishu-bot-service.ts` (`FeishuBotStatus` includes `connecting`), `src/server/routes/workspaces.ts` (`GET /:id/feishu/status`).
- Existing i18n keys: `chat:feishuBotSession` in `src/client/i18n/{en,zh-CN}/chat.json`; WeCom-branded `workspaceTabs.bot*` in `src/client/i18n/{en,zh-CN}/settings.json`.
- Test convention: `src/client/components/SessionList.test.tsx` (Vitest + Testing Library + `I18nextProvider` + mock store); no existing `WorkspaceTabs.test.tsx`.
- Precedent: workspace/session status-indicator brainstorm and the WeCom-config-into-workspace-tab consolidation establish bot config as per-workspace and the tab indicator cluster as stable surface to mirror.
