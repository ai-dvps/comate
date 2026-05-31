---
type: fix
title: "Fix status chooser popup anchoring in TodoList"
depth: lightweight
created: 2026-05-31
status: completed
---

## Summary

The status chooser dropdown in the TodoList component uses `absolute` CSS positioning without a positioned parent container, causing it to anchor incorrectly to an ancestor further up the DOM tree rather than to the status button that triggers it.

## Problem Frame

In `src/client/components/TodoList.tsx`, each todo item has a status button that toggles a custom dropdown menu. The dropdown is rendered as an inline sibling of the button with `absolute` positioning and `mt-5 ml-0` offsets. However, the parent flex container (`<div className="flex items-start gap-2">`) does not have `relative` positioning, so the dropdown's position is computed relative to the nearest positioned ancestor — which may be the todo item container or higher — resulting in the popup appearing in the wrong location, especially when the list scrolls or the viewport changes.

## Key Technical Decisions

- **Use the existing `ui/popover` component** — The codebase already wraps Radix UI's Popover primitive (`src/client/components/ui/popover.tsx`), which handles automatic anchoring, portal rendering, click-outside dismissal, and focus management. Using this component is consistent with patterns in `ProviderSelector.tsx`, `WorkspaceSwitcher.tsx`, and other components.
- **Remove manual open-state tracking** — The current `statusMenuTodoId` state is no longer needed because Radix UI manages the popover's open/close lifecycle internally.

## Scope Boundaries

### In Scope
- Replacing the custom inline status dropdown in `TodoList.tsx` with the `Popover` component
- Removing the `statusMenuTodoId` state and its setter
- Preserving existing status option rendering and click behavior

### Out of Scope
- Other dropdowns or popovers in the application
- Visual redesign of the status chooser beyond fixing anchoring
- Changes to the todo data model or status configuration

### Deferred to Follow-Up Work
- None

## Implementation Units

### U1. Replace custom status dropdown with Popover component

**Goal:** Fix the status chooser popup anchoring by replacing the custom absolute-positioned dropdown with the existing Radix UI Popover wrapper.

**Requirements:** The status chooser must open anchored to the status button, close on outside click or Escape, and preserve all existing status-change behavior.

**Dependencies:** None.

**Files:**
- `src/client/components/TodoList.tsx`

**Approach:**
1. Import `Popover`, `PopoverTrigger`, and `PopoverContent` from `./ui/popover`.
2. Remove the `statusMenuTodoId` state variable and its setter from the component state.
3. For each todo item, wrap the status button in a `<Popover>` with `<PopoverTrigger asChild>`.
4. Replace the conditional `{statusMenuTodoId === todo.id && (...)}` block with `<PopoverContent>` containing the status options.
5. Inside `PopoverContent`, map over `statusConfig` entries and render each status option as a button. On click, call `changeStatus(todo.id, s)` — the popover will close automatically.
6. Preserve existing styling classes on the status options.

**Patterns to follow:**
- See `ProviderSelector.tsx` lines 56–109 for the established Popover usage pattern in this codebase.
- See `src/client/components/ui/popover.tsx` for the available props (`side`, `align`, `sideOffset`, `alignOffset`).

**Test scenarios:**
- **Happy path:** Click a todo's status button → the dropdown opens directly adjacent to the button → click a different status → the todo's status updates → the dropdown closes.
- **Edge case:** Click a todo's status button → click outside the dropdown → the dropdown closes without changing the todo's status.
- **Edge case:** Click a todo's status button → press Escape → the dropdown closes without changing the todo's status.
- **Integration:** Interact with status choosers on multiple todo items in sequence; each should open and close independently without state leakage.

**Verification:**
- The dropdown appears directly below (or above, per Radix's collision detection) the status button, regardless of scroll position or list length.
- All four status options render correctly and update the todo status on click.
- No `statusMenuTodoId` references remain in the component.

## Deferred Implementation Notes

- None.
