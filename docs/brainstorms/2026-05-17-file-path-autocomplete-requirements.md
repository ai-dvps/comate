---
date: 2026-05-17
topic: file-path-autocomplete
---

# File Path Autocomplete in PromptInput

## Summary

Add an `@` file-path reference affordance to PromptInput, mirroring the Claude Code CLI behavior. Typing `@` at the start of an empty input (or after a space mid-text) opens a file picker popup; a **Files** button at the top of the input box opens the same picker. Selecting a path inserts `@<path> ` at the cursor.

---

## Problem Frame

The Claude Code CLI supports `@` as a shorthand for referencing files and folders in a prompt — the user types `@`, picks from an autocomplete list, and the path is inserted. The GUI has no equivalent affordance. Users who want to reference a file must type the full relative path from memory or switch to the FileExplorer sidebar to read and copy the path. This friction discourages file-specific prompts ("explain `@src/lib/auth.ts`", "fix the bug in `@tests/e2e/login.spec.ts`"), which are a primary interaction mode in the CLI.

The existing slash-command discovery (`/`, Commands button) proves the interaction pattern works in this codebase: a triggered popup, a persistent button, filterable list, keyboard navigation, and cursor-aware insertion. File path reference is the same pattern with a different data source (workspace file tree instead of command list).

---

## Requirements

**Trigger behavior**

- R1. Typing `@` as the **first character of an empty input** opens the file picker popup anchored to the textarea.
- R2. Typing `@` in the **middle of prompt text** opens the popup **only** when the `@` is immediately preceded by a whitespace character (space, newline). An `@` that appears mid-word (e.g., `email@domain.com`) does **not** trigger the popup.
- R3. When the popup is already open and the user continues typing characters after `@`, those characters populate the picker's filter input (same delegation pattern as the slash-command picker).
- R4. The popup closes when the user types a whitespace character after the `@`-prefixed filter, presses Escape, presses Tab, or clicks outside the popup.

**Button affordance**

- R5. A **Files** button is mounted at the top of the input box, to the right of the existing **Commands** button. Clicking it opens the same file picker popup.
- R6. The Files button is disabled when no workspace is active, when the input is disabled, or when a stream is in progress (same rules as the Commands button).

**Picker content and behavior**

- R7. The picker displays the workspace's file and folder tree as a flat, filterable list. Each row shows the relative path from workspace root and an icon indicating file vs folder.
- R8. The picker is filterable by path substring (case-insensitive). The filter matches against the full relative path, not just the basename.
- R9. Selecting a row (click, or arrow keys + Enter) inserts `@<relative-path> ` at the **current cursor position** in the textarea, then closes the popup and returns focus to the textarea.
- R10. The picker supports keyboard navigation identical to CommandPicker: ArrowDown/ArrowUp to cycle, Enter to select, Escape to close, Tab to dismiss.
- R11. Only one popup (commands or files) can be open at a time. Opening one closes the other.

**Data source**

- R12. The picker sources its tree from the existing `GET /api/workspaces/:id/files` endpoint, recursively walking folders as needed. No new server-side indexing or storage is required.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given an empty PromptInput with an active workspace, when the user types `@`, then the file picker popup opens within one frame showing the workspace root contents. Given the input contains `explain this bug`, when the user types ` @` at the end, then the popup opens. Given the input contains `email@domain.com`, when the user types the `@`, then no popup opens.

- AE2. **Covers R3, R4.** Given the popup is open after typing `@src`, when the user types `/lib`, then the filter updates to `src/lib` and the list narrows. When the user then types a space, the popup closes and the input reads `@src/lib `.

- AE3. **Covers R5, R9.** Given a workspace is active and the input is empty, when the user clicks the **Files** button, then the popup opens at the root. When the user clicks a row labeled `README.md`, then the input becomes `@README.md ` and the cursor is positioned after the trailing space.

- AE4. **Covers R9 (mid-text insertion).** Given the input contains `fix the bug in ` with the cursor positioned after the trailing space, when the user types `@tests/` and selects `login.spec.ts` from the popup, then the input becomes `fix the bug in @tests/login.spec.ts `.

- AE5. **Covers R11.** Given the slash-command picker is open after typing `/`, when the user types `@`, then the slash-command picker closes and the file picker opens (or vice versa).

---

## Success Criteria

- A user can reference any file or folder in the active workspace from PromptInput without leaving the keyboard or memorizing paths.
- The feature reuses the established CommandPicker interaction pattern so that a user familiar with slash-command discovery learns the file picker instantly.
- The implementation adds no new server-side storage, indexing, or background processes — it consumes the existing files API.

---

## Scope Boundaries

- Multi-file selection or bulk insert
- Recently-used or most-referenced file ranking
- File content preview inside the picker
- Drag-and-drop from FileExplorer into the prompt
- Smart file suggestions based on conversation context
- Inline rendering of the referenced file's content in the chat transcript
- Folder expansion / tree browsing inside the picker (flat filtered list only; no nested tree UI in v1)
- `@` autocomplete for paths outside the active workspace

---

## Key Decisions

- **Flat list with path filter rather than expandable tree:** The CommandPicker already renders a flat, filterable list. Reusing that shape keeps the UI and keyboard-handling code paths nearly identical. A nested tree inside a popover would introduce new interaction complexity (expand/collapse, indent-level scrolling) with marginal gain — the filter input is the primary navigation mode for keyboard users.
- **Recursive fetch on open rather than cached tree:** The existing files endpoint lists one directory per call. Eagerly fetching the full recursive tree on every open would be wasteful for large workspaces. The picker fetches lazily: root on open, then recursive directories as the user expands or filters. If filtering against an unexpanded directory, the picker may need to walk deeper. (Deferred to planning: exact fetch strategy.)
- **Both files and folders are selectable:** The CLI `@` accepts either. Folders are useful for prompts like "explain the files in @src/components".

---

## Dependencies / Assumptions

- The existing `GET /api/workspaces/:id/files` endpoint (with `?path=` query) is available and returns `{ path, nodes: [{ name, type }] }`. Verified present in `src/server/routes/files.ts`.
- The workspace store exposes an `activeWorkspaceId`. Verified present in `src/client/stores/workspace-store.ts`.
- `CommandPicker` can be generalized or duplicated to render file rows instead of command rows. The component is currently command-specific; planning will decide between parameterization, composition, or a sibling component.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7, R12][Technical] **Fetch strategy for deep filtering.** If the user types `@src/comp` and the `src/` folder has not been fetched yet, does the picker (a) fetch `src/` then filter client-side, (b) add a server-side search endpoint, or (c) eagerly fetch the full tree on first open and cache it? The existing endpoint is directory-scoped.
- [Affects R7][Technical] **Row display format.** Should rows show full relative paths (`src/lib/auth.ts`) or basenames with parent context (`auth.ts` in `src/lib/`)? Full paths are unambiguous but can be long; basenames are compact but may collide.
- [Affects R5][Technical] **Button icon.** The Commands button uses `SlashSquare`. The Files button needs a distinct icon from the Lucide set (e.g., `Paperclip`, `FileText`, or `FolderOpen`).
