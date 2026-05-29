---
title: Fix Resize Handle Boundaries in Three-Column Layout
type: fix
status: completed
date: 2026-05-29
---

# Fix Resize Handle Boundaries in Three-Column Layout

## Summary

The layout has two resize boundaries — sidebar/file-panel and file-panel/chat-panel — but the file panel's resize handle is incorrectly placed on its left edge, overlapping the sidebar's right-edge handle. This causes both handles to compete at the same boundary and leaves the file-panel/chat-panel boundary without any resize control.

## Problem Frame

The three-column layout (Sidebar → FilePanel → ChatPanel) has two logical resize boundaries, each controlling one panel width while the remaining space flexes:

1. **Sidebar–FilePanel boundary** should control sidebar width only. FilePanel stays fixed; ChatPanel adjusts via `flex-1`.
2. **FilePanel–ChatPanel boundary** should control FilePanel width only. Sidebar stays fixed; ChatPanel adjusts via `flex-1`.

Currently:
- Sidebar has a right-edge handle (`absolute right-0`) that controls sidebar width.
- FilePanel has a left-edge handle (`absolute left-0`) that controls file panel width.
- These two handles are positioned at the **same pixel boundary** (between Sidebar and FilePanel), so they overlap and compete for drag events.
- There is **no handle** at the FilePanel–ChatPanel boundary, so the file panel cannot be resized from its natural right edge.

## Requirements

- R1. The boundary between Sidebar and FilePanel has exactly one resize handle that controls sidebar width
- R2. The boundary between FilePanel and ChatPanel has exactly one resize handle that controls file panel width
- R3. Dragging either handle resizes only the panel it controls; the other panels are unaffected
- R4. Existing min/max width clamping and localStorage persistence remain unchanged

## Scope Boundaries

- No changes to width persistence logic (`useResizableWidth`, `useSidebarWidth`)
- No changes to min/max width constants
- No changes to Sidebar component behavior

## Context & Research

### Relevant Code and Patterns

- `src/client/components/Sidebar.tsx` — Right-edge resize handle (`absolute right-0`) with correct drag math for a right-edge handle: `delta = moveEvent.clientX - startX`.
- `src/client/components/FilePanel.tsx` — Left-edge resize handle (`absolute left-0`) with left-edge drag math: `delta = startX - moveEvent.clientX`. This handle must move to the right edge.
- `src/client/App.tsx` — Layout is `Sidebar` → `FilePanel` → `<main className="flex-1">` (ChatPanel). Both sidebar and file panel receive `width` and `onWidthChange` props.

### Key Technical Decisions

- **Move FilePanel handle to right edge; remove left-edge handle.** This places one handle per boundary and matches the sidebar pattern. The drag math inverts because the handle moves from left edge to right edge.
- **No z-index changes needed.** Both handles use `z-10`; once they no longer overlap, event interception is unambiguous.

## Implementation Units

### U1. Move FilePanel resize handle to right edge

**Goal:** Relocate the FilePanel resize handle from its left edge to its right edge so it controls the FilePanel–ChatPanel boundary, and update the drag calculation accordingly.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/client/components/FilePanel.tsx`

**Approach:**
- Change the resize handle div from `left-0` to `right-0`.
- Update drag math in `handleMouseDown`:
  - Current (left edge): `delta = startX - moveEvent.clientX`
  - New (right edge): `delta = moveEvent.clientX - startX`
  - Width update: `onWidthChange(startWidth + delta)` (same formula, but `delta` sign flips)
- Remove any comments or dead code related to the old left-edge positioning.

**Patterns to follow:**
- `src/client/components/Sidebar.tsx` — right-edge handle placement and drag math.

**Test scenarios:**
- Happy path: Dragging the FilePanel right-edge handle rightward increases file panel width; ChatPanel shrinks.
- Happy path: Dragging the FilePanel right-edge handle leftward decreases file panel width; ChatPanel grows.
- Happy path: Dragging the Sidebar right-edge handle still resizes sidebar only; FilePanel width is unchanged.
- Edge case: FilePanel hidden (`files.length === 0`) — no handle renders, no errors.
- Edge case: Rapid drag past window bounds — clamping in `useResizableWidth` prevents invalid widths.

**Verification:**
- Only one resize handle is visible at each boundary.
- Dragging each handle resizes exactly one panel.
- TypeScript compiles; no lint errors.

---

## System-Wide Impact

- **Interaction graph:** `FilePanel` no longer competes with `Sidebar` for drag events at the shared boundary. `App` layout remains unchanged.
- **Unchanged invariants:** Sidebar resize behavior, width persistence, min/max bounds, panel hide/show logic.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Right-edge handle visually overlaps with ChatPanel content if not enough padding | Handle is 4px wide with `z-10`; existing sidebar handle uses same pattern without issues. |

## Sources & References

- `src/client/components/Sidebar.tsx` — right-edge handle pattern
- `src/client/components/FilePanel.tsx` — current left-edge handle (to be moved)
