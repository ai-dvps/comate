---
title: 'fix: Virtualized message list cannot scroll after scroll-to-bottom button fix'
type: fix
status: completed
date: 2026-05-24
---

# fix: Virtualized message list cannot scroll after scroll-to-bottom button fix

## Summary

Commit `8ed0f56` fixed the scroll-to-bottom button visibility in `VirtualizedMessageList` by splitting a single scrollable `div` into an outer positioned wrapper and an inner scrollable container. The inner container uses `h-full` to fill the outer wrapper, but `height: 100%` on a child of a flex item (`flex-1` → `flex-basis: 0%`) does not reliably resolve to the parent's grown height, causing the scrollable area to collapse to zero and making the message list unscrollable.

Replace `h-full` with `absolute inset-0` on the inner scroll container so it fills the outer `relative` div regardless of flex sizing quirks, restoring scroll while keeping the button fixed in the viewport.

## Requirements

- R1. The virtualized message list is scrollable when message content exceeds the viewport height.
- R2. The scroll-to-bottom button remains visible and stationary when the user scrolls up.
- R3. Auto-scroll to bottom on new messages continues to work when the user is already at the bottom.
- R4. The fix does not regress the non-virtualized message list path or the empty-state path.

## Scope Boundaries

- **In scope:** The single className change in `VirtualizedMessageList.tsx` and manual verification in the dev server.
- **Out of scope:** Restructuring `MessageList.tsx`, changing `ChatPanel.tsx` layout, adding automated component tests, touching the non-virtualized `StickToBottom` path.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/VirtualizedMessageList.tsx` — The regression is at line 330: `<div ref={parentRef} className="h-full overflow-y-auto">`. The `h-full` utility (`height: 100%`) expects a parent with a definite height. The immediate parent has `flex-1` (`flex: 1 1 0%`), which does not provide a definite content-box height until after flex layout completes; in some browsers / container conditions the child resolves `100%` to `0` and the scroll container collapses.
- `src/client/components/ChatPanel.tsx` — Renders `<MessageList>` inside `flex-1 overflow-hidden flex flex-col`. The flex container is height-constrained, but the intermediate `flex-1` on `VirtualizedMessageList`'s outer div still leaves the inner `h-full` vulnerable to flex-basis resolution issues.
- `src/client/components/ai-elements/conversation.tsx` — `StickToBottom` (non-virtualized path) uses `relative flex-1 overflow-y-auto` as a single element; the library handles the scroll-to-bottom button internally. The virtualized path cannot use `StickToBottom` because `@tanstack/react-virtual` needs direct control of the scroll element ref.

### Root Cause

The two-layer pattern (outer `relative`, inner scrollable) is correct for keeping an absolutely positioned button in the viewport. The mistake was using `h-full` on the inner layer instead of `absolute inset-0`. `h-full` relies on the parent's computed height; `absolute inset-0` is positioned relative to the nearest positioned ancestor (the outer `relative` div) and fills it unconditionally.

## Key Technical Decisions

- **Use `absolute inset-0` instead of `h-full`.** This is the standard CSS pattern for a scrollable region inside a positioned container. It avoids flex-basis height resolution issues entirely.
- **Keep the two-layer structure.** The outer `relative flex-1` div and the inner scrollable div are the right architecture; only the sizing of the inner div is wrong.
- **Do not add `overflow-hidden` to the outer div.** The outer div already has `relative`, which establishes a containing block for the absolutely positioned child. Adding `overflow-hidden` is unnecessary and could clip focus rings or shadows.

## Implementation Units

### U1. Fix inner scroll container sizing in VirtualizedMessageList

**Goal:** Replace `h-full` with `absolute inset-0` on the inner scroll container so it fills the outer positioned wrapper and restores scrolling.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None.

**Files:**
- Modify: `src/client/components/VirtualizedMessageList.tsx`

**Approach:**
- On the inner scroll container (line 330), change `className="h-full overflow-y-auto"` to `className="absolute inset-0 overflow-y-auto"`.
- Leave the outer div (`relative flex-1`), the scroll-to-bottom button, and all other logic unchanged.

**Patterns to follow:**
- The two-layer positioned-container pattern used elsewhere in the codebase (e.g., modal overlays, drawer backdrops) where an outer `relative` wrapper contains an inner `absolute inset-0` scrollable surface.

**Test scenarios:**
- Happy path (scroll up and down): open a session with more than 50 messages (triggers virtualization) → scroll up with mouse wheel / trackpad → the list scrolls smoothly and earlier messages become visible; scroll back down → the latest messages are visible.
- Happy path (scroll-to-bottom button): scroll up in a long virtualized session → the down-arrow button appears centered near the bottom and stays fixed while scrolling; clicking it jumps to the latest message.
- Happy path (auto-scroll): with the view at the bottom, send a new message → the view auto-scrolls to the bottom as the assistant response streams in.
- Edge case (short session under threshold): open a session with fewer than 50 messages → the non-virtualized `StickToBottom` path renders and scroll behavior is unchanged.
- Edge case (empty session): open a brand-new session with zero messages → the empty state renders correctly and is not broken.
- Visual regression: no double scrollbars, no layout shift, no clipped content at the top or bottom of the message list.

**Verification:**
- All six test scenarios pass in a manual dev-server run.
- No console errors during scroll, session switch, or streaming.
- Project lint and type-check pass with no new violations.

## Sources & References

- Introducing commit: `8ed0f56 fix(ui): Keep scroll-to-bottom button visible in virtualized message list`
- Related prior plan: `docs/plans/2026-05-16-007-fix-session-message-list-scroll-plan.md`
