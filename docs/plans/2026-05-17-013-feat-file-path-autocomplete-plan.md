---
title: File Path Autocomplete in PromptInput
type: feat
status: active
date: 2026-05-17
origin: docs/brainstorms/2026-05-17-file-path-autocomplete-requirements.md
---

# File Path Autocomplete in PromptInput

## Summary

Extend PromptInput with an `@` file-path reference picker, mirroring the slash-command discovery pattern. A new `FilePicker` component and `files-store` provide the client-side picker; the server files endpoint gains an optional recursive listing mode so the picker can filter against the full workspace tree. PromptInput coordinates `@` trigger detection, a **Files** button, mutual exclusivity with the command picker, and cursor-aware insertion.

---

## Problem Frame

The GUI lacks the Claude Code CLI's `@` shorthand for referencing files and folders in prompts. Users must type full paths from memory or copy from the FileExplorer sidebar. The existing slash-command discovery (`/`, Commands button) proves the interaction pattern works; this plan applies the same pattern to file references.

---

## Requirements

**Trigger behavior**

- R1. `@` as the first character of an empty input opens the file picker popup.
- R2. `@` mid-text opens the popup only when immediately preceded by whitespace.
- R3. Characters typed after `@` populate the picker's filter input (delegation pattern, same as slash-command picker).
- R4. Popup closes on whitespace after the filter, Escape, Tab, outside click, or when the user deletes the `@` character or moves the cursor to a position before it.

**Button affordance**

- R5. A **Files** button at the top of the input box opens the same picker.
- R6. Files button disabled when no workspace is active, input is disabled, or streaming is in progress.

**Picker content and behavior**

- R7. Picker displays workspace files and folders as a flat, filterable list with relative paths.
- R8. Filter matches full relative path by substring (case-insensitive).
- R9. Selecting a row inserts `@<relative-path> ` at the current cursor position.
- R10. Keyboard navigation identical to CommandPicker (ArrowDown/Up, Enter, Escape, Tab).
- R11. Only one popup open at a time; opening one closes the other.

**Data source**

- R12. Data sourced from existing files endpoint with recursive listing support.

**Origin acceptance examples:** AE1 (covers R1, R2, including negative case `email@domain.com`), AE2 (covers R3, R4), AE3 (covers R5, R9), AE4 (covers R9 mid-text), AE5 (covers R11)

---

## Scope Boundaries

- Multi-file selection or bulk insert
- Recently-used or most-referenced file ranking
- File content preview inside the picker
- Drag-and-drop from FileExplorer into the prompt
- Smart file suggestions based on conversation context
- Inline rendering of referenced file content in chat transcript
- Folder expansion / tree browsing inside the picker (flat list only in v1)
- `@` autocomplete for paths outside the active workspace
- Adding a test framework to the project (project currently has none)

### Deferred to Follow-Up Work

- Auto-invalidation of the files-store cache when files change externally
- Virtualized long lists for very large workspaces (1000+ files)

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/PromptInput.tsx` — existing textarea, slash-command trigger logic, Commands button, ghost text, keyboard delegation to CommandPicker
- `src/client/components/CommandPicker.tsx` — popover-based picker with filter input, keyboard navigation, imperative handle for parent delegation
- `src/client/stores/commands-store.ts` — Zustand store with lazy fetch, module-level cache, per-workspace deduplication
- `src/server/routes/files.ts` — `GET /api/workspaces/:id/files?path=` returns `{ path, nodes: [{ name, type }] }`
- `src/client/components/FileExplorer.tsx` — file icon mapping (`FileCode`, `FileJson`, `FileText`, `File`, `Folder` from lucide-react)

### Institutional Learnings

- No test framework or test files exist in the project. Verification is manual via dev server.
- The CommandPicker uses `hideFilterInput` to suppress its internal filter when triggered from typing `/`, relying on the textarea itself as the filter source. The file picker will need the same dual-mode behavior.

---

## Key Technical Decisions

- **Separate FilePicker component rather than generalized CommandPicker:** CommandPicker is tightly coupled to `SlashCommandDto`, command names, aliases, and description rendering. Generalizing it would add abstraction complexity for marginal gain. FilePicker reuses the same Radix Popover + keyboard pattern but is independently evolvable for file-specific concerns (icons, path display, recursive loading).
- **Server-side recursive listing:** Adding `?recursive=true` to the existing endpoint is a small, localized server change that delivers the best UX (instant full-tree filtering). Client-side recursive fetching would require multiple round-trips and complex coordination. A dedicated search endpoint is overkill for v1.
- **Client-side Zustand store for file tree caching:** Following the `commands-store` pattern, a `files-store` caches the recursive tree per workspace with lazy fetch and refresh. This keeps FilePicker stateless and testable (were tests to exist).
- **Cursor-aware insertion via trigger-position tracking:** Unlike slash commands where the entire input is replaced, file selection must splice `@path ` at the specific `@` trigger position within a larger input string. PromptInput tracks `triggerStart` (index of `@`) and derives the filter from the substring between `@` and the current cursor position.

---

## Open Questions

### Resolved During Planning

- **Fetch strategy for deep filtering:** Resolved by adding `?recursive=true` to the server endpoint. The server walks the directory tree recursively and returns a flat list of all paths.
- **Row display format:** Full relative paths (`src/lib/auth.ts`) are unambiguous and match the filter behavior. Truncation is handled via CSS if needed.
- **Button icon:** `Paperclip` from lucide-react — commonly used for file/attachment affordances in chat UIs.

### Deferred to Implementation

- **Virtualization for large workspaces:** If recursive listing becomes slow for workspaces with 10,000+ files, the picker may need virtualized scrolling or a server-side search endpoint. Not a v1 concern.
- **Auto-refresh when files change:** The store cache does not auto-invalidate when files are added/removed externally. The user can close and reopen the picker to refresh. A filesystem watcher or polling refresh could be added later.

---

## Implementation Units

### U1. Server — recursive file listing

**Goal:** Extend the existing files endpoint to optionally return the full recursive workspace tree as a flat list.

**Requirements:** R12

**Dependencies:** None

**Files:**
- Modify: `src/server/routes/files.ts`

**Approach:**
- Add a `recursive` query parameter to `GET /api/workspaces/:id/files`.
- When `recursive !== 'true'`, preserve existing behavior (single-directory listing) with folder-first, alphabetical sort.
- When `recursive === 'true'`, walk all subdirectories recursively starting from the requested path (default empty string = workspace root). Collect every file and folder into a flat array of `{ path, type }` objects where `path` is the relative path from workspace root. Sort the full flat list alphabetically by path.
- Path validation (`validatePath`) continues to guard against directory traversal.

**Patterns to follow:**
- Existing directory listing and sorting logic in `src/server/routes/files.ts`

**Test scenarios:**
- Happy path: `GET /api/workspaces/:id/files?recursive=true` returns all files and folders in the workspace as a flat list with correct relative paths and types.
- Edge case: Empty workspace returns `[]`.
- Edge case: Workspace with nested directories (e.g., `src/lib/nested/file.ts`) returns entries at all depths.
- Error path: Invalid `path` query that escapes the workspace returns 403.

**Verification:**
- Manual test via browser/curl: `?recursive=true` returns flat list; omitting it returns single-directory list.
- Confirm path validation still rejects traversal attempts.

---

### U2. Client — files store

**Goal:** Create a Zustand store that fetches and caches the recursive file tree per workspace.

**Requirements:** R12

**Dependencies:** U1

**Files:**
- Create: `src/client/stores/files-store.ts`

**Approach:**
- Mirror the `commands-store` pattern: Zustand store with `useFiles(workspaceId)` hook returning `{ files, loading, error, fetch, refresh }`. (Files do not need `partial`/`partialReason` semantics; the endpoint returns the complete tree or fails.)
- `files` is an array of `{ path: string; type: 'file' | 'folder' }`.
- Module-level `Map<workspaceId, FileNode[]>` for cache; lazy fetch on first access.
- Defensively dedupe any duplicate paths returned by the server before caching (a filesystem guarantees uniqueness, but this guards against bugs).
- `fetch()` hits `GET /api/workspaces/${workspaceId}/files?recursive=true`.
- `refresh()` invalidates the cache entry and re-fetches.
- Dedupe concurrent requests with an `inflight` Map.

**Patterns to follow:**
- `src/client/stores/commands-store.ts` — lazy fetch, module-level cache, inflight deduplication, error handling

**Test scenarios:**
- Happy path: `useFiles(workspaceId)` returns cached files on second call without re-fetching.
- Edge case: Concurrent calls to `useFiles` for the same workspaceId produce only one network request.
- Error path: Network failure surfaces `error` string and leaves `files` as previous cache (or empty on first fetch).
- Integration: Store fetches from the recursive endpoint and returns paths with correct types.

**Verification:**
- Dev console inspection: opening the file picker triggers one network request; reopening without workspace switch uses cached data.
- Refresh button or workspace switch triggers a new request.

---

### U3. FilePicker component

**Goal:** Create a popover-based file picker with filtering, keyboard navigation, and file/folder rows.

**Requirements:** R7, R8, R10

**Dependencies:** U2

**Files:**
- Create: `src/client/components/FilePicker.tsx`

**Approach:**
- Structure mirrors `CommandPicker`: Radix Popover, filter input, keyboard-navigated list, imperative handle for parent delegation.
- Props: `workspaceId`, `open`, `onOpenChange`, `onSelect`, `anchor`, `side`, `align`, `initialFilter`, `hideFilterInput`.
- Uses `useFiles(workspaceId)` for data.
- Filter matches `path.toLowerCase().includes(needle)` against the full relative path.
- Each row shows a file/folder icon (reuse `FileExplorer` icon logic) and the full relative path.
- Active row tracked by index; scrollIntoView on change.
- Keyboard: ArrowDown/Up cycles, Enter selects, Escape closes, Tab dismisses.
- Loading state while `files.length === 0 && loading`.
- Error state while `error && files.length === 0`.
- Empty-workspace state when `files.length === 0 && !loading && !error`.
- Empty-filter state when filter yields no matches but files exist.

**Patterns to follow:**
- `src/client/components/CommandPicker.tsx` — popover structure, keyboard handling, imperative handle, focus management
- `src/client/components/FileExplorer.tsx` — file icon selection logic

**Test scenarios:**
- Happy path: Picker opens and renders all workspace files/folders when filter is empty.
- Happy path: Typing a filter narrows the list to matching paths (case-insensitive substring match).
- Happy path: Clicking a row calls `onSelect` with the path and closes the picker.
- Edge case: Empty workspace shows a distinct "This workspace is empty" message.
- Edge case: Keyboard navigation (ArrowDown/Up, Enter, Escape, Tab) behaves identically to CommandPicker.
- Error path: Failed fetch shows error message instead of the list.
- Edge case: Very long paths truncate gracefully without breaking layout.

**Verification:**
- Visual check: rows show correct icons for files vs folders and common extensions.
- Filter check: typing `src` shows `src/lib/auth.ts` but not `README.md`.
- Keyboard check: arrow keys cycle, Enter selects, Escape closes.

---

### U4. PromptInput integration

**Goal:** Wire `@` trigger detection, Files button, mutual exclusivity with command picker, and cursor-aware `@path ` insertion.

**Requirements:** R1, R2, R3, R4, R5, R6, R9, R11

**Dependencies:** U3

**Files:**
- Modify: `src/client/components/PromptInput.tsx`

**Approach:**
- Add state: `filePickerOpen`, `filePickerSource` (`'at'` | `'button'`), `filePickerFilter`, `fileTriggerStart` (number | null). Track `selectionStart` at time of selection for the splice computation.
- Add `FilePicker` ref handle for keyboard delegation.
- **Trigger detection in `handleInputChange`:**
  - Gate on a truthy `workspaceId`; if no workspace is active, `@` does not open the picker.
  - Detect `@` at start of empty input, or `@` preceded by whitespace mid-text.
  - When detected, close command picker if open, set `fileTriggerStart` to the `@` index, open file picker with empty filter.
  - While file picker is open and user types non-whitespace, update `filePickerFilter` from the substring between `fileTriggerStart + 1` and current cursor position. If user types whitespace, deletes back past `@`, or moves cursor before `fileTriggerStart`, close the file picker.
- **Files button:** Mount to the right of the Commands button using `Paperclip` icon and "Files" label. Click handler closes command picker if open, clears filter, opens file picker in button mode. Disabled rules mirror Commands button.
- **Keyboard handling:** When file picker is open, delegate ArrowDown/Up, Enter, Escape, Tab to FilePicker handle (same pattern as command picker). When both pickers are closed, Enter sends.
- **Selection handler:** On file select, capture the current `selectionStart` as `cursorPos`, then compute new input as:
  ```
  input.slice(0, fileTriggerStart) + '@' + selectedPath + ' ' + input.slice(cursorPos)
  ```
  Set input, close picker, focus textarea, and place cursor after the inserted trailing space.
- **Mutual exclusivity:** Opening either picker closes the other. Track via explicit state updates in both trigger handlers.

**Technical design:**
> *Directional guidance, not implementation specification.* The textarea's `selectionStart` property provides the cursor position needed to derive the filter substring and compute the splice on selection. `fileTriggerStart` is set once when `@` is detected and remains stable until the picker closes. If the user moves the cursor or deletes the `@` character while the picker is open, the picker closes immediately.

**Patterns to follow:**
- Existing slash-command picker integration in `PromptInput.tsx` — state shape, keyboard delegation, button placement, disabled rules

**Test scenarios:**
- Happy path (AE1): Empty input + `@` opens picker showing root files.
- Happy path (AE1): Mid-text `email@domain.com` does NOT open picker.
- Happy path (AE1): `explain this bug @` opens picker.
- Happy path (AE2): Typing `@src/lib` while picker is open updates filter to `src/lib`; typing space closes picker.
- Happy path (AE3): Files button opens picker at root; selecting `README.md` produces `@README.md `.
- Happy path (AE4): Input `fix the bug in ` + cursor at end + type `@tests/` + select `login.spec.ts` produces `fix the bug in @tests/login.spec.ts `.
- Edge case (AE5): Slash-command picker open + type `@` closes command picker and opens file picker.
- Edge case: No workspace active — Files button is disabled, `@` does not open picker.
- Edge case: Streaming in progress — Files button is disabled.
- Edge case: User deletes `@` while picker is open — picker closes.
- Edge case: User moves cursor before `@` while picker is open — picker closes.

**Verification:**
- Full manual walkthrough of AE1–AE5 in the dev server.
- Confirm mutual exclusivity: open command picker, type `@`, verify command picker closes and file picker opens.
- Confirm cursor position after insertion is after the trailing space.

---

## System-Wide Impact

- **Interaction graph:** PromptInput now coordinates two pickers (command and file). Keyboard event handling must correctly route to the active picker or fall through to send-on-Enter when neither is open.
- **Error propagation:** FilePicker fetch failures are localized to the picker UI (error message in the popover). They do not block prompt input or chat sending.
- **State lifecycle risks:** `fileTriggerStart` must be cleared when the picker closes to prevent stale position references on subsequent `@` triggers.
- **API surface parity:** The server endpoint change is backward-compatible (`recursive` defaults to false). No other consumers are affected.
- **Unchanged invariants:** The existing command picker behavior, send/clear/stop buttons, ghost text, and textarea resize logic are untouched.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Recursive file listing is slow for very large workspaces | Accept for v1; document as known limitation. The deferred follow-up work covers virtualization or server-side search if needed. |
| Cursor-position tracking logic has edge cases with multi-byte characters or IME input | Use `selectionStart`/`selectionEnd` which handles Unicode correctly. Test with emoji or CJK input during verification. |
| Two pickers in PromptInput increase keyboard-handling complexity | Existing slash-command delegation pattern is well-established; file picker follows the same pattern. Mutual-exclusivity state updates are centralized in PromptInput. |

---

## Documentation / Operational Notes

- No documentation updates required beyond the requirements and plan docs.
- No rollout or monitoring concerns — this is a pure client+server feature with no external dependencies.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-17-file-path-autocomplete-requirements.md](../brainstorms/2026-05-17-file-path-autocomplete-requirements.md)
- **Related code:** `src/client/components/PromptInput.tsx`, `src/client/components/CommandPicker.tsx`, `src/client/stores/commands-store.ts`, `src/server/routes/files.ts`, `src/client/components/FileExplorer.tsx`
- **Related prior work:** `docs/plans/2026-05-17-011-feat-slash-command-discovery-plan.md` (established the CommandPicker pattern)
