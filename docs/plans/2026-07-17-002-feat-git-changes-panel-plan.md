---
title: Git Changes Panel - Plan
type: feat
date: 2026-07-17
topic: git-changes-panel
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

## Goal Capsule

- **Objective:** Add a right-side Git Changes panel to Comate so users can see the current workspace's changed files and inspect diffs without leaving the app.
- **Product authority:** User request — primary use cases are reviewing AI-made edits and checking for uncommitted changes.
- **Open blockers:** None.

## Product Contract

### Summary

Add an independent, collapsible right sidebar that lists changed files in the active workspace. The list supports folder-tree and flat views, keeps untracked files in a separate fixed group, and opens a diff view on double-click. Diff rendering defaults to unified inline and can toggle to side-by-side; untracked files render their full content. The first version is read-only and does not modify the repository.

### Problem Frame

Right now users leave Comate and open an external Git tool to see what changed in the workspace. This context switch is especially awkward when checking what the AI just modified or whether anything was left uncommitted. A right-side panel that surfaces git status and diffs next to the chat keeps the user's attention inside the workspace.

### Key Decisions

- **Independent right sidebar, not a ChatPanel drawer.** The panel lives at the same layout level as the left sidebar and file panel so it can be collapsed to an icon rail and later host additional tabs.
- **Read-only first version.** The panel displays status and diffs only; staging, discarding, and committing are intentionally out of scope to keep the first release focused and safe.
- **Folder-tree view by default, expanded to one level.** This balances seeing the directory structure with keeping the list compact.
- **Untracked files in a fixed top group.** Separating unversioned files makes them immediately visible and avoids mixing them with tracked changes.
- **Unified inline diff by default, with a side-by-side toggle.** The default matches terminal `git diff` habits; the toggle accommodates reviewing line-aligned changes when width allows.
- **Real-time updates via file-system watch with fallback.** The panel refreshes automatically when files change, but degrades gracefully to manual refresh (refresh on open plus a manual control) when watching is unavailable or too expensive.
- **Double-click opens a file's diff.** This matches the existing file-list interaction where double-click opens a file in the file panel.

### Requirements

#### Panel structure

R1. Add a collapsible right sidebar to the main application layout, at the same level as the existing left sidebar and file panel.
R2. The sidebar exposes a Git changes icon that toggles the panel between collapsed and expanded.
R3. The panel width is resizable and persisted across sessions.
R4. The panel's structure supports adding future tabs without replacing the component.

#### File list

R5. When expanded, the panel lists all changed files for the active workspace's git repository.
R6. The list supports a flat view and a folder-tree view; folder-tree is the default.
R7. In folder-tree view, directories that contain changes are expanded to one level by default and can be collapsed or expanded by the user.
R8. Untracked files are shown in a fixed top-level group separate from modified, added, deleted, and renamed files.
R9. Each item displays the file's git status and its path relative to the workspace root.
R10. Double-clicking a file opens its diff or content inside the panel.

#### Diff view

R11. Double-clicking a tracked changed file opens a diff view for that file.
R12. The diff view defaults to unified inline format.
R13. The user can toggle the diff view to side-by-side format.
R14. Double-clicking an untracked file opens the full file content with syntax highlighting.
R15. The diff view provides a way to return to the file list.

#### Updates

R16. The panel refreshes automatically when files in the workspace change.
R17. If automatic refresh is unavailable, the panel falls back to refresh on open plus a manual refresh control.

### Acceptance Examples

AE1. A user opens the Git Changes panel for a workspace with three modified files and two untracked files.
  - **Given:** The workspace has git changes.
  - **When:** The user expands the right Git Changes sidebar.
  - **Then:** The panel shows an "Untracked" group containing the two untracked files, followed by a folder tree showing the three modified files grouped by directory, with each file labeled as modified.

AE2. A user reviews a specific change.
  - **Given:** The Git Changes panel is open and a tracked modified file is visible.
  - **When:** The user double-clicks the file.
  - **Then:** The panel switches to a diff view of that file in unified inline format, and a control lets the user switch to side-by-side or return to the list.

AE3. A user checks an untracked file.
  - **Given:** The Git Changes panel is open and an untracked file is visible.
  - **When:** The user double-clicks the untracked file.
  - **Then:** The panel shows the full file content with syntax highlighting, not a diff.

AE4. Real-time update fallback.
  - **Given:** The panel is open but the workspace cannot be watched (for example, due to OS limits).
  - **When:** The user makes a change outside Comate.
  - **Then:** The panel does not update automatically, but clicking the refresh control or re-opening the panel reflects the new status.

### Scope Boundaries

- **Deferred for later:** Moving the existing left Files panel into the new right sidebar as an additional tab.
- **Out of this version:** Any git write operation (stage, unstage, discard, commit), inline editing inside the diff view, multi-select or bulk actions, search or filter inside the file list, and branch or commit-history management.

### Dependencies / Assumptions

- The active workspace is a git repository. If it is not, the panel shows an empty or unsupported state.
- The server can run git commands and observe file changes within the workspace folder path.
- Existing syntax-highlighting and markdown components are reused for file and diff rendering.

### Sources / Research

- `src/client/App.tsx` — current main layout with left sidebar, file panel, and chat area.
- `src/client/components/ChatPanel.tsx` — the existing right-side `DetailDrawer` lives inside the chat panel, confirming the need for a new top-level right sidebar.
- `src/server/routes/git-status.ts` — existing `/api/workspaces/:id/git-ref` route returns only the current ref; no file-status endpoint exists yet.
- `src/server/routes/files.ts` — workspace-scoped route pattern with path-traversal guard that the new git routes can follow.
- `src/client/components/FilePanel.tsx` — reuse of `CodeBlockContent` and `MarkdownPreview` for rendered content.
- `src/client/hooks/use-resizable-width.ts` — existing width persistence hook that the new panel can reuse.

---

## Planning Contract

**Product Contract preservation:** unchanged.

### Key Technical Decisions

- **App-level right sidebar.** The panel is rendered as a sibling of `<main>` in `App.tsx`, outside `ChatPanel`, so it stays workspace-scoped and can coexist with the session-level `DetailDrawer`. Width and collapse state are persisted in `localStorage` following the existing `use-resizable-width` / `use-sidebar-width` pattern.
- **Workspace-scoped `git-changes` route.** A new Express router under `/api/workspaces/:id/git-changes` provides `git status --porcelain` parsing and per-file diff. It reuses the workspace lookup and path-traversal guard from `files.ts` and `git-status.ts`, and verifies workspace access before returning data.
- **All git porcelain statuses are surfaced.** The file list includes modified, added, deleted, and renamed files, plus the separate untracked group. The status endpoint returns both index and working-tree status (`indexStatus`, `workingTreeStatus`) plus an optional `originalPath` for renames so staged and unstaged changes can be shown together. The diff endpoint accepts a `staged` flag so the correct diff can be fetched for the clicked status.
- **Real-time updates via `chokidar` + WebSocket push, with manual-refresh fallback.** A server-side watcher service watches the workspace root and `.git/index`, parses `.gitignore` patterns, debounces changes, and broadcasts a `git_changes` event through the existing `ComateWebSocketServer`. If the watcher cannot start, the service emits a `watcher_unavailable` event so the client can show a warning and fall back to refresh on open plus a manual refresh control.
- **Diff rendering reuses `CodeBlockContent`.** Unified inline diff is rendered with `language="diff"`. Side-by-side mode splits the diff text into removed and added panes and renders each with `CodeBlockContent`, switching back to unified automatically when the panel is narrower than a defined threshold. Untracked files reuse the existing `/files/content` endpoint and render with `CodeBlockContent` or `MarkdownPreview`.
- **Single-click selects, double-click opens.** The file list uses single-click for selection/highlight and double-click to open the read-only diff view inside the same panel, with a back/close control to return to the list.
- **Store owns panel state and diff content.** The `git-changes-store` holds the selected file, diff content, loading/error flags, view mode, and watcher availability. `GitDiffView` reads from the store rather than fetching independently.

### High-Level Technical Design

```mermaid
flowchart TB
  subgraph Client
    A[Panel toggle] -->|toggle| B[App]
    B --> C[GitChangesPanel]
    C --> D[git-changes-store]
    D --> E[wsClient]
    C --> F[GitDiffView]
    F --> G[CodeBlockContent / MarkdownPreview]
    F --> H[/files/content]
  end
  subgraph Server
    I[Express /api/workspaces/:id/git-changes] --> J[git-changes route]
    J --> K[git status / git diff]
    L[chokidar watcher] --> M[git-changes-service]
    M --> N[ComateWebSocketServer]
    N --> E
  end
  D --> I
```

The panel is a workspace-scoped UI surface. The client store fetches status when the panel opens or the active workspace changes and subscribes to WebSocket events while the panel is expanded. The server watcher emits events only when the file system actually changes, so polling is unnecessary in the common case.

### Sequencing

1. Add the server status and diff route so the client has data to fetch.
2. Add the server watcher service and WebSocket event plumbing so real-time updates are available.
3. Add the client store and the panel component, wired into `App.tsx`.
4. Add the diff view component and the unified/side-by-side toggle.
5. Add i18n strings and tests at each layer.

### Assumptions

- The git binary is available in the server process path and can execute within the workspace folder.
- The watcher parses `.gitignore` patterns (using the `ignore` package, layered like `file-search-fallback.ts`) and ignores common large directories (e.g., `node_modules`) to avoid performance problems.
- The diff output is capped (e.g., 500 KB or 5,000 lines) and falls back to a truncated/binary placeholder when exceeded.
- The existing WebSocket connection is reused for push updates; no new transport is introduced.

---

## Implementation Units

### U1. Server git-status endpoint

- **Goal:** Add a workspace-scoped endpoint that returns the current git status as a list of changed files.
- **Requirements:** R5, R8, R9.
- **Dependencies:** None.
- **Files:**
  - `src/server/routes/git-changes.ts` (new)
  - `src/server/index.ts` (register route)
  - `src/server/routes/git-changes.test.ts` (new)
- **Approach:** Create an Express router with `mergeParams: true`. Register it in `src/server/index.ts` *before* the catch-all `/api/workspaces/:id` chat routes so the `git-changes` sub-path is not shadowed. Verify workspace access before serving data. On `GET /`, look up the workspace, run `git status --porcelain=v1` with a timeout, parse the two-letter status codes, and return a flat array of `{ path, indexStatus, workingTreeStatus, originalPath }`. `indexStatus` and `workingTreeStatus` are the single-character porcelain codes (e.g., `M`, `A`, `D`, `R`, `?`). For renamed entries (`R  old -> new`), populate `originalPath` with the old path. Use the workspace folder as `cwd`. Log errors with `diagLog`/`diagWarn`; return `404` for missing workspace, `403` for unauthorized access, and `500` for unexpected failures without leaking stack traces. New server tests must import `../test-utils/test-env.js` as the first statement, following project convention.
- **Patterns to follow:** `src/server/routes/git-status.ts` for workspace lookup and git execution; `src/server/routes/files.ts` for JSON error shapes.
- **Test scenarios:**
  - Returns files with correct statuses for a workspace with staged, unstaged, and untracked changes.
  - Returns separate entries or dual status when a file has both staged and unstaged modifications.
  - Returns `originalPath` for renamed files.
  - Returns an empty list for a clean repository.
  - Returns `404` when the workspace does not exist.
  - Returns `403` when the requester does not have access to the workspace.
  - Returns an empty list (not a crash) when the workspace is not a git repository.
- **Verification:** `npm run test:server` passes for `git-changes.test.ts`.

### U2. Server git-diff endpoint

- **Goal:** Add a workspace-scoped endpoint that returns the diff for a tracked changed file.
- **Requirements:** R11.
- **Dependencies:** U1.
- **Files:**
  - `src/server/routes/git-changes.ts`
  - `src/server/routes/git-changes.test.ts`
- **Approach:** Add `GET /diff?path=...&staged=...`. Verify workspace access. Resolve `path` with `path.resolve`, then call `fs.realpath` (or reject symlinks via `fs.lstat`) and ensure the resolved path is the workspace root or begins with `workspaceRoot + path.sep`. Use `child_process.execFile` or `spawn` with `shell: false`, passing `path` as a discrete argument after `--`. Run `git diff --cached --no-color -- <path>` when `staged` is true, otherwise `git diff --no-color -- <path>`. Detect binary output by checking whether the output starts with `Binary files ... differ` and return `{ diff, isBinary }`. Cap diff output (e.g., 500 KB or 5,000 lines) and return `{ diff, isBinary, truncated: true }` when the cap is exceeded. Log errors with `diagLog`/`diagWarn`; return `404` for missing workspace, `403` for unauthorized or outside-workspace paths, and `500` for unexpected failures.
- **Patterns to follow:** `src/server/routes/files.ts` for `validatePath` and path-outside-workspace handling.
- **Test scenarios:**
  - Returns a text diff for a modified unstaged file.
  - Returns a cached diff when `staged=true`.
  - Returns `403` when the requested path is outside the workspace or resolves through a symlink outside it.
  - Rejects shell metacharacters in the `path` parameter by using argument-array execution.
  - Marks binary changes as `isBinary: true`.
  - Returns `truncated: true` for diffs exceeding the size/line cap.
  - Returns deletion-only diff for a deleted file.
- **Verification:** `npm run test:server` passes for `git-changes.test.ts`.

### U3. Server file watcher and WebSocket push

- **Goal:** Push git-status updates to clients when files in the workspace change.
- **Requirements:** R16, R17.
- **Dependencies:** U1, existing WebSocket server.
- **Files:**
  - `src/server/services/git-changes-service.ts` (new)
  - `src/server/websocket/types.ts` (update — extend existing WebSocket types with `subscribeGitChanges` / `unsubscribeGitChanges` messages and the `git_changes` / `watcher_unavailable` events)
  - `src/server/websocket/server.ts` (route requests, broadcast events)
  - `src/server/index.ts` (attach service to server lifecycle)
  - `src/server/services/git-changes-service.test.ts` (new)
- **Approach:** Build a service that uses `chokidar` to watch the workspace root and `.git/index`, ignoring paths covered by `.gitignore` (parsed with the `ignore` package, layered like `file-search-fallback.ts`) and common large directories such as `node_modules`. Set `followSymlinks: false`, ignore `.git/**` except `.git/index`, and cap the watched file count. Debounce change events per workspace, coalesce in-flight `git status --porcelain` calls across sockets, and broadcast a `git_changes` event to subscribed WebSocket sockets. Add `subscribeGitChanges` and `unsubscribeGitChanges` request types with payload `{ workspaceId: string }`; track subscriptions per workspace/socket and verify workspace access before subscribing. If `chokidar` fails to initialize, broadcast a `watcher_unavailable` event to the affected sockets so clients can fall back. Clean up watchers when the last socket unsubscribes, the workspace is removed, or the server shuts down (provide a `dispose()` method like `commands-service.ts`). New server tests must import `../test-utils/test-env.js` as the first statement.
- **Patterns to follow:** `src/server/services/commands-service.ts` for existing `chokidar` usage and `dispose()`; `src/server/websocket/server.ts` for request routing and event broadcasting.
- **Test scenarios:**
  - A file change triggers a `git_changes` event for subscribed sockets.
  - Unsubscribing stops events for that socket.
  - Multiple sockets for the same workspace do not trigger redundant `git status` runs.
  - Watcher initialization failure emits `watcher_unavailable` and does not crash the server.
  - `dispose()` closes watchers and releases resources.
- **Verification:** `npm run test:server` passes for service and WebSocket tests.

### U4. Client git-changes store

- **Goal:** Manage panel data, selection, view mode, diff content, and update strategy.
- **Requirements:** R5, R16, R17.
- **Dependencies:** U1, U3.
- **Files:**
  - `src/client/stores/git-changes-store.ts` (new)
  - `src/client/stores/git-changes-store.test.ts` (new)
- **Approach:** Create a Zustand store keyed by `workspaceId`. State per workspace includes `statusItems`, `selectedFile`, `diffContent`, `diffLoading`, `diffError`, `statusLoading`, `statusError`, `viewMode`, `isWatcherAvailable`, and `panelVisible`. Fetch status when the panel becomes visible or the active workspace changes, exposing `statusLoading`/`statusError` for UI feedback. While the panel is expanded, send `{ type: 'subscribeGitChanges', workspaceId }` and refetch on each `git_changes` event. On `watcher_unavailable`, set `isWatcherAvailable: false` and rely on refresh-on-open plus a manual `refresh()` action. Provide `openDiff(file)` to set `selectedFile`, `loadDiff()` to fetch the diff into `diffContent`, and `clearDiff()` to return to the list. Keep selectors narrow to avoid re-renders.
- **Patterns to follow:** `src/client/stores/files-store.ts` for per-workspace keyed state and fetch abort patterns; `src/client/stores/chat-store.ts` for `wsClient` request/event usage.
- **Test scenarios:**
  - Store fetches status for the active workspace and exposes loading/error states.
  - Store refetches when a WebSocket `git_changes` event arrives.
  - Store sets `isWatcherAvailable: false` and falls back to refresh-on-open plus manual refresh when it receives `watcher_unavailable`.
  - Store clears stale state when the workspace changes.
  - `openDiff` selects the file and `loadDiff` populates `diffContent` with the correct `staged` flag.
- **Verification:** `npm run test:client` passes for the store test.

### U5. Client GitChangesPanel component

- **Goal:** Render the collapsible right sidebar and the file list.
- **Requirements:** R1–R10.
- **Dependencies:** U4, U6, existing resizable-width/collapse hooks.
- **Files:**
  - `src/client/components/GitChangesPanel.tsx` (new)
  - `src/client/components/GitChangesPanel.test.tsx` (new)
- **Approach:** The component receives `width`, `isCollapsed`, `onToggleCollapse`, and `onWidthChange` from `App.tsx`. It uses the store for data and renders a header with tree/flat toggle, a refresh button, a watcher-unavailability warning indicator, and the file list. The list renders the fixed "Untracked" group first, then the folder-tree or flat view. Directories with changes expand one level by default. Status badges pair color-coded labels with a distinct icon or letter prefix (M, A, D, R, ??). The folder-tree uses ARIA tree semantics (`role="tree"`, `role="treeitem"`, `aria-expanded`) and arrow-key navigation. `GitDiffView` is rendered as a child when a file is selected. Single-click selects a file; double-click calls `openDiff(file)` and `loadDiff()`. Show loading skeletons while status loads and while the refresh button is active; surface refresh errors via a banner or toast.
- **Patterns to follow:** `src/client/components/Sidebar.tsx` for collapse/resize handle UI; `src/client/components/FileExplorer.tsx` for recursive tree rendering; `src/client/hooks/use-resizable-width.ts` for width persistence.
- **Test scenarios:**
  - Renders a loading skeleton while status is loading.
  - Renders an empty state when there are no changes.
  - Shows the untracked group above the changed files tree.
  - Toggles between tree and flat views.
  - Calls the store's `openDiff` action and renders `GitDiffView` on double-click.
  - Collapse/expand controls work.
  - Refresh button shows a spinner while loading and surfaces an error on failure.
- **Verification:** `npm run test:client` passes for the component test.

### U6. Client GitDiffView component

- **Goal:** Render the diff or full content for the selected file.
- **Requirements:** R11–R15.
- **Dependencies:** U2, U4, U5.
- **Files:**
  - `src/client/components/GitDiffView.tsx` (new)
  - `src/client/components/GitDiffView.test.tsx` (new)
- **Approach:** Read `selectedFile`, `diffContent`, `diffLoading`, and `diffError` from the store. For untracked files, fetch `/api/workspaces/:id/files/content?path=...` and render with `CodeBlockContent` (or `MarkdownPreview` for markdown files). For tracked files, the store fetches `/api/workspaces/:id/git-changes/diff?path=...&staged=${selectedFile.staged}`; render the unified inline diff with `CodeBlockContent` and `language="diff"`. When the diff response has `isBinary: true`, render a placeholder instead of the diff text; when `truncated: true`, show a "diff too large" notice. A toggle switches to side-by-side mode by splitting diff lines into removed and added columns, each rendered with `CodeBlockContent`. When the panel width is below a threshold (e.g., 360 px), automatically switch back to unified mode. For deleted files, show only removed hunk lines with a "file deleted" header. The header contains a back button (icon or label) that returns to the file list; pressing `Escape` also returns to the list, restoring the file-list scroll position.
- **Patterns to follow:** `src/client/components/FilePanel.tsx` for content rendering; `src/client/components/tool-renderers/renderers/EditRenderer.tsx` for before/after split-pane layout inspiration.
- **Test scenarios:**
  - Renders full content for an untracked file.
  - Renders a unified inline diff for a modified file.
  - Toggles to side-by-side mode.
  - Falls back to unified mode when the panel is too narrow.
  - Shows placeholders for binary and truncated diffs.
  - Shows a "file deleted" header with only removed lines for deleted files.
  - Returns to the file list when the back control is activated or `Escape` is pressed.
- **Verification:** `npm run test:client` passes for the component test.

### U7. App layout integration

- **Goal:** Mount the right sidebar in the main layout and provide a global toggle.
- **Requirements:** R1–R4.
- **Dependencies:** U5.
- **Files:**
  - `src/client/App.tsx`
  - `src/client/components/AppLayout.test.tsx` (update)
- **Approach:** Add `GitChangesPanel` as a sibling after `<main>` in `App.tsx`. Manage its width with `useResizableWidth`, clamped to a minimum (e.g., 240 px) and maximum (e.g., 50% of the window width), and its collapsed state with a mirror of `use-sidebar-width` logic. On small screens where the panel would obscure the chat, auto-collapse or render as an overlay. Render a Git changes icon in the panel's collapsed icon rail that toggles the panel between collapsed and expanded. Move focus into the panel header/file list when the panel opens and return focus to the toggle button when it closes. Structure the panel so future tabs can be added without replacing the component.
- **Patterns to follow:** `src/client/App.tsx` for layout order; `src/client/hooks/use-sidebar-width.ts` for collapse/restore behavior.
- **Test scenarios:**
  - Clicking the panel toggle shows the panel.
  - Clicking again collapses the panel.
  - Panel width respects min/max bounds.
  - Panel width persists across renders.
  - Focus moves into the panel on open and back to the toggle on close.
  - Existing layout tests still pass after adding the new panel.
- **Verification:** `npm run test:client` passes for updated App layout tests.

### U8. i18n strings

- **Goal:** Provide user-facing strings for the panel, diff view, and empty/error states.
- **Requirements:** All UI requirements.
- **Dependencies:** U5, U6.
- **Files:**
  - `src/client/i18n/en/common.json`
  - `src/client/i18n/zh-CN/common.json`
- **Approach:** Add keys for panel title, toggle tooltip, empty state, loading state, refresh, refresh error, watcher-unavailable warning, view-mode labels, diff-mode labels, status badges (with M/A/D/R/?? letter prefixes), binary/truncated diff placeholders, deleted-file header, and error messages. Keep keys grouped under a `gitChanges` namespace within the existing `common` namespace.
- **Test scenarios:**
  - English and Chinese strings render in the panel tests.
  - No missing-key warnings appear during client tests.
- **Verification:** `npm run test:client` and `npm run lint` pass.

### U9. Browser component test

- **Goal:** Verify the open-diff flow in a real browser using mocked store/fetch responses.
- **Requirements:** AE2, AE3.
- **Dependencies:** U1–U7.
- **Files:**
  - `src/client/components/GitChangesPanel.browser.test.tsx` (new)
- **Approach:** Use Playwright/Vitest browser mode to render `GitChangesPanel` with mocked store state and mocked fetch responses. Click the panel toggle, double-click a changed file, and assert that `GitDiffView` appears. For untracked files, assert that full content is rendered. This is a component-level browser test, not a full end-to-end test against a live server.
- **Patterns to follow:** Existing `*.browser.test.tsx` files for browser test setup.
- **Test scenarios:**
  - Toggling the panel shows the file list.
  - Double-clicking a modified file opens the diff view.
  - Double-clicking an untracked file opens the full content view.
- **Verification:** `npm run test:browser` passes for the browser test.

---

## Verification Contract

| Command | What it proves | Units covered |
|---|---|---|
| `npm run test:server` | Git status/diff route logic and watcher service behavior are correct. | U1, U2, U3 |
| `npm run test:client` | Store, panel, diff view, layout integration, and i18n work in jsdom. | U4, U5, U6, U7, U8 |
| `npm run test:browser` | The open-diff flow works in a real browser. | U9 |
| `npm run lint` | TypeScript and ESLint rules are satisfied across new and modified files. | All |

Before declaring the feature complete, also run the existing `Sidebar`, `FilePanel`, `ChatPanel`, and `AppLayout` tests to confirm no regressions in the layout or adjacent panels.

---

## Definition of Done

- All commands in the Verification Contract pass with no new warnings or failures.
- A user can open the Git Changes panel from the panel's collapsed icon rail, see changed files grouped with untracked files on top, double-click a file to open its diff, toggle between unified and side-by-side modes, and see untracked files rendered with syntax highlighting.
- File-system changes are reflected in the panel automatically when the watcher is active, and the panel degrades to manual refresh (refresh on open plus a manual control) when the watcher is unavailable.
- The panel width and collapsed state persist across app restarts.
- No server route leaks stack traces, allows path traversal outside the workspace, or executes user input through a shell.
- Workspace access is verified before serving git status, diffs, or WebSocket updates.
- No regression in existing sidebar, file panel, chat panel, or detail drawer behavior.
- Abandoned experimental code from implementation iterations is removed before the final diff is committed.
