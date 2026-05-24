---
date: 2026-05-24
topic: workspace-tab-overflow
---

# Workspace Tab Overflow Handling

## Summary

Redesign the workspace tab bar with a scrollable, Chrome-style layout: all open tabs are always visible in original order, shrinking proportionally as more are opened. Horizontal scrolling (with a visually hidden scrollbar) reveals tabs that overflow the container. A persistent dropdown on the right side of the tab bar lists all open tabs with search, acting as a quick-switcher. Selecting a tab from the dropdown activates it and scrolls the tab bar to bring it into view.

## Problem Frame

The current tab bar uses priority-based overflow logic: tabs are reordered by priority (active, then tabs with status indicators, then normal tabs), and excess tabs are hidden behind a conditional `+N` dropdown. This leads to a poor user experience where only the active tab may be visible, hiding all other open workspaces. Users lose spatial memory of tab order and cannot see at a glance which workspaces are open.

A Chrome-style tab bar solves this by keeping all tabs visible and using horizontal scrolling, which preserves the user's mental model of tab order and position.

## Requirements

**Tab bar rendering**

- R1. All open workspace tabs are always rendered in the visible tab bar. None are hidden or moved to an overflow container.
- R2. Tabs are displayed in their original `openWorkspaceIds` order. No priority-based reordering occurs.
- R3. Tabs shrink proportionally in width as more workspaces are opened. There is no minimum width enforcement — tabs may become very narrow at extreme counts.
- R4. When the total tab width exceeds the container width, the tab bar scrolls horizontally.
- R5. The horizontal scrollbar is visually hidden (`scrollbar-width: none` / `::-webkit-scrollbar { display: none }`), but scrolling still works via mouse wheel, trackpad, and programmatic scroll.
- R6. When a tab is activated (via click or dropdown selection), the tab bar automatically scrolls to bring that tab into view.

**Dropdown (quick-switcher)**

- R7. A persistent dropdown button is displayed on the right side of the tab bar, always visible regardless of tab count or container width.
- R8. The dropdown lists all open tabs with their workspace name, status indicators (needs-me, unread, streaming, bot status), and close button.
- R9. The dropdown includes a search/filter input. Typing filters the list to tabs whose names match the query.
- R10. Selecting a tab from the dropdown activates that workspace and triggers the tab bar to scroll to it.

## Acceptance Examples

- AE1. **Covers R1, R4, R5.** Given 10 workspaces are open in a narrow window, all 10 tabs are rendered in the tab bar. The user scrolls horizontally with the mouse wheel to see tabs at either end. No horizontal scrollbar is visible.
- AE2. **Covers R6.** Given the active tab is at the far right of a scrolled tab bar, when the user activates a tab at the far left (via click or dropdown), the tab bar scrolls smoothly to bring the newly activated tab into view.
- AE3. **Covers R8, R9, R10.** Given the dropdown is open with 8 tabs listed, when the user types "proj", the list filters to 2 matching tabs. When the user clicks one, that workspace becomes active and the tab bar scrolls to reveal it.

## Success Criteria

- Opening many workspaces never hides tabs from the tab bar — all remain visible and reachable via scroll.
- The dropdown is always accessible, regardless of how many tabs are open or how wide the window is.
- Selecting a tab from the dropdown both activates the workspace and brings its tab into view in the bar.
- No horizontal scrollbar is visible at any window width or tab count.
- Tab order matches the order in which workspaces were opened (or the order maintained by the workspace store).

## Scope Boundaries

- No changes to tab pill styling (colors, borders, shapes) beyond width and scroll behavior.
- No changes to how status indicators are calculated or displayed within a tab pill.
- No drag-to-reorder functionality.
- No changes to the workspace switcher (the dropdown for all workspaces, not just open ones).
- No multi-row or wrapping tab layout.

## Key Decisions

- **Scrollable tab bar over priority-based overflow:** A scrollable bar preserves tab order and spatial memory, matching the Chrome browser mental model. The previous priority-based approach sacrificed order for visibility of high-priority tabs.
- **Persistent dropdown over conditional overflow indicator:** The dropdown is a quick-switcher for all open tabs, not a spillover container for hidden tabs. It is always visible so users always have a searchable list of open workspaces.
- **Hidden scrollbar over visible scrollbar:** A visible scrollbar adds visual clutter. Hiding it keeps the header clean while preserving all scroll functionality via mouse wheel, trackpad, and programmatic control.
- **No minimum tab width:** Enforcing a minimum width would require hiding tabs again once the minimum is reached. Allowing tabs to shrink arbitrarily avoids re-introducing the overflow problem.

## Dependencies / Assumptions

- The tab bar container supports CSS `overflow-x: auto` with hidden scrollbar styling across target browsers.
- `Element.scrollIntoView` or equivalent is available for programmatic scroll-to-tab behavior.
- The workspace store's `openWorkspaceIds` order is the source of truth for tab order.
