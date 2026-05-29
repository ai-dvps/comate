---
title: fix: Respect viewport boundaries for workspace dropdowns
type: fix
status: completed
date: 2026-05-29
---

# fix: Respect viewport boundaries for workspace dropdowns

## Summary

Replace the manual `absolute`-positioned dropdowns in `WorkspaceTabs` and `WorkspaceSwitcher` with the project's existing Radix UI `Popover` component. This gives automatic viewport collision detection so dropdowns reposition to stay within window bounds instead of overflowing.

## Requirements

- R1. The `WorkspaceTabs` dropdown (opened workspace list) must remain fully visible within the application window regardless of window size or scroll position.
- R2. The `WorkspaceSwitcher` dropdown (all workspaces list) must remain fully visible within the application window regardless of window size or scroll position.
- R3. The fix must follow the existing `Popover` pattern established by `CommandPicker` and `FilePicker` — reusing `src/client/components/ui/popover.tsx` and its collision-aware `PopoverContent`.

## Scope Boundaries

- Only the two workspace dropdown surfaces are in scope.
- Other custom dropdowns or popups in the codebase are out of scope.
- No new npm dependencies; `@radix-ui/react-popover` is already installed.

### Deferred to Follow-Up Work

- Audit and migrate other hand-rolled absolute-positioned dropdowns in the codebase to `Popover` for consistency.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/WorkspaceTabs.tsx` — Contains a custom dropdown for the opened-tab list using `absolute top-full right-0 mt-1` with no collision detection. The dropdown is rendered inside a `relative` wrapper and uses manual `mousedown`/`keydown` listeners for dismissal.
- `src/client/components/WorkspaceSwitcher.tsx` — Contains a custom dropdown for the workspace switcher using `absolute top-full left-0 mt-1` with the same lack of collision detection and manual dismissal listeners.
- `src/client/components/ui/popover.tsx` — Thin wrapper around `@radix-ui/react-popover` exporting `Popover`, `PopoverTrigger`, `PopoverAnchor`, and `PopoverContent`.
- `src/client/components/CommandPicker.tsx` and `src/client/components/FilePicker.tsx` — Existing consumers of the `Popover` pattern. They pass `side`, `align`, `sideOffset`, and styling classes to `PopoverContent`, which handles collision detection automatically via Radix's built-in `avoidCollisions` behavior.

### External References

- Radix UI Popover documentation: collision detection and viewport boundary respect are enabled by default via the `avoidCollisions` prop on `Popover.Content`.

## Key Technical Decisions

- **Use `Popover` instead of patching CSS**: The manual `absolute` dropdowns would require custom `ResizeObserver` or `useLayoutEffect` logic to detect overflow and flip position. The codebase already has a battle-tested `Popover` wrapper with this behavior built in; extending that pattern is less code and more maintainable.
- **Preserve existing styling and interaction semantics**: The dropdowns currently use Tailwind classes for surface, border, shadow, and rounded corners. These class names should transfer directly to `PopoverContent`'s `className` prop.
- **Remove manual dismissal listeners**: Radix Popover handles outside-click and `Escape` key dismissal automatically. The existing `useEffect` hooks that attach `mousedown` and `keydown` listeners can be removed when migrating.

## Implementation Units

### U1. Migrate WorkspaceTabs dropdown to Popover

**Goal:** Replace the hand-rolled dropdown in `WorkspaceTabs` with a collision-aware `Popover` so the opened-workspace list stays inside the viewport.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `src/client/components/WorkspaceTabs.tsx`

**Approach:**
1. Import `Popover`, `PopoverTrigger`, and `PopoverContent` from `./ui/popover`.
2. Wrap the dropdown button in `PopoverTrigger` and the dropdown panel in `PopoverContent`.
3. Set `side="bottom"`, `align="end"`, and `sideOffset={4}` on `PopoverContent` to match the current `top-full right-0 mt-1` visual placement.
4. Move the existing Tailwind styling classes (`bg-surface border border-border rounded-xl shadow-lg overflow-hidden w-64`) to `PopoverContent`.
5. Remove the `isDropdownOpen` state and the `useEffect` that manages `mousedown`/`keydown` dismissal; let Radix manage open state via `open` / `onOpenChange`.
6. Preserve the search input, filtered list, and close-button behavior inside `PopoverContent`.

**Patterns to follow:**
- `src/client/components/FilePicker.tsx` — usage of `Popover`, `PopoverAnchor` (or `PopoverTrigger`), and `PopoverContent` with `side` / `align` / `sideOffset`.

**Test scenarios:**
- Happy path: With zero open workspaces, click the ChevronDown button; the dropdown appears fully inside the window.
- Happy path: With several open workspaces, click the ChevronDown button; the dropdown still appears fully inside the window.
- Edge case: Resize the window to be narrow/short before opening the dropdown; verify the dropdown flips sides or shifts alignment to stay visible.
- Integration: Select a workspace from the dropdown; the dropdown closes and the active workspace switches correctly.

**Verification:**
- Manual visual check: open the app with no workspaces, click the dropdown button, confirm the panel does not overflow any window edge.
- Manual visual check: shrink the window to minimum reasonable size, reopen dropdown, confirm it repositions to stay visible.

---

### U2. Migrate WorkspaceSwitcher dropdown to Popover

**Goal:** Replace the hand-rolled dropdown in `WorkspaceSwitcher` with a collision-aware `Popover` so the all-workspaces list stays inside the viewport.

**Requirements:** R2, R3

**Dependencies:** U1 (establishes the Popover migration pattern; can be done in parallel if the pattern is obvious, but serial reduces risk)

**Files:**
- Modify: `src/client/components/WorkspaceSwitcher.tsx`

**Approach:**
1. Import `Popover`, `PopoverTrigger`, and `PopoverContent` from `./ui/popover`.
2. Wrap the switcher button in `PopoverTrigger` and the dropdown panel in `PopoverContent`.
3. Set `side="bottom"`, `align="start"`, and `sideOffset={4}` on `PopoverContent` to match the current `top-full left-0 mt-1` visual placement.
4. Move the existing Tailwind styling classes to `PopoverContent`.
5. Remove the `isOpen` state and the `useEffect` that manages `mousedown`/`keydown` dismissal; let Radix manage open state.
6. Preserve the workspace list, active highlighting, and open-tab checkmark behavior inside `PopoverContent`.

**Patterns to follow:**
- `src/client/components/CommandPicker.tsx` — usage of `Popover` with trigger, anchor, and content.

**Test scenarios:**
- Happy path: Click the LayoutGrid switcher button; the dropdown appears fully inside the window.
- Edge case: Resize the window to be very narrow/short; verify the dropdown flips or shifts to stay visible.
- Integration: Select a workspace from the dropdown; the dropdown closes and the workspace opens correctly.

**Verification:**
- Manual visual check: open the switcher dropdown, confirm it does not overflow any window edge.
- Manual visual check: shrink window, reopen dropdown, confirm it repositions to stay visible.

## System-Wide Impact

- **Unchanged invariants:** The data flow (workspace store selectors, `openWorkspace`, `setActiveWorkspace`, `closeWorkspace`) is untouched. Only the UI shell around the dropdown changes.
- **API surface parity:** Both dropdowns will behave consistently with other popover-based pickers (`CommandPicker`, `FilePicker`).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Radix Popover `z-index` stacking may differ from the current `z-[60]` manual dropdown, causing the panel to render underneath other UI elements. | Verify visually after migration; apply an explicit `z-[60]` or higher class to `PopoverContent` if needed. |
| Removing manual dismissal listeners may change timing of state updates (e.g., clicking a close button inside the dropdown). | Test the close-tab button inside `WorkspaceTabs` dropdown to ensure it still closes the workspace and the dropdown dismisses properly. |

## Sources & References

- Related code: `src/client/components/CommandPicker.tsx`, `src/client/components/FilePicker.tsx`
- Related code: `src/client/components/ui/popover.tsx`
