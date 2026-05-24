---
date: 2026-05-24
topic: workspace-tab-overflow
---

# Workspace Tab Overflow Handling

## Summary

When many workspaces are open, workspace tabs overflow the available header width. Handle overflow with a dropdown menu so the main window never shows scrollbars and the top-right toolbar remains always visible.

## Problem Frame

The workspace tab row grows horizontally as more workspaces are opened. Currently this can push the header toolbar off-screen or cause the main window to show a horizontal scrollbar. The user expects:
- Zero scrollbars on the main window in any direction
- The top-right toolbar (settings, theme toggle, create workspace) always visible
- All open workspaces accessible without scrolling the window

## Requirements

**R1. No main window scrollbars**
The application window must never display a horizontal or vertical scrollbar at the window level. (see origin)

**R2. Toolbar always visible**
The header toolbar (settings, theme toggle, create workspace button, user avatar) must always be fully visible regardless of how many workspaces are open. (see origin)

**R3. Overflow dropdown**
When open workspace tabs do not fit in the available header space, excess tabs are hidden and accessible through an overflow dropdown triggered by a `+N` or `...` button. (see origin)

**R4. Status-aware visibility priority**
Tabs with active status indicators (needs-me, streaming, unread, bot error) are always kept in the visible tab row. Only tabs with no active status may be moved to the overflow dropdown. (see origin)

**R5. Aggregate overflow badge**
If any tab hidden in the overflow dropdown has an active status indicator, the overflow trigger button displays an aggregate indicator (dot or count) so the user knows hidden tabs need attention. (see origin)

**R6. Dropdown preserves tab metadata**
Each item in the overflow dropdown displays the workspace name, close button, and all status indicators (needs-me count, unread count, streaming count, bot status) that would appear on the visible tab pill. (see origin)

## Success Criteria

- Opening 10+ workspaces does not produce a window scrollbar
- The header toolbar is never pushed off-screen or clipped
- All open workspaces remain accessible in one click (either directly visible or via dropdown)
- A workspace with a pending approval indicator is either visible in the tab row or discoverable via the overflow button's aggregate badge
- The dropdown can be used to switch to or close any hidden workspace

## Scope Boundaries

- No changes to workspace switcher (the dropdown for all workspaces, not just open ones)
- No changes to how status indicators are calculated
- No changes to tab styling for visible tabs
- No minimum window width changes

## Key Decisions

- **Dropdown over scroll:** A dropdown menu is more discoverable than a hidden-scrollbar scroll area for desktop users with a mouse. Both approaches hide tabs off-screen, but the dropdown provides explicit UI indicating hidden content exists.
- **Priority visibility for active tabs:** Tabs with status indicators must stay visible because the indicator is the user's signal that action is needed. Moving them to a dropdown would hide the signal.
