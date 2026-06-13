---
date: 2026-06-13
topic: session-list-title-search
---

## Summary

Add a search input above the session list so users can filter workspace sessions by their visible title. The filter applies to both the pinned active-session header and the scrolling list, resets when switching workspaces, and includes a clear button.

## Problem Frame

In `src/client/components/SessionList.tsx`, every session for a workspace is rendered in the sidebar. As the number of sessions grows, locating a specific session by scanning the list becomes slow. There is no way to narrow the list to sessions whose titles match a remembered name or topic.

## Requirements

- R1. A search input is shown above the session list in every workspace.
- R2. Typing in the search input filters sessions by their visible display name, case-insensitively, using substring matching.
- R3. The pinned active-session header is hidden when the active session's display name does not match the search query.
- R4. The scrolling session list shows only sessions whose display names match the search query.
- R5. An empty state is shown when no sessions match the current search query.
- R6. A clear button resets the search input to empty and restores the full list.
- R7. The search query resets to empty when the user switches workspaces.
- R8. Filtering is performed client-side against the sessions already loaded for the workspace.

## Key Decisions

- **Client-side substring filtering against the visible display name.** Matches existing patterns in the workspace and command pickers, requires no server changes, and stays instant for the loaded session set.
- **Pinned active-session header follows the same filter.** Keeps the filtered surface visually consistent and avoids showing an unrelated active session above matching results.
- **Search query resets on workspace switch.** The search is scoped to the current workspace; carrying a query across workspaces would usually produce an empty or confusing list.
- **Include a clear button.** Provides a faster path back to the full list than manually deleting the query.

## Scope Boundaries

- Server-side search or pagination.
- Searching message contents or session metadata beyond the display name.
- Fuzzy matching, relevance sorting, tags, or other advanced filters.
- Keyboard shortcuts to focus the search input.

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
