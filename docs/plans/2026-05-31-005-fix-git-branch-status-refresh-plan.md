---
title: "fix: Git branch status bar not refreshing"
date: 2026-05-31
type: fix
status: completed
---

# fix: Git branch status bar not refreshing

## Problem Frame

The `TokenUsageBar` component at the bottom of `ChatPanel` displays the current git branch name for the active workspace. It fetches the branch once when `workspaceId` changes, then never updates. If the user switches git branches while the app is open, the displayed branch name becomes stale and misleading.

Root cause: the `useEffect` that calls `/api/workspaces/${workspaceId}/git-ref` only lists `workspaceId` in its dependency array, so it never re-runs after the initial mount or workspace switch.

## Requirements Traceability

| Requirement | Description |
|-------------|-------------|
| R1 | The git branch name shown in the chat panel status bar must reflect the current branch within a reasonable time after a branch switch. |
| R2 | The refresh mechanism should not add excessive network load. |
| R3 | The fix should follow existing client-side polling patterns in the codebase. |

## Scope Boundaries

### In Scope
- Updating `TokenUsageBar.tsx` to refresh the git ref periodically and on relevant user-interaction events.

### Out of Scope
- Server-side caching or push mechanisms for git status.
- Visual redesign of the status bar.
- File-system watching for git changes.

### Deferred to Follow-Up Work
- Extracting a reusable hook for visibility-aware polling (only if the same pattern is needed elsewhere).

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| **Polling interval: 10 seconds** | The server route runs local `git` commands with no network latency, so polling is cheap. 10s strikes a balance between freshness and load. Existing polling in the codebase ranges from 5s (session status, bot status) to 10s (WeCom users). |
| **Also refresh on window focus / tab visibility** | Immediately updates the branch when the user returns to the app, avoiding a jarring stale state after alt-tabbing back from a terminal where they ran `git checkout`. |
| **No server-side changes** | The `git-status.ts` route is stateless and fast; client-side polling is sufficient for this UX need. |

## Implementation Units

### U1. Add periodic and visibility-based git-ref refresh to TokenUsageBar

**Goal:** Keep the displayed git branch name current without waiting for a workspace switch.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- `src/client/components/TokenUsageBar.tsx`

**Approach:**
1. Keep the existing `useEffect` that fetches on `workspaceId` change, but add a `setInterval` inside it that repeats the fetch every 10 seconds.
2. Add a second `useEffect` (or inline listeners in the first) that refreshes the git ref immediately when:
   - The `visibilitychange` event fires and `document.visibilityState` becomes `"visible"`.
   - The window receives a `"focus"` event.
3. Clean up both the interval and the event listeners in the effect cleanup function.
4. Ensure the fetch callback is stable (wrap in `useCallback` if needed) to avoid re-subscribing on every render.

**Patterns to follow:**
- `WorkspaceTabs.tsx` lines ~155: `setInterval` + `clearInterval` pattern inside `useEffect`.
- `chat-store.ts` lines ~14-48: background polling with cleanup on dependency change.

**Test scenarios:**

Test expectation: none — The project has no component-level test coverage for client components (`src/client/lib/summarize-tool-input.test.ts` is the only existing client test). This is a pure UI-data-sync change with no complex state logic; manual verification is sufficient.

**Verification:**
1. Open a workspace in the chat panel and note the displayed branch name.
2. In a terminal, run `git checkout <another-branch>` in that workspace folder.
3. Within ~10 seconds, the status bar should update to show the new branch name.
4. Switch to another application, run `git checkout` again, and switch back to the app — the branch name should update promptly (within a second of refocusing).
5. Switch workspaces and confirm the branch name updates immediately for the new workspace.
