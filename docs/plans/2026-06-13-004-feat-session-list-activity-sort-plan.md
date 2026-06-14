---
title: "feat: Session list activity sort"
type: feat
date: 2026-06-13
origin: docs/brainstorms/2026-06-13-session-list-activity-sort-requirements.md
---

## Summary

Sort the workspace session list by recency of activity so sessions with recent streaming, unread completions, or pending approvals rise to the top. Inactive sessions settle into their last-active position. The existing pinned header is removed; the list itself conveys priority through order, with no additional visual grouping.

## Problem Frame

`src/client/components/SessionList.tsx` renders sessions in server-returned order. Sessions that currently need attention can sit below inactive ones, forcing the user to scan. The brainstorm refined the earlier pinned-header experiment into a simpler model: reorder the whole list by activity, keep the selected session highlighted, and do not introduce a separate pinned surface.

## Requirements

- R1. The session list is sorted by most-recent activity first. (origin R1)
- R2. Activity includes streaming/processing, unread completions, and pending approvals. (origin R2)
- R3. Inactive sessions are ordered by the time of their last activity, not by a fixed original position. (origin R3)
- R4. The selected session receives no special placement unless it also has activity. (origin R4)
- R5. Search filters the sorted list without changing the sort order. (origin R5)
- R6. Sorting does not add a separate pinned header or visual section; rows keep their existing styling. (origin R6)

## Key Technical Decisions

- **Track a client-side `lastActivityAt` timestamp per session.** Server `lastModified` updates on message turns but is not reliably refreshed for pending approvals or unread completions. A client-side record captures the exact moment any activity signal fires. Seeding converts `lastModified` (a Unix timestamp number) or `updatedAt` (an ISO string) into a comparable millisecond value; newly created sessions are seeded with `Date.now()` because creation itself is activity.
- **Update `lastActivityAt` inside the activity handlers that already set `isStreaming`, `unreadCompletions`, or `approvalQueue`.** Bump the timestamp in `sendMessage`, SSE `assistant_start`, SSE `result`, SSE `pending_approval`, SSE `pending_question`, and the background `sessionStatus` poll when `pendingCount` transitions from zero to a positive value. Do not bump on `tool_result` (it does not change an activity signal) or on selection/read-state changes.
- **Defensively prune stale `lastActivityAt` entries.** When `fetchSessions` reloads a workspace, drop entries for session IDs that the server no longer returns. This prevents the record from growing without bound as workspaces churn.
- **Preserve the existing search UX from plan 003.** This plan assumes `docs/plans/2026-06-13-003-feat-session-list-title-search-plan.md` is already implemented. Sorting is applied before search filtering so matching sessions stay in recency order.
- **No reorder animation or extra focus management.** Rows reorder instantly; React moves the DOM node and native focus follows. The selected session remains a normal list row, so removing the pinned header does not require replacement ARIA landmarks.
- **Compute sort order in `SessionList` with `useMemo`.** The store stays focused on state; presentation order is derived close to rendering, matching the existing search-filter pattern.
- **Remove the pinned running-session header and the `variant` prop.** The brainstorm explicitly rejected pinning. Keeping a pinned header would contradict R6 and duplicate the top entries that sorting already surfaces.
- **Extract a pure sort comparator for testability.** A small utility in `src/client/lib/` mirrors the existing `session-filter` helper and can be unit-tested without mounting components.

## Implementation Units

### U1. Add `lastActivityAt` tracking to chat-store

**Goal:** Maintain a per-session timestamp that records the most recent moment of streaming, unread completion, or pending approval activity.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- `src/client/stores/chat-store.ts` (modify)

**Approach:**
- Add `lastActivityAt: Record<string, number>` to `ChatState` and initialize it to `{}`.
- Seed `lastActivityAt[session.id]` when sessions are loaded or added:
  - In `fetchSessions`, after storing the loaded sessions, set each session's entry to `session.lastModified ?? Date.parse(session.updatedAt) ?? Date.now()`. Then delete any entries whose IDs are not present in the newly loaded list.
  - In `createSession` and `addSession`, set the new session's entry to `Date.now()` (creation is itself activity).
- Bump `lastActivityAt[sessionId]` to `Date.now()` in the same setters that signal activity:
  - `sendMessage` (user initiates a turn).
  - SSE `assistant_start` handler that creates/updates a streaming assistant message.
  - SSE `result` handler that clears streaming and may set `unreadCompletions`.
  - SSE `pending_approval` / `pending_question` handlers that append to `approvalQueue`.
  - Background poll `sessionStatus` update when `pendingCount` transitions from `0` (or missing) to a positive value.
- Do not bump on `setActiveSession`, on clearing unread, on SSE `tool_result`, or on SSE `assistant_done`; selection, read-state changes, tool results, and stream completion are not activity under the chosen definition.
- Keep updates immutable by spreading the existing record.

**Patterns to follow:**
- Existing spread-update style for `isStreaming`, `unreadCompletions`, and `sessionStatus` in `src/client/stores/chat-store.ts`.

**Test scenarios:**
- Happy path: after `sendMessage`, the session's `lastActivityAt` is greater than before.
- Edge case: a session fetched from the server gets an initial `lastActivityAt` derived from `lastModified` or `updatedAt`.
- Edge case: clearing unread or selecting a session does not bump `lastActivityAt`.
- Edge case: stale entries are pruned when `fetchSessions` returns a smaller set.
- Integration: an SSE `pending_approval` event bumps the timestamp and adds the pending item.

**Verification:**
- Lint and TypeScript pass.
- Manual smoke test: start a turn and observe the session move to the top of the list.

### U2. Extract session sort comparator and add unit tests

**Goal:** Provide a testable, pure function that orders sessions by recency of activity.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- `src/client/lib/session-sort.ts` (create)
- `src/client/lib/session-sort.test.ts` (create)

**Approach:**
- Export `compareSessionActivity(a, b, lastActivityAt)` that returns a negative number when `a` is more recent than `b`.
- Primary sort key: the value of `lastActivityAt` for each session, descending (larger timestamp first).
- If `lastActivityAt` is missing for a session, fall back to `session.lastModified` (number) or `Date.parse(session.updatedAt)` (string), descending.
- Tie-breakers, applied in order:
  1. `lastModified` / `updatedAt` descending (whichever is present).
  2. `createdAt` descending.
  3. `id` ascending for stable ordering.
- Keep the comparator decoupled from React and the store so it can run under `node:test`.

**Patterns to follow:**
- `src/client/lib/session-filter.ts` and `src/client/lib/session-filter.test.ts` for helper/test layout and the `makeSession` factory style.

**Test scenarios:**
- Happy path: session A active later than B sorts A above B.
- Edge case: identical `lastActivityAt` timestamps fall back to `updatedAt` / `createdAt`.
- Edge case: missing `lastActivityAt` entries use session timestamps.
- Edge case: stable ordering when every timestamp matches (compare by `id`).
- Edge case: `lastModified` (number) and `updatedAt` (ISO string) are both handled.

**Verification:**
- `node src/client/lib/session-sort.test.ts` passes.

### U3. Sort sessions, remove the pinned header, and simplify SessionListItem

**Goal:** Replace the pinned active-session header with a fully sorted list, keep search filtering intact, and reduce `SessionListItem` to a single list-row variant.

**Requirements:** R1, R4, R5, R6

**Dependencies:** U1, U2; assumes the title-search feature from `docs/plans/2026-06-13-003-feat-session-list-title-search-plan.md` is already in place.

**Files:**
- `src/client/components/SessionList.tsx` (modify)
- `src/client/components/SessionListItem.tsx` (modify)

**Approach:**
- Read `lastActivityAt` from the store alongside the other session state selectors.
- Remove the pinned active-session header block and any derivation that split the active session out of the list. The list now contains every workspace session.
- Compute `sortedSessions` with `useMemo`:
  ```ts
  const sortedSessions = useMemo(
    () => sessions.toSorted((a, b) => compareSessionActivity(a, b, lastActivityAt)),
    [sessions, lastActivityAt],
  )
  ```
  If the build target does not support `Array.prototype.toSorted`, use `[...sessions].sort(...)` instead.
- Apply search filtering to `sortedSessions` so matching items remain in activity order.
- Update `matchCount` to `filteredSessions.length` and remove the active-session match adjustment.
- Render list rows from `filteredSessions`; pass `isActive={session.id === activeSessionId}` so the selected session still highlights. Do not pass a `variant` prop.
- Preserve existing search UX: reset on workspace switch, Escape handling, clear button, disabled-while-loading state.
- In `SessionListItem`, remove the `variant` prop and all pinned-only branches (bottom border, left accent, persistent pencil, `tabIndex`/`role`/`aria-label`, and the Enter/Space activation handler).
- Keep the hover-reveal rename pencil, active highlight, inline rename input, context menu handler, status indicator, badges, and timestamp.
- Removing the pinned header also removes its `role="button"` and `aria-label`; the selected session remains a normal list row, which is acceptable for this iteration because selection is conveyed by the existing active-row styling.

**Patterns to follow:**
- `useMemo` pattern already used for `filteredSessions` in `src/client/components/SessionList.tsx`.
- Immutability convention: prefer `toSorted()` if available, otherwise copy with `[...sessions].sort()`.

**Test scenarios:**
- Happy path (Covers AE1): a session starts streaming and appears at the top of the list.
- Edge case (Covers AE2): a newer unread completion pushes its session above a recently streamed session.
- Edge case (Covers AE3): typing a query filters the sorted list without reordering it.
- Edge case (Covers AE4): two inactive sessions with different last-activity times order by recency.
- Regression: the selected session still renders with active-row styling.
- Regression: switching workspaces clears the search query.
- Regression: a list row renders with hover-only rename pencil and inline rename still commits on Enter and cancels on Escape/Blur.

**Verification:**
- Manual smoke test in the dev build shows active sessions at the top, search works, and selection highlight remains.
- Targeted ESLint on `SessionList.tsx` and `SessionListItem.tsx` passes.
- Vite build succeeds.

## Scope Boundaries

### Out of scope

- Server-side sorting or pagination.
- Pinning sessions above the list or manual drag-and-drop reordering.
- Visual grouping, section headers, or new badges for active sessions.
- Sorting by name, creation date, or other non-activity criteria.
- Reorder animations, focus management beyond native DOM behavior, and ARIA landmarks for the active session.

### Deferred to follow-up work

- Virtualizing the session list if performance becomes an issue at large session counts.
- Adding client-side component tests beyond the pure sort/filter utilities.

## Acceptance Examples

- AE1. **Streaming session rises to the top.**
  - **Given:** session A is inactive and session B starts streaming.
  - **When:** the streaming state updates.
  - **Then:** session B appears above session A in the list.

- AE2. **Newer activity wins.**
  - **Given:** session B was streaming and then stopped; session C receives a new unread completion.
  - **When:** the unread state updates.
  - **Then:** session C appears above session B.

- AE3. **Search preserves sort.**
  - **Given:** the list is sorted by recency and the user types a query.
  - **When:** the filtered list renders.
  - **Then:** matching sessions remain in recency order.

- AE4. **Inactive session stays in last-active order.**
  - **Given:** session D had activity five minutes ago and is now inactive, while session E had activity one minute ago and is now inactive.
  - **When:** the list renders.
  - **Then:** session E appears above session D.

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-13-session-list-activity-sort-requirements.md`
- Existing session-filter helper and tests: `src/client/lib/session-filter.ts`, `src/client/lib/session-filter.test.ts`
- Existing session list rendering and search: `src/client/components/SessionList.tsx`
- Existing activity signals in the store: `src/client/stores/chat-store.ts` (`isStreaming`, `unreadCompletions`, `approvalQueue`, `sessionStatus`)
- Existing session row state derivation: `src/client/lib/session-status.ts`
