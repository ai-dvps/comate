---
title: Keep-Alive Workspace Tabs
type: feat
status: active
date: 2026-05-27
origin: docs/brainstorms/keep-alive-workspace-tabs-requirements.md
---

# Keep-Alive Workspace Tabs

## Summary

Render every open workspace's ChatPanel in the React tree at all times, showing only the active one via CSS visibility. Scope global loading flags to prevent cross-tab spinner bleed, and clean up SSE subscriptions and polling when tabs are closed.

---

## Problem Frame

Currently, App.tsx renders exactly one ChatPanel — the active workspace. Switching tabs destroys the previous panel and rebuilds it on return, causing seconds-long freezes for workspaces with large histories. Scroll position, composer state, and live streaming are all lost. (see origin: docs/brainstorms/keep-alive-workspace-tabs-requirements.md)

---

## Requirements

- R1. Every workspace in `openWorkspaceIds` must have its panel mounted in the React tree at all times.
- R2. Only the active workspace panel is visible; inactive panels are hidden without being unmounted.
- R3. Switching active workspace via tab click must be instantaneous, with no perceptible remount or rebuild.
- R4. Inactive workspace panels must preserve scroll position and virtualizer state across tab switches.
- R5. Inactive workspace panels must preserve composer draft text, input focus state, and cursor position across tab switches.
- R6. Inactive workspaces must continue receiving live SSE updates and streaming tokens for their active sessions without interruption.
- R7. Closing a workspace tab removes it from `openWorkspaceIds` and fully unmounts its panel.
- R8. Opening a new workspace tab mounts its panel for the first time.

**Origin actors:** End user
**Origin flows:** F1 (Switch workspace tab), F2 (Stream while backgrounded)
**Origin acceptance examples:** AE1, AE2, AE3

---

## Scope Boundaries

- No cap on the number of kept-alive tabs in v1.
- No sleep or suspend mechanism for background tabs.
- No state persistence across full page reloads or app restarts.
- No visual preview or thumbnail of inactive tabs.
- No new automated test suite — the project has no existing component/integration test infrastructure.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/App.tsx` — Currently renders a single `ChatPanel` for `activeWorkspace.id`.
- `src/client/stores/workspace-store.ts` — Tracks `openWorkspaceIds`, `activeWorkspaceId`, `openWorkspace`, `closeWorkspace`, `setActiveWorkspace`.
- `src/client/stores/chat-store.ts` — Session-scoped SSE subscriptions via `sessionSubscriptions` Map. `setActiveSession` closes the previous session for that workspace only; different sessionIds can subscribe simultaneously.
- `src/client/components/ChatPanel.tsx` — Scoped to `workspaceId` prop. Reads `activeSessionIds[workspaceId]`, `sessions[workspaceId]`, `isStreaming[sessionId]`. Calls `fetchSessions` on mount and `loadMessages` when `activeSessionId` changes.
- `src/client/components/VirtualizedMessageList.tsx` — Instance-scoped state, safe to mount multiple times. No global singletons.
- `src/client/components/WorkspaceTabs.tsx` — Already has `isActive` styling logic.

### Institutional Learnings

- `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md` — SSE clean-close retry logic in `subscribeToSession`. Background tabs will rely on this retry behavior if connections drop while inactive.

---

## Key Technical Decisions

- **CSS `visibility: hidden` over `display: none` for inactive panels:** `display: none` resets scroll position and virtualizer state. `visibility: hidden` preserves layout box and scroll offset while making content invisible. Combined with `pointer-events: none`, `aria-hidden`, and `inert` for interaction isolation.
- **Absolute-positioned panel stacking:** All panels fill a relative container via `absolute inset-0`. Only the active panel is `visible`; inactive panels are `invisible pointer-events-none`.
- **Scope `isLoadingMessages` by sessionId and `isLoadingSessions` by workspaceId:** Both are currently global booleans. With multiple panels mounted, a load in one tab bleeds spinners to all others. Changing to `Record<string, boolean>` keeps each panel's loading state isolated.

---

## Open Questions

### Resolved During Planning

- **Does the current SSE architecture support multiple simultaneous subscriptions?** Yes. `sessionSubscriptions` is keyed by `sessionId`, and `setActiveSession` only closes the previous session for the same workspace. Background workspaces keep their subscriptions open naturally.
- **Will VirtualizedMessageList break with multiple instances?** No. All state is instance-scoped; no global singletons.

### Deferred to Implementation

- **Exact cleanup strategy for subscriptions and polling on tab close:** Decide between adding a ChatPanel unmount effect vs. a dedicated chat-store action. Either works; choose based on which creates less coupling between workspace-store and chat-store.

---

## Implementation Units

### U1. App.tsx multi-panel rendering with CSS visibility and a11y isolation

**Goal:** Render all open workspace panels simultaneously, showing only the active one via CSS visibility.

**Requirements:** R1, R2, R3, R7, R8

**Dependencies:** None

**Files:**
- Modify: `src/client/App.tsx`

**Approach:**
- Replace the single `ChatPanel` render with a map over `openWorkspaceIds`.
- Wrap each panel in a relative container with absolute-positioned children (`absolute inset-0`).
- Toggle visibility via Tailwind's `visible` / `invisible pointer-events-none` classes.
- Add `aria-hidden={isInactive}` and `inert={isInactive}` to inactive wrappers.
- Preserve the empty-state fallback when no workspace is open.

**Patterns to follow:**
- Use existing `cn()` utility for conditional class names if available.
- `openWorkspaceIds` and `activeWorkspaceId` are already available from `useWorkspaceStore`.

**Test scenarios:**
- Happy path: Given three open workspaces, switching tabs instantly shows the correct panel with no loading state.
- Edge case: Close the active workspace tab; the fallback to the last-opened tab works and the closed panel is fully removed.
- Edge case: Close all workspaces; the empty-state placeholder appears.
- Integration: Background panel remains mounted in React DevTools after switching away.

**Verification:**
- Switching between tabs is visually instant with no remount flash.
- Inactive panels are not keyboard-focusable and are hidden from screen readers.

---

### U2. Scope loading flags to prevent cross-tab spinner bleed

**Goal:** Convert global `isLoadingMessages` and `isLoadingSessions` booleans to scoped records so each panel shows its own loading state.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/client/stores/chat-store.ts`
- Modify: `src/client/components/ChatPanel.tsx`
- Modify: `src/client/components/SessionList.tsx`

**Approach:**
- In `chat-store.ts`:
  - Change `isLoadingMessages: boolean` to `isLoadingMessages: Record<string, boolean>` (keyed by `sessionId`).
  - Change `isLoadingSessions: boolean` to `isLoadingSessions: Record<string, boolean>` (keyed by `workspaceId`).
  - Update `fetchSessions` to set `isLoadingSessions[workspaceId]`.
  - Update `loadMessages` to set `isLoadingMessages[sessionId]`.
- In `ChatPanel.tsx`: read `isLoadingMessages[activeSessionId]` instead of the global flag.
- In `SessionList.tsx`: read `isLoadingSessions[workspaceId]` instead of the global flag.

**Patterns to follow:**
- The store already uses `Record<string, T>` patterns for `isStreaming`, `approvalQueue`, `messages`, etc.

**Test scenarios:**
- Happy path: Loading messages in Workspace A does not show a spinner in Workspace B.
- Happy path: Loading sessions in Workspace A does not show a spinner in Workspace B's session list.
- Edge case: Simultaneous loading in multiple workspaces works without race conditions on the flags.

**Verification:**
- Open two workspaces. Trigger a message load in one (e.g., by switching sessions). The other workspace shows no loading indicator.

---

### U3. Verify and harden background tab state preservation

**Goal:** Confirm that scroll position, virtualizer state, composer input, and live SSE streaming all survive workspace switches without code changes, and patch any gaps found.

**Requirements:** R4, R5, R6

**Dependencies:** U1

**Files:**
- Modify (if needed): `src/client/stores/chat-store.ts`
- Modify (if needed): `src/client/components/ChatPanel.tsx`
- Modify (if needed): `src/client/components/VirtualizedMessageList.tsx`

**Approach:**
- The mount-all approach naturally preserves React local state (scroll, virtualizer, composer draft).
- SSE subscriptions are session-scoped and already support multiple concurrent connections. `setActiveSession` only closes the previous session for the same workspace, so switching `activeWorkspaceId` does not interrupt background streams.
- Verify during implementation that no workspace-switch logic inadvertently closes subscriptions.
- If `VirtualizedMessageList` loses scroll position when toggling `visibility`, investigate `scrollTop` persistence or add a lightweight scroll-restoration ref.

**Patterns to follow:**
- Existing `sessionSubscriptions` Map and `subscribeToSession` retry logic from `sse-clean-close-retry` learning.

**Test scenarios:**
- Happy path: Scroll down in Workspace A, switch to B, switch back to A — scroll position is preserved.
- Happy path: Start a stream in Workspace A, switch to B, verify tokens continue arriving in A's store state.
- Integration: Switch back to A after 30 seconds; all streamed tokens are present and the virtualizer renders them correctly.
- Edge case: Rapidly switch between three tabs; no state corruption or duplicate subscriptions.

**Verification:**
- Background streaming workspace shows new tokens in the store (observable via React DevTools or network tab).
- Returning to a backgrounded workspace shows the exact scroll position and composer state that were present when leaving.

---

### U4. Clean up subscriptions and polling when workspace tabs are closed

**Goal:** Ensure closing a workspace tab fully releases its SSE subscription and background polling interval.

**Requirements:** R7

**Dependencies:** U1

**Files:**
- Modify: `src/client/stores/chat-store.ts`
- Modify: `src/client/components/ChatPanel.tsx`

**Approach:**
- Add a cleanup effect in `ChatPanel.tsx` that runs on unmount:
  - Close the SSE subscription for the workspace's active session.
  - Stop the background polling interval for the workspace.
- Implement a dedicated chat-store action (e.g., `cleanupWorkspace(workspaceId)`) that:
  - Looks up the active session for the workspace.
  - Closes its subscription via `sessionSubscriptions.get(sessionId)?.close()`.
  - Clears the polling interval via `workspacePollIntervals.get(workspaceId)`.
- Call this action from ChatPanel's unmount effect.

**Patterns to follow:**
- Existing subscription cleanup pattern in `setActiveSession` (close + delete from Map).
- Existing polling cleanup pattern in `startBackgroundPolling` (clearInterval + delete from Map).

**Test scenarios:**
- Happy path: Open Workspace A, close it, and confirm the SSE connection closes (Network tab shows no active stream for that session).
- Happy path: Close Workspace A and confirm `/api/workspaces/{id}/sessions/status` polling stops.
- Edge case: Close a workspace while it is actively streaming; the stream terminates cleanly without errors.

**Verification:**
- Browser DevTools Network tab shows no SSE stream for a closed workspace's session.
- No `sessions/status` polling requests for closed workspaces.

---

## System-Wide Impact

- **Interaction graph:** `App.tsx` now mounts multiple `ChatPanel` instances. Each panel independently calls `fetchSessions` and subscribes to store updates. Zustand selectors are already scoped by `workspaceId` / `sessionId`, so cross-panel re-renders should be minimal after U2.
- **Error propagation:** A crash in one ChatPanel (e.g., a bad message render) could now affect the entire app because all panels are always mounted. React error boundaries should already handle this; verify none are missing around panels.
- **State lifecycle risks:** Background polling intervals and SSE subscriptions for open workspaces now live as long as the tab is open. Closing a tab must reliably clean them up (U4) to prevent resource leaks.
- **Unchanged invariants:** `setActiveSession`, `subscribeToSession`, and the retry logic remain unchanged. Session switching within a workspace still works exactly as before.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Background panel re-renders cause jank in the active tab | Zustand selectors are scoped; U2 scopes the remaining global flags. If jank persists, consider `React.memo` on ChatPanel or `content-visibility` CSS. |
| `visibility: hidden` panels still consume memory with large virtualized lists | Accept for v1 per scope boundaries. Mitigate by monitoring typical usage (≤5 tabs). If needed, a future cap or sleep mechanism can unmount older tabs. |
| Subscription/polling cleanup on close is missed, causing leaks | U4 explicitly adds cleanup. Verify via browser DevTools Network tab before considering the feature complete. |
| Focus trapped or lost when switching between invisible/visible panels | U1 adds `inert`, `aria-hidden`, and `pointer-events-none`. Manual keyboard navigation test during verification. |

---

## Sources & References

- **Origin document:** [docs/brainstorms/keep-alive-workspace-tabs-requirements.md](docs/brainstorms/keep-alive-workspace-tabs-requirements.md)
- Related code: `src/client/App.tsx`, `src/client/stores/chat-store.ts`, `src/client/stores/workspace-store.ts`, `src/client/components/ChatPanel.tsx`, `src/client/components/VirtualizedMessageList.tsx`, `src/client/components/WorkspaceTabs.tsx`
- Related learning: `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md`
