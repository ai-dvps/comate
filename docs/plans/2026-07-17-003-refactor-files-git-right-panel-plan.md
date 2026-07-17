---
title: Files and Git Changes Right Panel - Plan
type: refactor
date: 2026-07-17
topic: files-git-right-panel
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

## Goal Capsule

- **Objective:** Move the Files explorer from the left sidebar to the right side, group it with Git Changes, and replace both the left `FilePanel` and the existing `GitDiffPanel` with a single CodeMirror 6-based tabbed content panel on the right.
- **Product authority:** User request to group file-related views on the right.
- **Open blockers:** None.

## Product Contract

### Summary

Relocate the Files explorer from the left sidebar into a new right-side "Files & Changes" area. The right side has a collapsible list sidebar with Files and Git Changes tabs, and a tabbed content panel that shows both opened files and opened diffs. The content panel renders everything with CodeMirror 6. The left `FilePanel` and the existing `GitDiffPanel` are removed.

### Problem Frame

File-related views are currently split across the window: the file explorer sits in the left sidebar, opened files appear in a left panel, and git changes/diffs live on the right. Users reviewing files and AI-made changes together must shift attention between both sides. Grouping the file tree, opened files, and git changes/diffs on the right creates a single file-focused zone next to the chat.

### Key Decisions

- **CodeMirror 6 for rendering:** Replaces the existing file syntax highlighter and `@git-diff-view/react` diff renderer. `@codemirror/merge` provides unified inline diff and side-by-side diff views. CodeMirror 6 is lighter than Monaco and sufficient for a read-only viewer.
- **Mixed tab bar:** Opened files and opened diffs share the same content-panel tab bar, distinguished by file vs git icon and a diff status badge.
- **Single-click selects, double-click opens:** The Files tree matches the Git Changes list interaction model.
- **Two-icon collapsed rail:** Files and Git Changes each have their own icon in the collapsed rail.
- **Coupled collapse:** The list sidebar and the content panel collapse and expand together.
- **No persistence:** Active list tab and opened content tabs are per-session only; switching workspaces clears opened tabs, consistent with current behavior.

### Requirements

#### Layout

R1. Remove the left `FilePanel` from the main application layout.
R2. Remove the Files tab from the left `Sidebar`; the left Sidebar shows only Sessions and Todos tabs.
R3. Add a right list sidebar with Files and Git Changes tabs, sharing a single collapsed icon rail.
R4. The right list sidebar and the right content panel share collapse state: collapsing hides both, expanding shows both.
R5. The right content panel is a tabbed viewer that displays opened files and opened diffs in one tab bar.

#### Right list sidebar

R6. The Files tab shows the workspace file tree with search and a context menu (Reveal in Finder/Explorer/File Manager, Copy full path), preserving existing `FileExplorer` behavior.
R7. The Git Changes tab shows the workspace git status list with folder/flat views, an untracked group, and refresh, preserving existing `GitChangesPanel` behavior.
R8. The collapsed icon rail shows a Files icon and a Git Changes icon; clicking an icon expands the right side and activates the corresponding list tab.

#### Interactions

R9. Single-clicking a file in the Files tree selects/highlights it; double-clicking opens it as a tab in the right content panel.
R10. Single-clicking a changed file in the Git Changes list selects/highlights it; double-clicking opens its diff as a tab in the right content panel.
R11. Content tabs can be selected and closed; closing the last tab shows an empty state in the content panel.
R12. Switching workspaces clears all opened content tabs, consistent with current behavior.

#### Content panel rendering

R13. The content panel uses CodeMirror 6 for rendering both plain files and diffs.
R14. Plain file tabs render with syntax highlighting and Markdown preview for `.md` files.
R15. Diff tabs render unified inline diff by default and support a side-by-side toggle.
R16. Diff tabs preserve handling for untracked files, binary files, truncated diffs, and deleted files.
R17. Diff tabs display a status badge (M/A/D/R/?) next to the filename in the tab.
R18. File tabs display a file icon in the tab.

### Key Flows

- F1. Open a file from the Files tree
  - **Trigger:** User double-clicks a file in the Files tab.
  - **Steps:** Fetch file content, add a tab to the content panel, activate the new tab.
  - **Outcome:** The file content renders in the content panel with syntax highlighting or Markdown preview.

- F2. Open a diff from Git Changes
  - **Trigger:** User double-clicks a changed file in the Git Changes tab.
  - **Steps:** Fetch the original and modified content for the change, add a diff tab to the content panel, activate the new tab.
  - **Outcome:** The diff renders in the content panel in unified inline mode.

- F3. Switch between Files and Git Changes
  - **Trigger:** User clicks the Files or Git Changes list tab.
  - **Steps:** The list sidebar switches between the file tree and the git changes list.
  - **Outcome:** The content panel remains visible with its current tabs.

- F4. Collapse the right side
  - **Trigger:** User clicks the collapse control while the right side is expanded.
  - **Steps:** Both the list sidebar and the content panel collapse to the icon rail.
  - **Outcome:** Only the icon rail remains visible; Files and Git icons are shown.

### Acceptance Examples

- AE1. Open a file from Files.
  - **Given:** The Files tab is active and the file tree is visible.
  - **When:** The user double-clicks `src/App.tsx`.
  - **Then:** A tab labeled `App.tsx` with a file icon appears in the content panel, and `App.tsx` content renders with syntax highlighting.

- AE2. Open a diff from Git Changes.
  - **Given:** The Git Changes tab is active and a modified file is visible.
  - **When:** The user double-clicks the modified file.
  - **Then:** A tab labeled `App.tsx` with a git icon and an `M` badge appears, and the diff renders in unified inline mode.

- AE3. Switch list tabs while content tabs remain open.
  - **Given:** The Files tab is active and the content panel has an open file tab.
  - **When:** The user clicks the Git Changes tab.
  - **Then:** The list sidebar shows the git changes list, and the content panel still shows the open file tab.

- AE4. Collapse the right side with open tabs.
  - **Given:** The right side is expanded with an open file tab.
  - **When:** The user clicks the collapse control.
  - **Then:** Both the list sidebar and the content panel hide, leaving only the icon rail with Files and Git icons.

### Scope Boundaries

- **Deferred for later:** Inline editing in the content panel, full IDE features such as IntelliSense or go-to-definition, persisting open tabs across sessions, adding more tabs to the right list sidebar, and independent resizing between the list sidebar and content panel.
- **Out of this version:** Git write operations (stage, discard, commit), renaming or reorganizing the left Sidebar's Sessions/Todos tabs, and mobile layout changes beyond the existing collapse threshold.

### Dependencies / Assumptions

- CodeMirror 6 (`@uiw/react-codemirror`, `@codemirror/merge`) can render the file types and diff shapes currently handled by `CodeBlockContent` and `@git-diff-view/react`.
- A new server endpoint can return original and modified file content pairs for diff rendering.
- Workspace file and git endpoints remain unchanged.
- Existing `FileExplorer` and `GitChangesPanel` list logic can be reused inside the new right list sidebar.

### Sources / Research

- `docs/plans/2026-07-17-002-feat-git-changes-panel-plan.md` — Git Changes panel plan that explicitly deferred moving Files to the right sidebar.
- `src/client/App.tsx` — current main layout.
- `src/client/components/Sidebar.tsx` — current left sidebar tabs.
- `src/client/components/FileExplorer.tsx` — current file tree.
- `src/client/components/FilePanel.tsx` — current left file viewer.
- `src/client/components/GitDiffPanel.tsx` — current diff viewer.
- `src/client/components/GitChangesPanel.tsx` — current right git changes list.
- CodeMirror 6 Reference Manual (`https://codemirror.net/docs/ref/`) — `@codemirror/merge` `unifiedMergeView` and `MergeView` APIs.
- `@uiw/react-codemirror` documentation (`https://www.npmjs.com/package/@uiw/react-codemirror`) — React wrapper for CodeMirror 6.
- `@codemirror/merge` package (`https://www.npmjs.com/package/@codemirror/merge`) — diff/merge extension.

---

## Planning Contract

**Product Contract preservation:** unchanged except where the refactor directly changes layout and rendering.

### Key Technical Decisions

- **Single combined right area (`RightPanel`).** A new top-level component replaces `FilePanel` and `GitDiffPanel` and wraps the existing `GitChangesPanel` list behavior together with the relocated `FileExplorer`. It exposes a shared collapse state and a single resize handle for the whole right area.
- **Content panel owns mixed tabs.** A new `RightPanelContent` component renders a single tab bar for both file and diff tabs. Tab state is moved from `App.tsx` into a dedicated `right-panel-store.ts` so the panel, content viewer, and list components share it without prop drilling.
- **CodeMirror 6 for all rendering.** Plain files use `@uiw/react-codemirror` with a custom theme that reads the app's CSS variables and a language extension selected from a lightweight extension map. Markdown files continue to use `MarkdownPreview`. Diffs use `@codemirror/merge`: `unifiedMergeView` for unified mode and `MergeView` for side-by-side mode.
- **Diff rendering needs original + modified content.** `@codemirror/merge` operates on two documents, not on a pre-computed unified diff patch. A new server endpoint `/api/workspaces/:id/git-changes/compare` returns `{ original, modified, isBinary, truncated, isDeleted }`. The existing `/diff` endpoint is deprecated and removed once the compare endpoint is wired in.
- **Untracked, binary, truncated, and deleted diffs preserve existing UX.** Untracked and binary diff tabs show the same placeholders as today. Deleted files render with the original content shown as fully removed. Truncated diffs show a warning header and render the truncated pair.
- **Theme-aware CodeMirror setup.** A custom CodeMirror theme extension reads the `dark` class on `document.documentElement` and uses the app's HSL CSS variables for background, text, gutter, line numbers, selection, and cursor colors.
- **File tree interaction changes.** `FileExplorer` is updated to track a selected path and emit `onSelect` on single click and `onOpen` on double click, matching `GitChangesPanel`.

### High-Level Technical Design

```mermaid
flowchart TB
  subgraph App
    A[App.tsx] --> B[Sidebar <br/> Sessions/Todos only]
    A --> C[ChatPanel]
    A --> D[RightPanel]
    D --> E[Collapsed icon rail <br/> Files + Git icons]
    D --> F[List sidebar]
    F --> G[Files tab <br/> FileExplorer]
    F --> H[Git Changes tab <br/> GitChangesPanel]
    D --> I[RightPanelContent <br/> mixed file/diff tabs]
    I --> J[CodeMirrorFileViewer]
    I --> K[CodeMirrorDiffViewer]
  end
  subgraph Server
    L[/api/workspaces/:id/files/content] --> M[file content]
    N[/api/workspaces/:id/git-changes/compare] --> O[original + modified pair]
  end
  J --> L
  K --> N
```

The right area is a single flex container. From left to right inside it: content panel, list sidebar, icon rail. Collapsing hides the content panel and list sidebar, leaving only the rail. The whole area width is persisted; the list sidebar keeps a fixed width (e.g. 280 px) and the content panel fills the remainder.

### Sequencing

1. Add the server `compare` endpoint and tests (U1).
2. Add client dependencies and the CodeMirror theme/language helpers (U2).
3. Add the `right-panel-store.ts` tab state store and `use-right-panel-width.ts` hook (U3).
4. Build `RightPanel`, `RightPanelContent`, `CodeMirrorEditor`, `CodeMirrorFileViewer`, and `CodeMirrorDiffViewer` (U4).
5. Update `FileExplorer` for select-vs-open semantics (U5).
6. Update `Sidebar.tsx` to remove the Files tab and update `App.tsx` to remove `FilePanel`/`GitDiffPanel` and mount `RightPanel` (U6).
7. Update `GitChangesPanel` to integrate with the new tab store and remove its own diff-view state (U7).
8. Add i18n strings and tests (U8, U9).

### Assumptions

- The server git binary can produce `git show HEAD:<path>` and `git show :0:<path>` output for original/index content.
- Binary detection can reuse the existing `git diff --numstat` or null-byte heuristic approach.
- The CodeMirror 6 dependency tree is compatible with React 18 and the existing Vite build.

---

## Implementation Units

### U1. Server compare endpoint

- **Goal:** Provide original and modified file content so the client can render CodeMirror 6 diffs.
- **Requirements:** R13, R15, R16.
- **Dependencies:** None.
- **Files:**
  - `src/server/routes/git-changes.ts` (modify)
  - `src/server/routes/git-changes.test.ts` (modify)
- **Approach:** Add `GET /api/workspaces/:id/git-changes/compare?path=&staged=`. Reuse `resolveAndValidatePath` from the existing route. Determine `original` and `modified` content as follows:
  - `original`: run `git show HEAD:${relativePath}`. If the file is added (`A`), `original` is an empty string.
  - `modified`: when `staged=false`, read the working tree file (reuse `/files/content` logic); when `staged=true`, run `git show :0:${relativePath}`. If the file is deleted (`D`), `modified` is an empty string.
  - Detect binary by running `git diff --numstat --no-color -- <path>` (or `--cached` for staged) and checking for `-\t-` output, or by scanning content for null bytes.
  - Cap total fetched size (e.g. 500 KB per side, 5000 lines) and return `truncated: true` when exceeded.
  - Return `{ original, modified, isBinary, truncated, isDeleted }`.
  - For renamed files, the `path` query is the new path; use `originalPath` from status if needed to fetch original content.
  - Handle errors like the existing diff endpoint: `404` for missing workspace, `400` for missing path, `403` for outside-workspace paths, `500` for unexpected failures.
- **Patterns to follow:** Existing `git-changes.ts` for workspace lookup, path validation, and error shapes.
- **Test scenarios:**
  - Returns original HEAD content and modified working-tree content for an unstaged modified file.
  - Returns original HEAD content and modified index content for a staged file.
  - Returns empty `original` for an added file and empty `modified` for a deleted file.
  - Marks binary files as `isBinary: true`.
  - Returns `truncated: true` when content exceeds the cap.
  - Returns `403` for paths outside the workspace.
  - Returns `404` for missing workspace.
- **Verification:** `npm run test:server` passes for `git-changes.test.ts`.

### U2. CodeMirror dependencies and theme/language helpers

- **Goal:** Install CodeMirror 6 packages and create reusable helpers for theming and language selection.
- **Requirements:** R13, R14.
- **Dependencies:** None.
- **Files:**
  - `package.json` (modify)
  - `src/client/lib/codemirror-theme.ts` (new)
  - `src/client/lib/codemirror-language.ts` (new)
- **Approach:**
  - Add dependencies:
    - `@uiw/react-codemirror`
    - `@codemirror/merge`
    - `@codemirror/view`, `@codemirror/state`, `@codemirror/commands`, `@codemirror/language` (transitively required; pin compatible versions)
    - `@codemirror/lang-javascript` (covers JS/TS/JSX/TSX), `@codemirror/lang-json`, `@codemirror/lang-html`, `@codemirror/lang-css`, `@codemirror/lang-markdown`, `@codemirror/lang-python`, `@codemirror/lang-rust`, `@codemirror/lang-cpp`, `@codemirror/lang-java`, `@codemirror/lang-php`, `@codemirror/lang-sql`, `@codemirror/lang-xml`, `@codemirror/lang-yaml`
  - Create `codemirror-theme.ts` exporting a `comateTheme` extension:
    - Use `EditorView.theme({ ... }, { dark })` with CSS rules that reference the app's CSS variables (`--color-bg`, `--color-text-primary`, `--color-text-secondary`, `--color-text-tertiary`, `--color-accent`, `--color-border`, `--color-surface-hover`, `--color-destructive`, `--color-success`, `--color-warning`).
    - Set editor background to `transparent`, text color to `hsl(var(--color-text-primary))`, gutters to transparent, line numbers to `hsl(var(--color-text-tertiary))`, selection to `hsl(var(--color-accent) / 0.2)`.
    - Diff-specific styles: override `.cm-deletedChunk` background/border to use `hsl(var(--color-destructive) / 0.15)`, `.cm-insertedLine` to use `hsl(var(--color-success) / 0.15)`, and gutter markers to match status badge colors.
    - React to theme changes by reconfiguring a `Compartment` when `document.documentElement.classList.contains('dark')` changes.
  - Create `codemirror-language.ts` exporting `getCodeMirrorLanguage(filename: string)`:
    - Map file extension to the appropriate language extension factory (e.g. `javascript({ typescript: true })` for `.ts`/`.tsx`, `markdown()` for `.md`, `json()` for `.json`, etc.).
    - Return `null` for unknown extensions; the caller renders plain text.
- **Patterns to follow:** `src/client/lib/language.ts` for filename-to-language mapping; `src/client/hooks/use-theme.ts` for dark-mode detection.
- **Test scenarios:**
  - `getCodeMirrorLanguage` returns the expected extension for `.ts`, `.tsx`, `.js`, `.json`, `.md`, `.py`, `.rs`, `.cpp`, `.yaml`, and unknown extensions.
  - Theme helper produces a valid CodeMirror extension object.
- **Verification:** `npm install` succeeds and `npm run lint` passes.

### U3. Right panel state and width hooks

- **Goal:** Manage right-area collapse/width and content tabs in one place.
- **Requirements:** R4, R5, R11, R12.
- **Dependencies:** None.
- **Files:**
  - `src/client/hooks/use-right-panel-width.ts` (new)
  - `src/client/stores/right-panel-store.ts` (new)
  - `src/client/stores/right-panel-store.test.ts` (new)
- **Approach:**
  - `use-right-panel-width.ts`: mirror `use-sidebar-width.ts` logic with keys `right-panel-width`, `right-panel-collapsed`, and `right-panel-previous-width`. Default expanded width 640 px, min 360 px, max 50% of window width. Return `{ width, setWidth, isCollapsed, toggleCollapse, expandedWidth }`. When collapsed, width equals `RAIL_WIDTH` (48 px).
  - `right-panel-store.ts`: Zustand store with shape:
    ```ts
    interface RightPanelState {
      activeListTab: 'files' | 'git-changes'
      openTabs: ContentTab[]
      activeTabId: string | null
      setActiveListTab: (tab: 'files' | 'git-changes') => void
      openFile: (workspaceId: string, path: string, name: string) => Promise<void>
      openDiff: (workspaceId: string, item: GitStatusItem) => Promise<void>
      closeTab: (id: string) => void
      selectTab: (id: string) => void
      clearTabs: () => void
    }
    ```
    - `ContentTab` is a discriminated union:
      - `FileTab`: `{ type: 'file', id, path, name, content, isBinary }`
      - `DiffTab`: `{ type: 'diff', id, path, name, statusCode, original, modified, isBinary, truncated, isDeleted, isUntracked, error }`
    - `openFile` fetches `/api/workspaces/:id/files/content`, creates a `FileTab`, and activates it. If a file tab for the same path already exists, just activate it.
    - `openDiff` fetches `/api/workspaces/:id/git-changes/compare`, creates a `DiffTab`, and activates it. If a diff tab for the same path and status already exists, just activate it.
    - `closeTab` removes the tab and activates the nearest remaining tab; if none remain, set `activeTabId` to `null`.
    - `clearTabs` removes all tabs and resets `activeTabId`.
    - Tab IDs can be deterministic (`file:<path>` and `diff:<path>:<statusCode>`) to make deduplication simple.
  - Clear tabs automatically when the active workspace changes. Because the store does not know the active workspace, `App.tsx` calls `clearTabs()` in the workspace-change effect.
- **Patterns to follow:** `src/client/stores/files-store.ts` for fetch/abort patterns; `src/client/stores/git-changes-store.ts` for per-workspace state.
- **Test scenarios:**
  - `openFile` adds a file tab and activates it.
  - Opening the same file twice activates the existing tab.
  - `openDiff` adds a diff tab with correct status badge.
  - `closeTab` removes the tab and activates another.
  - `clearTabs` removes all tabs.
  - `setActiveListTab` updates the active list tab.
- **Verification:** `npm run test:client` passes for the store test.

### U4. Right panel and content viewer components

- **Goal:** Build the new right-area shell and the tabbed CodeMirror content viewer.
- **Requirements:** R3, R4, R5, R11, R13, R14, R15, R16, R17, R18.
- **Dependencies:** U2, U3.
- **Files:**
  - `src/client/components/RightPanel.tsx` (new)
  - `src/client/components/RightPanelContent.tsx` (new)
  - `src/client/components/CodeMirrorEditor.tsx` (new)
  - `src/client/components/CodeMirrorFileViewer.tsx` (new)
  - `src/client/components/CodeMirrorDiffViewer.tsx` (new)
  - `src/client/components/RightPanel.test.tsx` (new)
- **Approach:**
  - `RightPanel.tsx`:
    - Props: `width`, `isCollapsed`, `toggleCollapse`, `onWidthChange`, `workspaceId`, `workspacePath`.
    - Render order: content panel (`RightPanelContent`), list sidebar, icon rail.
    - The list sidebar renders tab buttons "Files" and "Git Changes" at the top, then `FileExplorer` or `GitChangesPanel` below.
    - The icon rail renders two tooltip-wrapped buttons: Files (Folder icon) and Git Changes (GitBranch icon). Clicking an icon expands the panel (if collapsed) and switches to that list tab.
    - A collapse/expand chevron is placed at the top of the list sidebar and rail.
    - Resize handle on the left edge of the whole right area adjusts total width.
    - List sidebar width is fixed at 280 px; content panel fills the remainder.
  - `RightPanelContent.tsx`:
    - Reads `openTabs` and `activeTabId` from `right-panel-store.ts`.
    - Renders a horizontal tab bar. Each tab shows:
      - File tab: file icon from `getFileIcon`, filename, close button.
      - Diff tab: GitBranch icon, filename, status badge, close button.
    - Active tab is highlighted.
    - Click selects; close button closes.
    - If no tabs are open, render an empty-state message.
    - Below the tab bar, render the active tab's viewer component.
  - `CodeMirrorEditor.tsx`:
    - Shared wrapper around `@uiw/react-codemirror`.
    - Props: `value`, `language`, `readOnly`, `className`.
    - Applies the custom `comateTheme`, `basicSetup` with line numbers, read-only settings (`editable={false}`, `readOnly={true}`), and the language extension if provided.
    - Accepts additional extensions via props so diff viewers can inject `unifiedMergeView`.
  - `CodeMirrorFileViewer.tsx`:
    - Props: `tab: FileTab`, `workspacePath`.
    - Header shows absolute path and a copy-content button.
    - If the file is markdown, render `MarkdownPreview` instead of CodeMirror.
    - Otherwise render `CodeMirrorEditor` with the appropriate language.
    - For binary files, show a placeholder.
  - `CodeMirrorDiffViewer.tsx`:
    - Props: `tab: DiffTab`, `workspacePath`, `width`.
    - Local state: `diffMode: 'unified' | 'sideBySide'`.
    - Header shows absolute path, status badge, and a toggle button (unified/side-by-side). Hide the toggle for untracked files.
    - If `isBinary`, show the binary placeholder.
    - If `error`, show an error banner.
    - If `isUntracked`, render the modified content as a file viewer (CodeMirror or MarkdownPreview).
    - Unified mode: render `CodeMirrorEditor` with `doc={modified}` and extension `unifiedMergeView({ original, highlightChanges: true, gutter: true, syntaxHighlightDeletions: true, mergeControls: false })`.
    - Side-by-side mode: instantiate `MergeView` from `@codemirror/merge` in a `useEffect` against a DOM ref, with `a` containing original content and `b` containing modified content. Destroy the view on cleanup. Pass the same theme and read-only settings to both editors. If `width` is below 360 px, force unified mode.
    - For deleted files, `modified` is empty so the unified view shows all original content as deleted; side-by-side shows empty right pane.
    - For truncated diffs, render a warning header above the viewer.
- **Patterns to follow:** `src/client/components/FilePanel.tsx` and `src/client/components/GitDiffPanel.tsx` for headers, paths, copy, and placeholders; `src/client/components/GitChangesPanel.tsx` for status badge colors.
- **Test scenarios:**
  - `RightPanel` renders collapsed icon rail with Files and Git icons.
  - Expanding the panel shows the list sidebar and content panel.
  - Clicking the Git icon switches to the Git Changes list tab.
  - `RightPanelContent` renders file and diff tabs with correct icons/badges.
  - Closing a tab removes it and shows empty state when last tab is closed.
  - `CodeMirrorDiffViewer` forces unified mode when width is below threshold.
- **Verification:** `npm run test:client` passes for new and updated component tests.

### U5. Update FileExplorer for select-vs-open semantics

- **Goal:** Make the Files tree use single-click for selection and double-click for opening.
- **Requirements:** R6, R9.
- **Dependencies:** U3.
- **Files:**
  - `src/client/components/FileExplorer.tsx` (modify)
  - `src/client/components/FileExplorer.test.tsx` (new or update if exists)
- **Approach:**
  - Add props `selectedPath?: string` and `onSelectPath?: (path: string) => void`.
  - Keep `onFileClick` but repurpose it to mean "open" (called on double-click). Rename internally for clarity if needed, but keep the prop name to minimize call-site churn or rename it to `onFileOpen` and update callers.
  - Single-click on a file row sets selection via `onSelectPath` and highlights the row.
  - Double-click calls `onFileClick`/`onFileOpen`.
  - Apply highlight styles using `bg-accent/10 text-text-primary` when selected.
  - Search results also support single-click select and double-click open.
  - Context menu still works on right-click.
- **Patterns to follow:** `src/client/components/GitChangesPanel.tsx` for single-click select / double-click open behavior.
- **Test scenarios:**
  - Single-clicking a file highlights it and calls `onSelectPath`.
  - Double-clicking a file calls the open handler.
  - Context menu still reveals on right-click.
- **Verification:** `npm run test:client` passes for FileExplorer tests.

### U6. Update App.tsx layout

- **Goal:** Remove the left file panel and existing diff panel, mount the new right panel.
- **Requirements:** R1, R2, R3, R4, R5.
- **Dependencies:** U3, U4.
- **Files:**
  - `src/client/App.tsx` (modify)
  - `src/client/components/AppLayout.test.tsx` (modify)
- **Approach:**
  - Remove `FilePanel` import and JSX, remove `GitDiffPanel` import and JSX.
  - Remove `openFiles`, `activeFilePath`, `openDiffs`, `activeDiffPath`, `filePanelWidth`, `gitDiffPanelWidth`, and related handlers from `App.tsx`.
  - Keep `handleFileClick` (single-click) behavior for tool renderers that open files; route it through `rightPanelStore.openFile` instead of local state.
  - Add `useRightPanelWidth()` and pass its values to `RightPanel`.
  - Mount `RightPanel` after `<main>` in the layout.
  - Call `rightPanelStore.clearTabs()` in the workspace-change effect.
  - Remove the `FilePanel` mock from `AppLayout.test.tsx` and add a `RightPanel` mock; update layout assertions.
- **Patterns to follow:** Existing `App.tsx` layout order.
- **Test scenarios:**
  - `AppLayout` no longer renders `FilePanel` or `GitDiffPanel`.
  - `AppLayout` renders `RightPanel`.
  - Workspace switch clears open tabs.
- **Verification:** `npm run test:client` passes for `AppLayout.test.tsx`.

### U7. Update Sidebar and GitChangesPanel

- **Goal:** Remove the Files tab from the left sidebar and wire Git Changes into the new right panel tab store.
- **Requirements:** R2, R7, R10.
- **Dependencies:** U3, U5.
- **Files:**
  - `src/client/components/Sidebar.tsx` (modify)
  - `src/client/components/Sidebar.test.tsx` (modify)
  - `src/client/components/GitChangesPanel.tsx` (modify)
- **Approach:**
  - `Sidebar.tsx`: remove the `files` tab from the `tabs` array and the `onFileClick`/`onFileDoubleClick` props. Keep only Sessions and Todos. Update i18n keys if needed.
  - `Sidebar.test.tsx`: update tests to expect only two tabs and two collapsed icons.
  - `GitChangesPanel.tsx`: remove the diff-view rendering path (the old `GitDiffView` if it exists; the current component only lists files). Change `onOpenDiff` prop usage to call `rightPanelStore.openDiff(workspaceId, file)` directly. Remove local state for selected file/diff if any remains. Keep list rendering, collapse/resize, and WebSocket subscription logic unchanged.
- **Patterns to follow:** Existing `GitChangesPanel.tsx` for list rendering.
- **Test scenarios:**
  - `Sidebar` renders only Sessions and Todos tabs.
  - `Sidebar` collapsed rail shows only two icons.
  - `GitChangesPanel` double-click calls `rightPanelStore.openDiff`.
- **Verification:** `npm run test:client` passes for updated tests.

### U8. i18n strings

- **Goal:** Provide user-facing strings for the new right panel UI.
- **Requirements:** All UI requirements.
- **Dependencies:** U4, U6, U7.
- **Files:**
  - `src/client/i18n/en/common.json` (modify)
  - `src/client/i18n/zh-CN/common.json` (modify)
- **Approach:** Add keys under a new `rightPanel` group:
  - `files`: "Files"
  - `gitChanges`: "Git Changes"
  - `showFiles`: "Show files"
  - `showGitChanges`: "Show git changes"
  - `collapse`: "Collapse right panel"
  - `expand`: "Expand right panel"
  - `emptyState`: "Open a file or change to view it"
  - `closeTab`: "Close tab"
  - `copyContent`: "Copy content" (can reuse existing top-level key)
  - `diffModeUnified`: "Unified diff"
  - `diffModeSideBySide`: "Side-by-side diff"
  - Extend `gitChanges` if needed for status badge tooltips.
- **Patterns to follow:** Existing `gitChanges` group in `common.json`.
- **Test scenarios:**
  - English and Chinese strings render in component tests.
  - No missing-key warnings during client tests.
- **Verification:** `npm run test:client` and `npm run lint` pass.

### U9. Tests and cleanup

- **Goal:** Verify the refactor end-to-end and remove dead code.
- **Requirements:** All.
- **Dependencies:** U1–U8.
- **Files:**
  - `src/client/components/RightPanel.browser.test.tsx` (new)
  - `src/client/components/CodeMirrorDiffViewer.test.tsx` (new)
  - `src/client/components/GitDiffPanel.tsx` (delete)
  - `src/client/components/FilePanel.tsx` (delete)
  - `src/client/components/git-diff-panel.css` (delete)
  - `package.json` (modify to remove `@git-diff-view/react`)
- **Approach:**
  - Browser test: render `RightPanel` with mocked store state and fetch responses. Assert that double-clicking a file in the Files tab opens a CodeMirror file tab, and double-clicking a git change opens a diff tab.
  - Add unit tests for `CodeMirrorDiffViewer` mocking `@codemirror/merge` and `@uiw/react-codemirror` if needed.
  - Delete `FilePanel.tsx`, `GitDiffPanel.tsx`, and `git-diff-panel.css` once `RightPanel` is wired.
  - Remove `@git-diff-view/react` from `package.json` dependencies.
- **Patterns to follow:** Existing `*.browser.test.tsx` files for browser test setup.
- **Test scenarios:**
  - Browser: open file from Files tree renders CodeMirror.
  - Browser: open diff from Git Changes renders unified diff.
  - Unit: diff viewer toggles side-by-side and falls back to unified on narrow widths.
- **Verification:** `npm run test:client`, `npm run test:browser`, and `npm run lint` pass.

---

## Verification Contract

| Command | What it proves | Units covered |
|---|---|---|
| `npm run test:server` | The new `compare` endpoint returns correct original/modified pairs and handles edge cases. | U1 |
| `npm run test:client` | Tab store, right panel layout, content viewer, updated sidebar, and i18n work in jsdom. | U3, U4, U5, U6, U7, U8 |
| `npm run test:browser` | The open-file and open-diff flows render in a real browser. | U9 |
| `npm run lint` | TypeScript and ESLint rules are satisfied and dead imports are removed. | All |
| `npm run build` | The Vite build succeeds with the new CodeMirror dependencies and no `@git-diff-view/react` references. | All |

Before declaring the refactor complete, also run the existing `Sidebar`, `AppLayout`, `FileExplorer`, and `GitChangesPanel` tests to confirm no regressions.

---

## Definition of Done

- All commands in the Verification Contract pass with no new warnings or failures.
- The left sidebar shows only Sessions and Todos; the Files explorer no longer appears there.
- The left `FilePanel` and `GitDiffPanel` are removed from the codebase.
- The right area shows a collapsed icon rail with Files and Git Changes icons.
- Expanding the right area shows the list sidebar and the tabbed content panel.
- Double-clicking a file in the Files tab opens a CodeMirror-rendered file tab.
- Double-clicking a change in the Git Changes tab opens a CodeMirror-rendered diff tab in unified mode with a status badge.
- Users can toggle diff tabs between unified and side-by-side modes (when width allows).
- Untracked, binary, truncated, and deleted files render with the correct placeholders or highlighting.
- Switching workspaces clears all content tabs.
- No regression in existing sidebar, chat panel, or git-changes list behavior.
- Abandoned experimental code and the `@git-diff-view/react` dependency are removed before the final diff is committed.
