---
date: 2026-06-15
topic: delete-workspace
---

## Summary

Add a workspace delete affordance in the SettingsPanel workspace tab. Users confirm by typing the workspace name. Deleting removes the workspace record and all associated sessions from the database, leaves the workspace folder on disk untouched, and updates active and open workspace state automatically.

## Problem Frame

The app already supports creating and updating workspaces, but there is no way for a user to remove a workspace they no longer need. Stale workspaces accumulate in the list. The backend exposes `DELETE /api/workspaces/:id`, and the store already removes WeCom user sessions, WeCom workspace users, todos, and proactive messages for the workspace, but the frontend workspace store and settings UI have no delete action or affordance, and the store's delete does not yet remove the workspace's chat sessions.

## Key Decisions

- **SettingsPanel location.** The delete action lives in the workspace tab of SettingsPanel, alongside the workspace being edited, rather than in the main workspace switcher.
- **Type-name confirmation.** Deletion requires typing the exact workspace name before the Delete button enables, preventing accidental one-click deletion.
- **Hard delete with sessions.** The workspace record and all sessions associated with it are removed from the database; no archive or undo window is provided.
- **Folder untouched.** The folder path referenced by the workspace is not modified on disk.
- **Automatic focus switch.** If the deleted workspace is active, the UI activates another open or available workspace; if none remain, it shows the empty-workspace state.

## Requirements

**UI affordance and confirmation**

- R1. The SettingsPanel workspace tab exposes a destructive "Delete workspace" action for the selected workspace.
- R2. Triggering the action opens a confirmation dialog that shows the workspace name and warns that deletion is irreversible.
- R3. The dialog requires the user to type the exact workspace name before the Delete button is enabled.
- R4. The dialog can be cancelled; cancelling leaves the workspace unchanged.

**Deletion scope and side effects**

- R5. Confirming deletion calls the backend delete endpoint for the selected workspace.
- R6. Deleting a workspace removes the workspace record and all sessions whose `workspace_id` matches it from the database.
- R7. The folder path referenced by the workspace is not modified, created, or deleted on disk.
- R8. Related WeCom user sessions, WeCom workspace users, todos, proactive messages, and analytics cache rows associated with the workspace are also removed.

**Workspace state cleanup**

- R9. If the deleted workspace is the active workspace, the UI automatically activates another open workspace, or the next available workspace, or enters the empty state if none remain.
- R10. If the deleted workspace is open in a non-active tab, that tab is closed.
- R11. The workspace is removed from the workspace list without requiring a manual refresh.

## Key Flows

- F1. Delete active workspace
  - **Trigger:** User selects workspace A in SettingsPanel, clicks Delete workspace, types the name, and confirms.
  - **Actors:** End user.
  - **Steps:**
    1. Dialog opens showing workspace A name and a warning.
    2. User types workspace A name; Delete enables.
    3. User confirms.
    4. Backend deletes workspace A and all associated sessions and related data.
    5. Workspace A is removed from open tabs and the workspace list.
    6. UI activates workspace B or shows the empty-workspace state.
  - **Covered by:** R1-R11

- F2. Cancel deletion
  - **Trigger:** User opens the delete dialog and clicks Cancel.
  - **Steps:**
    1. Dialog closes.
    2. Workspace remains unchanged.
  - **Covered by:** R4

## Acceptance Examples

- AE1. Delete last workspace
  - **Covers:** R6, R9
  - **Given:** The user has only one workspace and it is active.
  - **When:** The user deletes it.
  - **Then:** The workspace and its sessions are removed and the UI shows the empty-workspace state.

- AE2. Delete workspace open in another tab
  - **Covers:** R10
  - **Given:** Workspace A is open in a tab but workspace B is active.
  - **When:** The user deletes workspace A from SettingsPanel.
  - **Then:** Workspace A's tab closes and workspace B remains active.

- AE3. Type wrong name
  - **Covers:** R3
  - **Given:** The delete dialog is open for workspace "Production".
  - **When:** The user types "production" (lowercase) or any other text.
  - **Then:** The Delete button remains disabled.

## Scope Boundaries

- Archive, soft-delete, or any undo-after-delete behavior.
- Delete affordance in the main workspace switcher.
- Deleting files or the folder on disk.
- Bulk deletion of multiple workspaces.
- Recovering a workspace after deletion.

## Dependencies / Assumptions

- The backend endpoint `DELETE /api/workspaces/:id` exists and returns 204 on success or 404 if the workspace is not found.
- The current store delete removes WeCom user sessions, WeCom workspace users, todos, and proactive messages, but does not cascade to sessions or analytics cache rows; planning must extend deletion to cover those.
- The workspace folder path is a user-controlled directory and must not be modified by this feature.
