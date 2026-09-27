---
date: 2026-05-27
topic: keep-alive-workspace-tabs
---

# Keep-Alive Workspace Tabs

## Summary

All open workspace tabs stay mounted and live in the background. Switching tabs shows the workspace instantly with scroll, input, and streaming state fully preserved — no rebuild, no seconds-long freeze on large histories.

---

## Problem Frame

Users frequently switch between workspace tabs to check on parallel conversations or reference prior context. Currently, only the active workspace panel is rendered; switching tabs destroys the previous panel and rebuilds it from store data on return. For workspaces with extensive message history, this rebuild triggers seconds of UI freeze while the virtualizer remounts and re-renders. Additionally, scroll position, composer draft text, input focus, and live streaming state are all lost on every switch. This makes the tab experience feel unlike desktop applications where tabs remain fully warm in the background.

---

## Key Flows

- F1. Switch workspace tab
  - **Trigger:** User clicks an open workspace tab that is not currently active.
  - **Actors:** End user
  - **Steps:**
    1. User clicks the target workspace tab.
    2. The target workspace panel becomes visible.
    3. The previously active workspace panel is hidden.
  - **Outcome:** The target workspace appears instantly with all UI state intact.
  - **Covered by:** R1, R2, R3, R4, R5

- F2. Stream while backgrounded
  - **Trigger:** A workspace is receiving a streaming response and the user switches to another workspace.
  - **Actors:** End user
  - **Steps:**
    1. Workspace A receives a streaming response.
    2. User switches to Workspace B.
    3. Workspace A continues receiving tokens in the background.
    4. User switches back to Workspace A.
  - **Outcome:** Workspace A shows all tokens that arrived during the absence, with no catch-up rendering delay.
  - **Covered by:** R6

---

## Requirements

**Tab rendering and visibility**
- R1. Every workspace in `openWorkspaceIds` must have its panel mounted in the React tree at all times, not just the active one.
- R2. Only the active workspace panel is visible; inactive panels are hidden from view and interaction without being unmounted.
- R3. Switching active workspace via tab click must be instantaneous, with no perceptible remount or rebuild of the target panel.

**Live state preservation**
- R4. Inactive workspace panels must preserve their scroll position and virtualizer state across tab switches.
- R5. Inactive workspace panels must preserve composer draft text, input focus state, and cursor position across tab switches.
- R6. Inactive workspaces must continue receiving live SSE updates and streaming tokens for their active sessions without interruption.

**Lifecycle**
- R7. Closing a workspace tab removes it from `openWorkspaceIds` and fully unmounts its panel.
- R8. Opening a new workspace tab mounts its panel for the first time.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3, R4.** Given three workspaces are open with Workspace A active, when the user clicks the tab for Workspace B, then Workspace B appears instantly at its prior scroll position with no loading state or visible remount.
- AE2. **Covers R6.** Given Workspace A is receiving a streaming response and the user switches to Workspace B, when the user switches back to Workspace A after 30 seconds, then all streamed tokens received during the absence are already present and the stream continues if not yet complete.
- AE3. **Covers R7.** Given three workspaces are open, when the user closes Workspace C, then Workspace C's panel is fully unmounted and no longer consumes rendering or subscription resources.

---

## Success Criteria

- Switching between open tabs feels instant with no perceptible freeze even for workspaces with 100+ messages.
- A user can leave a streaming workspace, work in another, and return to find the stream fully caught up.
- No regressions in memory or CPU usage for typical usage (5 or fewer open tabs).

---

## Scope Boundaries

- No cap on the number of kept-alive tabs in v1.
- No sleep or suspend mechanism for background tabs.
- No state persistence across full page reloads or app restarts.
- No visual preview or thumbnail of inactive tabs.

---

## Key Decisions

- **Mount-all with CSS-hide over state-snapshot remount:** The only way to preserve live SSE streaming and full UI state without complex snapshot-and-restore logic.
- **No cap on kept-alive tabs for v1:** Start simple, measure real-world impact, and add throttling or a cap later if needed.

---

## Dependencies / Assumptions

- Each workspace panel can manage its own SSE subscription independently; there is no architectural singleton that forces only one active subscription at a time.
- React component state (virtualizer, scroll, input) is the source of truth for UI state and does not need to be lifted into the global store to survive tab switches.
