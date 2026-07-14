---
title: Sidebar Collapse and Expand - Plan
type: feat
date: 2026-07-14
topic: sidebar-collapse-expand
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Sidebar Collapse and Expand - Plan

## Goal Capsule

- **Objective:** Add a collapse/expand control to the main left sidebar so users can reclaim horizontal space on small screens while keeping tab switching within one click.
- **Product Authority:** UI chrome preference; no server-side or workspace-scoped data changes.
- **Stop Conditions:** The sidebar toggles between expanded and a narrow icon rail, the previous width restores on expand, and the state persists across restarts.
- **Execution Profile:** Client-only React change; no sidecar or native work.
- **Tail Ownership:** Frontend; no ongoing operational concerns.

---

## Product Contract

*Product Contract preserved from the requirements-only artifact. No scope changes were required during planning.*

### Summary

Add a toggle that collapses the main left sidebar into a narrow icon rail showing the sessions, todos, and files tab icons. A button at the bottom of the rail expands the sidebar back to its previously resized width. The collapsed state and width persist across app restarts, and a keyboard shortcut toggles the state.

### Problem Frame

The main sidebar is always visible and currently occupies 200–600px of horizontal space. Users who run the app in a small window or on a compact screen need more room for the chat panel, but they still want quick access to switch between sessions, todos, and files. Today the only recourse is manual resizing, which does not go below 200px and still leaves a large panel when it is not actively being used.

### Requirements

- R1. The sidebar supports two states: expanded and collapsed.
- R2. In the collapsed state the sidebar renders as a narrow icon rail, wide enough to display the three tab icons comfortably (target ~48px).
- R3. Clicking a tab icon in the collapsed rail switches the active tab without expanding the sidebar.
- R4. Clicking the expand button at the bottom of the rail restores the sidebar to the width it had before the last collapse.
- R5. The collapse/expand state persists across application restarts.
- R6. A keyboard shortcut toggles collapse and expand.
- R7. Tab icons and the expand button show accessible labels via tooltips in the collapsed state.
- R8. When expanded, the existing drag-to-resize handle on the sidebar's right edge continues to work exactly as it does today.

### Key Decisions

- **Icon rail instead of fully hidden.** A fully hidden sidebar would save the most space, but the primary use case is small-window multitasking where users still want one-click tab switching. The rail keeps that affordance at the cost of a small persistent strip.
- **Expand control lives inside the rail.** Placing the expand button at the bottom of the collapsed rail keeps the control adjacent to the object it manipulates and avoids adding new persistent chrome to the header.
- **Restore previous resized width on expand.** Re-opening to the last manually dragged width respects the user's layout preference; falling back to a default width would force re-adjustment every time.

### Scope Boundaries

- The file panel, settings panel, analytics panel, and other secondary surfaces are not affected.
- A fully-hidden zero-width sidebar mode is out of scope; only the icon-rail collapse state is supported.
- Touch or swipe gestures are out of scope.
- Changing tab order, tab icons, or tab behavior beyond collapse-aware rendering is out of scope.

### Dependencies / Assumptions

- The existing `useResizableWidth` hook and localStorage persistence pattern in `src/client/hooks/` will be reused or extended for the collapsed state.
- The project already bundles Radix UI collapsible primitives and accessible tooltip primitives.
- New i18n keys for collapsed-state labels will be added to both `en` and `zh-CN` namespaces.

### Sources & Research

- `src/client/components/Sidebar.tsx` — current sidebar with three tabs and right-edge resize handle.
- `src/client/hooks/use-sidebar-width.ts` — existing width persistence hook.
- `src/client/hooks/use-resizable-width.ts` — generic width persistence hook used by `use-sidebar-width`.
- `src/client/App.tsx` — horizontal layout housing Sidebar, FilePanel, and ChatPanel.
- `src/client/components/ui/tooltip.tsx` — Radix-based tooltip primitive.
- `src/client/components/ui/collapsible.tsx` — Radix-based collapsible primitive.
- `src/client/i18n/en/common.json` and `src/client/i18n/zh-CN/common.json` — existing sidebar label keys.
- `src/client/components/Sidebar.test.tsx` — existing jsdom tests for tab rendering.
- `docs/plans/2026-05-29-002-feat-resizable-sidebar-plan.md` — prior plan that implemented resizing and explicitly deferred collapsible behavior.

---

## Planning Contract

### Key Technical Decisions

- **Extend `useSidebarWidth` to own collapsed state.** `useResizableWidth` already manages width persistence. Adding a separate `isCollapsed` boolean and `toggleCollapse` function to the same hook keeps sidebar chrome state in one place and follows the existing `localStorage` persistence pattern. A separate hook would fragment related UI state.
- **Store previous width separately from collapsed width.** When the user collapses, the current width is saved as the "previous width" and the live width is switched to the rail width. On expand, the live width is restored to the saved previous width. This avoids losing the user's dragged width across collapse cycles.
- **Keep the collapse UI inside `Sidebar`.** The component already owns tab state and resize-handle rendering. Adding the icon rail and expand button there keeps layout concerns colocated. `App` only wires state and the global keyboard shortcut.
- **Global keyboard shortcut in `App`.** Cmd/Ctrl+B is a common "sidebar toggle" convention. Listening on `window` from `App` keeps the shortcut discoverable and avoids propagating keyboard concerns into `Sidebar`. The listener should ignore events when the user is typing in an input, textarea, or contenteditable.
- **Use the existing tooltip primitive for collapsed labels.** The Radix-based tooltip component is already styled and accessible. Tooltips only need new i18n keys for the expand action and tab labels in the collapsed rail.

### High-Level Technical Design

The sidebar collapse state is a simple two-state machine driven by one hook and wired into `App` and `Sidebar`.

```mermaid
stateDiagram-v2
    [*] --> Expanded : app launch with isCollapsed=false
    [*] --> Collapsed : app launch with isCollapsed=true
    Expanded --> Collapsed : click collapse button / Cmd(Ctrl)+B
    Collapsed --> Expanded : click expand button / Cmd(Ctrl)+B
    Expanded --> Expanded : drag resize handle
    Collapsed --> Collapsed : click tab icon (switches active tab)
```

State transitions:
- On **collapse**, the current resized width is saved and the sidebar width becomes the fixed rail width.
- On **expand**, the saved resized width is restored.
- The drag handle is visible only in the `Expanded` state.
- Tab icons are visible and clickable in both states.

### Assumptions

- The keyboard shortcut will not conflict with an existing browser or app shortcut on any supported platform; if a conflict surfaces during implementation, the shortcut can be changed or made configurable in settings.
- The collapsed rail width can be a fixed Tailwind class value (e.g., `w-12`) rather than user-configurable.
- Existing jsdom tests can render the `Sidebar` component in both states using the existing `I18nextProvider` wrapper.

### Sequencing

1. Extend the hook with collapsed state and previous-width storage.
2. Add the collapsed rail UI and expand button to `Sidebar`.
3. Add i18n keys for tooltips and button labels.
4. Wire the hook and keyboard shortcut in `App`.
5. Add/update tests.

---

## Implementation Units

### U1. Extend sidebar width hook to track collapsed state

- **Goal:** Add `isCollapsed` and `toggleCollapse` to the sidebar state hook, persist the collapsed flag, and remember the pre-collapse width so expansion restores it.
- **Requirements:** R1, R4, R5
- **Dependencies:** None
- **Files:**
  - Modify: `src/client/hooks/use-sidebar-width.ts`
  - Create: `src/client/hooks/use-sidebar-width.test.ts`
- **Approach:** Wrap or extend the existing `useResizableWidth` usage. Introduce a second `localStorage` key for the collapsed boolean. On collapse, store the current width under a "previous width" key and set the live width to the rail width. On expand, restore the previous width. Clamp restored values within `[200, 600]` to respect current bounds.
- **Patterns to follow:** `src/client/hooks/use-resizable-width.ts` for localStorage read/write guards.
- **Test scenarios:**
  - Happy path: hook initializes with `isCollapsed: false` and the stored width when no collapsed flag exists.
  - Happy path: calling `toggleCollapse` switches `isCollapsed` and updates the persisted flag.
  - Edge case: expanding after collapse restores the width that existed before collapse, not the default width.
  - Edge case: a corrupted or missing `localStorage` entry falls back to sensible defaults without throwing.
- **Verification:** Hook tests pass; `npm run test:client src/client/hooks/use-sidebar-width.test.ts` succeeds.

### U2. Add collapse toggle and icon rail to Sidebar

- **Goal:** Render the collapsed icon rail with clickable tab icons, a bottom expand button, and hidden resize handle while collapsed.
- **Requirements:** R1, R2, R3, R4, R7, R8
- **Dependencies:** U1, U4
- **Files:**
  - Modify: `src/client/components/Sidebar.tsx`
  - Modify: `src/client/components/Sidebar.test.tsx`
- **Approach:** Add `isCollapsed` and `onToggleCollapse` props. In collapsed mode, replace the tab switcher with a vertical column of icon-only buttons and move the expand chevron to the bottom of the rail. Keep `activeTab` state unchanged so clicking an icon switches tabs without expanding. Hide the resize handle when collapsed. Wrap icon buttons and the expand button with the tooltip primitive using new i18n keys.
- **Technical design:** The rail uses a fixed width class (e.g., `w-12`). The tab icons reuse the same labels already shown in the expanded tab switcher. The expand button uses a chevron/right-arrow icon from `lucide-react`.
- **Patterns to follow:** Existing tab switcher styling and active-state classes; `src/client/components/ui/tooltip.tsx` for tooltips; `cn()` for conditional class merging.
- **Test scenarios:**
  - Happy path: when `isCollapsed` is true, the component renders three icon buttons and an expand button.
  - Happy path: clicking a tab icon in collapsed mode updates the active tab content without calling `onToggleCollapse`.
  - Happy path: clicking the expand button calls `onToggleCollapse`.
  - Edge case: the resize handle is present when expanded and absent when collapsed.
  - Integration: switching between sessions, todos, and files tabs works in both expanded and collapsed states.
- **Verification:** Sidebar tests pass; `npm run test:client src/client/components/Sidebar.test.tsx` succeeds.

### U3. Wire collapse state and keyboard shortcut in App

- **Goal:** Connect the sidebar collapse hook to the UI and provide a global keyboard shortcut.
- **Requirements:** R4, R5, R6
- **Dependencies:** U1, U2
- **Files:**
  - Modify: `src/client/App.tsx`
- **Approach:** Destructure `isCollapsed`, `toggleCollapse`, `width`, and `setWidth` from `useSidebarWidth`. Pass `isCollapsed`, `onToggleCollapse`, and the restored `width` to `Sidebar`. Add a `useEffect` in `App` that listens for `keydown` on `window`, checks for Cmd/Ctrl+B, ignores the event when an input/textarea/contenteditable is focused, and calls `toggleCollapse`.
- **Patterns to follow:** Existing keyboard shortcut patterns in `src/client/components/CommandPicker.tsx` and `src/client/components/PromptInput.tsx`.
- **Test scenarios:**
  - Integration (manual): pressing Cmd/Ctrl+B toggles the sidebar when no text input is focused.
  - Integration (manual): pressing Cmd/Ctrl+B while typing in the prompt input does not toggle the sidebar.
- **Verification:** The app compiles, the sidebar toggles via the keyboard shortcut in dev, and the collapsed/expanded state restores correctly across reloads.

### U4. Add i18n labels for collapse/expand tooltips

- **Goal:** Provide accessible labels for the collapsed rail icons and the expand button in both supported languages.
- **Requirements:** R7
- **Dependencies:** None
- **Files:**
  - Modify: `src/client/i18n/en/common.json`
  - Modify: `src/client/i18n/zh-CN/common.json`
- **Approach:** Add `sidebar.collapse`, `sidebar.expand`, and `sidebar.showSessions` / `sidebar.showTodos` / `sidebar.showFiles` keys under the existing `sidebar` namespace. Use these keys for tooltips in the collapsed rail.
- **Patterns to follow:** Existing `sidebar.sessions`, `sidebar.todos`, `sidebar.files` keys.
- **Test scenarios:**
  - Happy path: the application loads in English and Chinese without missing-translation warnings for the new keys.
- **Verification:** `npm run lint` passes and the dev UI shows translated tooltip text.

### U5. Add/update tests for collapse behavior

- **Goal:** Cover the new collapse behavior in automated tests.
- **Requirements:** R1–R8 (where feasible under jsdom)
- **Dependencies:** U1, U2, U4
- **Files:**
  - Modify: `src/client/components/Sidebar.test.tsx`
  - Create: `src/client/hooks/use-sidebar-width.test.ts`
- **Approach:** Extend `Sidebar.test.tsx` with collapsed-state rendering and interaction tests. Add a dedicated hook test for persistence and previous-width restoration. Mock `localStorage` to avoid cross-test leakage.
- **Patterns to follow:** Existing `Sidebar.test.tsx` `I18nextProvider` wrapper and workspace-store mock.
- **Test scenarios:**
  - Happy path: expanded `Sidebar` renders text tabs and the resize handle.
  - Happy path: collapsed `Sidebar` renders icon buttons and the expand button.
  - Happy path: clicking a collapsed icon button switches the active tab content.
  - Happy path: clicking the expand button calls the toggle handler.
  - Happy path: `useSidebarWidth` persists collapsed state and restores previous width.
  - Edge case: `localStorage` values outside the allowed width range are clamped on restore.
- **Verification:** `npm run test:client src/client/components/Sidebar.test.tsx src/client/hooks/use-sidebar-width.test.ts` succeeds.

---

## Verification Contract

- **Automated test command:** `npm run test:client src/client/components/Sidebar.test.tsx src/client/hooks/use-sidebar-width.test.ts`
- **Lint command:** `npm run lint`
- **Type-check command:** `npm run build:client` or `npx tsc -b` (whichever the repo's `package.json` defines for client type checking)
- **Manual verification:**
  - Launch the app with `npm run dev:client` (or `npm run tauri:dev` for the full desktop shell).
  - Toggle the sidebar with the collapse button and with Cmd/Ctrl+B.
  - Confirm the sidebar restores to the previous width after expanding.
  - Confirm tab switching works in the collapsed rail.
  - Confirm tooltips appear on collapsed icons.
  - Resize the sidebar when expanded and confirm collapse/expand preserves the resized width across reloads.

---

## Definition of Done

- All implementation units are complete and the app compiles without type errors.
- `npm run lint` passes with zero warnings.
- Automated tests for the hook and `Sidebar` component pass.
- The sidebar toggles between expanded and collapsed states via both the UI button and the keyboard shortcut.
- Collapsed-state width, expanded width, and collapsed flag persist across application reloads.
- The collapsed rail shows accessible tooltips for tab icons and the expand button in both English and Chinese.
- No dead code, experimental files, or unrelated changes remain in the diff.
- The `CHANGELOG.md` is updated with a user-facing entry for the new collapse/expand feature.
