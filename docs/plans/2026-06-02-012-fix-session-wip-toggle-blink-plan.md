---
title: "fix: Prevent WIP toggle from blinking on non-draft sessions"
type: fix
status: completed
date: 2026-06-02
origin: docs/brainstorms/2026-05-26-session-work-in-progress-tag-requirements.md
---

# fix: Prevent WIP toggle from blinking on non-draft sessions

## Summary

Patch the server-side session sync path so that local `isWip` metadata is preserved in the session object returned to the client after SDK session discovery. The database already persists WIP correctly; the bug is that the returned object overwrites the client’s optimistic update with an `undefined` value, causing the badge to flash and disappear.

---

## Problem Frame

Users can mark any session as Work in progress via a context menu. After toggling WIP on a non-draft session, the badge appears for an instant then vanishes. Closing and reopening the workspace tab reveals the WIP badge is correctly persisted in the database. The issue is a data-loss bug in `ChatService.updateSession` and `ChatService.getSession`: both methods return a session mapped from fresh SDK data that does not include the local `isWip` field, and the client replaces its optimistic state with this incomplete object.

---

## Requirements

- R1. Toggling WIP on a non-draft session must result in a stable WIP badge that does not disappear after the server responds.
- R2. The fix must not change the existing `syncSdkSession` conflict-resolution behavior, which correctly preserves local metadata in the database.
- R3. The same preservation pattern should apply to `getSession` so that future callers do not rediscover the same bug class.

**Origin acceptance examples:** The toggle interaction acceptance examples from the origin doc (mark as WIP, clear WIP, badge persists across reloads).

---

## Scope Boundaries

- Does not add new WIP functionality or visual behavior.
- Does not change `syncSdkSession` ON CONFLICT column list.
- Does not introduce new test infrastructure — verification is manual given the project’s current test surface.
- Adjacent metadata field `approvalMode` is out of scope unless it shares the exact same return path and the fix is trivially extended.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/services/chat-service.ts` — `updateSession` and `getSession` both call `mapSdkSessionInfo` followed by `syncSdkSession`, then return the mapped session without local metadata.
- `src/server/storage/sqlite-store.ts` — `syncSdkSession` uses `ON CONFLICT(id) DO UPDATE` that intentionally omits `is_wip` so local metadata survives SDK syncs. `setSessionMetadata` and `getLocalSession` correctly read and write `isWip`.
- `src/client/stores/chat-store.ts` — `toggleSessionWip` applies an optimistic update, awaits the PUT, then replaces local state with the server response. When the response lacks `isWip`, the optimistic `true` is overwritten with `undefined`.
- Existing precedent in `getSession`: `providerId` is already preserved from the local DB after SDK sync via an explicit patch.

### Institutional Learnings

- None specific to this surface in `docs/solutions/`.

---

## Key Technical Decisions

- **Patch after sync, not modify `mapSdkSessionInfo`:** The mapper is intentionally SDK-only. Preserving local metadata after the sync call mirrors the existing `providerId` pattern in `getSession` and keeps the fix minimal.
- **Limit to `isWip` in `updateSession`; extend `getSession` for consistency:** `updateSession` is the directly reported bug path. `getSession` shares the same flaw and is cheap to fix at the same time, preventing rediscovery.

---

## Implementation Units

### U1. Fix `updateSession` to preserve `isWip` in returned session

**Goal:** After renaming or syncing a non-draft session, merge the local `isWip` value into the returned session object so the client receives the correct state.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/server/services/chat-service.ts`

**Approach:**
- In the non-draft branch of `updateSession`, after `syncSdkSession(session)` and before returning, read the local session via `workspaceStore.getLocalSession(id)` and copy `isWip` from it into the returned session object.
- The draft branch already uses `updateLocalSession`, which reads from the database after `setSessionMetadata` has run, so it already returns the correct `isWip` and needs no change.

**Patterns to follow:**
- The existing `providerId` preservation pattern in `getSession`.

**Test scenarios:**
- **Happy path:** Given a non-draft session with `isWip: false`, when the client sends `isWip: true`, the server response includes `isWip: true` and the badge remains visible.
- **Happy path:** Given a non-draft session with `isWip: true`, when the client sends `isWip: false`, the server response includes `isWip: false` and the badge disappears.
- **Edge case:** Given a draft session, when the client toggles WIP, the server response continues to include the correct `isWip` (no regression).

**Verification:**
- Toggle WIP on a non-draft session in the UI. The WIP badge appears and does not vanish.
- Refresh the page. The WIP badge is still present.
- Toggle WIP off. The badge disappears and stays gone after refresh.

---

### U2. Fix `getSession` to preserve `isWip` from local DB

**Goal:** When `getSession` discovers a session via the SDK and syncs it, preserve `isWip` (and `approvalMode` for consistency) from the local database in the returned object.

**Requirements:** R3

**Dependencies:** None (can land independently of U1, but both touch the same file)

**Files:**
- Modify: `src/server/services/chat-service.ts`

**Approach:**
- After `workspaceStore.syncSdkSession(session)` in `getSession`, read `workspaceStore.getLocalSession(id)` and copy `isWip` and `approvalMode` from the local session into the returned object, alongside the existing `providerId` preservation.

**Patterns to follow:**
- The existing `providerId` preservation pattern already present in `getSession`.

**Test scenarios:**
- **Integration:** Given a non-draft session with `isWip: true` in the local DB, when `getSession` is called (e.g., during runtime creation or message loading), the returned session retains `isWip: true`.

**Verification:**
- Call `getSession` for a WIP-marked non-draft session and confirm `isWip` is present in the result.

---

## System-Wide Impact

- **Unchanged invariants:** `syncSdkSession` conflict resolution, client optimistic update pattern, `listSessions` behavior, `session_metadata` migration path.
- **Error propagation:** If `getLocalSession` returns `null` (rare race), the patch safely falls back to `undefined`, which is the current behavior — no new failure mode.
- **State lifecycle risks:** None. The fix only reads local metadata that was already persisted by `setSessionMetadata`.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-26-session-work-in-progress-tag-requirements.md](../brainstorms/2026-05-26-session-work-in-progress-tag-requirements.md)
- Related code: `src/server/services/chat-service.ts` (`updateSession`, `getSession`, `mapSdkSessionInfo`)
- Related code: `src/client/stores/chat-store.ts` (`toggleSessionWip`)
- Related code: `src/server/storage/sqlite-store.ts` (`syncSdkSession`, `setSessionMetadata`, `getLocalSession`)
