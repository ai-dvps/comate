---
title: File Search and Resizable File Panel
type: feat
status: completed
date: 2026-05-29
origin: docs/brainstorms/2026-05-29-file-search-and-resizable-file-panel-requirements.md
---

# File Search and Resizable File Panel

## Summary

Add workspace-wide file search to the Files tab and replace the drawer-based file viewer with a persistent, resizable side panel that supports multiple concurrently open files as tabs. The sidebar resize pattern is generalized into a reusable hook and applied to the new file panel.

---

## Problem Frame

Finding a specific file in a large workspace currently requires manually expanding folders in the tree view. When a file is located, clicking it opens a temporary overlay drawer that must be explicitly pinned to persist, creating a two-step interaction before the file can be viewed side-by-side with the chat. This friction slows down file discovery and context switching.

(see origin: docs/brainstorms/2026-05-29-file-search-and-resizable-file-panel-requirements.md)

---

## Requirements

- R1. The Files tab includes a search input at the top of the file list area
- R2. Typing in the search input triggers a workspace-wide file search with debouncing
- R3. Search results display as a flat list of file paths with appropriate file-type icons
- R4. Clearing the search input (empty string) returns the view to the folder tree
- R5. Clicking a search result opens the corresponding file in the side panel
- R6. Clicking a file in the tree opens it directly in the side panel; the drawer intermediate step is eliminated
- R7. The side panel supports multiple concurrently open files, each represented as a tab
- R8. Tabs display the file name and a close button; clicking a tab switches the panel to that file's content
- R9. The side panel has a draggable resize handle on its left edge
- R10. Panel width respects minimum and maximum bounds and persists across application sessions via localStorage
- R11. The panel hides completely when no files are open; it does not render an empty placeholder
- R12. The existing FileDrawer overlay component is removed entirely

**Origin actors:** A1 (User)
**Origin flows:** F1 (Search for a file), F2 (Open a file from the tree), F3 (Manage open file tabs), F4 (Resize the file panel)
**Origin acceptance examples:** AE1 (search and open), AE2 (tree click opens panel), AE3 (tab switching), AE4 (resize persists), AE5 (close last tab hides panel)

---

## Scope Boundaries

- File content remains read-only; editing is not included
- Drag-and-drop tab reordering within the file panel is not included
- Split view or multi-pane layout within the file panel is not included
- Search within file contents is not included
- Changes to the Sessions tab or session management are not included
- Changes to the sidebar resizing behavior are not included
- Keyboard navigation in file search results is not included

### Deferred to Follow-Up Work

- Keyboard navigation (arrow up/down, Enter, Escape) in the Files tab search results
- Tab overflow dropdown menu when horizontal scroll is insufficient

---

## Context & Research

### Relevant Code and Patterns

- `src/client/App.tsx` — Root layout managing `drawerFile`/`pinnedFile` state; main flex row is Sidebar → FilePanel → ChatPanel
- `src/client/components/Sidebar.tsx` — Recently made resizable via `useSidebarWidth` + drag handle pattern
- `src/client/hooks/use-sidebar-width.ts` — localStorage-persisted width with MIN/MAX clamping; writes only on `mouseup`
- `src/client/components/FileExplorer.tsx` — Lazy-loading folder tree; `TreeNode` handles folders/files; no search capability
- `src/client/components/FilePanel.tsx` — Single-file persistent panel, fixed `w-96`, displays content via `CodeBlockContent`
- `src/client/components/FileDrawer.tsx` — Fixed-position overlay drawer with Pin/Copy/Close; to be removed
- `src/client/components/FilePicker.tsx` — Popover search using `useFiles`; debounced input, loading/error/empty states, file icons
- `src/client/stores/files-store.ts` — `useFiles(workspaceId)` hook with 120ms debounce, AbortController race handling
- `src/client/components/WorkspaceTabs.tsx` — Horizontal scrollable tabs with close buttons, active state, `overflow-x-auto scrollbar-hide`
- `src/client/hooks/use-app-settings.ts` — localStorage persistence pattern with try/catch guards

### Institutional Learnings

- Commit planning docs alongside code changes and update plan status to `completed` before committing
- Raw mouse events over library for drag resizing; document-level listeners during drag; suppress `userSelect` and set body cursor

---

## Key Technical Decisions

- **Reusable `useResizableWidth` hook over separate hook:** Generalize the sidebar-width hook to accept `storageKey`, `defaultWidth`, `min`, `max`. This avoids duplication while keeping the localStorage persistence pattern consistent. Both sidebar and file panel use the same hook with different parameters.
- **Tab overflow: horizontal scroll only:** Follow the `WorkspaceTabs` pattern — `overflow-x-auto scrollbar-hide` with flex row. No dropdown overflow menu for v1; deferred if needed.
- **File click behavior (tree or search):** If the file is already open in a tab, switch to that tab rather than opening a duplicate. This matches standard IDE behavior and prevents tab proliferation.
- **Panel visibility self-managed:** `FilePanel` returns `null` when its `files` array is empty, so `App` always renders it and the panel decides whether to show itself. This keeps `App` layout simple.

---

## Open Questions

### Resolved During Planning

- **Tab overflow behavior:** Horizontal scroll with hidden scrollbar, matching `WorkspaceTabs`. Dropdown menu deferred.
- **Reusable hook vs. separate hook:** Create `useResizableWidth` and have `useSidebarWidth` delegate to it.

### Deferred to Implementation

- **Exact active-tab styling details:** Match `WorkspaceTabs` as closely as possible, but minor visual tuning may be needed during implementation.
- **Resize handle z-index relative to other panels:** Ensure the file panel's left-edge handle does not interfere with the sidebar's right-edge handle when both are visible. The 4px handle width and careful positioning should prevent overlap.

---

## Implementation Units

### U1. Create reusable useResizableWidth hook

**Goal:** Extract the sidebar width logic into a reusable hook so both sidebar and file panel can share it.

**Requirements:** R10

**Dependencies:** None

**Files:**
- Create: `src/client/hooks/use-resizable-width.ts`
- Modify: `src/client/hooks/use-sidebar-width.ts`

**Approach:**
- Create `useResizableWidth(options)` accepting `{ storageKey, defaultWidth, minWidth, maxWidth }`
- Move all read/write/clamp logic from `use-sidebar-width.ts` into the new hook
- `use-sidebar-width.ts` becomes a thin wrapper calling `useResizableWidth` with sidebar-specific constants
- Ensure localStorage write still only happens on explicit set (not every drag pixel — the drag handler in the component writes on `mouseup`, the hook just persists on set)

**Patterns to follow:**
- `src/client/hooks/use-sidebar-width.ts` — existing read/write/clamp logic
- `src/client/hooks/use-app-settings.ts` — try/catch guards around localStorage

**Test scenarios:**
- Happy path: hook returns default width when no stored value exists
- Edge case: stored value below minimum is clamped on read
- Edge case: stored value above maximum is clamped on read
- Integration: width written to localStorage survives page reload
- Integration: sidebar still renders and resizes correctly after refactoring

**Verification:**
- TypeScript compiles without errors
- Sidebar continues to initialize, resize, and persist width correctly
- Hook accepts different parameters and returns independent values when called with different keys

---

### U2. Add file search UI to FileExplorer

**Goal:** Add a search input to the Files tab that performs workspace-wide file search and displays results as a flat list.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** None

**Files:**
- Modify: `src/client/components/FileExplorer.tsx`
- Modify: `src/client/i18n/en/common.json`
- Modify: `src/client/i18n/zh-CN/common.json`

**Approach:**
- Add local state for `searchQuery: string` in `FileExplorer`
- Use `useFiles(activeWorkspaceId)` to get `results`, `loading`, `error`, `search`, `clear`
- On query change, call `search(query)`; on empty query, call `clear()`
- Render a search input at the top of the file list area (above the tree)
- When `searchQuery` is non-empty, render flat results list instead of tree
- Each result shows file icon (reuse `getFileIcon` / `getIconForPath` pattern from `FilePicker`) and full path
- Clicking a result calls `onFileClick(path, basename)` — same as tree click
- Show loading, error, and empty states matching `FilePicker` styling
- Clearing the input (backspacing to empty) returns to tree view

**Technical design:**
> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*
>
> The search input sits at the top of the FileExplorer container, styled as `bg-transparent`, `border-b border-border`, `focus:outline-none`. Below it, conditional rendering: if `searchQuery` is truthy, render the flat results list; otherwise render the existing tree. The results list uses the same `flex-1 overflow-y-auto` container as the tree so scrolling behavior is consistent.

**Patterns to follow:**
- `src/client/components/FilePicker.tsx` — search input styling, loading/error/empty states, file icon display
- `src/client/stores/files-store.ts` — `useFiles` hook usage
- `src/client/components/FileExplorer.tsx` — existing `getFileIcon` for tree file icons

**Test scenarios:**
- Covers AE1. Happy path: typing "config" shows matching files with icons; clicking opens file in side panel
- Happy path: clearing search input returns view to folder tree
- Edge case: typing when no workspace is active shows appropriate empty state
- Edge case: search returns no results shows "no files match" message
- Error path: search API failure displays error message without crashing
- Integration: search debouncing works (120ms delay before API call)

**Verification:**
- Search input renders at top of Files tab
- Typing triggers debounced search with loading state
- Results display with correct file icons
- Clicking a result opens the file in the side panel
- Clearing input restores folder tree
- No regressions in folder tree behavior

---

### U3. Rewrite FilePanel for tabs and resizability

**Goal:** Replace the single-file panel with a tabbed, resizable panel that can display multiple open files.

**Requirements:** R7, R8, R9, R10, R11

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/FilePanel.tsx`

**Approach:**
- New props:
  - `files: ViewedFile[]` — all open files
  - `activeFilePath: string` — which file is currently displayed
  - `onSelectFile: (path: string) => void` — switch active tab
  - `onCloseFile: (path: string) => void` — close a tab
  - `width: number` — panel width in pixels
  - `onWidthChange: (width: number) => void` — resize callback
- Export `ViewedFile` interface from this component (moved from `FileDrawer`)
- If `files.length === 0`, return `null` (panel hides completely)
- Tab bar: horizontal flex row with `overflow-x-auto scrollbar-hide`
  - Each tab: file name, close button
  - Active tab: `bg-surface-hover text-text-primary`
  - Inactive tab: `text-text-tertiary hover:text-text-secondary hover:bg-surface-hover`
  - Close button: `opacity-0 group-hover:opacity-100` on inactive, always visible on active; `hover:text-destructive`
- Content area: display the active file's content via `CodeBlockContent` with syntax highlighting and line numbers
- Copy button in header copies the active file's content
- Resize handle: 4px-wide absolute div on the left edge (`left: 0`)
  - Same drag behavior as sidebar: `mousedown` captures start, `document` listeners for `mousemove`/`mouseup`, clamp to bounds, suppress text selection, restore on release
  - Only call `onWidthChange` during drag; parent persists via `useResizableWidth`

**Technical design:**
> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*
>
> The panel is a flex column. The tab bar is a flex row with `flex-shrink-0` at the top. Below it is the content area (`flex-1 overflow-auto`). The resize handle is an absolute-positioned div at `left: 0`, `top: 0`, `bottom: 0`, `width: 4px`, `cursor-col-resize`. On mousedown, capture `clientX` and current width; on mousemove compute `newWidth = startWidth - (e.clientX - startX)` because dragging left widens the panel (the handle is on the left edge). Clamp to `[min, max]` before calling `onWidthChange`.

**Patterns to follow:**
- `src/client/components/WorkspaceTabs.tsx` — tab styling, active/inactive states, close button visibility, overflow handling
- `src/client/components/Sidebar.tsx` — resize handle DOM placement, drag event handling, body cursor/userSelect suppression
- `src/client/components/FilePanel.tsx` (existing) — `CodeBlockContent` usage, header layout, copy button

**Test scenarios:**
- Covers AE2. Happy path: panel appears with single tab when first file is opened
- Covers AE3. Happy path: clicking a tab switches to that file's content and highlights the tab
- Covers AE4. Happy path: dragging left edge resizes panel smoothly; width restores after reload
- Covers AE5. Happy path: closing the last tab hides the entire panel
- Edge case: opening a file that's already open switches to existing tab instead of creating duplicate
- Edge case: resize clamped to minimum and maximum bounds
- Edge case: rapid mouse-out during drag still releases correctly on mouseup anywhere
- Integration: copy button copies the currently active file's content

**Verification:**
- Panel renders when files are open, hides when empty
- Tabs switch correctly and show active state
- Close buttons remove tabs
- Resize handle works smoothly, respects bounds
- Width persists across reloads
- File content display (syntax highlighting, line numbers) unchanged

---

### U4. Remove FileDrawer and integrate new panel into App layout

**Goal:** Remove the FileDrawer overlay entirely and wire the new tabbed FilePanel into App's state and layout.

**Requirements:** R6, R10, R12

**Dependencies:** U2, U3

**Files:**
- Modify: `src/client/App.tsx`
- Delete: `src/client/components/FileDrawer.tsx`

**Approach:**
- Remove `FileDrawer` import and component usage
- Remove `drawerFile`, `setDrawerFile`, `pinnedFile`, `setPinnedFile`, `handlePinDrawer` state and callbacks
- Add new state in App:
  - `openFiles: ViewedFile[]`
  - `activeFilePath: string`
- Update `handleFileClick`:
  - Load file content via existing fetch
  - If file is already in `openFiles`, set `activeFilePath` to its path (switch to tab)
  - Otherwise append to `openFiles` and set as active
- Add `handleCloseFile(path)`:
  - Remove file from `openFiles`
  - If closing the active file, activate the next available file (or previous if last)
- Add `handleSelectFile(path)`: set `activeFilePath`
- Use `useResizableWidth` for file panel width:
  - `storageKey: 'file-panel-width'`
  - `defaultWidth: 384` (current `w-96`)
  - `minWidth: 200`, `maxWidth: 600`
- Pass width and callbacks to `FilePanel`
- Update `copyFileContent` to copy the active file's content (look up by `activeFilePath` in `openFiles`)
- `Sidebar`'s `onFileClick` prop continues to work — it now directly opens in the panel

**Patterns to follow:**
- Existing `handleFileClick` async fetch pattern
- `useResizableWidth` hook pattern from U1

**Test scenarios:**
- Covers AE1, AE2. Integration: clicking a file in tree opens it directly in side panel (no drawer)
- Covers AE2. Integration: clicking a search result opens it in side panel
- Integration: clicking an already-open file switches to its tab instead of duplicating
- Integration: closing a non-active tab removes it without changing the active file
- Integration: closing the active tab activates another tab and shows its content
- Integration: closing the last tab hides the panel, leaving sidebar and chat area only
- Integration: panel width restores on app launch
- Integration: layout remains stable at any panel width within bounds

**Verification:**
- App compiles and runs
- FileDrawer component file is deleted
- Clicking any file (tree or search) opens directly in panel
- Multiple files open as tabs
- Closing all tabs hides panel
- Resizing works and persists
- No console errors or warnings
- No regressions in chat panel or sidebar behavior

---

## System-Wide Impact

- **Interaction graph:** `App` no longer manages drawer/pinned file state; instead it manages an `openFiles` array and `activeFilePath`. `Sidebar` → `FileExplorer` → `onFileClick` chain remains unchanged in prop shape but changes behavior (direct panel open instead of drawer).
- **Error propagation:** File load failures in `handleFileClick` continue to log to console; no new error surfaces introduced.
- **State lifecycle risks:** `useFiles` store clears per-workspace state automatically. When switching workspaces, `App` should also clear `openFiles` and `activeFilePath` to avoid showing stale files from a different workspace.
- **Unchanged invariants:**
  - File content display via `CodeBlockContent` (syntax highlighting, line numbers, copy)
  - ChatPanel flex behavior and session switching
  - Sidebar tabs, session list, and file explorer tree loading
  - `useFiles` debounce, abort, and race-handling logic
  - Backend file search endpoint

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| File panel resize handle conflicts with sidebar resize handle | Place handles on opposite edges (sidebar right, panel left) with 4px width; they should not overlap in the layout |
| Stale file tabs when switching workspaces | Clear `openFiles` and `activeFilePath` in App when `activeWorkspaceId` changes |
| Duplicate `getFileIcon` logic across FileExplorer and FilePicker | Accept for now; deduplication is deferred follow-up work |
| Removing FileDrawer breaks any remaining imports | Verify all imports of `ViewedFile` from `./FileDrawer` are updated; only `FilePanel` imported it |

---

## Documentation / Operational Notes

- No additional operational monitoring required — this is a pure client-side UI change with no production runtime impact.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-29-file-search-and-resizable-file-panel-requirements.md](docs/brainstorms/2026-05-29-file-search-and-resizable-file-panel-requirements.md)
- Related plan: [docs/plans/2026-05-29-002-feat-resizable-sidebar-plan.md](docs/plans/2026-05-29-002-feat-resizable-sidebar-plan.md)
- Related code:
  - `src/client/components/Sidebar.tsx` — resize handle pattern
  - `src/client/hooks/use-sidebar-width.ts` — persistence pattern
  - `src/client/components/FilePicker.tsx` — search UI pattern
  - `src/client/stores/files-store.ts` — file search API hook
  - `src/client/components/WorkspaceTabs.tsx` — tab overflow pattern
