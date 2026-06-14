---
title: "feat: Replace archived checkbox with session status filter dropdown"
type: feat
date: 2026-06-14
origin: docs/brainstorms/2026-06-14-session-status-filter-requirements.md
---

## Summary

Replace the "Show archived" checkbox under the session search box with a compact single-select status filter dropdown placed next to the search box. The dropdown offers All / Active / Archived / WIP, defaults to Active, and keeps WIP independent of archived state.

## Problem Frame

The current archive filter is a checkbox tucked under the search box. It reads like an afterthought rather than a first-class filter, and it cannot isolate WIP sessions. A dropdown next to the search box matches the sidebar patterns users already expect and scales better if more statuses appear later.

## Requirements

- R1. The session list filter control is a single-select dropdown located next to the session search box.
- R2. The dropdown options are All, Active, Archived, and WIP, in that order.
- R3. The default selected option is Active, so archived sessions are hidden by default.
- R4. Selecting Active shows every session that is not archived.
- R5. Selecting Archived shows every session that is archived, including archived sessions that are also WIP.
- R6. Selecting WIP shows every session marked WIP, including WIP sessions that are also archived.
- R7. Selecting All shows every session regardless of archive or WIP state.
- R8. The dropdown selection resets to Active when the user switches workspaces.
- R9. The existing right-click archive/unarchive context menu continues to work unchanged.

## Key Technical Decisions

- **Native `<select>` over a custom dropdown component.** Matches the established `WorkspaceSelector` pattern in `src/client/components/analytics/WorkspaceSelector.tsx` and keeps the control small and accessible without new dependencies.
- **Shared filter predicate in `session-filter.ts`.** Keeps status semantics in one testable place and lets the component stay thin, mirroring how `matchesSessionQuery` already centralizes search logic.
- **Single-select with WIP independent of archived.** WIP is a separate flag, so the WIP predicate ignores archived state and the Archived predicate ignores WIP state.
- **Default to Active and reset on workspace switch.** Preserves the current "hide archived by default" behavior and prevents a stale filter from surprising users when they jump between workspaces.

## Implementation Units

### U1. Status filter predicate

- **Goal:** Add a pure predicate that decides whether a session matches a selected status filter value.
- **Requirements:** R4, R5, R6, R7.
- **Dependencies:** None.
- **Files:**
  - Modify `src/client/lib/session-filter.ts`
  - Test `src/client/lib/session-filter.test.ts`
- **Approach:** Export a `SessionStatusFilter` union (`'all' | 'active' | 'archived' | 'wip'`) and a `matchesSessionStatus(session, status)` predicate. `active` returns true when `isArchived` is falsy. `archived` returns true when `isArchived` is truthy. `wip` returns true when `isWip` is truthy. `all` always returns true. The predicate reads only booleans on `ChatSession`, so no store changes are required.
- **Patterns to follow:** Existing `matchesSessionQuery` in `src/client/lib/session-filter.ts` and its test file.
- **Test scenarios:**
  - Active filter excludes an archived session and includes a non-archived session.
  - Covers AE2. Archived filter includes a session that is both archived and WIP.
  - Covers AE3. WIP filter includes a WIP session that is also archived.
  - All filter returns true for archived, WIP, and plain active sessions.
  - Active filter includes a WIP session that is not archived.
  - Archived filter excludes a non-archived session.
- **Verification:** Running `session-filter.test.ts` passes with the new scenarios; predicate stays pure and synchronous.

### U2. Status filter dropdown in the session list

- **Goal:** Replace the "Show archived" checkbox with a single-select dropdown next to the session search box and wire it into the existing filter pipeline.
- **Requirements:** R1, R2, R3, R8, R9.
- **Dependencies:** U1.
- **Files:**
  - Modify `src/client/components/SessionList.tsx`
  - Modify `src/client/i18n/en/chat.json`
  - Modify `src/client/i18n/zh-CN/chat.json`
  - Test `src/client/components/SessionList.test.tsx`
- **Approach:** Replace the `showArchived` boolean state with a `statusFilter` state typed as `SessionStatusFilter`, initialized to `'active'`. Render a labeled native `<select>` next to the search input with options All / Active / Archived / WIP in that order. Update the `filteredSessions` memo to apply `matchesSessionStatus` alongside the existing search and archive filters; remove the now-redundant archive-only branch and the checkbox. Reset `statusFilter` to `'active'` in the workspace-switch effect that already clears the search query. Leave the right-click context menu and `toggleSessionArchive` wiring untouched.
- **Patterns to follow:** Native select styling and label layout in `src/client/components/analytics/WorkspaceSelector.tsx`; existing search input styling and workspace-reset effect in `src/client/components/SessionList.tsx`.
- **Test scenarios:**
  - Covers AE1. On mount with mixed sessions, the dropdown shows Active and archived sessions are absent from the list.
  - Covers AE2. Selecting Archived reveals only archived sessions and each row still renders the Archived tag.
  - Covers AE3. Selecting WIP reveals a session that is both WIP and archived.
  - Covers AE4. Changing the filter to Archived, then switching workspaces, resets the dropdown to Active for the new workspace.
  - Selecting All lists archived and active sessions together.
- **Verification:** The checkbox is gone, the dropdown appears next to the search box, and the filter behaves per the scenarios above.

## Scope Boundaries

### Deferred for later

- Bulk archive/unarchive actions.
- Additional status filters such as Draft or pinned sessions.
- Multi-select filter combinations.
- Removing the now-unused `showArchived` i18n key is in-scope cleanup for U2; any other i18n key pruning is deferred.

### Outside this product's identity

- Changing WIP or archive semantics (for example, auto-clearing WIP when archiving).

## Open Questions

None. All decisions are resolved in the origin brainstorm and the Key Technical Decisions above.

## Sources / Research

- Existing session list and search filter: `src/client/components/SessionList.tsx`, `src/client/lib/session-filter.ts`.
- Native-select pattern to mirror: `src/client/components/analytics/WorkspaceSelector.tsx`.
- Archive UI and context menu: `src/client/components/SessionListItem.tsx` and the context menu block in `src/client/components/SessionList.tsx`.
- Origin requirements and acceptance examples: `docs/brainstorms/2026-06-14-session-status-filter-requirements.md`.
