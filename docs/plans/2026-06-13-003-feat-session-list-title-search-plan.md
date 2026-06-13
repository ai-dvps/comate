---
title: "feat: Session list title search"
type: feat
date: 2026-06-13
origin: docs/brainstorms/2026-06-13-session-list-title-search-requirements.md
---

## Summary

Add a client-side search input above the session list that filters workspace sessions by their visible title. The pinned active-session header follows the same filter, the query resets when switching workspaces, and basic accessibility and interaction states are included.

## Problem Frame

`src/client/components/SessionList.tsx` renders every workspace session in the sidebar. Once the list grows beyond a handful of items, finding a specific session by scrolling becomes inefficient. There is no way to narrow the list to sessions whose displayed title matches a remembered name.

## Requirements

- R1. A search input is shown above the session list in every workspace.
- R2. Typing in the search input filters sessions by their visible display name, case-insensitively, using substring matching.
- R3. The pinned active-session header is hidden when the active session's display name does not match the search query.
- R4. The scrolling session list shows only sessions whose display names match the search query.
- R5. An empty state is shown when the query is non-empty and the scrolling list has no matching sessions.
- R6. A clear button resets the search input to empty and restores the full list.
- R7. The search query resets to empty when the user switches workspaces.
- R8. Filtering is performed client-side against the sessions already loaded for the workspace.
- R9. The search input has an accessible label and the clear button has an accessible label; the filtered result surface is usable with assistive technologies.
- R10. Pressing `Escape` clears a non-empty query or blurs the input when the query is already empty; `Enter` does not submit.
- R11. The search input is disabled while sessions are loading and none have arrived yet.

## Key Technical Decisions

- **Keep filtering client-side in the session list surface.** No chat-store or server changes are needed; the workspace sessions are already in memory.
- **Match against the visible display name using case-insensitive substring matching.** This matches the existing workspace-tab search pattern in `src/client/components/WorkspaceTabs.tsx` and the behavior users expect from a simple title filter.
- **Hide the pinned active-session header when it does not match.** Keeps the filtered surface visually consistent with the list below it.
- **Reset the query on `workspaceId` change.** The search is scoped to one workspace; carrying a query across workspaces would usually produce an empty or confusing list.
- **Extract a small, pure filter helper and add a unit test.** The codebase already has `src/client/lib/*.test.ts` files but no React component tests; a pure helper is the cheapest place to get regression coverage.

## Implementation Units

### U1. Extract session filter helper and add unit tests

- **Goal:** Provide a testable function that decides whether a session matches a search query and computes its visible display name.
- **Requirements:** R2, R8
- **Dependencies:** None
- **Files:**
  - `src/client/lib/session-filter.ts` (create)
  - `src/client/lib/session-filter.test.ts` (create)
- **Approach:** Move the existing `getSessionDisplayName` logic out of `SessionList.tsx` into a shared helper. Add a `matchesSessionQuery(session, query)` helper that trims and lowercases the query, then checks whether the display name includes it. Treat an empty or whitespace-only query as a match for all sessions.
- **Patterns to follow:** Existing workspace search in `src/client/components/WorkspaceTabs.tsx:183-186` uses `toLowerCase().includes(query)`.
- **Test scenarios:**
  - Happy path: a session with display name "Project Alpha" matches query `proj`.
  - Case-insensitive matching: "Project Alpha" matches `ALPHA`.
  - Empty/whitespace query returns true.
  - Non-matching query returns false.
  - WeCom-prefixed names strip the "WeCom: " prefix before matching (preserves current `SessionList` behavior).
  - Custom title takes precedence over summary, which takes precedence over `name`.
- **Verification:** `session-filter.test.ts` passes and covers the cases above.

### U2. Add search input and filtering behavior to SessionList

- **Goal:** Render the search UI above the session list and wire it to filter both the pinned header and the scrolling list.
- **Requirements:** R1, R3, R4, R5, R6, R7, R9, R10, R11
- **Dependencies:** U1
- **Files:**
  - `src/client/components/SessionList.tsx` (modify)
  - `src/client/i18n/en/chat.json` (modify: add `searchSessions`, `clearSearch`, `noMatchingSessions`)
  - `src/client/i18n/zh-CN/chat.json` (modify: add `searchSessions`, `clearSearch`, `noMatchingSessions`)
- **Approach:**
  1. Add a `searchQuery` state to `SessionList`.
  2. Add a `useEffect` that resets `searchQuery` to empty when `workspaceId` changes.
  3. Render a search input between the new-session button and the pinned active-session header, inside the same `p-3` container with `mt-2` spacing and `w-full`. Use existing Tailwind utility classes (`bg-bg`, `border-border`, `rounded-lg`, `focus:border-accent`, etc.) for visual consistency.
  4. Disable the search input while `isLoading && sessions.length === 0`.
  5. Add an accessible label via `aria-label` (or a visually hidden label) and `role="search"` on the container. Add an `aria-live="polite"` region that announces the count of matching sessions.
  6. Render a clear button inside the input when the query is non-empty, using the same icon-button pattern as `src/client/components/FileExplorer.tsx:275-287`. Give it an `aria-label`.
  7. Handle `Escape` to clear a non-empty query or blur the input when empty; `Enter` does nothing.
  8. Cancel any in-flight session rename when the search input receives focus, so two text inputs do not compete for attention.
  9. Derive a `queryMatches` boolean and a filtered session list using the helper from U1.
  10. Only render the pinned header when the active session matches.
  11. Only render list items that match.
  12. Show an empty-state row when the query is non-empty and the filtered scrolling list is empty.
- **Patterns to follow:** Search input styling in `WorkspaceTabs.tsx`, clear-button pattern in `FileExplorer.tsx:275-287`, empty-state row pattern already present in `SessionList.tsx` for no sessions.
- **Test scenarios:**
  - Happy path: typing a query narrows the list to matching sessions.
  - Active session hidden: when the active session does not match, the pinned header is not rendered.
  - Clear button: clicking it empties the input and restores the full list.
  - Workspace switch: changing `workspaceId` clears the query.
  - Empty state: a non-empty query with no matches shows a "no matching sessions" message.
  - Escape: pressing `Escape` with a non-empty query clears it; pressing `Escape` with an empty query blurs the input.
  - Loading: the input is disabled while sessions are loading and none are present.
  - Rename collision: focusing the search input cancels any active inline rename.
- **Verification:** Running the app and exercising the scenarios above shows the expected behavior; typing `proj` filters the list, clearing restores it, switching workspaces resets the search, and keyboard/accessibility behaviors work.

## Scope Boundaries

- Server-side search or pagination.
- Searching message contents or session metadata beyond the display name.
- Fuzzy matching, relevance sorting, tags, or other advanced filters.
- Keyboard shortcuts to focus the search input.
- Virtualized list changes — the existing list remains un-virtualized.

## Acceptance Examples

- AE1. **Filtering by substring**
  - **Given:** a workspace has sessions named "Project Alpha", "Project Beta", and "Design".
  - **When:** the user types `proj` into the search input.
  - **Then:** only "Project Alpha" and "Project Beta" remain visible.

- AE2. **Active session hidden when it does not match**
  - **Given:** the active session is "Design" and the search query is `proj`.
  - **Then:** the pinned header is hidden and the scrolling list shows only "Project Alpha" and "Project Beta".

- AE3. **Case-insensitive matching**
  - **Given:** a workspace has a session named "Project Alpha".
  - **When:** the user types `ALPHA`.
  - **Then:** "Project Alpha" is shown.

- AE4. **Clear button restores the full list**
  - **Given:** the search query `alpha` filters the list to one session.
  - **When:** the user clicks the clear button.
  - **Then:** the search input is empty and the full session list is restored.

- AE5. **Workspace switch resets search**
  - **Given:** workspace A has the search query `alpha`.
  - **When:** the user switches to workspace B.
  - **Then:** the search input is empty and workspace B's full session list is shown.

## Sources / Research

- Existing local title filtering: `src/client/components/WorkspaceTabs.tsx:183-186` uses `toLowerCase().includes(query)`.
- Existing display-name logic: `src/client/components/SessionList.tsx:14-20` shows the current `customTitle || summary || name` precedence and WeCom prefix stripping.
- Existing test location pattern: `src/client/lib/*.test.ts` files demonstrate client-side unit tests.
- Clear-button pattern: `src/client/components/FileExplorer.tsx:275-287` shows an input-embedded clear button.
