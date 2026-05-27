---
title: "feat: Close Workspace Tab Confirmation"
type: feat
status: completed
date: 2026-05-27
origin: docs/brainstorms/2026-05-27-close-workspace-tab-confirmation-requirements.md
---

# feat: Close Workspace Tab Confirmation

## Summary

Remove the restriction that prevents closing the last workspace tab, and add a reusable confirmation dialog that warns users before closing a tab whose active session is streaming or has pending approvals.

---

## Problem Frame

Users currently cannot close the last open workspace tab — the close button is hidden whenever only one tab remains. Closing a workspace tab with an active streaming session or pending approvals happens instantly with no warning, causing users to accidentally interrupt in-progress work. (see origin)

---

## Requirements

- R1. Every open workspace tab must display a close button, regardless of how many tabs are open.
- R2. Clicking a tab's close button must close that workspace after any required confirmation.
- R3. The dropdown list must also show a close button for every workspace, including the last one.
- R4. A workspace is considered to have a live session if its active session has an ongoing streaming response OR has pending approvals or questions (pendingCount > 0).
- R5. Closing a workspace with a live session must display a confirmation modal before the close action executes.
- R6. The confirmation modal must include text warning the user that closing the tab will interrupt the active session.
- R7. If the user dismisses or cancels the confirmation modal, the tab must remain open with no state changes.
- R8. If the user confirms the modal, the tab must close normally and the workspace store's close action must be invoked.
- R9. The confirmation dialog must be visually consistent with the application's existing modal pattern.
- R10. All user-facing text in the confirmation dialog must be translatable via the existing i18n system.

**Origin actors:** A1 (End user)
**Origin flows:** F1 (Close a tab with no live session), F2 (Close a tab with a live session), F3 (Cancel closing a tab with a live session)
**Origin acceptance examples:** AE1, AE2, AE3, AE4, AE5

---

## Scope Boundaries

- No undo or restore-closed-tab functionality.
- No "Don't ask again" preference or setting to disable confirmations.
- No keyboard shortcut for closing workspace tabs.
- No automatic session saving or resumption after the tab is closed.
- No changes to the workspace store's `closeWorkspace` action itself.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/WorkspaceTabs.tsx` — Main component to modify. Contains tab pills and dropdown with existing `openWorkspaces.length > 1` guard on close buttons.
- `src/client/stores/workspace-store.ts` — `closeWorkspace(id)` handles tab removal and active-workspace fallback, including the last-tab case.
- `src/client/stores/chat-store.ts` — Provides `isStreaming`, `sessionStatus`, and `activeSessionIds` for live-session detection.
- `src/client/components/CreateWorkspaceModal.tsx` — Existing modal pattern to follow: fixed overlay, centered panel, header, action buttons.
- `src/client/i18n/en/settings.json` and `src/client/i18n/zh-CN/settings.json` — Existing `workspaceTabs.closeTab` key; new keys needed for confirmation dialog.

### Institutional Learnings

- `docs/solutions/conventions/commit-plan-and-brainstorm-files-with-code-changes.md` — Commit planning docs alongside implementation.

---

## Key Technical Decisions

- **Reusable `ConfirmDialog` component over inline confirmation:** The codebase has no generic confirmation primitive. A reusable component establishes a pattern for future confirmations with minimal carrying cost.
- **Live session detection in `WorkspaceTabs`:** The tab component already reads `isStreaming`, `sessionStatus`, and `activeSessionIds` for status indicators, so adding close-time detection requires no new store subscriptions.
- **Generic warning message:** A single confirmation message covers both streaming and pending-approval states, keeping i18n copy simple.

---

## Open Questions

### Resolved During Planning

- **Reusable component vs. inline confirmation?** Reusable component — sets up a pattern for future confirmations.

### Deferred to Implementation

- **Exact dialog width and padding:** Match `CreateWorkspaceModal` proportions during implementation.
- **Confirm button color:** Decide between `bg-destructive` (red, matches the destructive action) or `bg-accent` (matches primary actions) based on visual fit.

---

## Implementation Units

### U1. Remove last-tab close restriction and add live-session detection

**Goal:** Allow closing any workspace tab (including the last one) and detect live sessions before closing.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `src/client/components/WorkspaceTabs.tsx`

**Approach:**
1. Remove the `openWorkspaces.length > 1` guard from the tab pill's `onClose` prop so every tab shows a close button.
2. Remove the same guard from the dropdown's close button.
3. Add a `confirmCloseId` state (`string | null`) to track which workspace is awaiting confirmation.
4. Add a `hasLiveSession(workspaceId)` helper that resolves the workspace's active session and checks `isStreaming[sessionId]` or `sessionStatus[sessionId]?.pendingCount > 0`.
5. Create a `handleClose(id)` function: if `hasLiveSession(id)`, set `confirmCloseId` to `id`; otherwise call `closeWorkspace(id)` directly.
6. Wire `handleClose` into both the tab pill's `onClose` and the dropdown's `handleCloseFromDropdown`.

**Patterns to follow:**
- Existing `getWorkspaceCounts` helper shows how to read per-workspace session state from the chat store.

**Test scenarios:**
- Happy path: Close a workspace with no live session — tab closes immediately.
- Edge case: Close the last remaining workspace — close button is visible and tab closes immediately.
- Happy path: Close a workspace with a streaming session — confirmation state is set instead of immediate close.
- Happy path: Close a workspace with pending approvals — confirmation state is set instead of immediate close.
- Edge case: Close from both tab bar and dropdown — both trigger the same `handleClose` logic.

**Verification:**
- All workspace tabs show a close button regardless of tab count.
- Closing a non-live session workspace closes immediately with no dialog.
- Closing a live session workspace sets the confirmation state.

---

### U2. Create reusable ConfirmDialog component

**Goal:** Build a generic confirmation dialog consistent with the existing modal pattern.

**Requirements:** R9

**Dependencies:** None

**Files:**
- Create: `src/client/components/ConfirmDialog.tsx`

**Approach:**
1. Define props: `isOpen`, `title`, `message`, `confirmLabel`, `cancelLabel`, `onConfirm`, `onCancel`.
2. Render a fixed overlay with `bg-overlay/60 backdrop-blur-sm` and click-to-dismiss behavior.
3. Render a centered panel with `bg-surface border border-border rounded-xl shadow-2xl` and a max-width constraint.
4. Include a title, message body, and a footer with Cancel and Confirm buttons.
5. Add keyboard handlers: Escape calls `onCancel`, Enter calls `onConfirm` when open.
6. Return `null` when `isOpen` is false to keep the React tree clean.

**Patterns to follow:**
- Match `CreateWorkspaceModal` overlay, panel rounding, shadow, and button styling.
- Use the same `text-xs font-medium` button sizing as existing UI.

**Test scenarios:**
- Happy path: Dialog renders with provided title, message, and button labels when `isOpen` is true.
- Happy path: Clicking the confirm button calls `onConfirm`.
- Happy path: Clicking the cancel button calls `onCancel`.
- Happy path: Clicking the overlay calls `onCancel`.
- Edge case: Pressing Escape calls `onCancel`.
- Edge case: Pressing Enter calls `onConfirm`.
- Edge case: Dialog returns null and renders nothing when `isOpen` is false.

**Verification:**
- Dialog is visually consistent with `CreateWorkspaceModal`.
- Dialog properly handles keyboard interactions and overlay dismissal.

---

### U3. Wire confirmation dialog and add i18n strings

**Goal:** Integrate `ConfirmDialog` into the tab close flow and add translatable strings.

**Requirements:** R5, R6, R7, R8, R10

**Dependencies:** U1, U2

**Files:**
- Modify: `src/client/components/WorkspaceTabs.tsx`
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:**
1. Import `ConfirmDialog` into `WorkspaceTabs`.
2. Render it conditionally based on `confirmCloseId` state.
3. Pass the workspace name into the dialog title for context.
4. On confirm, call `closeWorkspace(confirmCloseId)` and clear `confirmCloseId`.
5. On cancel, clear `confirmCloseId` state.
6. Add i18n keys under a `closeWorkspace` namespace:
   - `confirmTitle`: "Close workspace?"
   - `confirmMessage`: "This workspace has an active session. Closing the tab will stop it."
   - `confirmButton`: "Close anyway"
   - `cancelButton`: "Cancel"
7. Provide Chinese translations for all new keys.

**Patterns to follow:**
- Existing `workspaceTabs.closeTab` key in `settings.json` shows the naming convention.
- Use `t('closeWorkspace.confirmTitle')` pattern with the `settings` namespace.

**Test scenarios:**
- Covers AE2. Given a workspace with a streaming session, when the user clicks the tab close button and confirms the dialog, the tab closes.
- Covers AE3. Given a workspace with pending approvals, when the user clicks close and confirms, the tab closes.
- Covers AE4. Given the confirmation dialog is open, when the user clicks Cancel, the dialog closes and the tab remains open.
- Covers AE5. Given a workspace with no live session, when the user clicks close, the tab closes immediately with no dialog.
- Integration: Dialog text renders in the correct language when switching between en and zh.

**Verification:**
- Closing a live session tab shows the confirmation dialog with the correct workspace name and warning text.
- Confirming closes the tab; canceling leaves it open.
- Both English and Chinese i18n strings are present and display correctly.

---

## System-Wide Impact

- **Interaction graph:** `WorkspaceTabs` reads from `workspace-store` and `chat-store`. No new cross-store reads are added.
- **State lifecycle risks:** `confirmCloseId` is local UI state. If the workspace is closed by another mechanism while the dialog is open, the confirmation callback will reference a stale ID — but `closeWorkspace` is idempotent for unknown IDs.
- **API surface parity:** N/A — this is a UI-only change.
- **Unchanged invariants:** `closeWorkspace` behavior, tab pill styling, status indicator calculation, bot status polling, and dropdown behavior all remain unchanged except for the close-button visibility and confirmation gate.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Dialog styling drifts from existing modal pattern | Follow `CreateWorkspaceModal` proportions and Tailwind classes closely. |
| i18n strings missing in one language | Add both `en` and `zh-CN` keys in the same unit. |
| Closing the last tab leaves the app in an unexpected state | The workspace store already handles `activeWorkspaceId = null`; verify the empty state renders correctly. |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-27-close-workspace-tab-confirmation-requirements.md](docs/brainstorms/2026-05-27-close-workspace-tab-confirmation-requirements.md)
- Related code: `src/client/components/WorkspaceTabs.tsx`, `src/client/stores/workspace-store.ts`, `src/client/stores/chat-store.ts`, `src/client/components/CreateWorkspaceModal.tsx`
- Related plan: `docs/plans/2026-05-27-001-feat-keep-alive-workspace-tabs-plan.md`
