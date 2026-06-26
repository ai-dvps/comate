---
title: feat: Distinguish active bot session icon in session list
type: feat
date: 2026-06-26
---

# Distinguish Active Bot Session Icon in Session List

## Summary

When a workspace has multiple bot sessions (WeCom / Feishu), the currently selected session's bot icon is visually identical to the inactive ones, so users can't tell at a glance which bot session they're in. This plan makes the active bot session's icon stand out and dims the inactive ones.

## Problem Frame

In `src/client/components/SessionListItem.tsx`, the bot `<img>` (WeCom/Feishu, ~lines 179–194) renders with a fixed `className` and ignores the `isActive` prop entirely. Every other active-state cue in the row already branches on `isActive` — the leading `MessageSquare` icon (`isActive ? 'text-accent' : 'text-text-tertiary'`), the row background, and the name weight — but the bot icon does not. The result is that among several bot sessions, all bot icons look the same regardless of which one is selected.

## Requirements

- R1. The active (currently selected) bot session's bot icon is visually distinct from inactive bot sessions' icons in the session list: active shows full-color with an accent ring; inactive icons are desaturated and dimmed.
- R2. The differentiation applies to both bot channels — WeCom (`source === 'wecom'`) and Feishu (`source === 'feishu'`).
- R3. Non-bot (`gui`) sessions are unaffected — no bot `<img>` is rendered for them, and this plan adds no new rendering there.
- R4. The treatment reads correctly in both light and dark themes by using existing theme tokens (`accent`) and standard Tailwind filter utilities.

## Key Technical Decisions

- KTD1 — Differentiate by dimming inactive, not by decorating active alone: At 12px (`w-3 h-3`) a ring on one icon is a weak "selected" signal; desaturating the inactive icons makes the single full-color icon pop by contrast. User-confirmed direction ("Dim inactive + accent active").
- KTD2 — Use an accent ring on the active icon (`ring-2 ring-accent`) rather than a tinted background chip: Keeps the existing trailing-metadata-row layout intact and echoes the `ring-accent` token already used in the codebase (the refresh button's focus ring in `SessionList.tsx`). Note this is a decorative selected-state ring on a static icon — a new use of the accent ring, not a mirror of the focus-ring idiom, so its visual weight at 12px is the implementer's call (KTD1).
- KTD3 — Branch the `<img>` inline in `SessionListItem` rather than extract a shared component: The change is two image tags in one file. Promoting a shared active-aware renderer (e.g., extending `BotStatusIcon` with an `isActive` prop across SessionList / WorkspaceTabs / WorkspaceSwitcher) is deferred — it isn't load-bearing here and would churn unrelated surfaces.

---

## Implementation Units

### U1. Active-aware bot icon styling in SessionListItem

- **Goal:** Make the WeCom and Feishu bot `<img>` apply active vs. inactive classes based on the existing `isActive` prop.

- **Requirements:** R1, R2, R3, R4

- **Dependencies:** None. The `isActive` prop is already threaded from `SessionList.tsx` (`isActive={session.id === activeSessionId}`) into `SessionListItem`; no store or backend change is needed.

- **Files:**
  - `src/client/components/SessionListItem.tsx` — modify the two bot `<img>` blocks (~lines 179–194)
  - `src/client/components/SessionListItem.test.tsx` — add test cases asserting the conditional classes

- **Approach:** Branch each bot `<img>` `className` through `cn()` (from `src/client/components/ui/utils.ts`). Active: full color plus an accent ring; inactive: grayscale and reduced opacity. Directional class intent — final composition (exact ring width / opacity value) is the implementer's call:

  ```
  active   -> "w-3 h-3 flex-shrink-0 ring-2 ring-accent"
  inactive -> "w-3 h-3 flex-shrink-0 grayscale opacity-40"
  ```

  Apply the same branching to both the `wecom` and the `feishu` `<img>`. Leave the `title`/`alt` attributes and the surrounding metadata-row layout untouched.

- **Implementation watch-items:**
  - `feishu-icon.svg` has an opaque white background `<rect>` while `wecom-icon.svg` is a transparent single-color glyph, so `grayscale`+`opacity-40` renders the two channels differently — verify an *inactive Feishu* row actually reads as "inactive" rather than a washed-out/broken square, and adjust the Feishu treatment (e.g. opacity-only) if it does not.
  - The bot `<img>` is decorative for selection state — confirm the active row already exposes `aria-current`/`aria-selected` (so assistive-tech users get the selection signal another way) and set `aria-hidden` on the icon if it is purely decorative.

- **Patterns to follow:**
  - Active-state branching idiom already in this file: `isActive ? 'text-accent' : 'text-text-tertiary'` (~line 92).
  - `grayscale` + `opacity-40` dimming idiom from `BOT_STATUS_CLASS` in `src/client/hooks/use-bot-statuses.ts`.
  - `ring-accent` usage in `SessionList.tsx` (~line 280, the refresh button's focus ring).

- **Test scenarios:**
  - **Active WeCom session row:** bot `<img>` carries the accent ring class and does NOT carry `grayscale`. (Covers R1, R2.)
  - **Inactive WeCom session row:** bot `<img>` carries `grayscale` + the dim opacity class and does NOT carry the accent ring.
  - **Inactive Feishu session row:** same dim treatment as the inactive WeCom case (no ring, desaturated/dimmed). (Covers R2.)
  - **Active Feishu session row:** bot `<img>` carries the accent ring class and does NOT carry `grayscale`. (Symmetric to the active WeCom case; covers R2 — guards against a copy-paste leaving the Feishu branch unconditionally inactive.)
  - **Non-bot (`gui`) session:** no bot `<img>` is present in the row — unchanged behavior. (Covers R3.)

- **Verification:** `npm run test:client` passes the new assertions. Visually in `npm run dev:client`, with two bot sessions of the same channel visible, the selected one shows a colored ring + full color while the other is dimmed — confirm in both light and dark mode. (Covers R4.)

---

## Scope Boundaries

In scope: visual styling of the bot icon in the session-list row, for both channels.

### Deferred to Follow-Up Work

- Repositioning the bot icon to a leading/avatar slot in the row. A leading position would give a stronger selected affordance, but it is a layout change; the trailing-metadata placement stays for now.
- Promoting a shared active-aware bot-icon renderer across SessionList, WorkspaceTabs, and WorkspaceSwitcher (extending `BotStatusIcon` with an `isActive` prop).
- Coordinating with the in-flight `feat+bot-session-provider-switch` branch, which touches the same row. Land this independently; resolve any merge conflict if the two land concurrently.
