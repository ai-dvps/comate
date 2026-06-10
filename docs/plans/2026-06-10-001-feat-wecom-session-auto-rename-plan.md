---
title: WeCom Session Auto-Rename on User ID Resolution
type: feat
status: active
date: 2026-06-10
origin: docs/brainstorms/2026-06-10-wecom-session-auto-rename-requirements.md
---

# WeCom Session Auto-Rename on User ID Resolution

## Summary

Change the `wecom_user_sessions` schema to support multiple sessions per user, then build an auto-rename service that triggers when the WeCom resolver stores a new mapping. The service renumbers all eligible WeCom sessions for that user using readable plaintext IDs, preserving user-set custom titles. Includes an idempotent startup backfill for existing sessions.

---

## Problem Frame

WeCom sessions are created with opaque encrypted user IDs as their names. When the resolver maps these to plaintext enterprise IDs, the session titles remain unreadable. The existing `wecom_user_sessions` schema enforces only one session per user per workspace, which blocks the multi-session numbering scheme the product requires. (see origin)

---

## Requirements

- R1. WeCom session titles for a given user in a workspace shall use the format `<plaintext_user_id> session` when the user has exactly one session in that workspace.
- R2. When a user has more than one session in a workspace, each title shall use `<plaintext_user_id> session #<seq_no>`, where `<seq_no>` is a 1-based index ordered by session creation time (oldest = #1).
- R3. If a session's count changes, all eligible sessions for that user in the workspace shall be renumbered to maintain sequential correctness.
- R4. Sessions with a user-set custom title shall never be auto-renamed.
- R5. Only sessions created via WeCom (`source === 'wecom'`) are eligible for auto-renaming.
- R6. For the backfill, only sessions whose current stored name matches the original encrypted WeCom user ID are eligible for auto-renaming.
- R7. On feature deployment, all existing WeCom sessions with already-resolved plaintext mappings shall be evaluated and renamed if eligible per R4, R5, and R6.

**Origin actors:** A1 (Workspace admin / GUI user), A2 (WeCom user), A3 (Resolver system)
**Origin flows:** F1 (New mapping resolution), F2 (New WeCom session creation), F3 (Retroactive backfill)
**Origin acceptance examples:** AE1–AE6

---

## Scope Boundaries

- GUI-created sessions are not affected by this feature.
- No opt-out toggle for auto-renaming is provided.
- Session deletion does not trigger renumbering of remaining sessions.
- Unresolved mappings (encrypted IDs with no known plaintext) remain unchanged.

### Deferred to Follow-Up Work

- None

---

## Context & Research

### Relevant Code and Patterns

- `src/server/services/wecom-user-resolver.ts` — Batch resolver with `flushWorkspace()` and `resolveImmediate()`. No existing hook for mapping storage events.
- `src/server/services/chat-service.ts` — `updateSession()` handles renaming differently for draft (SQLite `name`) vs SDK (`sdkClient.renameSession()`) sessions.
- `src/server/services/wecom-bot-service.ts` — Creates WeCom sessions with `name: wecomUserId` but does **not** set `source: 'wecom'`.
- `src/server/storage/sqlite-store.ts` — `wecom_user_sessions` has `PRIMARY KEY (workspaceId, wecomUserId)` with `ON CONFLICT DO UPDATE`, enforcing one session per user. `source` is only materialized dynamically in `listSessions()`.
- `src/server/models/session.ts` — `ChatSession` has `customTitle?: string`, but `UpdateSessionInput` does not expose `customTitle`, so draft sessions cannot carry user-set custom titles independently of `name`.

### Institutional Learnings

- `session.name` cannot be trusted as the encrypted WeCom user ID — `wecom_user_sessions` is the source of truth. (`2026-05-30-002-fix-wecom-username-lookup-plan.md`)
- `wecom_user_id_mappings` is global (not per-workspace). (`2026-05-26-001-feat-wecom-user-id-resolution-plan.md`)
- Past plan explicitly deferred "Session name update after resolution" — this feature is that follow-up.
- Existing migrations in `SqliteStore` constructor are idempotent and run on every startup.

---

## Key Technical Decisions

- **Multi-session schema change:** Change `wecom_user_sessions` primary key from `(workspaceId, wecomUserId)` to `(workspaceId, wecomUserId, sessionId)`. Add `listWecomSessionsByUser(workspaceId, wecomUserId)` for renumbering queries. Keep `getWecomSession` returning the most recent session for message routing.
- **`source` persisted at creation:** Add `source?: 'gui' | 'wecom'` to `CreateSessionInput` and propagate through `createLocalSession`. Backfill existing WeCom sessions to set `source = 'wecom'`.
- **Resolver hook via callback:** Add an optional `onMappingStored` callback to `WeComUserIdResolver`, invoked after each successful `setWecomUserMapping` in both `flushWorkspace` and `resolveImmediate`. This is the minimal change to the resolver; no EventEmitter needed.
- **Eligibility: `customTitle` for ongoing, `name === encryptedId` for backfill:** R6 (name matches encrypted ID) is used only for the backfill safety guard. For ongoing renumbers, the guard is `customTitle` presence (R4). This resolves the R3/R6 incompatibility: once a session is auto-renamed, it can still be renumbered because `customTitle` is still null.
- **Draft session custom title ambiguity accepted:** Draft sessions have no `customTitle` field in their update path. A user-renamed draft session and an auto-renamed draft session are indistinguishable. For now, both are treated the same: if `customTitle` is absent, the session is eligible for renumber. This is accepted because draft sessions are transient and user renames of WeCom draft sessions are expected to be rare.
- **Backfill as idempotent startup migration:** Run `backfillWeComSessionNames()` from `SqliteStore` constructor on every startup. It is naturally idempotent because R6 limits it to sessions whose `name` still matches the encrypted ID; already-renamed sessions are skipped.
- **Race conditions accepted with eventual consistency:** Concurrent session creation and resolver flushes may briefly produce inconsistent numbering. The next trigger (new session or new mapping) will renumber the group to consistency. This is acceptable for a display-name feature.

---

## Open Questions

### Resolved During Planning

- **How to support multiple sessions per WeCom user?** Change `wecom_user_sessions` primary key to include `sessionId`; update `setWecomSession` to insert without conflict-update; keep `getWecomSession` returning the latest session for routing.
- **How to resolve R3/R6 incompatibility?** R6 applies only to backfill; ongoing renumbers use `customTitle` presence as the eligibility guard.
- **How to trigger renames when mappings are stored?** Add `onMappingStored` callback to `WeComUserIdResolver`.

### Deferred to Implementation

- **Exact tiebreaking for sessions with identical `created_at`:** If two sessions share the same millisecond, ordering is undefined. In practice this is rare; if encountered, add secondary sort by `session.id`.
- **Draft session `customTitle` support:** Whether to add `customTitle` to draft session update path so user renames can be distinguished from auto-renames. Deferred because draft WeCom sessions are transient.

---

## Implementation Units

### U1. Schema and storage changes for multi-session support

**Goal:** Allow multiple WeCom sessions per user per workspace and persist `source` at creation time.

**Requirements:** R5, R7

**Dependencies:** None

**Files:**
- Modify: `src/server/storage/sqlite-store.ts`
- Modify: `src/server/models/session.ts`
- Modify: `src/server/services/chat-service.ts`
- Test: `src/server/storage/sqlite-store.test.ts`

**Approach:**
1. Drop and recreate `wecom_user_sessions` with primary key `(workspaceId, wecomUserId, sessionId)`. Use a migration that preserves existing data.
2. Change `setWecomSession` to plain `INSERT` (no conflict update).
3. Change `getWecomSession` to return the most recent session (`ORDER BY createdAt DESC LIMIT 1`).
4. Add `listWecomSessionsByUser(workspaceId, wecomUserId)` returning all sessions ordered by `createdAt ASC`.
5. Add `source?: 'gui' | 'wecom'` to `CreateSessionInput` and propagate through `createLocalSession`.
6. Update `wecom-bot-service.ts` to pass `source: 'wecom'` when creating sessions.
7. Add `backfillWeComSessionSource()` migration in `SqliteStore` constructor to set `source = 'wecom'` on existing sessions that are in `wecom_user_sessions` but have `source IS NULL`.

**Patterns to follow:**
- Existing migration pattern in `SqliteStore` constructor (`migrateFromLegacy`, `migrateDraftSessions`, etc.)

**Test scenarios:**
- Happy path: `setWecomSession` called twice for same user creates two rows.
- Happy path: `getWecomSession` returns the most recently created session.
- Happy path: `listWecomSessionsByUser` returns all sessions in creation order.
- Happy path: Creating a session with `source: 'wecom'` stores the source.
- Edge case: `getWecomSession` with no sessions returns null.

**Verification:**
- `sqlite-store.test.ts` passes with new multi-session assertions.
- `wecom-bot-service.ts` creates sessions with `source = 'wecom'`.

---

### U2. Add resolver mapping hook

**Goal:** Provide a trigger mechanism for the auto-rename service when mappings are stored.

**Requirements:** R1–R3

**Dependencies:** None

**Files:**
- Modify: `src/server/services/wecom-user-resolver.ts`
- Test: `src/server/services/wecom-user-resolver.test.ts` (create if absent)

**Approach:**
1. Add optional `onMappingStored?: (workspaceId: string, encryptedUserId: string, plaintextUserId: string) => void | Promise<void>` to `WeComUserIdResolver` constructor options.
2. After each successful `workspaceStore.setWecomUserMapping()` in `flushWorkspace()` and `resolveImmediate()`, invoke the callback with the stored mapping.
3. If the callback throws, log the error but do not fail the resolver operation (renaming is best-effort).

**Patterns to follow:**
- `SessionRuntime` event handler pattern (`addBotEventHandler`) for optional callback style.

**Test scenarios:**
- Happy path: Callback is invoked with correct arguments when `flushWorkspace` stores a mapping.
- Happy path: Callback is invoked when `resolveImmediate` stores a mapping.
- Error path: Callback throw does not abort the resolver flush or immediate lookup.
- Edge case: No callback registered — resolver operates normally.

**Verification:**
- Resolver tests confirm callback invocation and error isolation.

---

### U3. Create WeCom session renamer service

**Goal:** Implement the core renaming logic that computes and applies readable titles.

**Requirements:** R1–R4

**Dependencies:** U1

**Files:**
- Create: `src/server/services/wecom-session-renamer.ts`
- Test: `src/server/services/wecom-session-renamer.test.ts`

**Approach:**
1. Export `wecomSessionRenamer` singleton.
2. Provide `renameSessionsForUser(workspaceId: string, encryptedUserId: string)` method:
   a. Look up plaintext ID via `workspaceStore.getWecomUserMapping(encryptedUserId)`. If no mapping, return.
   b. Query all sessions for this user via `workspaceStore.listWecomSessionsByUser(workspaceId, encryptedUserId)`.
   c. Filter to `source === 'wecom'` and `customTitle IS NULL` (or `customTitle` absent).
   d. Order by `created_at ASC`.
   e. Compute titles: `<plaintext> session` if count === 1, else `<plaintext> session #<index>`.
   f. For each session, call `chatService.updateSession(sessionId, { name: newTitle }, workspaceId)`. Catch and log per-session errors; do not abort the batch.
3. Provide `shouldRename(session, encryptedUserId): boolean` helper for eligibility checks.

**Patterns to follow:**
- Singleton service pattern (`wecomBotService`, `wecomUserResolver`).
- `chatService.updateSession()` for draft/SDK rename abstraction.

**Test scenarios:**
- Happy path: Single session renamed to `<user> session`.
- Happy path: Two sessions renamed to `<user> session #1` and `#2`.
- Happy path: Session with `customTitle` set is skipped.
- Happy path: GUI session (source !== 'wecom') is skipped.
- Error path: SDK `renameSession` failure is logged and remaining sessions are still renamed.
- Edge case: No mapping exists — no-op.
- Edge case: No eligible sessions — no-op.
- Edge case: `created_at` ties — deterministic ordering (secondary sort by `id`).

**Verification:**
- Renamer service tests pass.
- Manual verification: create WeCom sessions, resolve mapping, observe rename.

---

### U4. Integrate renamer with bot service and resolver

**Goal:** Wire the renamer into session creation and mapping resolution flows.

**Requirements:** R1–R3, F1, F2

**Dependencies:** U2, U3

**Files:**
- Modify: `src/server/services/wecom-bot-service.ts`
- Modify: `src/server/services/wecom-user-resolver.ts` (wiring)
- Modify: `src/server/index.ts` (or wherever services are initialized)

**Approach:**
1. In `wecom-bot-service.ts`, when creating a new WeCom session:
   a. Pass `source: 'wecom'` to `chatService.createSession()`.
   b. After session creation, if `workspaceStore.getWecomUserMapping(wecomUserId)` returns a plaintext ID, call `wecomSessionRenamer.renameSessionsForUser(workspaceId, wecomUserId)`.
2. In app initialization, connect resolver to renamer:
   ```typescript
   wecomUserResolver.setOnMappingStored(async (workspaceId, encryptedUserId, plaintextUserId) => {
     await wecomSessionRenamer.renameSessionsForUser(workspaceId, encryptedUserId);
   });
   ```
   (Exact wiring shape depends on constructor vs setter pattern chosen in U2.)

**Patterns to follow:**
- Service singleton wiring pattern used elsewhere in `src/server/index.ts`.

**Test scenarios:**
- Integration: New message from unresolved user creates session; after resolver flush, session is renamed.
- Integration: New message from already-resolved user creates session; existing sessions are renumbered.
- Integration: Second session creation triggers renumber of the first session.

**Verification:**
- WeCom message flow end-to-end produces correctly named sessions.

---

### U5. Implement startup backfill

**Goal:** Rename existing WeCom sessions that already have resolved mappings.

**Requirements:** R6, R7, F3

**Dependencies:** U1, U3

**Files:**
- Modify: `src/server/storage/sqlite-store.ts`
- Modify: `src/server/services/wecom-session-renamer.ts` (backfill method)
- Test: `src/server/storage/sqlite-store.test.ts`

**Approach:**
1. Add `backfillWeComSessionNames()` to `sqlite-store.ts` or `wecom-session-renamer.ts`.
2. Query: join `wecom_user_sessions` with `sessions` and `wecom_user_id_mappings` to find sessions where:
   - `sessions.source = 'wecom'`
   - `sessions.name = wecom_user_sessions.wecomUserId` (R6 guard)
   - `sessions.custom_title IS NULL`
   - A mapping exists in `wecom_user_id_mappings`
3. Group by `(workspaceId, wecomUserId)`, order by `created_at ASC`, compute titles, call `chatService.updateSession()`.
4. Call this backfill from `SqliteStore` constructor. It is idempotent because R6 prevents re-processing already-renamed sessions.

**Patterns to follow:**
- Existing startup migration pattern in `SqliteStore` constructor.

**Test scenarios:**
- Happy path: Existing session with resolved mapping and original encrypted-ID name is renamed.
- Happy path: Already-renamed session is skipped.
- Happy path: Session with `customTitle` is skipped.
- Happy path: Running backfill twice is a no-op.
- Edge case: No resolved mappings — no-op.

**Verification:**
- Backfill tests pass.
- After restart, existing eligible sessions have readable titles.

---

### U6. End-to-end and integration tests

**Goal:** Verify the complete auto-rename flow across components.

**Requirements:** AE1–AE6

**Dependencies:** U1–U5

**Files:**
- Create or modify: `src/server/services/wecom-session-renamer.test.ts`
- Create or modify: `src/server/services/wecom-bot-service.test.ts` (create if absent)

**Approach:**
1. Test the full F1 flow: simulate resolver flush → verify session rename.
2. Test the full F2 flow: create multiple sessions for a resolved user → verify renumbering.
3. Test the full F3 flow: seed DB with pre-existing sessions → run backfill → verify renames.

**Test scenarios:**
- Covers AE1: Single session renamed on mapping.
- Covers AE2: Two sessions renamed with `#1` and `#2`.
- Covers AE3: Second session creation triggers renumber of first.
- Covers AE4: Custom-titled session is preserved.
- Covers AE5: GUI session is not renamed.
- Covers AE6: Backfill renames 10 existing sessions.

**Verification:**
- All acceptance examples are covered by automated tests.

---

## System-Wide Impact

- **Interaction graph:** `WeComUserIdResolver` now emits a callback consumed by `WeComSessionRenamer`. `WeComBotService` calls `WeComSessionRenamer` after session creation. `SqliteStore` runs backfill on startup.
- **Error propagation:** Rename failures are logged and swallowed per-session; they do not break message routing or resolver flushes.
- **State lifecycle risks:** Partial rename batches may leave temporary numbering gaps. The next renumber trigger corrects them. Backfill is idempotent by design.
- **API surface parity:** No public API changes.
- **Integration coverage:** The resolver-to-renamer callback must be verified under actual batch flush conditions. The draft-vs-SDK `updateSession` path must be tested for both session types.
- **Unchanged invariants:** WeCom message routing still uses `getWecomSession` (most recent session). The encrypted user ID remains the canonical session key. Existing GUI session behavior is untouched.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Schema change to `wecom_user_sessions` affects message routing if `getWecomSession` behavior changes | `getWecomSession` continues to return the most recent session; only the PK and insert semantics change |
| `source` backfill misses some legacy WeCom sessions | Backfill targets all rows in `wecom_user_sessions`; sessions not in that table were never WeCom-routed |
| Concurrent session creation + resolver flush produces transient numbering inconsistency | Accepted — eventual consistency; next trigger renumbers to correctness |
| Draft sessions cannot distinguish user-renamed from auto-renamed | Accepted — rare case; can be improved later by adding `customTitle` to draft update path |
| SDK `renameSession` failures during batch leave inconsistent state | Log and continue; next renumber trigger corrects |

---

## Documentation / Operational Notes

- No rollout steps required; backfill runs automatically on startup.
- No feature flag needed.
- Monitor logs for rename errors after deployment.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-10-wecom-session-auto-rename-requirements.md](docs/brainstorms/2026-06-10-wecom-session-auto-rename-requirements.md)
- Related plan: `docs/plans/2026-05-26-001-feat-wecom-user-id-resolution-plan.md`
- Related plan: `docs/plans/2026-05-30-002-fix-wecom-username-lookup-plan.md`
