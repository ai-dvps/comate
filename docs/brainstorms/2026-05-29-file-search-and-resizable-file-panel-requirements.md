---
date: 2026-05-29
topic: file-search-and-resizable-file-panel
---

# File Search and Resizable File Panel

## Summary

Add workspace-wide file search to the Files tab and replace the drawer-based file viewer with a persistent, resizable side panel that supports multiple open files as tabs.

---

## Problem Frame

Finding a specific file in a large workspace currently requires manually expanding folders in the tree view. There is no way to search by file name within the Files tab. When a file is located, clicking it opens a temporary overlay drawer that must be explicitly pinned to persist, creating a two-step interaction before the file can be viewed side-by-side with the chat. This friction slows down file discovery and context switching.

---

## Actors

- A1. User: browses the file tree, searches for files by name, opens files for side-by-side viewing, manages open file tabs, and resizes the file panel

---

## Key Flows

- F1. Search for a file
  - **Trigger:** User types in the search input in the Files tab
  - **Actors:** A1
  - **Steps:**
    1. User focuses the search input above the file list
    2. User types a query
    3. System debounces and performs a workspace-wide file search
    4. System displays matching files as a flat list with file icons
    5. User clicks a result
  - **Outcome:** The selected file opens in the side panel as a new tab
  - **Covered by:** R1, R2, R3, R4, R5

- F2. Open a file from the tree
  - **Trigger:** User clicks a file in the folder tree
  - **Actors:** A1
  - **Steps:**
    1. User expands folders and locates a file
    2. User clicks the file
  - **Outcome:** The file opens directly in the side panel as a new tab
  - **Covered by:** R6, R7

- F3. Manage open file tabs
  - **Trigger:** User interacts with tabs in the file panel
  - **Actors:** A1
  - **Steps:**
    1. User clicks a tab to switch between open files
    2. User clicks a tab's close button to remove a file
  - **Outcome:** The panel shows the selected file or hides completely when all tabs are closed
  - **Covered by:** R7, R8, R11

- F4. Resize the file panel
  - **Trigger:** User drags the edge of the file panel
  - **Actors:** A1
  - **Steps:**
    1. User hovers over the panel's left edge to reveal the resize handle
    2. User drags to the desired width
    3. User releases
  - **Outcome:** The panel remains at the chosen width and restores on next app launch
  - **Covered by:** R9, R10

---

## Requirements

**File search**
- R1. The Files tab includes a search input at the top of the file list area
- R2. Typing in the search input triggers a workspace-wide file search with debouncing (matching the existing `useFiles` debounce behavior)
- R3. Search results display as a flat list of file paths with appropriate file-type icons
- R4. Clearing the search input (empty string) returns the view to the folder tree
- R5. Clicking a search result opens the corresponding file in the side panel

**File panel**
- R6. Clicking a file in the tree opens it directly in the side panel; the drawer intermediate step is eliminated
- R7. The side panel supports multiple concurrently open files, each represented as a tab
- R8. Tabs display the file name and a close button; clicking a tab switches the panel to that file's content
- R9. The side panel has a draggable resize handle on its left edge (the edge adjacent to the sidebar)
- R10. Panel width respects minimum and maximum bounds and persists across application sessions via localStorage
- R11. The panel hides completely when no files are open; it does not render an empty placeholder
- R12. The existing `FileDrawer` overlay component is removed entirely

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3, R5.** Given the Files tab is active and the folder tree is visible, when the user types "config" in the search input, then matching files appear in a flat list below the input with file icons, and clicking a result opens that file in the side panel.
- AE2. **Covers R6, R7.** Given no files are open and the side panel is hidden, when the user clicks a file in the folder tree, then the side panel appears with the file content and a single tab showing the file name.
- AE3. **Covers R7, R8.** Given two files are open in the side panel, when the user clicks the second tab, then the panel displays the second file's content and the second tab becomes active.
- AE4. **Covers R9, R10.** Given the file panel is visible, when the user drags the left edge 100 pixels wider, then the panel resizes smoothly, the chat area adjusts accordingly, and the new width restores on the next app launch.
- AE5. **Covers R8, R11.** Given one file is open in the side panel, when the user clicks the tab's close button, then the tab disappears and the entire side panel hides, leaving only the sidebar and chat area.

---

## Success Criteria

- A user can locate and open any workspace file in under three seconds without manually expanding folder trees
- The file viewing experience feels direct: one click on a file shows its content side-by-side with the active chat
- Panel resizing is smooth, respects bounds, and does not cause layout thrashing or visual glitches
- The removal of the drawer does not regress any existing functionality (copy file content, syntax highlighting, line numbers)

---

## Scope Boundaries

- File content remains read-only; editing is not included
- Drag-and-drop tab reordering within the file panel is not included
- Split view or multi-pane layout within the file panel is not included
- Search within file contents is not included
- Changes to the Sessions tab or session management are not included
- Changes to the sidebar resizing behavior are not included

---

## Key Decisions

- **Workspace-wide flat search over in-tree filter:** A flat search across the entire workspace is more powerful for large projects and is consistent with the existing `FilePicker` search pattern. The tree view remains available when search is cleared.
- **Multiple files as tabs over single file:** Tabs allow users to reference multiple files without losing context, which is a common IDE pattern and was explicitly requested.
- **Panel hides when empty over placeholder:** Maximizing chat area when no files are being viewed is the preferred default.

---

## Dependencies / Assumptions

- The existing `/api/workspaces/{id}/files/search` endpoint supports workspace-wide file name search
- The existing `useFiles` store hook and its debounce/abort behavior can be reused for search state management in the Files tab
- The recently implemented sidebar resize pattern (`useSidebarWidth` hook and drag handle behavior) can be adapted for the file panel
- The existing `FilePanel` component's read-only display capabilities (syntax highlighting, line numbers, copy) are sufficient and do not need enhancement

---

## Outstanding Questions

### Resolve Before Planning

- None

### Deferred to Planning

- [Affects R7][Technical] Exact tab overflow behavior when many files are open (horizontal scroll, dropdown, or overflow menu)
- [Affects R9][Technical] Whether to generalize the recently created `useSidebarWidth` hook into a reusable `useResizableWidth` hook, or to create a separate hook for the file panel
