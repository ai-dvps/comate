---
date: 2026-06-13
topic: active-session-header
---

## Summary

Add a pinned, visually distinct header above the session list that displays the currently active session. The active session is removed from the scrolling list; all other sessions keep their existing order.

## Problem Frame

In `src/client/components/SessionList.tsx`, the active session is rendered inline with the rest of the workspace sessions. When the list is long or sessions arrive in a fixed order, the active session can be hard to locate at a glance. The user wants the active session to be immediately visible at the top of the list without disturbing the order of the remaining sessions.

## Requirements

- R1. A pinned header is shown above the scrolling session list whenever a session is active for the current workspace.
- R2. The header displays the active session and only the active session.
- R3. The active session is not rendered inside the scrolling session list while it is active.
- R4. The header uses a visually distinct style from normal list rows.
- R5. The header exposes the same session actions as a normal row: rename and WIP toggle.
- R6. All sessions other than the active one keep their existing order in the scrolling list.
- R7. When no session is active, the header is hidden and the list behaves as it does today.

## Key Decisions

- **Pinned header instead of list reordering.** Preserves the user's mental model of the list and avoids the active session shifting as new activity arrives.
- **Active session shown only in the header, not duplicated in the list.** Keeps the list compact and unambiguous.
- **Header supports the same row actions as normal session items.** Users do not lose rename or WIP-toggle functionality for the active session.

## Scope Boundaries

- Sorting the remaining sessions by recency or activity.
- Pinning more than one session at a time.
- A user setting to disable the pinned header.

## Acceptance Examples

- AE1. **Selecting a session moves it to the header.**
  - **Given:** a workspace with multiple sessions and none selected.
  - **When:** the user clicks a session in the list.
  - **Then:** the clicked session appears in the pinned header and disappears from its original list position.

- AE2. **Rename input follows an active-session change.**
  - **Given:** the user is renaming the active session inline.
  - **When:** the active session changes to a different session.
  - **Then:** the inline rename input moves into the newly active session's header entry.

- AE3. **No active session hides the header.**
  - **Given:** the workspace has sessions but none is selected.
  - **Then:** the pinned header is not rendered and the full session list is visible.

- AE4. **WIP toggle works from the header.**
  - **Given:** a session is active and shown in the header.
  - **When:** the user opens the context menu on the header and toggles WIP.
  - **Then:** the session's WIP state updates and the header reflects the change.
