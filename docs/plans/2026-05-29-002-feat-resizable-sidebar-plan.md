---
title: Resizable Sidebar
type: feat
status: completed
date: 2026-05-29
---

# Resizable Sidebar

## Summary

Add a draggable resize handle to the right edge of the sessions/files sidebar so users can adjust its width horizontally. The chosen width is persisted to localStorage and restored on app launch.

## Requirements

- R1. Users can resize the sidebar horizontally by dragging a handle on its right edge
- R2. The sidebar width persists across application restarts via localStorage
- R3. Width respects minimum (200px) and maximum (600px) bounds so the layout stays usable

## Scope Boundaries

- File panel resizing is explicitly out of scope (design doc deferred work)
- Collapsible sidebar (collapse to icon/minimal state) is out of scope
- Touch/mobile resize gestures are out of scope

### Deferred to Follow-Up Work

- Resizable file panel: tracked in design doc §15 as deferred

## Context & Research

### Relevant Code and Patterns

- `src/client/components/Sidebar.tsx` — current fixed-width `w-72` sidebar with session/file tabs
- `src/client/App.tsx` — flex layout housing Sidebar, FilePanel, and ChatPanel
- `src/client/hooks/use-app-settings.ts` — localStorage persistence pattern with try/catch guards and validation

### Institutional Learnings

- No existing resizable components in the codebase; this is the first

## Key Technical Decisions

- **Raw mouse events over library**: No drag/resize library is in dependencies and adding one is overkill for a single-axis drag. Implement with `mousedown`/`mousemove`/`mouseup` on a resize handle element.
- **Dedicated hook over app-settings merge**: Sidebar width is a UI chrome preference, not an app setting. Keep it in its own `useSidebarWidth` hook to avoid bloating the app-settings schema and to follow single-responsibility.
- **Document-level mouse listeners**: Attach `mousemove`/`mouseup` to `document` during drag so releasing the mouse anywhere (even outside the window) correctly ends the drag and prevents stuck resize state.

## Implementation Units

### U1. Create useSidebarWidth hook

**Goal:** Provide a reactive sidebar width with localStorage persistence and sensible defaults.

**Requirements:** R2, R3

**Dependencies:** None

**Files:**
- Create: `src/client/hooks/use-sidebar-width.ts`

**Approach:**
- Mirror the `useAppSettings` localStorage pattern: read on mount, write on change, guard with try/catch
- Default: 288px (matches current `w-72` Tailwind value)
- Clamp values to [200, 600] both when reading from storage and when setting
- Storage key: `sidebar-width`

**Patterns to follow:**
- `src/client/hooks/use-app-settings.ts` — localStorage read/write with validation guards

**Test scenarios:**
- Happy path: hook returns default width (288) when no stored value exists
- Edge case: stored value below 200px is clamped to 200 on read
- Edge case: stored value above 600px is clamped to 600 on read
- Integration: width written to localStorage survives page reload

**Verification:**
- Hook returns a number and a setter
- Width persists across page reloads
- Out-of-bounds stored values are clamped on initialization

---

### U2. Add resize handle to Sidebar component

**Goal:** Render a draggable resize handle on the sidebar's right edge and emit width changes during drag.

**Requirements:** R1, R3

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/Sidebar.tsx`

**Approach:**
- Add an optional `width: number` prop to `SidebarProps`
- Replace fixed `w-72` class with an inline `style={{ width }}` prop; keep `flex-shrink-0`
- Add a narrow handle `div` on the right edge (`cursor-col-resize`, ~4px wide, full height, positioned at the border)
- Attach `onMouseDown` to the handle; in the handler register `mousemove` and `mouseup` on `document`
- On `mousemove`, compute new width from `clientX` relative to the sidebar's left edge and call the `onWidthChange` callback
- On `mouseup`, remove document listeners
- Clamp width to [200, 600] during drag
- Set `document.body.style.userSelect = 'none'` during drag to prevent text selection, restore on release
- Add `cursor: col-resize` to `document.body` during drag for visual feedback

**Technical design:**
> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*
>
> The handle is a child of the sidebar, absolutely positioned at `right: 0`, `top: 0`, `bottom: 0`, `width: 4px`. On mousedown, capture the starting X and the starting width. Each mousemove computes `newWidth = startWidth + (e.clientX - startX)` and calls `onWidthChange` with the clamped result. Mouseup always cleans up.

**Patterns to follow:**
- Existing Tailwind utility classes for colors (`bg-border`, `hover:bg-accent`) for handle visual feedback
- `cn()` utility from `src/client/components/ui/utils` for conditional class merging

**Test scenarios:**
- Happy path: dragging the handle 100px to the right increases sidebar width by 100px
- Edge case: dragging below 200px clamps to minimum
- Edge case: dragging above 600px clamps to maximum
- Error path: rapid mouse-out during drag still releases correctly on mouseup anywhere in the document
- Integration: handle is visually distinct on hover (background color change)

**Verification:**
- Sidebar renders at correct initial width
- Dragging the handle resizes the sidebar smoothly
- Width is clamped to bounds
- Text selection is suppressed during drag
- Listeners are always cleaned up after drag

---

### U3. Integrate into App layout

**Goal:** Wire the hook into App and remove the fixed width constraint.

**Requirements:** R1, R2

**Dependencies:** U1, U2

**Files:**
- Modify: `src/client/App.tsx`

**Approach:**
- Import `useSidebarWidth` in App
- Call the hook and pass `width` and `setWidth` to `<Sidebar />`
- Remove any `w-72` equivalent from App's Sidebar wrapper (it is inside Sidebar itself)

**Patterns to follow:**
- Existing prop-passing pattern in App for `onFileClick`, `onFileDoubleClick`

**Test scenarios:**
- Integration: on reload, sidebar restores to last dragged width
- Integration: resizing does not break workspace tab or chat panel layout
- Integration: switching between sessions and files tabs works at any sidebar width

**Verification:**
- App compiles and sidebar renders correctly
- Resized width persists across reloads
- Layout remains stable during and after resize
- All existing sidebar functionality (tabs, session list, file explorer) works at any width within bounds

## System-Wide Impact

- **Unchanged invariants:** FilePanel width (`w-96`) and ChatPanel flex behavior remain unchanged. The main flex layout in App continues to distribute space as before — only the Sidebar's explicit width changes.
- **State lifecycle risks:** The `useSidebarWidth` hook writes to localStorage on every drag pixel, which could be frequent. Debounce the write (e.g., 100ms) or only write on `mouseup` to avoid excessive localStorage I/O.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Drag handle interferes with scrollbar or tab content | Place handle at the visual border edge, use `z-index` to float above content, keep width at 4px |
| Rapid drags cause layout thrashing | Width updates are pure CSS (inline style); React re-renders are cheap for this component tree. Write to localStorage only on `mouseup`, not on every `mousemove` |
| Tauri window drag region conflict | The header has `data-tauri-drag-region`; the sidebar handle is in a different DOM region and uses different mouse buttons/behavior, so no conflict is expected |

## Sources & References

- Design doc: `docs/design/ui-ux-design.md` line 570 — "Resizable sidebar and file panel (drag handles)" listed as deferred work
