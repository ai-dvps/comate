---
date: 2026-06-13
topic: session-list-refresh-button
---

## Summary

Add a manual refresh button next to the "New Session" button in the session list sidebar. Clicking it clears the search filter, reloads the current workspace's sessions from the server, and shows a spinning icon while loading. Refresh failures surface through a new reusable, application-level toast system in the top-right viewport that supports auto-dismiss, manual dismiss, stacking, and severity levels.

## Problem Frame

In `src/client/components/SessionList.tsx`, sessions are loaded automatically when the workspace mounts or changes, but there is no way for the user to manually reload the list after sessions are created, renamed, or deleted elsewhere. The existing background polling only updates session status, not the session list itself. A manual refresh gives the user control without waiting for a workspace switch.

## Requirements

**Refresh button**

- R1. A refresh button is shown next to the "New Session" button at the top of the session list sidebar for every workspace.
- R2. Clicking the refresh button reloads the current workspace's session list from the server.
- R3. Clicking the refresh button clears the session search filter.
- R4. The refresh button is disabled while sessions for the workspace are loading.
- R5. The refresh icon spins while sessions for the workspace are loading.

**Toast system**

- R6. When session reload fails, an error toast is shown using the application-level toast system.
- R7. Toasts auto-dismiss after a configurable timeout.
- R8. Toasts can be dismissed manually with a close button.
- R9. Multiple toasts can be visible at the same time in a stacked layout.
- R10. Toasts support severity levels: info, success, warning, and error.
- R11. Toasts render in a fixed container positioned in the top-right corner of the viewport.
- R12. The toast system exposes a shared client-side mechanism so any feature can show a toast without adding a new rendering container.

## Key Decisions

- **Refresh button next to "New Session" rather than inside the search field.** Keeps the search input focused on filtering and groups session-management actions at the top of the sidebar.
- **Clear search filter on refresh.** A manual reload is a reset action; showing the full refreshed list matches the user's intent and avoids a stale filter hiding newly loaded sessions.
- **Reuse the existing `fetchSessions` action.** No server changes are needed; the store already manages loading state.
- **Build a reusable toast system instead of a one-off error banner.** Other features need toast-like feedback, so a shared mechanism reduces duplication.
- **Top-right viewport positioning.** Visible across the app without pushing content or competing with the sidebar layout.

## Scope Boundaries

- Migrating existing error surfaces to the new toast system.
- Auto-refresh or background polling of the session list.
- Toast behaviors beyond auto-dismiss, manual dismiss, stacking, and severity levels.
- Customizing toast duration per severity in the initial release.

## Key Flows

- F1. **Refresh session list**
  - **Trigger:** The user clicks the refresh button.
  - **Steps:** Clear the search query, call `fetchSessions(workspaceId)`, update the session list, stop the loading indicator.
  - **Outcome:** The session list reflects the latest server state.

- F2. **Refresh fails**
  - **Trigger:** The server returns an error or the request fails.
  - **Steps:** Stop the loading indicator, show an error toast, auto-dismiss after the timeout.
  - **Outcome:** The user sees a transient failure notice and can retry.

## Acceptance Examples

- AE1. **Refresh reloads sessions**
  - **Given:** a workspace with sessions already loaded.
  - **When:** the user clicks the refresh button.
  - **Then:** the session list is re-fetched from the server and the list updates.

- AE2. **Refresh clears search**
  - **Given:** the user has typed `alpha` into the search input and the list is filtered.
  - **When:** the user clicks the refresh button.
  - **Then:** the search input is empty and the full session list is shown after reload.

- AE3. **Refresh shows loading state**
  - **Given:** the user clicks the refresh button.
  - **Then:** the refresh icon spins and the button is disabled until the request completes.

- AE4. **Refresh failure shows error toast**
  - **Given:** the session reload request fails.
  - **Then:** an error-severity toast appears in the top-right viewport and auto-dismisses after the timeout.

- AE5. **Toast manual dismiss**
  - **Given:** an error toast is visible.
  - **When:** the user clicks the toast's close button before the timeout.
  - **Then:** the toast disappears immediately.

- AE6. **Toast stacking**
  - **Given:** an error toast is already visible.
  - **When:** another feature shows a success toast.
  - **Then:** both toasts are visible in a stacked layout.

- AE7. **Toast severity styling**
  - **Given:** toasts of severity info, success, warning, and error are shown.
  - **Then:** each severity renders with a visually distinct style.

## Dependencies / Assumptions

- The existing `fetchSessions` action in `src/client/stores/chat-store.ts` returns the workspace's sessions and sets `isLoadingSessions[workspaceId]`.
- `lucide-react` is available for the refresh icon.
- Translation keys for the refresh button and failure message can be added to `src/client/i18n/*/chat.json`.
