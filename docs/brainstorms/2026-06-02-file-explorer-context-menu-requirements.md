---
date: 2026-06-02
topic: file-explorer-context-menu
---

# File Explorer Context Menu

## Summary

Add right-click context menus to files and folders in the FileExplorer panel, providing "Reveal in Finder/Explorer" and "Copy full path" actions. Search results receive the same menu.

## Problem Frame

Users browsing files inside Comate often need to locate a file in their system file manager or copy its absolute path for use elsewhere. Today they must manually navigate from the workspace root, which is slow and error-prone. A context menu on file tree items collapses both needs into a single right-click action.

## Requirements

- R1. Right-clicking any file or folder row in the FileExplorer tree shows a context menu positioned at the cursor.
- R2. Right-clicking any search result in the FileExplorer search mode shows the same context menu.
- R3. The context menu contains a "Reveal in Finder/Explorer/File Manager" action that opens the system file manager at the item's location.
- R4. The context menu contains a "Copy full path" action that copies the item's absolute filesystem path to the clipboard.
- R5. The menu label for R3 adapts to the OS: "Reveal in Finder" on macOS, "Reveal in Explorer" on Windows, "Reveal in File Manager" on Linux.
- R6. Clicking outside the menu, pressing Escape, or selecting an action dismisses the menu.
- R7. The menu follows the existing visual style used by SessionList and TodoList context menus.

## Success Criteria

- Users can reveal any file or folder in the OS file manager without leaving Comate.
- Users can copy any file or folder's absolute path in one click.
- The interaction feels consistent with existing context menus in the app.

## Scope Boundaries

- No additional file operations (delete, rename, edit, create new file/folder).
- No context menus outside the FileExplorer panel.
- No drag-and-drop or multi-select actions.

## Key Decisions

- Both files and folders get the menu, not just files, since both are navigable in the OS file manager.
- "Copy full path" is included alongside "reveal" because it shares the same path-resolution mechanism and is a common companion action.
- The absolute path is resolved by combining the workspace's `folderPath` with the item's relative path within the tree.

## Dependencies / Assumptions

- The frontend has access to the active workspace's `folderPath` to construct absolute paths.
- The Tauri shell plugin or a backend endpoint can handle the "reveal" action cross-platform.
