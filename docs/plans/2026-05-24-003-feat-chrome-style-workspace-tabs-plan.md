---
title: "feat: Chrome-Style Scrollable Workspace Tabs"
type: feat
status: completed
date: 2026-05-24
origin: docs/brainstorms/2026-05-24-workspace-tab-overflow-requirements.md
---

# feat: Chrome-Style Scrollable Workspace Tabs

## Summary

Replace the priority-based tab overflow logic in `WorkspaceTabs` with a Chrome-style scrollable tab bar: all open tabs always visible in original order, horizontally scrollable with a hidden scrollbar, and a persistent dropdown quick-switcher with search.

---

## Problem Frame

The current `WorkspaceTabs` component uses priority-based overflow: tabs are reordered by priority (active, then status indicators, then normal), measured at runtime with a hidden container and `ResizeObserver`, and excess tabs are hidden behind a conditional `+N` dropdown. This can leave only the active tab visible, breaking spatial memory and making it hard to see which workspaces are open. The measurement logic is complex and has already required one fix for an infinite loop.

A scrollable tab bar eliminates the need for runtime width measurement and priority reordering, matching the Chrome browser mental model.

---

## Requirements

- R1. All open workspace tabs are always rendered in the visible tab bar. (see origin)
- R2. Tabs are displayed in their original `openWorkspaceIds` order. No priority-based reordering. (see origin)
- R3. When the total tab width exceeds the container width, the tab bar scrolls horizontally. (see origin)
- R4. The horizontal scrollbar is visually hidden, but scrolling works via mouse wheel, trackpad, and programmatic control. (see origin)
- R5. When a tab is activated, the tab bar automatically scrolls to bring that tab into view. (see origin)
- R6. A persistent dropdown button is always visible on the right side of the tab bar, regardless of tab count. (see origin)
- R7. The dropdown lists all open tabs with workspace name, status indicators, and close button. (see origin)
- R8. The dropdown includes a search/filter input. Typing filters the list. (see origin)
- R9. Selecting a tab from the dropdown activates that workspace and scrolls the tab bar to it. (see origin)

**Origin acceptance examples:** AE1 (covers R1, R3, R4), AE2 (covers R5), AE3 (covers R7, R8, R9)

---

## Scope Boundaries

- No changes to tab pill styling (colors, borders, shapes) beyond scroll behavior.
- No changes to how status indicators are calculated or displayed within a tab pill.
- No drag-to-reorder functionality.
- No changes to the workspace switcher (the all-workspaces dropdown).
- No multi-row or wrapping tab layout.

### Deferred to Follow-Up Work

- Tab drag-to-reorder: would require rethinking `openWorkspaceIds` ordering and is not needed for the overflow redesign.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/WorkspaceTabs.tsx` — Main component to redesign. Currently contains the priority-based overflow logic, hidden measurement container, `ResizeObserver`, and conditional `+N` dropdown.
- `src/client/App.tsx` — Header layout. The tab area is wrapped in `<div className="min-w-0">` within a flex row. This structure is preserved; the scrollable container lives inside `WorkspaceTabs`.
- `src/client/components/WorkspaceSwitcher.tsx` — Dropdown pattern to follow for click-outside and Escape-to-close behavior.
- `src/client/components/CommandPicker.tsx` and `src/client/components/FilePicker.tsx` — Use `scrollIntoView({ block: 'nearest' })` for keyboard navigation; same pattern applies for programmatic scroll-to-tab.
- `src/client/components/ui/popover.tsx` — Radix Popover primitive available, though the current dropdown is custom.
- `src/client/i18n/en/settings.json` and `src/client/i18n/zh-CN/settings.json` — Existing `workspaceTabs` keys include `hiddenTabs`, `noHiddenTabs`, `closeTab`, and bot status labels.

### Institutional Learnings

- `docs/plans/2026-05-24-001-feat-workspace-tab-overflow-plan.md` — The prior plan implemented the priority-based overflow approach that this plan replaces. The hidden measurement container and `ResizeObserver` pattern was used there but is no longer needed with a scroll container.
- `docs/plans/2026-05-16-007-fix-session-message-list-scroll-plan.md` — Fix at the shared wrapper level, not consumers. For scroll behavior, ensure the correct element has `overflow` set.
- No existing `docs/solutions/` entries for tab overflow or scrolling patterns.

---

## Key Technical Decisions

- **Scroll container replaces measurement logic:** A simple `overflow-x-auto` container with hidden scrollbar eliminates the entire `ResizeObserver` + hidden measurement container + priority-sorting calculation. This removes a significant source of complexity and the infinite-loop risk.
- **Tab pills use `flex-shrink-0`:** Tabs maintain their natural content width and the container scrolls when they overflow. This is simpler than proportional shrinking + scroll hybrid and matches Chrome's behavior.
- **Dropdown remains custom (not Radix Popover):** The existing custom dropdown in `WorkspaceTabs` already handles click-outside and Escape correctly. Switching to Radix would add a dependency without meaningful benefit for this change.
- **`scrollIntoView` for programmatic scroll:** The browser-native `scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })` is sufficient and matches the pattern already used in `CommandPicker` and `FilePicker`.

---

## Open Questions

### Resolved During Planning

- **How to handle the old `+N` dropdown button?** Replace with a persistent button that always shows. Use a chevron-down or list icon to indicate it's a quick-switcher, not an overflow count.

### Deferred to Implementation

- **Exact dropdown button icon/label:** Decide between a chevron, a list icon, or a tab-count badge during implementation based on visual fit with the header toolbar.

---

## Implementation Units

### U1. Replace overflow logic with scrollable tab bar

**Goal:** Remove the priority-based overflow system and replace it with a horizontally scrollable tab container that always renders all tabs in original order.

**Requirements:** R1, R2, R3, R4

**Files:**
- Modify: `src/client/components/WorkspaceTabs.tsx`

**Approach:**
1. Remove the hidden measurement container (`measureRef`), `ResizeObserver` setup, overflow calculation `useEffect`, and all `overflowIds` state.
2. Remove the priority-sorting logic and the `visibleWorkspaces` / `hiddenWorkspaces` split. Render all `openWorkspaces` directly.
3. Replace the visible tabs container (`visibleRef`) with a scrollable container: `overflow-x-auto` combined with `scrollbar-hide` styling.
4. Give each tab pill `flex-shrink-0` so they maintain natural width and drive container overflow.
5. Keep the bot status polling `useEffect` and `getWorkspaceCounts` helper unchanged — they are independent of overflow logic.

**Patterns to follow:**
- Match existing tab pill markup and styling (colors, hover states, status indicators, close button behavior).

**Test scenarios:**
- **Happy path:** Open 8 workspaces. All 8 tabs are visible in the tab bar. The container shows no scrollbar but scrolls horizontally with mouse wheel.
- **Happy path:** Open 3 workspaces. All tabs fit without scrolling. No scrollbar appears.
- **Edge case:** Close a workspace from the middle of the tab bar. Remaining tabs stay in original order and the scroll position adjusts naturally.

**Verification:**
- Open 10+ workspaces and verify all tabs are visible in the bar, reachable via horizontal scroll.
- Verify no horizontal scrollbar is visible at any window width.

---

### U2. Add programmatic scroll-to-active-tab

**Goal:** When a tab is activated (via click or dropdown selection), the scrollable tab bar automatically brings that tab into view.

**Requirements:** R5

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/WorkspaceTabs.tsx`

**Approach:**
1. Add a ref to the active tab pill (e.g., `activeTabRef`).
2. In a `useEffect` keyed on `activeWorkspaceId`, call `activeTabRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })`.
3. Ensure the effect also fires when a tab is activated from the dropdown (same `activeWorkspaceId` change path).

**Patterns to follow:**
- `CommandPicker.tsx` and `FilePicker.tsx` use `scrollIntoView({ block: 'nearest' })` for keyboard navigation.

**Test scenarios:**
- **Happy path:** Scroll the tab bar so the active tab is off-screen, then activate a different tab via dropdown. The tab bar smoothly scrolls to bring the newly active tab into view.
- **Edge case:** The active tab is already fully visible. Calling `scrollIntoView` does not cause jarring movement.
- **Edge case:** Close the active workspace. The workspace store focuses the last-opened workspace; the tab bar scrolls to that newly active tab.

**Verification:**
- Activate a workspace from the dropdown that is off-screen. The tab bar scrolls to reveal it.

---

### U3. Redesign dropdown as persistent quick-switcher with search

**Goal:** Replace the conditional `+N` overflow dropdown with a persistent quick-switcher button that always shows. Add a search input to filter open tabs.

**Requirements:** R6, R7, R8, R9

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/WorkspaceTabs.tsx`
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:**
1. Replace the conditional `overflowIds.size > 0 && (...)` dropdown button with a persistent button always rendered on the right side of the tab bar.
2. Use a down-chevron or list icon (e.g., `ChevronDown` or `List` from `lucide-react`) instead of `+N` text.
3. Inside the dropdown panel, add a search input at the top. Use a `useState` query string to filter `openWorkspaces` by name.
4. The dropdown list renders filtered results. Each item shows workspace name, status indicators, bot status, and close button — same as the current dropdown items.
5. Clicking an item calls `setActiveWorkspace(id)` and closes the dropdown. The `U2` scroll effect handles bringing the tab into view.
6. Update i18n: remove `hiddenTabs` and `noHiddenTabs` keys (no longer needed). Add a `searchTabs` or `searchWorkspaces` key for the search input placeholder.

**Patterns to follow:**
- Match `WorkspaceSwitcher.tsx` for dropdown panel styling (`bg-surface`, `border-border`, `rounded-xl`, `shadow-lg`) and dismissal behavior (click outside, Escape).

**Test scenarios:**
- **Happy path:** Click the persistent dropdown button. The dropdown opens showing all open tabs.
- **Happy path (search):** Type "dev" in the search input. The list filters to tabs whose names contain "dev".
- **Happy path (select):** Click a filtered tab in the dropdown. The workspace activates, dropdown closes, and the tab bar scrolls to the selected tab.
- **Edge case:** Search returns zero results. Show an empty state message.
- **Edge case:** Close a workspace from the dropdown. The tab is removed and the dropdown list updates.

**Verification:**
- The dropdown button is visible with 1 tab open and with 10 tabs open.
- Search filters correctly and selecting a result activates the workspace.

---

## System-Wide Impact

- **Interaction graph:** `WorkspaceTabs` reads from `workspace-store` and `chat-store`. No new cross-store reads are added; existing reads are preserved.
- **State lifecycle risks:** `openWorkspaceIds` order remains the source of truth. No state shape changes.
- **Unchanged invariants:** Tab pill styling, status indicator calculation, bot status polling interval, workspace switcher behavior, and header toolbar layout all remain unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Scroll behavior feels unnatural without visible scrollbar | The hidden scrollbar is intentional per the requirements. Mouse wheel and trackpad scrolling still work. The persistent dropdown provides an alternative navigation path. |
| Tab bar scroll conflicts with Tauri drag region | The drag region is in `App.tsx` and spans the middle of the header, not the tab bar. The tab bar sits in the left section. No conflict expected. |
| Removing ResizeObserver drops overflow recalculation for status indicator changes | With all tabs always visible, status indicator changes no longer affect which tabs are shown. The tab pills simply update in place. |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-24-workspace-tab-overflow-requirements.md](docs/brainstorms/2026-05-24-workspace-tab-overflow-requirements.md)
- **Prior plan (being replaced):** `docs/plans/2026-05-24-001-feat-workspace-tab-overflow-plan.md`
- **Related code:** `src/client/components/WorkspaceTabs.tsx`, `src/client/App.tsx`, `src/client/components/WorkspaceSwitcher.tsx`
