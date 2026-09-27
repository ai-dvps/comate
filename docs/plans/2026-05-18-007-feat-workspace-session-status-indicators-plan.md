---
title: Workspace & Session Status Indicators
type: feat
status: active
date: 2026-05-18
origin: docs/brainstorms/2026-05-18-workspace-and-session-status-indicators-requirements.md
---

# Workspace & Session Status Indicators

## Summary

Surface three-state status indicators (needs-me, finished-unread, streaming) on session list rows and workspace tabs so the user can see at a glance which parallel sessions need attention without clicking into each workspace. Session rows show a single dot using the needs-me > finished-unread > streaming precedence; workspace tabs stack up to three per-state dots side by side with concurrent counts. Streaming dots pulse for liveness. A new per-session `unreadCompletions` flag in `chat-store` tracks the unread state, set when a stream ends on a non-active session and cleared by `setActiveSession`.

---

## Problem Frame

The user runs many sessions across many workspaces in parallel, but the GUI only shows one session at a time. `src/client/components/Sidebar.tsx` renders `SessionList` scoped to the *active* workspace, so any session in any *other* open workspace is invisible while the user works — they have no signal that workspace B's session needs an approval, or that workspace C's session has finished and there's output to review. `src/client/components/WorkspaceTabs.tsx` carries no status at all today; only a folder icon, name, and close button.

The existing orange dot at `src/client/components/SessionList.tsx:165-170` covers needs-approval for visible (active-workspace) sessions only. There is no "this session finished while you were elsewhere" signal anywhere, and no liveness signal to confirm a stream is still progressing rather than silently stuck.

The cost is throughput: parallel sessions idle waiting on the user because the user has no way to know which to switch to without manually clicking through every workspace tab. See origin requirements doc for full motivation and acceptance examples.

---

## Requirements

**States and precedence**
- R1. Three states per session: needs-me, finished-unread, streaming. Session rows pick one via the precedence needs-me > finished-unread > streaming.
- R2. Streaming indicator pulses to convey liveness (visually distinct from a static dot).
- R3. Finished-unread appears when a streaming response completes on a session that is NOT the currently-active session; clears when that session becomes active.
- R4. Needs-me appears whenever `sessionStatus[sessionId].pendingCount > 0`; clears when the queue drains.

**Session list row**
- R5. Each session row renders at most one indicator at a time per R1 precedence.
- R6. The existing orange dot for needs-me at `src/client/components/SessionList.tsx:165-170` is extended into the new three-state indicator.
- R7. The currently-active session still renders its indicator, except for finished-unread (suppressed because activating IS the read).

**Workspace tab aggregation**
- R8. Each workspace tab renders up to three indicators stacked side by side, one per state present in that workspace; no indicators when no non-idle sessions exist.
- R9. Each tab indicator carries a count; a session that is both streaming and needs-me counts in both buckets (concurrent counting at the tab level, even though it shows only as needs-me on the row).
- R10. The currently-active workspace's tab follows the same aggregation rules; finished-unread counts decrement immediately when the user activates a session within that workspace.

**Read-state tracking**
- R11. Track per-session "has the user viewed this session since its last stream completion." Activating a session counts as viewing.
- R12. Switching workspaces does NOT clear finished-unread for any session — only activating the specific session clears its own unread state.

**Origin acceptance examples:** AE1 (R1, R3, R7), AE2 (R1, R4, R5), AE3 (R8, R9), AE4 (R10, R11, R12), AE5 (R8).

---

## Scope Boundaries

- OS notifications, in-app toasts, sound chimes, vibration (origin scope).
- Stalled-streaming detection — streaming reflects `isStreaming` per session; SSE reconnect/replay layer handles network blips.
- Cross-workspace global aggregation badge above the tabs.
- Manual "mark as read" or "mark all as read" actions; activating a session is the only read event in v1.
- Per-message unread state; unread is per-session boolean only.
- Browser tab title / favicon mutation.
- Light-mode theming.
- User-facing customization of color, icon, or animation.
- Persistence of unread state across browser reloads. Decided below: transient in-memory only.
- Test infrastructure (Vitest, RTL). Decided below: extract pure logic and skip test setup in this PR.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/SessionList.tsx:165-170` — existing per-row orange dot for `sessionStatus[session.id]?.pendingCount > 0`. This is the extension point — the new component replaces this dot with a three-state indicator.
- `src/client/components/SessionList.tsx:180` — existing accent dot on the active session row. Stays as-is; new indicator lives in the inline cluster at line 150 (`flex items-center gap-1.5`) next to the title.
- `src/client/components/SessionList.tsx:150-170` — existing inline cluster (title + Draft pill + status dot) is the natural place to slot the new indicator.
- `src/client/components/WorkspaceTabs.tsx` — current pill layout: `tab-pill flex items-center gap-1.5 px-3 py-1.5` with `Folder` icon, truncated name (`max-w-[100px]`), and close button. New indicators slot between the truncated name and the close button.
- `src/client/components/ChatPanel.tsx:141-145` — bouncing accent dots for streaming at the panel level today (precedent for animated streaming UI, but the row/tab indicators are deliberately simpler — just a pulsing dot).
- `src/client/components/SubagentBriefStatus.tsx:67` — `ClockIcon animate-pulse text-amber-500` is the precedent for `animate-pulse` used as a "work in progress" cue. We mirror that with `animate-pulse` on the streaming dot.
- `src/client/stores/chat-store.ts:109-118` — current state shape: `isStreaming: Record<string, boolean>`, `sessionStatus: Record<string, { pendingCount: number }>`, `approvalQueue`, `activeSessionIds: Record<string, string>`.
- `src/client/stores/chat-store.ts:644,665,852` — the three places where `isStreaming` flips to false (`interrupted`, `result`, subscription error). Each is a candidate stream-completion event; **only `result` (line 665) represents a normal completion**. `interrupted` (line 644) and the subscription error (line 852) also flip false but should NOT mark unread because the user already knows the stream stopped (they pressed Stop, or the connection failed visibly).
- `src/client/stores/chat-store.ts:968-985` — `setActiveSession(workspaceId, sessionId)`. This is the hook that clears unread for the newly-active session.
- `src/client/stores/chat-store.ts:1038` — `sendMessage` flips `isStreaming` to true. Defensive clear of unread happens here too (a session can't be both unread and currently sending in the active workspace, but we clear for cleanliness).
- `src/client/stores/chat-store.ts:944-948` — `deleteSession` cleans up several per-session state slices; `unreadCompletions[sessionId]` must be added to this cleanup.
- `src/client/stores/workspace-store.ts` — `Workspace` type, `openWorkspaceIds`. Workspaces have no status field; tab aggregation reads from `chat-store` and joins by `workspaceId`.
- `tailwind.config.js` — no custom keyframes today. `animate-pulse` (built-in) covers liveness without adding to the CSS budget.
- `src/client/index.css:117` — single custom `ai-shimmer` keyframe (precedent for adding custom animations if needed, but not needed here).

### Institutional Learnings

- No `docs/solutions/` directory exists. No prior learnings to apply.
- Recent UX work (larger stop button at `0199bed`, SSE replay-on-reconnect at `9731a78`, SSE pool exhaustion fix at `2b66f99`) shows the user is actively living in multi-session pain — this plan directly addresses the same surface.

---

## Key Technical Decisions

- **Use only `result` as the stream-completion trigger for unread.** `interrupted` and subscription-error flips do not mark unread. Rationale: those paths involve user action or a visible error — there is no "new output to review" to flag. Only a natural `result` end yields output the user might want to come back to.
- **Transient in-memory `unreadCompletions` — no persistence.** A page refresh clears all unread state. This matches the parallel-throughput-within-a-session use case stated in the requirements, and avoids `localStorage`/`sessionStorage` mutation paths and migration concerns. Revisit if user feedback suggests reload-survival matters.
- **No test infrastructure changes.** The client has no Vitest/Jest/RTL today. Adding test setup just for this feature is scope creep. Instead, extract precedence and aggregation logic to a pure function in `src/client/lib/session-status.ts` so it's trivially testable later if/when test infra is added. Manual QA only for v1 (verification checklist in each unit).
- **Single `StatusIndicator` component, two consumers.** Both `SessionList` rows and `WorkspaceTabs` render the same dot styling; only `WorkspaceTabs` passes `count`. Sharing the component keeps colors and animation centralized — a future palette tweak touches one file.
- **Concurrent counting at the tab level via direct contribution checks, not precedence collapse.** The tab aggregator does NOT use `deriveSessionState` (which returns a single precedence-collapsed state). It iterates sessions and contributes to each bucket independently. This satisfies R9 — a session that is both streaming and needs-me counts in both tab buckets, while still showing only as needs-me on its row.
- **Inline Zustand selectors only; no `useShallow`, no memoized aggregators.** Matches the existing codebase pattern. For typical session counts (a few dozen), per-render recomputation in `WorkspaceTabs` is acceptable; if profiling later shows churn, introduce a memoized selector. Premature memoization fights the established pattern.
- **Active-session accent dot stays where it is.** The accent dot at `SessionList.tsx:180` lives in the right-hand utility column (alternating with the delete button on hover). The new status indicator lives in the inline title cluster at line 150. They are spatially separate; no coexistence work needed.
- **Count display: numeric for 1-9, `"9+"` for ≥ 10.** Standard convention. Counts of 10+ in a single workspace are rare; the cap prevents tab overflow.
- **Colors:** `bg-orange-500` (needs-me, keeps existing), `bg-blue-500` (finished-unread), `bg-emerald-500` (streaming, with `animate-pulse`). Stays within Tailwind defaults, no theme tokens added.
- **Indicator size on rows and tabs: 1.5×1.5 dots (`w-1.5 h-1.5`) matching the existing orange dot at `SessionList.tsx:167`.** When a count is shown on a tab indicator, the dot pairs with a 10px text label inline (`gap-0.5`) so the cluster reads as one badge.
- **Tab indicator placement: between the truncated workspace name and the close button.** Pre-existing `gap-1.5` on the pill flex container provides spacing. The cluster wraps each indicator with `flex items-center gap-0.5` for dot+count pairing.

---

## Open Questions

### Resolved During Planning

- **What counts as "stream completion" for finished-unread?** The `result` SSE event at `src/client/stores/chat-store.ts:665`. Not `interrupted`, not subscription-error.
- **Persistence across reloads?** Transient in-memory only.
- **Count > 9 behavior?** Render as `"9+"`.
- **Streaming animation?** Tailwind `animate-pulse` on the streaming dot.
- **Color palette per state?** Orange/Blue/Emerald — Tailwind 500-weight.
- **Accent dot coexistence?** Spatially separate; no conflict, both render.
- **Test infrastructure?** None added in this PR; pure logic extracted for future testability.
- **Tab indicator placement?** Between truncated name and close button.

### Deferred to Implementation

- Whether the count label uses `text-[9px]` or `text-[10px]` — visual tuning during implementation against the existing `text-[9px]` Draft pill at `SessionList.tsx:161`.
- Exact `gap-*` between stacked tab indicators — `gap-1` or `gap-1.5` chosen by visual fit at implementation time.

---

## Implementation Units

### U1. Extend chat-store with `unreadCompletions` and viewed-state mutations

**Goal:** Add per-session unread tracking to `chat-store`. Set unread when a `result` SSE event flips `isStreaming` false on a non-active session; clear unread when `setActiveSession` activates the session, when a new stream starts via `sendMessage`, or when the session is deleted.

**Requirements:** R3, R4, R11, R12

**Dependencies:** None

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**

1. Add to `ChatState` interface (near line 118, alongside `sessionStatus`):
   ```ts
   unreadCompletions: Record<string, boolean>
   ```

2. Initialize in the store default (near line 874, alongside `sessionStatus: {}`):
   ```ts
   unreadCompletions: {},
   ```

3. Create a small helper near the existing `mutateToolUsePart`/`addSystemMessage` helpers (around line 238):
   ```ts
   function isSessionActive(state: ChatState, sessionId: string): boolean {
     for (const activeId of Object.values(state.activeSessionIds)) {
       if (activeId === sessionId) return true
     }
     return false
   }
   ```
   This avoids threading `workspaceId` through the SSE event handler.

4. In the `result` event handler (currently line 663-668), update to also set unread:
   ```ts
   case 'result': {
     set((state) => {
       const next: Partial<ChatState> = {
         isStreaming: { ...state.isStreaming, [sessionId]: false },
       }
       if (!isSessionActive(state, sessionId)) {
         next.unreadCompletions = { ...state.unreadCompletions, [sessionId]: true }
       }
       return next
     })
     return
   }
   ```
   Do NOT modify the `interrupted` handler (line 642-647) or the subscription-error path (line 851-853). Those flip `isStreaming` false but must not mark unread — the user already knows the stream stopped.

5. In `setActiveSession` (line 968-985), after the existing `set` call that updates `activeSessionIds`, clear unread for the newly-active session:
   ```ts
   set((state) => {
     const nextUnread = { ...state.unreadCompletions }
     delete nextUnread[sessionId]
     return {
       activeSessionIds: { ...state.activeSessionIds, [workspaceId]: sessionId },
       unreadCompletions: nextUnread,
     }
   })
   ```
   Replaces the existing single-key `set` at line 978-980. Note: a session ID of empty string (`sessionId === ''`) should still update `activeSessionIds` but not delete an empty key — `delete nextUnread['']` is a no-op so this is safe.

6. In `sendMessage` (around line 1021-1040), defensively clear unread for the session when streaming starts. Easiest: in the `set((state) => { ... })` block that flips `isStreaming` to true, also remove the session's unread flag:
   ```ts
   const nextUnread = { ...state.unreadCompletions }
   delete nextUnread[sessionId]
   return {
     // ... existing fields ...
     isStreaming: { ...state.isStreaming, [sessionId]: true },
     unreadCompletions: nextUnread,
   }
   ```

7. In `deleteSession` (line 944-960), add cleanup for `unreadCompletions` alongside the other per-session slices:
   ```ts
   const newUnread = { ...state.unreadCompletions }
   delete newUnread[sessionId]
   // ... return new state including `unreadCompletions: newUnread` ...
   ```

**Patterns to follow:**
- Mirror the existing per-session cleanup pattern in `deleteSession` (line 944-960) for adding `unreadCompletions`.
- Mirror the existing `set((state) => ({ isStreaming: { ...state.isStreaming, [sessionId]: false } }))` immutability shape when updating `unreadCompletions`.
- Inline access to `state.activeSessionIds` for the active-session check — no new helper exports.

**Test scenarios** (manual QA — see Verification):
- Happy path: session A streaming, user viewing B in same workspace → A's `result` event sets `unreadCompletions[A] = true`.
- Happy path: session A streaming, user activates A → `unreadCompletions[A]` is cleared on `setActiveSession`.
- Happy path: user activates session A, then A streams and completes → `unreadCompletions[A]` is NOT set (A was active when `result` fired).
- Edge case: user interrupts a streaming session (clicks Stop) → `interrupted` flips `isStreaming` false but `unreadCompletions` is unchanged.
- Edge case: subscription error during streaming → connection-error path flips `isStreaming` false but `unreadCompletions` is unchanged.
- Edge case: session deleted while unread → `deleteSession` cleans up `unreadCompletions[sessionId]`.
- Edge case: session A is unread, then user sends a new message in A → `sendMessage` clears unread defensively (sending implies viewing).
- Edge case (R12): user switches to a different *workspace* (not session) → `unreadCompletions` is unchanged for any session. (Verified by inspection: `setActiveWorkspace` lives in `workspace-store`, not `chat-store`, and is not touched by this unit.)

**Verification:**
- Open two workspaces; in each, create two sessions and send a prompt in the non-active one. Observe via React DevTools that `unreadCompletions` gains entries when streams `result`-end and not when interrupted.
- Click into an unread session and confirm its key is removed from `unreadCompletions`.
- Delete an unread session and confirm cleanup.

---

### U2. Pure session-state derivation helper

**Goal:** A single pure function that applies the R1 precedence and the R7 active-suppression for finished-unread. Used by `SessionList` to pick the row's single state. Tab aggregation does NOT use this helper (it needs concurrent contributions per R9).

**Requirements:** R1, R5, R7

**Dependencies:** None (typed against primitive inputs, not store state)

**Files:**
- Create: `src/client/lib/session-status.ts`

**Approach:**

1. Create the file with a small typed function:
   ```ts
   export type SessionStatusState =
     | 'needs-me'
     | 'finished-unread'
     | 'streaming'
     | 'idle'

   export interface SessionStatusInput {
     isStreaming: boolean
     pendingCount: number
     unread: boolean
     isActive: boolean
   }

   export function deriveSessionState(input: SessionStatusInput): SessionStatusState {
     if (input.pendingCount > 0) return 'needs-me'
     if (input.unread && !input.isActive) return 'finished-unread'
     if (input.isStreaming) return 'streaming'
     return 'idle'
   }
   ```

2. No store imports, no React imports — keeps the function trivially testable from a future test runner.

**Patterns to follow:**
- New `src/client/lib/` directory does not exist yet; this is the first lib file. Naming mirrors `src/client/types/`. (Confirm at implementation time whether `src/client/utils/` or `src/client/lib/` already exists; if `lib` is the first, that's fine — single file.)

**Test scenarios** (manual QA via consumer behavior in U4/U5):
- Happy path: `pendingCount > 0` → 'needs-me' regardless of other flags.
- Happy path: `unread = true, isActive = false, isStreaming = false` → 'finished-unread'.
- Happy path: `isStreaming = true, isActive = true` → 'streaming' (R7 lets active session show streaming).
- Edge case (R7): `unread = true, isActive = true` → 'idle' (finished-unread suppressed for active).
- Edge case: `pendingCount = 0, unread = false, isStreaming = false` → 'idle'.
- Edge case: `pendingCount > 0 AND isStreaming = true AND unread = true` → 'needs-me' (precedence picks the highest).

**Verification:**
- Verified indirectly via U4 row rendering against the AE1, AE2 scenarios from the origin doc.

---

### U3. `StatusIndicator` component

**Goal:** A single visual component that renders one colored dot, optionally pulsing, optionally with a count label. Used by `SessionList` rows (no count) and `WorkspaceTabs` (with count).

**Requirements:** R2, R5, R8, R9

**Dependencies:** None

**Files:**
- Create: `src/client/components/StatusIndicator.tsx`

**Approach:**

1. Component shape:
   ```tsx
   interface StatusIndicatorProps {
     state: 'needs-me' | 'finished-unread' | 'streaming'
     count?: number
   }
   ```

2. Color and animation by state:
   - `needs-me` → `bg-orange-500`
   - `finished-unread` → `bg-blue-500`
   - `streaming` → `bg-emerald-500 animate-pulse`

3. Dot dimensions: `w-1.5 h-1.5 rounded-full flex-shrink-0` — matches existing `SessionList.tsx:167`.

4. Title attribute per state for accessibility hover (`title="Needs approval"`, `title="Finished — unread"`, `title="Streaming"`).

5. When `count` is provided and ≥ 1: render an adjacent label. Format as `count >= 10 ? '9+' : String(count)`. Wrap dot + label in a `<span class="inline-flex items-center gap-0.5">`. Label style: `text-[10px] text-text-tertiary leading-none`.

6. When `count` is undefined (row consumer): render just the dot, no wrapper, no label.

7. No `useChatStore` access inside this component — it is pure presentation.

**Patterns to follow:**
- Match the existing inline-flex pattern at `SessionList.tsx:150` (`gap-1.5` between siblings).
- Use Tailwind classes only; do not add custom CSS.
- The Draft pill at `SessionList.tsx:160-164` is the closest sibling pattern for "small inline label" sizing.

**Test scenarios** (manual QA via U4/U5 rendering):
- Happy path: `<StatusIndicator state="needs-me" />` renders a solid orange dot.
- Happy path: `<StatusIndicator state="finished-unread" />` renders a solid blue dot.
- Happy path: `<StatusIndicator state="streaming" />` renders a pulsing emerald dot.
- Happy path: `<StatusIndicator state="needs-me" count={3} />` renders an orange dot with " 3" adjacent.
- Edge case: `<StatusIndicator state="streaming" count={10} />` renders " 9+".
- Edge case: `<StatusIndicator state="streaming" count={0} />` renders nothing? — current behavior: still renders the dot, no label. Tab aggregator (U5) should not render any indicator for a state with count 0 — that decision lives in U5, not here.

**Verification:**
- Render all three states with and without counts in an ad-hoc test harness or in the consumers; visually confirm pulse on streaming and color parity with the existing orange dot.

---

### U4. Update `SessionList` row to use `StatusIndicator`

**Goal:** Replace the existing inline orange dot at `SessionList.tsx:165-170` with a `StatusIndicator` driven by `deriveSessionState`. The active-session accent dot at line 180 stays unchanged.

**Requirements:** R1, R5, R6, R7

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `src/client/components/SessionList.tsx`

**Approach:**

1. Add a new selector to read `unreadCompletions` and `isStreaming` from `chat-store`:
   ```ts
   const isStreaming = useChatStore((s) => s.isStreaming)
   const unreadCompletions = useChatStore((s) => s.unreadCompletions)
   ```
   Place alongside the existing `sessionStatus` selector at line 43.

2. Inside the `sessions.map((session) => ...)` block, compute the row state:
   ```ts
   const rowState = deriveSessionState({
     isStreaming: !!isStreaming[session.id],
     pendingCount: sessionStatus[session.id]?.pendingCount ?? 0,
     unread: !!unreadCompletions[session.id],
     isActive: session.id === activeSessionId,
   })
   ```

3. Replace lines 165-170 (the existing orange dot conditional):
   ```tsx
   {rowState !== 'idle' && <StatusIndicator state={rowState} />}
   ```
   Keep the placement: inside the inline cluster at line 150 (`flex items-center gap-1.5`), after the Draft pill.

4. Import `StatusIndicator` from `./StatusIndicator` and `deriveSessionState` from `../lib/session-status` at the top of the file.

5. Active-session indicator visibility (R7): the active session shows its row indicator when `rowState` is `'needs-me'` or `'streaming'`, but NOT when it would be `'finished-unread'`. This is already handled by U2's `deriveSessionState` returning `'idle'` for an active session with unread. No additional gating needed at this layer.

6. Do NOT touch the accent dot at line 180. It remains as the active-session marker, on the right side of the row.

**Patterns to follow:**
- Inline `useChatStore` selectors (one per slice) — match the existing 7 inline selectors at lines 40-47.
- No memoization, no `useShallow`. Per-render derivation of `rowState` is cheap.
- Preserve the existing flex hierarchy unchanged; only swap the conditional dot for the indicator.

**Test scenarios** (manual QA — see Verification):
- AE1 (R1, R3, R7): session X streams while user views session Y in the same workspace → X's row shows the streaming dot; on `result`, X's row shows the blue finished-unread dot; clicking X clears the dot.
- AE2 (R1, R4, R5): session X is streaming and gets an approval request → X's row shows orange (needs-me), not green (streaming), per precedence; resolving the approval reverts to green (or blue/idle if stream completed in the meantime).
- Edge case: active session is streaming → row shows pulsing green dot.
- Edge case: active session has pending approval → row shows orange dot (R7 allows needs-me on active).
- Edge case: active session was unread before activation → unread is cleared by `setActiveSession` per U1; row shows `'idle'`. Even if a race left `unreadCompletions[sessionId] = true` somehow, `deriveSessionState` returns `'idle'` for active+unread (R7).
- Edge case: session with no streaming, no pending, no unread → no indicator rendered.

**Verification:**
- Open two workspaces. In workspace A, create sessions S1 and S2. Send a prompt in S1, then click S2. S1's row should show pulsing green during stream, then blue when complete. Click S1; blue clears.
- In workspace A, create session S3 and send a prompt that triggers an approval (e.g., a tool that the SDK will request permission for). While viewing another session, S3's row shows orange.

---

### U5. Workspace tab aggregate status indicators

**Goal:** Each workspace tab renders up to three stacked `StatusIndicator`s with counts, computed from its sessions' concurrent state contributions. Render between the truncated workspace name and the close button.

**Requirements:** R8, R9, R10, R12

**Dependencies:** U1, U3

**Files:**
- Modify: `src/client/components/WorkspaceTabs.tsx`

**Approach:**

1. Read the needed slices from `chat-store` inside `WorkspaceTabs`. Use inline selectors (one per slice):
   ```ts
   const sessions = useChatStore((s) => s.sessions)
   const isStreaming = useChatStore((s) => s.isStreaming)
   const sessionStatus = useChatStore((s) => s.sessionStatus)
   const unreadCompletions = useChatStore((s) => s.unreadCompletions)
   const activeSessionIds = useChatStore((s) => s.activeSessionIds)
   ```

2. Add a helper inside the component (or extract as a small pure function in the same file):
   ```ts
   function getWorkspaceCounts(workspaceId: string): {
     needsMe: number
     finishedUnread: number
     streaming: number
   } {
     const list = sessions[workspaceId] ?? []
     const activeId = activeSessionIds[workspaceId]
     let needsMe = 0
     let finishedUnread = 0
     let streaming = 0
     for (const s of list) {
       if ((sessionStatus[s.id]?.pendingCount ?? 0) > 0) needsMe++
       if (unreadCompletions[s.id] && s.id !== activeId) finishedUnread++
       if (isStreaming[s.id]) streaming++
     }
     return { needsMe, finishedUnread, streaming }
   }
   ```

3. **Concurrent counting (R9):** a session contributes independently to every bucket it qualifies for. A streaming session with a pending approval increments BOTH `needsMe` AND `streaming`. This is intentionally distinct from `deriveSessionState`, which collapses to a single state for rows.

4. **Active-session participation (R10, R12):**
   - `streaming` and `needsMe` count the active session normally — the active session can still be streaming or need approval, and the tab should reflect that.
   - `finishedUnread` skips the active session (`s.id !== activeId`) — consistent with U1 clearing unread on activation. R12 holds because the helper reads `activeSessionIds[workspaceId]` for the tab's OWN workspace, not the globally active workspace.

5. In the JSX, for each workspace tab, render the indicator cluster between the truncated `<span>` (the workspace name at `WorkspaceTabs.tsx:30-something`) and the close button. Use the existing `gap-1.5` from the pill flex container; no extra wrapper needed for spacing:
   ```tsx
   {counts.needsMe > 0 && <StatusIndicator state="needs-me" count={counts.needsMe} />}
   {counts.finishedUnread > 0 && <StatusIndicator state="finished-unread" count={counts.finishedUnread} />}
   {counts.streaming > 0 && <StatusIndicator state="streaming" count={counts.streaming} />}
   ```

6. Order of stacked indicators on the tab: **needs-me, finished-unread, streaming** (same as the precedence — most-urgent left, least-urgent right). Consistent ordering makes the chrome scannable at a glance.

7. When all three counts are 0, no indicators render — the tab shows just folder icon + name + close button as today (R8, AE5).

8. The pill's `max-w-[100px]` on the workspace name remains unchanged; indicators sit outside that constraint. The pill itself can grow horizontally as indicators are added — accept the layout shift. If long names plus many indicators visibly overflow during QA, revisit truncation in implementation.

**Patterns to follow:**
- Inline Zustand selectors. No `useShallow`, no memoization.
- Match the existing `tab-pill flex items-center gap-1.5` shell; do not introduce additional wrappers.
- Preserve the close button position and behavior unchanged.

**Test scenarios** (manual QA — see Verification):
- AE3 (R8, R9): workspace B has 4 sessions: 1 needs-me, 2 finished-unread, 1 streaming where the streaming session ALSO has a pending approval. While viewing workspace A, B's tab renders three indicators: needs-me "2" (the lone needs-me + the streaming-also-needs-me), finished-unread "2", streaming "1". Verify the dual-bucket session counts in BOTH needs-me and streaming.
- AE4 (R10, R11, R12): workspace B tab shows finished-unread "2". Click B's tab to switch workspaces but don't click a session row. Tab still shows finished-unread "2". Now click one of the two unread sessions — `setActiveSession` clears that session's unread (U1), the tab recomputes, and finished-unread drops to "1".
- AE5 (R8): all sessions in workspace C are idle (no streams, no approvals, no unread) → C's tab renders no indicators, just folder + name + close.
- Edge case: workspace with 12 sessions all streaming → streaming indicator shows "9+".
- Edge case: workspace with zero sessions → no indicators.
- Edge case: count drops from 1 to 0 → indicator disappears immediately (next render).
- Edge case (R10): workspace D is the currently-active workspace with 1 streaming session. D's tab renders streaming "1" same as inactive tabs — the active tab does NOT suppress its indicators (R10).

**Verification:**
- Open three workspaces. Trigger multiple states across sessions in each (start streams in some, leave approvals pending in others, let some complete while you're elsewhere). Confirm each tab's indicator cluster matches the expected counts and that switching workspaces does NOT clear finished-unread counts.
- Confirm visual layout: indicators fit between the (sometimes truncated) name and the close button without breaking the pill at typical workspace counts and name lengths.

---

## System-Wide Impact

- **Store surface:** one new state slice (`unreadCompletions: Record<string, boolean>`) in `chat-store`. Read by `SessionList` and `WorkspaceTabs`. Written by the `result` SSE handler, `setActiveSession`, `sendMessage`, and `deleteSession`.
- **Component surface:** one new shared component (`StatusIndicator`), one new pure helper module (`session-status.ts`), edits to two existing components (`SessionList`, `WorkspaceTabs`).
- **Cross-store reads:** `WorkspaceTabs` now reads from `chat-store` (was: workspace-store only). This is the first place such cross-store aggregation exists in the codebase. Acceptable — both stores are simple Zustand stores and the read pattern is identical.
- **Render churn:** `WorkspaceTabs` re-renders when any of `sessions`, `isStreaming`, `sessionStatus`, `unreadCompletions`, or `activeSessionIds` changes. For typical session counts this is fine; if profiling later shows churn, introduce a memoized selector returning aggregated counts. Do not optimize prematurely.
- **SSE protocol:** unchanged. No new events, no schema changes.
- **Persistence:** no schema changes. Server unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `WorkspaceTabs` re-render churn under many active sessions. | Inline selectors today; promote to memoized aggregator if profiling shows it. Typical multi-workspace usage stays under a few dozen sessions. |
| User does not notice the new indicators because they sit in chrome they've learned to tune out. | Visual treatment uses existing palette anchors (orange already established for needs-me). Pulsing emerald for streaming adds motion that draws the eye. If feedback is "I miss completions", revisit with sound/notification (currently scope-excluded). |
| `unreadCompletions` is transient — a refresh loses the signal. | Documented decision matches the within-session-throughput use case. Revisit if user pushes back; `sessionStorage` is a small follow-up. |
| Concurrent counting at the tab level surfaces a contradiction with the per-row precedence ("why does the tab say 2 needs-me but I only see 1 orange dot in the row?"). | Title attributes on tab indicators (e.g., "2 sessions need approval") clarify. The row's single dot is the per-session most-urgent state; the tab's per-state count is the aggregate. Document in the visual layout section of the origin doc if confusion surfaces. |
| Tab layout overflow when many indicators + long workspace name combine. | `max-w-[100px]` on the name truncates; indicators sit outside that constraint. Pill grows horizontally. Acceptable for typical names; revisit if visible overflow occurs at QA. |
| `isStreaming` could remain `true` across SSE replay edge cases (e.g., the recent fix at commit `9731a78`). | Existing replay-on-reconnect path is correct; the streaming dot following `isStreaming` accurately reflects live state. If a future bug makes `isStreaming` stuck-true, that's a stream-state bug to fix at the source, not in indicator code. |

---

## Sources & References

- Origin requirements doc: `docs/brainstorms/2026-05-18-workspace-and-session-status-indicators-requirements.md`
- `src/client/components/SessionList.tsx` — extension point at lines 150-170 and active-dot at line 180
- `src/client/components/WorkspaceTabs.tsx` — pill layout to extend
- `src/client/stores/chat-store.ts` — state shape (line 109-118), stream-completion event at line 663-668, setActiveSession at line 968-985, deleteSession at line 944-960, sendMessage at line 1021-1040
- `src/client/stores/workspace-store.ts` — open workspaces, no status field
- `src/client/components/Sidebar.tsx` — confirms SessionList is active-workspace-scoped, explaining the visibility gap
- `src/client/components/SubagentBriefStatus.tsx:67` — `animate-pulse` precedent
- Recent multi-session UX work: commits `0199bed` (larger stop button), `9731a78` (SSE replay), `2b66f99` (SSE pool exhaustion)
