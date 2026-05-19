---
date: 2026-05-18
topic: workspace-and-session-status-indicators
---

# Workspace & Session Status Indicators

## Summary

Add three-state status indicators to workspace tabs and session list items — needs-me (approval/input required), finished-unread, and streaming — so the user can maximize parallel-work throughput by glancing at the chrome rather than switching into each session. Workspace tabs stack the indicators with per-state counts when multiple sessions are in different states; session rows show their single current state by precedence. Indicators are visual-only — no OS notifications, in-app toasts, or sound.

---

## Problem Frame

The user runs many sessions across many workspaces in parallel, but the GUI can only show one session at a time. The session list (`src/client/components/SessionList.tsx`) is scoped to the *active* workspace, so any session in any *other* open workspace is invisible while the user is working — they have no signal that workspace B's session needs an approval, or that workspace C's session has finished and there's output to review.

Today the only status signal on the chrome is a small orange dot on a session row when its approval queue is non-empty (`src/client/components/SessionList.tsx:165-170`). Workspace tabs (`src/client/components/WorkspaceTabs.tsx`) carry no status at all — they show only the folder icon, name, and close button.

The cost of this gap is throughput: parallel sessions sit idle waiting on the user because the user has no way to know which one to switch to without manually clicking through every workspace tab to check. The user also has no signal that work is actually progressing in another workspace versus silently stuck, so they lose confidence in parallelism itself. Recent UX work on streaming (e.g., the larger stop button, the SSE replay-on-reconnect fix) shows the user is actively living in this multi-session pain.

---

## Requirements

**States and precedence**

- R1. Three states per session: **streaming**, **finished-unread**, **needs-me** (approval or user input required). A session resolves to one state at a time on the session row, using the precedence **needs-me > finished-unread > streaming** when multiple conditions are true.
- R2. The streaming indicator visually conveys liveness (e.g., a pulsing or animated form), not a static dot. The user must be able to distinguish "currently streaming" from "stopped/idle" without clicking into the session.
- R3. The finished-unread indicator is an *unread* state: it appears when a streaming response completes on a session that is **not** the currently-active session, and clears the moment that session becomes active.
- R4. The needs-me indicator appears whenever a session's approval queue is non-empty (existing trigger — `sessionStatus[sessionId].pendingCount > 0` in `chat-store`), and clears when the queue drains.

**Session list row**

- R5. Each session row in the session list renders at most one status indicator at a time, reflecting that session's current single state per R1's precedence.
- R6. The existing orange dot on a session row for needs-me (`src/client/components/SessionList.tsx:165-170`) continues to fulfill R4 — extended in shape to be one of three possible per-row indicators rather than the only one.
- R7. The currently-active session in the list still renders its indicator, except for finished-unread, which is suppressed because activating the session IS the read event.

**Workspace tab aggregation**

- R8. Each workspace tab aggregates state from its sessions and renders up to three indicators **stacked side by side**, one per state present in that workspace. When no non-idle sessions exist, no status indicators render — the tab shows only folder icon + name + close button as today (`src/client/components/WorkspaceTabs.tsx`).
- R9. Each indicator on a workspace tab carries a count of sessions in that state (e.g., needs-me indicator with "2" means two sessions in that workspace need approval). Counts are computed per-state independently — a session that is both streaming and needs-me (R1 collision) counts in *both* tab buckets even though it shows only as needs-me on the session row.
- R10. The currently-active workspace's tab follows the same rules as inactive workspace tabs — its per-state counts render normally. Finished-unread counts decrement immediately when the user activates a session within that workspace.

**Read-state tracking**

- R11. The system tracks per-session "has the user viewed this session since its last stream completion." Setting a session active counts as viewing it.
- R12. Switching to a different *workspace* does not clear finished-unread state for any session — only making the specific session active clears its own unread status. A user who tabs over to workspace B without clicking any session row still sees workspace B's finished-unread counts unchanged.

**Visual layout**

```
Workspace tab layouts (after this doc lands):

[📁 backend   1🟠  2🔵  1🟢  ×]    ← 1 needs-me, 2 finished-unread, 1 streaming
[📁 ui-work          2🟢  ×]       ← 2 streaming, nothing else
[📁 docs      1🟠         ×]       ← 1 needs-me only
[📁 quiet                 ×]       ← no non-idle sessions, no indicators

Legend:
  🟠 = needs-me  (approval/input required)
  🔵 = finished-unread
  🟢 = streaming (pulses to convey liveness)

Session row layouts (within the active workspace):

[💬 Refactor auth      🟠 ]   ← needs-me (highest precedence)
[💬 Write tests        🟢 ]   ← streaming
[💬 Generate report    🔵 ]   ← finished-unread (not active session)
[💬 Read docs             ]   ← idle, no indicator
[💬 [active session]      ]   ← active, finished-unread suppressed by R7
```

Exact colors, icon shapes, and animation specifics are designer calls (see Outstanding Questions).

---

## Acceptance Examples

- AE1. **Covers R1, R3, R7.** Given session X is mid-stream and the user is viewing a different session Y in the same workspace, when X's stream completes, X's row shows the finished-unread indicator. When the user clicks into X, the indicator disappears from X's row.
- AE2. **Covers R1, R4, R5.** Given session X is mid-stream and a tool-approval request lands on it, when X is not the currently-active session, X's row shows the needs-me indicator (not the streaming indicator) per R1's precedence. When the user resolves the approval, X's row reverts to the streaming indicator if the stream is still in progress, or to finished-unread / idle if the stream has since completed.
- AE3. **Covers R8, R9.** Given workspace B has 1 session needing approval, 2 sessions finished-unread, and 1 session streaming (and the streaming session is also the needs-me session — i.e., a streaming session with a pending approval), when the user is viewing workspace A, B's tab renders three indicators side by side: needs-me "1", finished-unread "2", streaming "1". The shared session counts in both needs-me and streaming.
- AE4. **Covers R10, R11, R12.** Given workspace B's tab shows finished-unread "2", when the user clicks B's tab to switch *to* workspace B (without yet clicking a specific session row), B's tab still shows finished-unread "2" — switching workspaces is not a read event for any session. When the user then clicks one of the two unread sessions, B's tab's finished-unread count decrements to "1".
- AE5. **Covers R8.** Given a workspace has no non-idle sessions (all sessions are idle, or the only non-idle session is the currently-active one whose unread state has been cleared by R7), when the user looks at that workspace's tab, no status indicators render — only folder icon, name, and close button.

---

## Success Criteria

- The user can tell at a glance, from the workspace tabs and session list alone, which of their parallel sessions is blocking on them, which has finished output to review, and which is actively making progress — without clicking into any workspace they're not currently viewing.
- The streaming indicator visually distinguishes "still working" from "stopped/idle"; the user can confirm a session is actually progressing rather than silently stuck without opening it.
- The new indicators coexist with the existing orange needs-me dot on session rows without visual conflict, and with the existing accent-color "active session" dot at `src/client/components/SessionList.tsx:180`.
- A downstream implementer can take this doc and `ce-plan` it without inventing the precedence rules, the unread-clearing trigger, the tab aggregation shape, or what happens on the currently-active session/workspace.

---

## Scope Boundaries

- **All notification modalities** — OS-level browser notifications, in-app toasts, sound chimes, vibration. The user explicitly chose indicators-only. No notification-preferences UI.
- **Stalled-streaming detection** (e.g., a separate state for "stream started but no tokens received recently"). The streaming indicator reflects whether the stream is currently open per the existing `isStreaming` boolean; the existing SSE reconnect/replay layer handles network drops.
- **Cross-workspace aggregation** — no global "12 things need attention" badge in the chrome above the tabs. Scope is per-tab and per-row only.
- **Manual "mark as read" or "mark all as read" actions.** Activating a session is the only read event in v1. The user cannot dismiss a finished-unread indicator without entering the session.
- **Per-message read-state.** Unread is a per-session boolean — not "you read 3 of 5 messages within this session."
- **Notification badge in the browser tab title or favicon** (`document.title` mutation, favicon overlay). Indicators live inside the app surface only.
- **Light-mode theming** for the new indicators, consistent with prior brainstorms' scope.
- **Color, icon, and animation customization.** Visual treatment is fixed in v1; no user-facing settings.

---

## Key Decisions

- **Indicators only over notifications.** Alternatives considered: OS popups (highest interrupt), in-app toasts (medium), sound (audio cue). User explicitly chose passive visual over any form of active interrupt — the goal is "let me decide when to look." Trade-off: relies on the user remembering to glance at the chrome; the chrome itself must be salient enough that this works.
- **Stacked indicators with per-state counts on workspace tabs over single highest-priority.** Alternatives considered: single highest-priority dot (cleanest), single dot + count of dominant state, stacked dots without counts. User explicitly chose to see the full shape of a workspace's state at one glance — including the secondary states that a single-dot approach would hide. Trade-off: tabs are busier; visual budget for long workspace names tightens; counts decorate every state.
- **Single highest-priority indicator on session rows.** A session can technically be in two states at once (streaming with a pending approval). Showing both on a single row is cluttered; the precedence (needs-me > finished-unread > streaming) concentrates attention on the most urgent state per session, while the workspace tab still counts the session in *each* of its buckets so nothing is hidden at the aggregate level.
- **"Finished" as an unread state, not a transient.** Alternatives considered: flash briefly on stream end then auto-clear (transient), persist until manually dismissed, persist until the next user message in that session. The unread shape was chosen because the value of the signal is "go read this output" — a transient flash misses the user looking elsewhere; manual dismissal adds friction. Trade-off: requires new per-session viewed/unread state plumbing in `chat-store`.
- **Indicators on the currently-active session/workspace still render (except finished-unread, which auto-clears).** Alternative considered: suppress all indicators on the active context (treat "active" as inherently informed). Rejected because the needs-me indicator on the active session row still serves a purpose — it confirms which session has the pending request (useful when the approval surface is visible but the user wants to verify the session row's identity), and the streaming pulse confirms work is alive. Finished-unread is the one state that is logically impossible for an active session per R3, so it suppresses naturally.

---

## Dependencies / Assumptions

- The existing `isStreaming: Record<sessionId, boolean>` in `src/client/stores/chat-store.ts` is reliable as the source of truth for the streaming indicator. Confirmed by code reading; assumes the existing SSE reconnect/replay logic correctly maintains it through network blips.
- The existing `sessionStatus: Record<sessionId, { pendingCount: number }>` and `approvalQueue: Record<sessionId, PendingItem[]>` continue to fulfill the data needs of the needs-me indicator. R4's trigger is unchanged from the existing implementation.
- Workspaces in `src/client/stores/workspace-store.ts` and sessions in `src/client/stores/chat-store.ts` can be cross-referenced — the workspace tab can iterate its session IDs (`sessions[workspaceId]`) to compute aggregate state on every render or via a derived selector. Confirmed by reading the stores.
- Per-session viewed/unread state is **new state** that needs new plumbing in `chat-store`. Exact shape (timestamp-based, boolean flag, or a Set of unread session IDs) is deferred to planning.
- The visual budget of the workspace tab (currently `tab-pill flex items-center gap-1.5 px-3 py-1.5` plus a folder icon, truncated name capped at `max-w-[100px]`, and close button — see `src/client/components/WorkspaceTabs.tsx:19-44`) can accommodate up to three small indicators with single-digit counts without breaking the tab layout. Assumes single-digit counts in typical use; behavior for ≥10 is in Outstanding Questions.
- This work coexists with — does not replace — the existing accent-color "active session" dot on session rows (`src/client/components/SessionList.tsx:180`). Visual interaction between the two is in Outstanding Questions.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R11, R12][Technical] Does per-session viewed/unread state persist across browser reloads (via `sessionStorage` / `localStorage` / server-side), or is it transient per-session? The user's stated goal is parallel-throughput within a working session, but persistence might be expected as a quality-of-life win.
- [Affects R8, R9][Design] Exact placement of the indicators on the workspace tab — between name and close button, in a corner, replacing the close button until hover? Visual design call.
- [Affects R2][Design] Exact animation for the streaming indicator — Tailwind `animate-pulse`, custom keyframes, three-dot bounce, progress-bar shimmer? Designer call.
- [Affects R1, R5, R8][Design] Visual treatment of each state — color, shape, size. Existing palette uses orange for needs-me (already in `SessionList.tsx`); the brainstorm sketched blue for finished-unread and green for streaming. Confirm or adjust in planning.
- [Affects R9][Design] Behavior when a per-state count exceeds 9 — show "9+", show the actual two-digit number, or omit the count? Unlikely in practice but should be settled.
- [Affects R8][Technical] Performance of recomputing workspace-tab aggregates on every state change — likely fine given typical session counts but worth a quick check during planning (memoized selector vs. direct compute).
- [Affects R7, R10][Design] On the currently-active session row, the existing accent dot ("active indicator", `src/client/components/SessionList.tsx:180`) coexists with the new status indicators. Do they stack side by side, share space, or does one suppress the other when both are present? Designer call.
- [Affects R3, R11][Technical] What exactly counts as a "stream completion" for the purpose of triggering finished-unread? End of the assistant message (current `isStreaming` flip from true to false)? Receipt of the final SSE event? End-of-turn marker? Likely the existing flip, but planning should pin this against the SSE stream contract.
