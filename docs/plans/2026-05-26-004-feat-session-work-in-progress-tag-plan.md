---
title: Session Work in Progress Tag
type: feat
status: completed
date: 2026-05-26
origin: docs/brainstorms/2026-05-26-session-work-in-progress-tag-requirements.md
---

# Session Work in Progress Tag

## Summary

Add a manually-toggled `isWip` boolean to chat sessions, persisted in a new SQLite metadata table and surfaced as a text badge beside the session timestamp. Users toggle the flag via a right-click context menu on session rows. The implementation follows existing patterns: `isDraft` for session boolean fields, `renameSession` for client-side optimistic updates, and the existing `PUT /sessions/:sessionId` route for server persistence.

---

## Problem Frame

Users juggle many parallel sessions but have no self-controlled marker to flag which ones they are actively thinking about. The existing indicators (streaming, needs-me, finished-unread, draft) are all system-determined; none capture user intent. (see origin: docs/brainstorms/2026-05-26-session-work-in-progress-tag-requirements.md)

---

## Requirements

- R1. Right-clicking a session row opens a context menu with a "Mark as Work in progress" option when the session is not WIP, and "Clear Work in progress" when it is.
- R2. Selecting the menu item toggles the session's WIP state immediately with optimistic UI updates.
- R3. WIP state persists across reloads for all sessions, including SDK sessions that outlive the draft store.
- R4. When WIP is true, a text badge renders directly alongside the relative timestamp on the session row.
- R5. The WIP badge is visually distinct from the existing `draft` pill and automatic status indicators.
- R6. The WIP badge coexists with automatic session states without precedence rules or suppression.

**Origin acceptance examples:** AE1 (covers R1, R2), AE2 (covers R4, R6), AE3 (covers R1, R2)

---

## Scope Boundaries

- No auto-clear behavior — WIP does not clear when streaming finishes, approvals resolve, or any other automatic condition changes.
- No functional effects — WIP does not pin sessions to the top, change sort order, prevent deletion, or trigger any other behavior change.
- No workspace-tab aggregation — WIP counts do not appear on workspace tabs.
- No keyboard shortcut for toggling WIP in v1.
- No bulk WIP operations (mark all, clear all).
- No integration with the existing automatic status indicator precedence rules — WIP is a separate visual layer.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/models/session.ts` — `ChatSession` interface and `UpdateSessionInput`; model for adding `isWip?: boolean`
- `src/server/storage/sqlite-store.ts` — SQLite persistence layer for workspaces; pattern for adding a new `session_metadata` table
- `src/server/storage/json-store.ts` — `DraftSessionStore` holds draft session metadata in JSON, but this does *not* survive draft-to-SDK promotion
- `src/server/services/chat-service.ts` — `listSessions` merges SDK sessions + draft sessions; `updateSession` handles renames; `mapSdkSessionInfo` maps SDK fields to `ChatSession`
- `src/server/routes/chat.ts` — `PUT /api/workspaces/:id/sessions/:sessionId` currently accepts `{ name }` only
- `src/client/stores/chat-store.ts` — `renameSession` action is the reference pattern for optimistic client-side updates of session metadata
- `src/client/components/SessionList.tsx` — session row rendering, timestamp area, and badge row with `draft` / `wecom` / `StatusIndicator`
- `src/client/i18n/en/chat.json` and `src/client/i18n/zh-CN/chat.json` — i18n namespace for chat UI strings

### Institutional Learnings

- `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md` — chat store SSE state is sensitive to re-renders; keep session metadata updates shallow and targeted to avoid unnecessary list re-renders.

---

## Key Technical Decisions

- **SQLite metadata table over extending draft JSON store:** Draft sessions live in `draft-sessions.json`, but SDK sessions do not. A `session_metadata` table in the existing SQLite database (`~/.comate/data.db`) persists WIP state for all sessions and survives draft-to-SDK promotion.
- **Extend existing PUT endpoint over dedicated route:** The `PUT /api/workspaces/:id/sessions/:sessionId` route is already the session mutation surface. Adding `isWip?: boolean` to `UpdateSessionInput` keeps the API minimal. The service layer branches internally: `name` continues to use existing rename logic, while `isWip` writes to the metadata table.
- **Custom inline context menu over third-party library:** No context menu library exists in the project. A lightweight native `onContextMenu` handler with an absolutely-positioned div is sufficient for a two-item menu.
- **Optimistic client update following `renameSession` pattern:** The store updates the local `sessions` array immediately, then syncs to the server. On error, the optimistic change is rolled back by re-fetching or reverting local state.

---

## Open Questions

### Resolved During Planning

- **Where should WIP state persist for SDK sessions?** → A new SQLite `session_metadata` table, since the draft JSON store does not cover SDK sessions and draft-to-SDK promotion would lose WIP state.
- **Should WIP use a dedicated API endpoint?** → No; extend the existing `PUT /sessions/:sessionId` to accept `isWip`.

### Deferred to Implementation

- **Exact badge color and size:** Deferred — implementer should pick a Tailwind color that is distinct from amber (`draft`), orange (`needs-me`), blue (`finished-unread`), and green (`streaming`). Purple or teal are candidates.
- **Context menu positioning strategy:** Deferred — exact positioning math (cursor-aligned vs. row-aligned) and animation can be settled during implementation.

---

## Implementation Units

### U1. Add server-side session metadata persistence

**Goal:** Create a SQLite table and store methods for session metadata, and merge metadata into the session list response so all sessions can carry an `isWip` field.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `src/server/models/session.ts`
- Modify: `src/server/storage/sqlite-store.ts`
- Modify: `src/server/services/chat-service.ts`

**Approach:**
- Add `isWip?: boolean` to the server-side `ChatSession` interface.
- Add a `session_metadata` table to `SqliteStore` with `session_id TEXT PRIMARY KEY` and `is_wip INTEGER DEFAULT 0`.
- Add `getSessionMetadata(sessionIds: string[]): Record<string, { isWip: boolean }>` and `setSessionMetadata(sessionId: string, isWip: boolean)` methods to `SqliteStore`.
- In `chatService.listSessions`, after assembling the merged list of SDK + draft sessions, query `getSessionMetadata` for all session IDs and merge `isWip` into each session object before returning.
- Ensure `mapSdkSessionInfo` does not set `isWip` (it should remain undefined by default, with the merge step providing the value).

**Patterns to follow:**
- `src/server/storage/sqlite-store.ts` — existing table initialization pattern (search for `CREATE TABLE` calls in the constructor)
- `src/server/services/chat-service.ts` — existing `listSessions` merge logic for SDK + draft sessions

**Test scenarios:**
- Happy path: `getSessionMetadata` returns `{ isWip: true }` for a session that was previously marked WIP
- Edge case: `getSessionMetadata` called with an empty array returns an empty object
- Edge case: `getSessionMetadata` called with unknown session IDs returns entries only for known IDs
- Integration: `listSessions` returns `isWip: true` on a session whose metadata was set, and `isWip: undefined` (or false) on sessions with no metadata

**Verification:**
- Querying the session list API returns `isWip: true` for sessions whose metadata was set in SQLite, and no `isWip` (or `false`) for sessions without metadata.

---

### U2. Extend session update API to persist isWip

**Goal:** Allow the existing session update endpoint to accept and persist `isWip` changes to the metadata table.

**Requirements:** R2, R3

**Dependencies:** U1

**Files:**
- Modify: `src/server/models/session.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/server/services/chat-service.ts`

**Approach:**
- Extend `UpdateSessionInput` to include `isWip?: boolean`.
- Update `chatService.updateSession` to detect when `isWip` is present in the input and route it to `SqliteStore.setSessionMetadata` instead of the existing rename/draft-update logic.
- Update the `PUT /api/workspaces/:id/sessions/:sessionId` route to pass the full input object (including `isWip`) to the service.
- Ensure the route returns the updated session object with the merged `isWip` field.

**Patterns to follow:**
- `src/server/routes/chat.ts` — existing `PUT /sessions/:sessionId` route for `renameSession`
- `src/server/services/chat-service.ts` — existing `updateSession` method

**Test scenarios:**
- Happy path: Calling the PUT endpoint with `{ isWip: true }` sets metadata and returns the session with `isWip: true`
- Happy path: Calling the PUT endpoint with `{ isWip: false }` clears metadata and returns the session with `isWip: false`
- Integration: Calling the PUT endpoint with `{ name: "New Name", isWip: true }` updates both fields correctly

**Verification:**
- PUT requests with `isWip` toggle the value in SQLite and the response reflects the new state.

---

### U3. Add client-side store action for toggling WIP

**Goal:** Client can toggle `isWip` with optimistic updates and localized labels.

**Requirements:** R2, R3

**Dependencies:** U2

**Files:**
- Modify: `src/client/stores/chat-store.ts`
- Modify: `src/client/i18n/en/chat.json`
- Modify: `src/client/i18n/zh-CN/chat.json`

**Approach:**
- Add `isWip?: boolean` to the client-side `ChatSession` interface (mirroring the server type).
- Add `toggleSessionWip(workspaceId: string, sessionId: string, isWip: boolean)` action to the Zustand store.
- The action should:
  1. Call `PUT /api/workspaces/${workspaceId}/sessions/${sessionId}` with `{ isWip }`
  2. Optimistically update the local `sessions[workspaceId]` array by mapping over and replacing only the matching session's `isWip` field
  3. On success, use the server response to confirm state
  4. On error, revert or re-fetch sessions
- Add i18n keys: `markAsWip`, `clearWip`, `wip` in both English and Chinese.

**Patterns to follow:**
- `src/client/stores/chat-store.ts` — `renameSession` action for optimistic update pattern
- `src/client/i18n/en/chat.json` and `zh-CN/chat.json` — existing camelCase key conventions

**Test scenarios:**
- Happy path: Calling `toggleSessionWip` updates the local session array immediately and syncs to the server
- Edge case: Calling `toggleSessionWip` while offline or on network error does not leave stale optimistic state (revert or error surface)
- Integration: After toggling WIP, switching workspaces and back still shows the correct WIP state

**Verification:**
- The store action updates local state optimistically and the server persists the change across reloads.

---

### U4. Add context menu interaction to session rows

**Goal:** Right-click on a session row opens a menu to toggle WIP.

**Requirements:** R1, R2

**Dependencies:** U3

**Files:**
- Modify: `src/client/components/SessionList.tsx`

**Approach:**
- Add a `contextmenu` event handler to the session row container div.
- Implement a lightweight inline context menu component (or inline JSX) that:
  - Appears at the cursor position on right-click
  - Shows "Mark as Work in progress" when `!session.isWip`
  - Shows "Clear Work in progress" when `session.isWip`
  - Closes on click outside, Escape key, or scroll
- On menu item selection, call `toggleSessionWip` and close the menu.
- Prevent the default browser context menu from appearing.

**Patterns to follow:**
- None existing — this is the first context menu in the app. Keep it minimal: a single `div` with `absolute` positioning, Tailwind styling, and native event handlers.

**Test scenarios:**
- Happy path: Right-clicking a session row opens the context menu
- Happy path: Selecting "Mark as Work in progress" toggles the state and closes the menu
- Edge case: Clicking outside the menu or pressing Escape closes it without toggling
- Edge case: Right-clicking a different row while a menu is open moves the menu to the new row

**Verification:**
- Users can right-click any session row and see the appropriate toggle option; selecting it updates WIP state and the menu closes.

---

### U5. Render WIP badge alongside session timestamp

**Goal:** Display a distinct text badge beside the relative timestamp when `isWip` is true.

**Requirements:** R4, R5, R6

**Dependencies:** U3

**Files:**
- Modify: `src/client/components/SessionList.tsx`

**Approach:**
- In the timestamp rendering area of the session row, conditionally render a small text pill before or after the timestamp when `session.isWip` is true.
- Use a visual treatment distinct from the `draft` badge (`bg-warning/20 text-warning`) and the automatic status indicators. A purple or teal tinted pill is recommended.
- Ensure the badge does not interfere with the existing timestamp layout or truncate the session name.
- The badge should coexist with automatic indicators in the tag row above — no precedence or suppression logic.

**Patterns to follow:**
- `src/client/components/SessionList.tsx` — existing `draft` badge rendering for pill sizing and spacing conventions
- Tailwind utility conventions used elsewhere in the component

**Test scenarios:**
- Happy path: A WIP session shows the badge beside the timestamp
- Happy path: A non-WIP session shows no badge
- Edge case: A session that is both WIP and `draft` shows both badges in their respective locations (WIP beside timestamp, `draft` in tag row)
- Edge case: Long session names + WIP badge + timestamp do not break layout or cause overflow

**Verification:**
- WIP sessions display a clearly distinguishable badge next to the timestamp; non-WIP sessions are unchanged.

---

## System-Wide Impact

- **Interaction graph:** The new `session_metadata` table is read during every `listSessions` call. The `getSessionMetadata` query should accept a batch of session IDs to avoid N+1 queries.
- **Error propagation:** `updateSession` service method now handles two paths (rename and metadata). Ensure `isWip` failures in SQLite do not break rename operations when both fields are present.
- **State lifecycle risks:** Draft-to-SDK promotion previously lost draft-only metadata. The SQLite metadata table survives this transition, but verify that `clearDraftFlag` does not inadvertently clear `isWip`.
- **API surface parity:** The PUT endpoint now accepts `isWip`. Ensure the existing rename flow (which only sends `name`) continues to work unchanged.
- **Unchanged invariants:** The existing automatic status indicators (streaming, needs-me, finished-unread) and their precedence rules are untouched. The `draft` badge and its behavior are unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SQLite schema migration for new table | The project uses `better-sqlite3` without an explicit migration framework. Add table creation in `SqliteStore` constructor with `CREATE TABLE IF NOT EXISTS` to handle first-time creation gracefully. |
| Context menu positioning on small screens / overflow | Keep menu minimal (1-2 items) and position relative to viewport bounds. Test with long session lists and varying sidebar widths. |
| Re-render performance in session list | Follow the shallow targeted update pattern from `renameSession`. Do not replace the entire `sessions` object; map only the affected workspace array. |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-26-session-work-in-progress-tag-requirements.md](docs/brainstorms/2026-05-26-session-work-in-progress-tag-requirements.md)
- Related code: `src/client/stores/chat-store.ts` (`renameSession` pattern)
- Related code: `src/server/storage/sqlite-store.ts` (SQLite persistence patterns)
- Related code: `src/server/models/session.ts` (`ChatSession` interface)
- Related plan: `docs/plans/2026-05-26-003-feat-session-title-editing-plan.md` (similar client-server sync pattern)
