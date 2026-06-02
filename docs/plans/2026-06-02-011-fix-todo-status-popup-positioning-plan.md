---
title: fix: Todo status popup positioning after scroll
type: fix
status: completed
date: 2026-06-02
origin: docs/plans/2026-05-29-006-fix-workspace-dropdown-positioning-plan.md
---

# fix: Todo status popup positioning after scroll

## Summary

Replace the hand-rolled `absolute`-positioned status dropdown in `TodoList` with the project's existing Radix UI `Popover` component. This fixes the popup drift that occurs when the todo list is scrolled, and gives automatic viewport collision detection for free.

## Problem Frame

In the todo list, clicking a status icon opens a dropdown to change the todo's status. The dropdown is implemented as a plain `<div className="absolute ...">` inside the scrollable todo list container. Because the todo item lacks `position: relative`, the `absolute` dropdown positions relative to a distant ancestor. When the user scrolls the list, the popup detaches from its trigger and appears in the wrong place.

## Requirements

- R1. The status dropdown must remain visually anchored to its trigger button after scrolling the todo list.
- R2. The fix must follow the existing `Popover` pattern established by `CommandPicker`, `FilePicker`, and the workspace dropdown migration — reusing `src/client/components/ui/popover.tsx`.

## Scope Boundaries

- Only the status dropdown in `TodoList` is in scope.
- The right-click context menu is out of scope (it uses `fixed` positioning with viewport coordinates, a different mechanism).
- No new npm dependencies; `@radix-ui/react-popover` is already installed.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/TodoList.tsx` — Contains the buggy status dropdown at lines 257-279, implemented as `absolute z-50 mt-5 ml-0` without a `relative` parent. The dropdown is toggled by `statusMenuTodoId` state.
- `src/client/components/ui/popover.tsx` — Thin wrapper around `@radix-ui/react-popover` exporting `Popover`, `PopoverTrigger`, `PopoverAnchor`, and `PopoverContent`.
- `docs/plans/2026-05-29-006-fix-workspace-dropdown-positioning-plan.md` — Prior art for the exact same class of bug: migrating hand-rolled `absolute` dropdowns to Radix `Popover`. The workspace dropdowns were fixed by the same migration pattern.
- `src/client/components/ApprovalModeToggle.tsx`, `src/client/components/ProviderSelector.tsx` — Existing consumers of the `Popover` pattern with `side`, `align`, and `sideOffset` props.

### External References

- Radix UI Popover documentation: collision detection and viewport boundary respect are enabled by default via the `avoidCollisions` prop on `Popover.Content`.

## Key Technical Decisions

- **Use `Popover` instead of patching CSS**: Adding `relative` to the todo item would fix the immediate anchor issue, but the dropdown would still be clipped by the `overflow-y-auto` list container and would lack viewport collision detection. Radix Popover portals the content to `document.body` and handles both scroll tracking and collision detection automatically.
- **Remove `statusMenuTodoId` state**: Radix Popover manages its own open/closed state via `open` / `onOpenChange`. The existing `statusMenuTodoId` string state can be replaced by a boolean per-todo or by letting Radix manage state internally. Because the dropdown is per-todo and only one can be open at a time, a controlled pattern with a single state variable is simplest.

## Implementation Units

### U1. Migrate status dropdown to Radix Popover

**Goal:** Replace the hand-rolled `absolute` status dropdown in `TodoList` with a collision-aware `Popover` so it stays anchored correctly during list scroll.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/client/components/TodoList.tsx`

**Approach:**
1. Import `Popover`, `PopoverTrigger`, and `PopoverContent` from `./ui/popover`.
2. Replace the `statusMenuTodoId` state with a `statusMenuOpen` boolean state (or keep `statusMenuTodoId` and wire it to `open` / `onOpenChange` on `Popover`).
3. Wrap the status icon button in `PopoverTrigger asChild`.
4. Replace the inline `absolute` dropdown `<div>` with `PopoverContent`, passing:
   - `side="bottom"`
   - `align="start"`
   - `sideOffset={4}`
   - The existing Tailwind classes for surface, border, shadow, and rounded corners
5. Move the status option buttons (`pending`, `done`, `discard`, `did-but-need-verify`) inside `PopoverContent`.
6. On status selection, call `changeStatus` and close the popover by clearing `statusMenuTodoId`.

**Patterns to follow:**
- `src/client/components/ApprovalModeToggle.tsx` — simple `Popover` + `PopoverTrigger` + `PopoverContent` with controlled `open` state.
- `docs/plans/2026-05-29-006-fix-workspace-dropdown-positioning-plan.md` — prior art for the same migration pattern.

**Test scenarios:**
- **Happy path:** Click a todo's status icon; the dropdown opens directly below the icon.
- **Happy path:** Select a different status from the dropdown; the todo status updates and the dropdown closes.
- **Edge case:** Open the dropdown, then scroll the todo list; the dropdown remains anchored to the status icon instead of drifting.
- **Edge case:** Open the dropdown near the bottom of the viewport; Radix collision detection flips the dropdown upward so it stays visible.
- **Integration:** Click outside the dropdown or press Escape; the dropdown dismisses without changing status.

**Verification:**
- Manual visual check: open a status dropdown and scroll the todo list; confirm the popup follows the trigger.
- Manual visual check: open the dropdown near the window edge; confirm it repositions to stay visible.

## System-Wide Impact

- **Unchanged invariants:** The todo data model, API, store methods (`changeStatus`, `updateTodo`, etc.), and all other interactions are untouched. Only the UI shell around the status dropdown changes.
- **API surface parity:** The status dropdown will behave consistently with other popover-based UI (`CommandPicker`, `FilePicker`, `ApprovalModeToggle`, `WorkspaceTabs`).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Radix Popover `z-index` stacking may differ from the current `z-50` manual dropdown, causing the panel to render underneath other UI elements. | Verify visually after migration; apply an explicit `z-50` class to `PopoverContent` if needed. |
| The dropdown currently uses `ml-0` to align with the status icon; Radix's `align="start"` may produce a slightly different visual offset. | Adjust `sideOffset` or `alignOffset` during implementation until the visual placement matches. |

## Sources & References

- **Origin document:** `docs/plans/2026-05-29-006-fix-workspace-dropdown-positioning-plan.md`
- Related code: `src/client/components/ui/popover.tsx`
- Related code: `src/client/components/ApprovalModeToggle.tsx`
- Related code: `src/client/components/ProviderSelector.tsx`
