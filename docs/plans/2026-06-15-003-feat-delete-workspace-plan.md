---
title: feat: Add workspace deletion to SettingsPanel
type: feat
date: 2026-06-15
origin: docs/brainstorms/2026-06-15-delete-workspace-requirements.md
---

## Summary

Add a workspace delete affordance in the SettingsPanel workspace tab. Users confirm by typing the workspace name. Deleting removes the workspace record and all associated sessions from the database, leaves the workspace folder on disk untouched, and updates active and open workspace state automatically.

## Problem Frame

The app already supports creating and updating workspaces, but there is no way for a user to remove a workspace they no longer need. Stale workspaces accumulate in the list. The backend exposes `DELETE /api/workspaces/:id`, and the store already removes WeCom user sessions, WeCom workspace users, todos, and proactive messages for the workspace, but the frontend workspace store and settings UI have no delete action or affordance, and the store's delete does not yet remove the workspace's chat sessions or analytics cache.

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

## Key Technical Decisions

- **Dedicated delete dialog component.** Build a new `DeleteWorkspaceDialog` component instead of extending the generic `ConfirmDialog`. The type-name input gating is a specialized interaction that does not fit the simple title/message shape of `ConfirmDialog`; a dedicated component keeps the generic dialog reusable and makes the gating logic testable.
- **Workspace store orchestrates cleanup.** The `deleteWorkspace` action in `workspace-store.ts` calls the backend and updates its own state, then invokes cleanup on `chat-store`, `files-store`, `analytics-store`, `commands-store`, and `wecom-queue-store`. Centralizing cleanup in the store prevents the SettingsPanel component from needing to know every workspace-scoped surface.
- **Cascade delete in SQLite store.** Extend the existing `SqliteStore.delete(id)` method to delete `sessions` rows and call `AnalyticsCache.clearByWorkspace(id)` inside the existing `if (result.changes > 0)` guard. This keeps deletion atomic and consistent with the existing manual cascade pattern.
- **Active-workspace fallback mirrors `closeWorkspace`.** Reuse the existing fallback logic from `closeWorkspace` inside `deleteWorkspace`: remove the id from `openWorkspaceIds`; if it was active, focus the last remaining open workspace or fall back to the first available workspace, or `null` if none remain.

## Implementation Units

### U1. Extend SQLite store delete to cascade sessions and analytics cache

- **Goal:** Ensure deleting a workspace removes all associated chat sessions and analytics cache rows.
- **Requirements:** R6, R8
- **Dependencies:** None
- **Files:**
  - `src/server/storage/sqlite-store.ts`
  - `src/server/storage/sqlite-store.test.ts`
- **Approach:** Inside `SqliteStore.delete(id)`, after confirming the workspace row was deleted, add `DELETE FROM sessions WHERE workspace_id = ?` and call `this.getAnalyticsCache().clearByWorkspace(id)`. Keep the change inside the existing guard so these are only run when the workspace actually existed.
- **Patterns to follow:** The existing cascade deletes in `store.delete` for `wecom_user_sessions`, `wecom_workspace_users`, `todos`, and `wecom_proactive_messages`.
- **Test scenarios:**
  - Happy path: create a workspace, add sessions and analytics cache rows, delete the workspace, assert sessions and cache rows are gone.
  - Edge case: deleting a non-existent workspace leaves sessions and cache untouched.
  - Integration scenario: existing WeCom/todo/proactive cascades still work after the change.
- **Verification:** `sqlite-store.test.ts` passes and asserts both `sessions` and `session_analytics_cache` are empty after workspace deletion.

### U2. Add `deleteWorkspace` action to workspace store with cross-store cleanup

- **Goal:** Provide a frontend action that deletes a workspace, updates workspace state, and cleans up related per-workspace state.
- **Requirements:** R5, R9, R10, R11
- **Dependencies:** U1
- **Files:**
  - `src/client/stores/workspace-store.ts`
  - Create `src/client/stores/workspace-store.test.ts` if it does not exist
- **Approach:** Add `deleteWorkspace(id)` to the store. It calls `DELETE /api/workspaces/${id}`, filters the workspace from `workspaces`, closes the tab/focus via the same logic as `closeWorkspace`, and invokes cleanup on `chat-store.cleanupWorkspace`, `files-store.clearFilesForWorkspace`, `analytics-store.clearWorkspace`, `commands-store.clearCommandsForWorkspace`, and `wecom-queue-store` workspace-scoped state. Handle 404 and network errors by setting `error`.
- **Patterns to follow:** Existing async actions in `workspace-store.ts` (`createWorkspace`, `updateWorkspace`) for loading/error handling; existing `closeWorkspace` for focus fallback.
- **Test scenarios:**
  - Happy path: delete succeeds, workspace removed, active workspace switches to another.
  - Edge case: deleting the active workspace falls back to another open workspace.
  - Edge case: deleting the last workspace sets `activeWorkspaceId` to null.
  - Error path: backend returns 404, error state is set and workspace list is unchanged.
- **Verification:** New or updated workspace-store tests pass.

### U3. Create `DeleteWorkspaceDialog` component with type-name confirmation

- **Goal:** Implement the type-name confirmation dialog.
- **Requirements:** R1, R2, R3, R4
- **Dependencies:** None
- **Files:**
  - Create `src/client/components/DeleteWorkspaceDialog.tsx`
  - Create `src/client/components/DeleteWorkspaceDialog.test.tsx`
- **Approach:** Build a modal that receives `workspaceName`, `isOpen`, `onCancel`, and `onConfirm`. Show the workspace name and a warning. Render a text input; enable the destructive confirm button only when the input exactly matches `workspaceName`. Support Escape to cancel and Enter to submit when enabled. Mirror the modal proportions and styling of `ConfirmDialog` and `CreateWorkspaceModal`.
- **Patterns to follow:** `ConfirmDialog.tsx` for modal shell proportions and keyboard handling; `CreateWorkspaceModal` for form input styling; Tailwind color tokens for destructive action.
- **Test scenarios:**
  - Happy path: typing the exact workspace name enables the Delete button.
  - Edge case: typing a different name or a case mismatch keeps Delete disabled.
  - Interaction: clicking Cancel fires `onCancel` and leaves the workspace unchanged.
  - Interaction: pressing Escape cancels; pressing Enter submits only when Delete is enabled.
- **Verification:** Component tests pass and the dialog renders in both English and Chinese (i18n keys added).

### U4. Wire delete affordance into SettingsPanel workspace tab

- **Goal:** Let users trigger workspace deletion from the workspace settings.
- **Requirements:** R1, R2, R4, R9, R10, R11
- **Dependencies:** U2, U3
- **Files:**
  - `src/client/components/SettingsPanel.tsx`
  - `src/client/i18n/en/settings.json`
  - `src/client/i18n/zh-CN/settings.json`
- **Approach:** Add a destructive "Delete workspace" button in the workspace tab, inside or immediately after `BasicInfoSection`. Clicking it opens `DeleteWorkspaceDialog` with the selected workspace name. On confirm, call `deleteWorkspace(selectedWorkspaceId)`. On success, the store handles state cleanup; on error, surface the store error via the existing error display. Add i18n keys for the button label and dialog copy.
- **Patterns to follow:** SettingsPanel's existing two-column workspace layout and dirty-state handling; existing destructive button styling in `PathConfigSection`.
- **Test scenarios:**
  - Happy path: user clicks Delete workspace, types the name, confirms; workspace is removed from the list.
  - Edge case: deleting the currently selected workspace updates `selectedWorkspaceId` to the fallback workspace.
  - Error path: backend error shows the store's error message.
- **Verification:** Manual or component test verification that the delete flow works end-to-end in SettingsPanel.

### U5. Add backend route tests for workspace delete cascade

- **Goal:** Verify the route-level delete behavior, including runtime eviction and cascade coverage.
- **Requirements:** R5, R6, R8
- **Dependencies:** U1
- **Files:**
  - `src/server/routes/workspaces.test.ts` (create if absent, otherwise extend)
- **Approach:** Add tests for the existing `DELETE /api/workspaces/:id` route that assert `store.delete` and `chatService.closeRuntimesForWorkspace` are called, and that the route returns 204 on success and 404 when missing.
- **Patterns to follow:** `src/server/routes/wecom-queue.test.ts` for mocking the store and response object with `node:test`.
- **Test scenarios:**
  - Happy path: returns 204 and calls `store.delete` and `closeRuntimesForWorkspace`.
  - Error path: returns 404 when workspace does not exist.
- **Verification:** Route tests pass.

## Scope Boundaries

- Archive, soft-delete, or undo-after-delete behavior.
- Delete affordance in the main workspace switcher.
- Deleting files or the folder on disk.
- Bulk deletion of multiple workspaces.
- Recovering a workspace after deletion.

## Risks & Dependencies

- **Backend cascade gap.** The current `store.delete` does not remove `sessions` or `session_analytics_cache`. Until U1 lands, the backend leaves orphaned session data. Mitigation: implement and test U1 before U2.
- **Cross-store cleanup completeness.** New per-workspace stores added after this feature may be missed. Mitigation: keep cleanup centralized in `workspace-store.ts` so future stores have one place to register cleanup.
- **Active session loss.** Deleting a workspace with an active streaming session will abruptly stop it. This is expected for a hard-delete operation; the dialog copy should make the destructive nature clear.
- **WeCom queue state cleanup.** `wecom-queue-store.ts` does not expose a `clearWorkspace` method. U2 will add one as part of the delete action's cleanup.

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

## Sources / Research

- Existing backend delete endpoint and cascade behavior: `src/server/routes/workspaces.ts` and `src/server/storage/sqlite-store.ts`
- Existing frontend workspace store and close logic: `src/client/stores/workspace-store.ts`
- Existing per-workspace cleanup patterns: `src/client/stores/chat-store.ts`, `src/client/stores/files-store.ts`, `src/client/stores/analytics-store.ts`, `src/client/stores/commands-store.ts`
- Reusable dialog shell pattern: `src/client/components/ConfirmDialog.tsx`
- SettingsPanel workspace tab structure: `src/client/components/SettingsPanel.tsx`
- Related prior plan for confirmation dialog patterns: `docs/plans/2026-05-27-009-feat-close-workspace-tab-confirmation-plan.md`
