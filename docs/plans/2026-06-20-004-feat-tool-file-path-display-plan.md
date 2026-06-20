---
title: "Tool file path display improvements"
type: feat
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-tool-file-path-display-requirements.md
---

# Tool File Path Display Improvements

## Summary

Make file paths in tool input renderers workspace-relative, trailing-slash-cleaned, and clickable. A shared React context supplies each renderer with the active workspace path and a file-open callback; a reusable component handles path formatting and click behavior.

## Problem Frame

Tool input renderers currently show raw absolute paths in the **Parameters** section. This repeats the workspace root, leaves trailing slashes on directory paths, and offers no way to open the referenced file directly from the tool card.

## Requirements

- R1. Remove any trailing slash from a file path before rendering it.
- R2. When the path is inside the active workspace, display it relative to the workspace root.
- R3. Keep the absolute path accessible via a hover tooltip or title attribute.
- R4. Clicking a displayed file path opens the file in the existing file panel using the same behavior as clicking a file in the file explorer.
- R5. If the path cannot be opened, do not show inline error UI; leave the path non-clickable or no-op.

## Key Technical Decisions

- **React context for renderer environment.** Tool renderers are registered as static `(input) => ReactNode` functions, so workspace path and file-open callback are provided through a `ToolRendererContext` rather than by changing the registry signature or prop-drilling through every call site. (see origin: requirements)
- **Shared `FilePath` component.** All file-path-carrying renderers use a single component that encapsulates trailing-slash removal, relative-path computation, absolute-path tooltip, and click-to-open behavior. This keeps formatting consistent and avoids duplicating the logic across renderers.
- **App-level provider using active workspace.** The context provider lives in `App.tsx` and uses the currently active workspace's `folderPath` and the existing `handleFileClick` callback. Only the active workspace's panel is interactive, so a single active-workspace context is sufficient.
- **Paths outside the workspace remain non-clickable.** If a path does not start with the workspace root, it is rendered as plain text with the tooltip but no click handler.

## Implementation Units

### U1. Add tool renderer context

- **Goal:** Provide workspace path and file-open callback to any tool renderer.
- **Requirements:** Advances R2, R4.
- **Dependencies:** None.
- **Files:** `src/client/components/tool-renderers/ToolRendererContext.tsx` (new).
- **Approach:** Create a React context with `{ workspacePath: string | undefined; onOpenFile: (path: string, name: string) => void }`, plus a provider component and a `useToolRendererContext` hook. Default `onOpenFile` to a no-op.
- **Patterns to follow:** Standard React context pattern used elsewhere in the app.
- **Test scenarios:**
  - The hook returns default values when no provider is present.
  - The hook returns provided values inside a provider.
- **Verification:** Context file compiles and tests pass.

### U2. Add shared file path component

- **Goal:** Render a cleaned, workspace-relative, clickable file path.
- **Requirements:** Advances R1, R2, R3, R4, R5.
- **Dependencies:** U1.
- **Files:** `src/client/components/tool-renderers/FilePath.tsx` (new), `src/client/components/tool-renderers/FilePath.test.tsx` (new).
- **Approach:** Component accepts an absolute path. It normalizes both the path and `workspacePath` (unify separators via the same `replace(/\\/g, '/')` convention `FileExplorer` uses, resolve `.`/`..`, strip trailing slashes), computes the relative path against `workspacePath`, shows the relative text with the absolute path as tooltip/title, and calls `onOpenFile` on click when the path resolves inside the workspace. Use a button or span with hover underline and pointer cursor so it reads as interactive.
- **Path contract for click — important.** The existing `handleFileClick` in `src/client/App.tsx` forwards its `path` argument verbatim to `GET /api/workspaces/:id/files/content?path=...`, and the server's `validatePath(folderPath, relativePath)` expects a **workspace-relative** path (`FileExplorer` already feeds it relative paths). Tool inputs are **absolute**, so `FilePath` must pass the **relative** path (the same value it computes for display) as the first argument to `onOpenFile`, and derive the file `name` (basename) for the second argument. The absolute path is kept only for the tooltip. Passing the absolute path would fail `validatePath` and the server returns 403 "Path outside workspace" — R4 would silently never work.
- **Directories.** For tools whose path is a directory rather than a file (notably Glob's and Grep's `path`, which is the search root), `handleFileClick`'s backend rejects non-files (400 "Not a file"). Render directory paths non-clickable (plain text + tooltip) so they no-op per R5 rather than producing a silent error.
- **Patterns to follow:** Existing renderer styling with `font-mono text-xs text-text-primary`.
- **Test scenarios:**
  - Happy path: absolute path inside workspace renders as relative path, has absolute path as title, and calls `onOpenFile` with the **relative** path (and basename as `name`) on click.
  - Click passes relative path: assert the mock `onOpenFile` receives the workspace-relative path, not the absolute one.
  - Trailing slash: path ending in `/` renders without it.
  - Separator/`./` normalization: path with mixed separators or a `./` prefix inside the workspace still classifies as inside and computes the correct relative path.
  - Outside workspace: path outside workspace renders absolute text, still has tooltip, and is not clickable.
  - Directory path: a directory path renders non-clickable.
  - No workspace: path renders as-is when `workspacePath` is undefined.
- **Verification:** Component tests pass.

### U3. Update file-path-carrying renderers

- **Goal:** Use `FilePath` for all paths displayed by Read, Write, Edit, Glob, and Grep renderers.
- **Requirements:** Advances R1, R2, R3, R4, R5.
- **Dependencies:** U2.
- **Files:** `src/client/components/tool-renderers/renderers/ReadRenderer.tsx`, `src/client/components/tool-renderers/renderers/WriteRenderer.tsx`, `src/client/components/tool-renderers/renderers/EditRenderer.tsx`, `src/client/components/tool-renderers/renderers/GlobRenderer.tsx`, `src/client/components/tool-renderers/renderers/GrepRenderer.tsx`.
- **Approach:** Replace the raw `<span>{filePath}</span>` or `<span>{path}</span>` elements with the new `FilePath` component, passing the absolute path. Keep surrounding labels and icons unchanged.
- **Patterns to follow:** Existing renderer layout and icon usage.
- **Test scenarios:**
  - Each renderer still renders its label and passes the path through to `FilePath`.
  - Integration: rendering a tool input inside a `ToolRendererContext.Provider` produces a clickable relative path.
- **Verification:** Existing renderer behavior preserved; new path display visible in storybook or manual checks.

### U4. Wire context provider into App

- **Goal:** Make workspace path and file-open callback available to all tool renderers.
- **Requirements:** Advances R2, R4, R5.
- **Dependencies:** U1, U2, U3.
- **Files:** `src/client/App.tsx`.
- **Approach:** Wrap the app's outermost returned tree with `ToolRendererContext.Provider` so both renderer call sites are descendants — `src/client/components/ai-elements/tool.tsx` (chat surface, `renderer!(input)`) and `src/client/components/ApprovalSurface.tsx` (`renderer!(item.input)`). Supply `activeWorkspace?.folderPath` as `workspacePath` and the existing `handleFileClick` as `onOpenFile`. Note `handleFileClick` consumes a **workspace-relative** path; `FilePath` is responsible for passing the relative form (see U2 path contract).
- **Patterns to follow:** Existing provider-style wrappers in App.
- **Test scenarios:**
  - Integration: a tool input rendered inside the app structure can open a file when clicked.
- **Verification:** Manual verification that clicking a path in chat and approval surfaces opens the file panel.

### U5. Add renderer-level integration tests

- **Goal:** Verify end-to-end behavior of path display and click-to-open.
- **Requirements:** Advances R1–R5.
- **Dependencies:** U3, U4.
- **Files:** `src/client/components/tool-renderers/renderers/ReadRenderer.test.tsx` (new), `src/client/components/tool-renderers/renderers/WriteRenderer.test.tsx` (new), `src/client/components/tool-renderers/renderers/EditRenderer.test.tsx` (new), `src/client/components/tool-renderers/renderers/GlobRenderer.test.tsx` (new), `src/client/components/tool-renderers/renderers/GrepRenderer.test.tsx` (new).
- **Approach:** Render each renderer wrapped in `ToolRendererContext.Provider` with a mocked `onOpenFile`. Assert the displayed text is relative, the title is absolute, and clicking invokes the mock.
- **Patterns to follow:** `ChatMessageRenderer.test.tsx` mocking patterns for `react-i18next` and external dependencies.
- **Test scenarios:**
  - Read renderer shows relative path and opens file on click.
  - Write renderer shows relative path for `file_path`.
  - Edit renderer shows relative path for `file_path`.
  - Glob renderer shows relative path for `path`.
  - Grep renderer shows relative path for `path`.
- **Verification:** Tests pass.

## Scope Boundaries

- **Deferred for later:** path treatment in the tool header summary line.
- **Outside this product's identity:** editing files from the tool card, opening files in an external editor, mutating tool input data.
- **Deferred to follow-up work:** applying the same `FilePath` treatment to other renderers that may display paths (for example `LSPToolRenderer` or `NotebookEditRenderer`) if product decides to expand scope.

## Risks & Dependencies

- **Risk:** Renderer registry functions are static; adding context avoids changing the registry contract, but context must be above every renderer call site. Mitigation: provider is placed at the App root, above both chat messages and the approval surface.
- **Dependency:** The active workspace must have a valid `folderPath` for relative paths to compute correctly.

## Sources / Research

- Existing renderer implementations in `src/client/components/tool-renderers/renderers/`.
- Existing file-open behavior in `src/client/App.tsx` (`handleFileClick`) and `src/client/components/FileExplorer.tsx`.
