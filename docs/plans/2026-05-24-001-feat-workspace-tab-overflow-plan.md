---
title: "feat: Workspace Tab Overflow Dropdown"
type: feat
status: active
date: 2026-05-24
origin: docs/brainstorms/2026-05-24-workspace-tab-overflow-requirements.md
---

# feat: Workspace Tab Overflow Dropdown

## Summary

When many workspaces are open, workspace tabs overflow the available header width and can push the toolbar off-screen or trigger a window scrollbar. Constrain the tab container so it shrinks within the header flex layout, measure tab widths at runtime, and move overflow tabs into a `+N` dropdown. Tabs with active status indicators (needs-me, streaming, unread, bot error) are prioritized to stay visible.

---

## Problem Frame

The workspace tab row in `WorkspaceTabs` grows horizontally without bound. The header's left section has `flex-shrink-0`, so it pushes the middle spacer and right toolbar instead of shrinking. The result: the toolbar can be clipped or the window shows a horizontal scrollbar when many workspaces are open. (see origin)

---

## Requirements

**R1. No main window scrollbars** — The window must never show a horizontal or vertical scrollbar. (see origin)

**R2. Toolbar always visible** — The header toolbar must never be clipped or pushed off-screen. (see origin)

**R3. Overflow dropdown** — Excess tabs hide behind a `+N` button that opens a dropdown with hidden tabs. (see origin)

**R4. Status-aware visibility priority** — Tabs with active status indicators stay visible; only inactive tabs may overflow. (see origin)

**R5. Aggregate overflow badge** — The `+N` button shows a warning dot when any hidden tab has a status indicator. (see origin)

**R6. Dropdown preserves tab metadata** — Each dropdown item shows the workspace name, status indicators, and close button. (see origin)

---

## Key Technical Decisions

- **Hidden measurement container for widths:** A `position: absolute; invisible` flex container renders all tabs off-screen so their widths can be measured via `offsetWidth`. This avoids layout oscillation that would occur if we measured visible tabs and then removed them from the DOM.
- **ResizeObserver on both containers:** Observe the visible tab container (catches window resize) and the measurement container (catches tab content changes like status indicators appearing) to recalculate overflow.
- **Priority-based greedy fit:** Sort tabs by priority (active > has-status > inactive), then greedily pack them left-to-right until space runs out. Remaining tabs go to overflow. This is simple, stable, and guarantees high-priority tabs are always visible if they physically fit.
- **Dropdown follows WorkspaceSwitcher pattern:** Absolute-positioned panel with click-outside and Escape-to-close, matching the existing switcher dropdown for visual consistency.

---

## Implementation Units

### U1. Constrain tab container in header layout

**Goal:** Allow the tab area to shrink within the header flex layout so the toolbar never gets pushed.

**Requirements:** R1, R2

**Files:**
- `src/client/App.tsx`

**Approach:**
- Remove `flex-shrink-0` from the header's left section container so it can shrink.
- Add `flex-shrink-0` to the logo container and the `WorkspaceSwitcher` wrapper so only the tab area shrinks.
- Wrap `<WorkspaceTabs />` in a `<div className="min-w-0 overflow-hidden">` so the tab container can shrink below its content width and clip overflow.

**Test scenarios:**
- **Happy path:** Open 10 workspaces; the header toolbar remains fully visible and no window scrollbar appears.
- **Edge case:** At the minimum window width (800px), the toolbar is still visible with multiple tabs open.

**Verification:**
- Resize the window to 800px with 6+ workspaces open; toolbar is not clipped.

---

### U2. Add overflow detection, priority logic, and dropdown

**Goal:** Measure tab widths, determine which tabs fit, hide the rest in a dropdown with full metadata.

**Requirements:** R3, R4, R5, R6

**Dependencies:** U1

**Files:**
- `src/client/components/WorkspaceTabs.tsx`

**Approach:**
1. **Measurement:** Render a hidden absolute container (`aria-hidden`) with all tabs. After each render, read `offsetWidth` from each tab via `data-tab-id` and store widths in a ref.
2. **Overflow calculation:** In a `useLayoutEffect`, read the visible container's `clientWidth`, subtract the overflow button width (~48px) when needed, and greedily fit tabs in priority order (active > status > inactive). Store overflow IDs in state.
3. **ResizeObserver:** Attach observers to both the visible container and the measurement container. Recalculate on resize or when tab content changes.
4. **Overflow button:** Render a `+N` button when `overflowIds.size > 0`. Show a `bg-warning` dot when any hidden tab has a status indicator.
5. **Dropdown:** Render an absolute dropdown below the overflow button following the `WorkspaceSwitcher` pattern. Each item shows the folder icon, workspace name, all status indicators, and a close button. Clicking an item switches to that workspace; clicking the close button removes it.
6. **Click-outside / Escape:** Close the dropdown when clicking outside or pressing Escape, matching the existing switcher behavior.

**Patterns to follow:**
- Match `WorkspaceSwitcher.tsx` for dropdown markup, positioning, and close behavior.
- Keep existing tab pill styling and status indicator rendering unchanged for visible tabs.

**Test scenarios:**
- **Happy path:** Open 8 workspaces. The first N that fit are visible; the rest are in the `+N` dropdown. Clicking a dropdown item switches workspaces.
- **Happy path (priority):** Open 6 workspaces where workspace #5 has a `needs-me` indicator but workspace #3 does not. Resize until only 4 tabs fit. Workspace #5 stays visible; workspace #3 moves to the dropdown.
- **Happy path (badge):** A hidden tab has a `needs-me` indicator. The `+N` button shows a warning dot.
- **Edge case:** Close the last visible tab via its X button; the next tab from the dropdown should automatically become visible.
- **Edge case:** Close a hidden tab from the dropdown; the dropdown count decrements and the tab is removed.
- **Edge case:** At minimum window width with 2 workspaces open, both tabs fit and no overflow button appears.

**Verification:**
- Open 10 workspaces, resize the window, verify toolbar stays visible and all tabs are accessible.
- Verify that a workspace with `needs-me` is either visible or triggers the overflow button dot.
- Verify dropdown items have correct status indicators and close buttons.

---

## Scope Boundaries

- No changes to workspace switcher (the all-workspaces dropdown).
- No changes to how status indicators are calculated.
- No changes to visible tab styling.
- No minimum window width changes.

## Dependencies / Assumptions

- `ResizeObserver` is available in the Tauri webview (supported in all modern webviews).
- The tab pill styling (`tab-pill` class) does not change width dynamically after initial render except for status indicators appearing/disappearing.
- The overflow button width is approximately 48px; a small conservative estimate is acceptable.
