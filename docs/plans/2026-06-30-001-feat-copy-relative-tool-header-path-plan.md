---
title: "feat: Copy workspace-relative path from tool headers"
type: feat
date: 2026-06-30
origin: docs/brainstorms/2026-06-20-tool-file-path-display-requirements.md
---

# feat: Copy workspace-relative path from tool headers

## Summary

Change the copy action on file paths rendered in tool use headers so the clipboard receives the workspace-relative path instead of the absolute path. When the path sits outside the active workspace, the copy action falls back to the absolute path.

## Problem Frame

The "Tool File Path Display Improvements" work cleaned up how paths are shown in tool input parameter sections and deferred the same treatment for the tool header summary line. Today, when a user clicks the copy button next to a file path in a tool header, the clipboard receives the raw absolute path even though the UI is displaying a workspace-relative path. This is inconsistent and forces users to manually strip the workspace root after copying.

## Requirements

- R1. When a user copies a file path rendered by `FilePath`, the clipboard receives the workspace-relative path if the path is inside the active workspace.
- R2. When the path is outside the active workspace, the clipboard receives the absolute path.
- R3. Existing display text, hover tooltip, and Cmd/Ctrl-click-to-open behavior remain unchanged.

## Key Technical Decisions

- KTD1. **Copy target uses the existing `relativePath` computation.** `FilePath` already computes `relativePath` via `getPathDisplayInfo`; it is `null` for out-of-workspace paths. The copy handler writes `relativePath ?? displayAbsolute`, satisfying R1 and R2 with a one-line change.
- KTD2. **Change the shared `FilePath` primitive rather than `ToolHeader`.** `ToolHeader` renders header summaries through `FilePath`, and custom tool renderers also use `FilePath`. Updating the primitive keeps copy behavior consistent across every surface that shows a file path.

## Implementation Units

### U1. Update `FilePath` copy handler

**Goal:** Copy the workspace-relative path when available, falling back to the absolute path.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- `src/client/components/tool-renderers/FilePath.tsx`
- `src/client/components/tool-renderers/FilePath.test.tsx`

**Approach:** In `FilePath.handleCopy`, replace `navigator.clipboard.writeText(displayAbsolute)` with `navigator.clipboard.writeText(relativePath ?? displayAbsolute)`. Keep the existing `try/catch` error handling.

**Patterns to follow:** Existing `FilePath` click handler already uses `relativePath` for `onOpenFile`; path normalization and relativization live in `path-utils.ts`.

**Test scenarios:**
- Happy path: Inside-workspace path copies the relative path (e.g., `src/components/Button.tsx`).
- Edge case: Workspace root path copies `.`.
- Edge case: Out-of-workspace path copies the absolute path.
- Edge case: `workspacePath` is undefined and path copies the normalized absolute path.
- Error path: Clipboard API failure is caught and logged (existing behavior).

**Verification:** The existing test `"copies absolute path when copy button is clicked"` is updated to expect the relative path, and a new test verifies the out-of-workspace fallback.

### U2. Verify `ToolHeader` integration

**Goal:** Confirm the tool header summary line inherits the new copy behavior.

**Requirements:** R1, R3

**Dependencies:** U1

**Files:**
- `src/client/components/ai-elements/tool.test.tsx`

**Approach:** Add a focused test that renders `ToolHeader` with a path-like summary and asserts the copy button writes the workspace-relative path. No production code changes are expected in `tool.tsx` because `ToolHeader` already delegates path rendering to `FilePath`.

**Patterns to follow:** Existing `tool.test.tsx` already wraps `ToolHeader` in `ToolRendererProvider` and `I18nextProvider`.

**Test scenarios:**
- Happy path: `ToolHeader` with a path-like summary copies the relative path when the copy button is clicked.
- Edge case: `ToolHeader` with a non-path summary does not render `FilePath` or a copy button.

**Verification:** New test passes and existing `ToolHeader` tests remain green.

## Scope Boundaries

- **In scope:** Copy behavior for file paths rendered via `FilePath`, which covers tool header summaries and custom tool renderers.
- **Deferred for later:** Visual copied-state feedback (the `CodeBlockCopyButton` pattern) and extracting a reusable clipboard utility or hook.
- **Outside this product's identity:** Editing files from the tool card, opening files in an external editor, or mutating the underlying tool input data.

## Sources / Research

- Origin: `docs/brainstorms/2026-06-20-tool-file-path-display-requirements.md`
- Shared path primitive: `src/client/components/tool-renderers/FilePath.tsx`
- Path utilities: `src/client/components/tool-renderers/path-utils.ts`
- Tool header rendering: `src/client/components/ai-elements/tool.tsx`
- Rendering context: `src/client/components/tool-renderers/ToolRendererContext.tsx`
