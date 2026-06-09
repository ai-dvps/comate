---
date: 2026-06-02
status: completed
---

# feat: Add context menu to FileExplorer with "Reveal in Finder" and "Copy full path"

## Summary

Add right-click context menus to files and folders in the FileExplorer panel. The menu provides two actions: revealing the item in the system file manager and copying its absolute path to the clipboard.

## Problem Frame

Users browsing files inside Comate often need to locate a file in their system file manager or copy its absolute path for use elsewhere. Today they must manually navigate from the workspace root, which is slow and error-prone. A context menu on file tree items collapses both needs into a single right-click action.

## Requirements Trace

| Origin | Requirement |
|---|---|
| R1 | Right-clicking any file or folder row in the FileExplorer tree shows a context menu positioned at the cursor. |
| R2 | Right-clicking any search result in the FileExplorer search mode shows the same context menu. |
| R3 | The context menu contains a "Reveal in Finder/Explorer/File Manager" action that opens the system file manager at the item's location. |
| R4 | The context menu contains a "Copy full path" action that copies the item's absolute filesystem path to the clipboard. |
| R5 | The menu label for R3 adapts to the OS. |
| R6 | Clicking outside the menu, pressing Escape, or selecting an action dismisses the menu. |
| R7 | The menu follows the existing visual style used by SessionList and TodoList context menus. |

## Implementation Units

### U1. Add Tauri command for revealing files cross-platform

**Goal:** Add a Rust command that reveals a file or folder in the system file manager, and grant it the necessary capability.

**Requirements:** R3, R5

**Dependencies:** None

**Files:**
- `src-tauri/src/lib.rs` — add `reveal_in_file_manager` command

**Approach:**
- Add a new `#[tauri::command]` fn `reveal_in_file_manager(path: String, item_type: String)` in `src-tauri/src/lib.rs`.
- Use `std::process::Command` with the builder API (each argument passed as a separate `.arg()` to avoid shell interpolation issues with spaces):
  - macOS: `Command::new("open").arg("-R").arg(&path)`
  - Windows files: `Command::new("explorer").arg(format!("/select,{}"), path)`
  - Windows folders: `Command::new("explorer").arg(&path)`
  - Linux: `Command::new("xdg-open").arg(parent_dir)` — opens the parent directory without selecting the specific file (no universal cross-DE API for file selection exists on Linux)
- Register the command in the `invoke_handler` macro.
- Custom Tauri commands in v2 do not need explicit capability entries when `core:default` is already granted.

**Patterns to follow:**
- Existing command pattern in `src-tauri/src/lib.rs` (`get_api_port`, `update_badge_state`).

**Test scenarios:**
- **Happy path:** Invoking `reveal_in_file_manager` with a valid file path opens the system file manager at that location on each supported OS.
- **Error path:** Invoking with a non-existent path should fail gracefully without crashing the app.

**Verification:**
- The command is listed in the invoke handler.
- Manual test on each OS confirms the file manager opens at the correct location.

---

### U2. Add context menu UI to FileExplorer

**Goal:** Wire up right-click context menus on tree items and search results, resolving absolute paths and invoking reveal or copy actions.

**Requirements:** R1, R2, R3, R4, R5, R6, R7

**Dependencies:** U1

**Files:**
- `src/client/components/FileExplorer.tsx`
- `src/client/i18n/en/common.json`
- `src/client/i18n/zh-CN/common.json`
- `src/client/lib/platform.ts` (optional, if extending OS detection)

**Approach:**
- Add context menu state in `FileExplorer` following the exact pattern from `SessionList.tsx` and `TodoList.tsx`:
  - State shape: `{ x: number; y: number; itemPath: string; itemType: 'file' \| 'folder' } | null` — `itemPath` stores the relative path (the existing `nodePath` variable in `FileExplorer.tsx`)
  - `onContextMenu` handler on file/folder rows and search result rows.
  - `useEffect` for `mousedown` and `Escape` dismissal.
  - Fixed-position menu portal at the bottom of the component with `onClick` and `onMouseDown` `stopPropagation`.
- Drill a new `onContextMenu` callback prop through `TreeNodeProps` so `TreeNode` can report right-clicks up to `FileExplorer`.
- Resolve absolute paths by selecting the active workspace from `useWorkspaceStore` (`workspaces.find(w => w.id === activeWorkspaceId)`) and joining `workspace.folderPath` with the item's relative path. For tree items, join with `nodePath`; for search results, join with `entry.path`. Normalize separators for Windows (`\` in `folderPath` joined with `/` in relative paths).
- "Copy full path": use `navigator.clipboard.writeText(absolutePath).catch(...)` (pattern from `App.tsx`).
- "Reveal in ...": use `invoke('reveal_in_file_manager', { path: absolutePath, itemType }).catch(err => console.error('Failed to reveal:', err))` via `import { invoke } from '@tauri-apps/api/core'`.
- Close the menu immediately when either action is selected. Log errors to the console; do not show loading spinners or toasts.
- OS-adaptive label: use synchronous `navigator.platform` checks inline (e.g. `/Win/i.test(navigator.platform)`, `/Linux/i.test(navigator.platform)`) with a fallback to "Reveal in File Manager". This is consistent with the existing `platform.ts` pattern and avoids adding async complexity for a simple label swap.
- Add translation keys to `common.json` in both `en` and `zh-CN`:
  - `contextMenu.revealInFinder`
  - `contextMenu.revealInExplorer`
  - `contextMenu.revealInFileManager`
  - `contextMenu.copyFullPath`

**Patterns to follow:**
- Context menu state and dismissal from `SessionList.tsx` (line 52 for state, lines 102–114 for dismissal useEffect, lines 299–321 for menu JSX).
- Clipboard write from `App.tsx` (`copyFileContent`).
- Tauri invoke via `import { invoke } from '@tauri-apps/api/core'` (used in `src/client/lib/tauri-api.ts`).
- i18n namespace usage from existing components (`useTranslation('common')`).

**Test scenarios:**
- **Happy path — file:** Right-click a file in the tree; menu appears at cursor with both actions.
- **Happy path — folder:** Right-click a folder in the tree; menu appears with both actions.
- **Happy path — search result:** Right-click a search result; menu appears with both actions.
- **Happy path — copy path:** Selecting "Copy full path" copies the correct absolute path (workspace root + relative path) to the clipboard.
- **Happy path — reveal:** Selecting "Reveal in ..." invokes the Tauri command with the correct absolute path and `itemType`.
- **Edge case — no workspace path:** If the workspace's `folderPath` is unavailable, do not render the context menu on right-click (consistent with SessionList's conditional rendering).
- **Edge case — menu dismissal:** Pressing mouse down outside the menu, pressing Escape, or selecting an action closes the menu.
- **Integration:** The menu styling matches existing context menus (`bg-surface-active`, `border-border`, `shadow-lg`, item hover states).

**Verification:**
- Right-click on any file, folder, or search result shows the context menu.
- Both actions work correctly in a dev build.
- Menu styling is consistent with SessionList and TodoList.
- Chinese translations are present.

## Scope Boundaries

- No additional file operations (delete, rename, edit, create new file/folder).
- No context menus outside the FileExplorer panel.
- No drag-and-drop or multi-select actions.

## Key Technical Decisions

- **Custom Tauri command for reveal:** Chosen over a backend API endpoint because the app is a Tauri desktop app and shelling out from Rust is simpler and avoids a round-trip to the Node sidecar.
- **Frontend path resolution:** The frontend joins `workspace.folderPath` with the relative item path, normalizing mixed separators for Windows. This is lightweight and avoids adding a new API endpoint just for path resolution.
- **Browser Clipboard API for copy:** Chosen over a Tauri clipboard plugin because the codebase already uses `navigator.clipboard.writeText` successfully and no new dependency is needed.
- **Synchronous `navigator.platform` for OS label:** Chosen over extending `platform.ts` with async helpers because the label swap is immediate and does not warrant async complexity.
- **Menu closes immediately on action:** Chosen over showing loading states because the Tauri invoke is typically fast and the existing codebase does not use toasts for similar actions.

## Deferred to Follow-Up Work

- Extend `src/client/lib/platform.ts` with reusable `isWindows()` and `isLinux()` helpers if other features need them.
- Viewport-aware menu positioning (prevent clipping near edges) — pre-existing issue across all context menus in the app.
- Keyboard accessibility (Shift+F10 trigger, arrow-key navigation) for context menus — matches existing SessionList/TodoList patterns but is a known accessibility gap.
