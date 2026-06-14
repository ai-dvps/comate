---
date: 2026-06-14
topic: session-status-filter
---

## Summary

Replace the "Show archived" checkbox under the session search box with a compact, single-select status filter dropdown placed next to the search box. The dropdown offers All, Active, Archived, and WIP, defaults to Active, and keeps WIP independent of archived state.

## Problem Frame

The current archive filter is a checkbox tucked under the search box. It feels like an afterthought rather than a first-class filter control, and it does not give users a quick way to isolate WIP sessions. A dropdown next to the search box matches common sidebar patterns and scales better if more statuses are added later.

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

## Key Decisions

- **Single-select dropdown.** A single-select control is simpler than multi-select and matches common sidebar filter patterns.
- **WIP independent of archived state.** WIP is a separate flag, so the WIP filter includes archived WIP sessions rather than being mutually exclusive with Archived.
- **Default to Active.** This preserves the current behavior where archived sessions are hidden until the user chooses to reveal them.

## Acceptance Examples

- AE1. **Default view**
  - **Given** the user has opened a workspace with both active and archived sessions,
  - **When** the sidebar loads,
  - **Then** the filter dropdown shows "Active" and archived sessions are not listed.
- AE2. **Reveal archived sessions**
  - **Given** the filter is set to Active,
  - **When** the user selects "Archived" from the dropdown,
  - **Then** only archived sessions appear, and each archived row still shows the "Archived" tag next to its timestamp.
- AE3. **WIP filter includes archived WIP**
  - **Given** a session is both WIP and archived,
  - **When** the user selects "WIP",
  - **Then** that session appears in the list even though it is archived.
- AE4. **Workspace switch resets filter**
  - **Given** the user has changed the filter to "Archived",
  - **When** the user switches to another workspace,
  - **Then** the filter returns to "Active" for the new workspace.

## Scope Boundaries

- **Deferred for later:** bulk archive/unarchive actions, additional filters such as Draft or pinned sessions, and multi-select filter combinations.
- **Outside this product's identity:** changing the semantics of WIP or archive (e.g., auto-clearing WIP when archiving).

## Sources / Research

- Existing session list and archive UI: `src/client/components/SessionList.tsx` and `src/client/components/SessionListItem.tsx`.
- Existing archive persistence and reactivation behavior: `src/client/stores/chat-store.ts`, `src/server/services/chat-service.ts`, and `src/server/storage/sqlite-store.ts`.
