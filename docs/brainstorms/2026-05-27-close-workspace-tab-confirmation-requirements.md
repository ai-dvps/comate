---
date: 2026-05-27
topic: close-workspace-tab-confirmation
---

# Close Workspace Tab Confirmation

## Summary

Remove the restriction that hides the close button on the last workspace tab, and add a confirmation modal before closing any tab whose active session is currently streaming or has pending approvals. The dialog warns the user that closing will interrupt the active session.

---

## Problem Frame

Users currently cannot close the last open workspace tab — the close button is hidden whenever only one tab remains. This forces users to keep at least one tab open even when they want a clean slate. Additionally, closing a workspace tab with an active streaming session or pending approvals happens instantly with no warning, causing users to accidentally interrupt in-progress work. A misclick on the small tab X can lose a streaming response or dismiss pending questions that required user input.

---

## Actors

- A1. End user: Opens, switches, and closes workspace tabs.

---

## Key Flows

- F1. Close a tab with no live session
  - **Trigger:** User clicks the X on a workspace tab or in the dropdown.
  - **Actors:** A1
  - **Steps:**
    1. User clicks the close button.
    2. The workspace tab closes immediately.
    3. If the closed workspace was active, focus shifts to another open workspace (or to the empty state if none remain).
  - **Outcome:** The tab is closed with no interruption.
  - **Covered by:** R1, R2, R3

- F2. Close a tab with a live session
  - **Trigger:** User clicks the X on a workspace tab whose active session is streaming or has pending approvals.
  - **Actors:** A1
  - **Steps:**
    1. User clicks the close button.
    2. A confirmation modal appears warning that closing will interrupt the active session.
    3. User clicks the confirm action.
    4. The workspace tab closes.
    5. If the closed workspace was active, focus shifts to another open workspace (or to the empty state if none remain).
  - **Outcome:** The tab closes after explicit confirmation.
  - **Covered by:** R4, R5, R6, R8

- F3. Cancel closing a tab with a live session
  - **Trigger:** User clicks the X on a workspace tab with a live session, then changes their mind.
  - **Actors:** A1
  - **Steps:**
    1. User clicks the close button.
    2. A confirmation modal appears.
    3. User clicks Cancel or dismisses the modal.
    4. The modal closes and the tab remains open.
  - **Outcome:** No state changes; the tab stays open.
  - **Covered by:** R7

---

## Requirements

**Tab close availability**
- R1. Every open workspace tab must display a close button, regardless of how many tabs are open.
- R2. Clicking a tab's close button must close that workspace after any required confirmation.
- R3. The dropdown list must also show a close button for every workspace, including the last one.

**Live session detection**
- R4. A workspace is considered to have a live session if its active session has an ongoing streaming response OR has pending approvals or questions (pendingCount > 0).
- R5. Closing a workspace with a live session must display a confirmation modal before the close action executes.
- R6. The confirmation modal must include text warning the user that closing the tab will interrupt the active session.
- R7. If the user dismisses or cancels the confirmation modal, the tab must remain open with no state changes.
- R8. If the user confirms the modal, the tab must close normally and the workspace store's close action must be invoked.

**Modal presentation**
- R9. The confirmation dialog must be visually consistent with the application's existing modal pattern (overlay, panel, action buttons).
- R10. All user-facing text in the confirmation dialog must be translatable via the existing i18n system.

---

## Acceptance Examples

- AE1. **Covers R1, R3.** Given only one workspace is open, when the user views the tab bar and the dropdown, then the close button is visible on the tab pill and in the dropdown row.
- AE2. **Covers R4, R5, R6, F2.** Given Workspace A has an active session that is currently streaming, when the user clicks the tab's close button, then a confirmation modal appears with text warning that closing will interrupt the session.
- AE3. **Covers R4, R5, F2.** Given Workspace B has a session with pending approvals (pendingCount > 0) but is not streaming, when the user clicks the tab's close button, then a confirmation modal appears.
- AE4. **Covers R7, F3.** Given the confirmation modal is open for a live session, when the user clicks Cancel, then the modal closes and the tab remains open with no state changes.
- AE5. **Covers R1, R2.** Given a workspace with no active session, when the user clicks the tab's close button, then the tab closes immediately with no confirmation.

---

## Success Criteria

- Users can close any workspace tab, including the last one, from both the tab bar and the dropdown.
- Users are never surprised by a streaming session or pending approvals being lost due to an accidental tab close.
- The confirmation experience is consistent across tab X buttons and dropdown close buttons.

---

## Scope Boundaries

- No undo or restore-closed-tab functionality.
- No "Don't ask again" preference or setting to disable confirmations.
- No keyboard shortcut for closing workspace tabs.
- No automatic session saving or resumption after the tab is closed.

---

## Key Decisions

- **Live session = streaming OR pending approvals:** Covers both "thinking" and "waiting for me" states without being overly broad (any active session would be too noisy).
- **Interrupt-on-close with warning:** Closing the tab stops the session; the modal confirms rather than prevents. This matches the existing architecture where closing unmounts the panel and cleans up subscriptions.
- **Generic warning message for v1:** A single confirmation message covers both streaming and pending-approval states to keep copy simple and avoid over-engineering message variants.

---

## Dependencies / Assumptions

- The workspace store's `closeWorkspace` action already handles the last-tab case by setting `activeWorkspaceId` to `null`, which renders the app's empty state.
- `isStreaming` and `sessionStatus` are available per session in the chat store and can be read by the tab component to detect live sessions.
- The existing custom modal pattern (overlay + panel + action buttons) is the baseline for confirmation dialog styling.
