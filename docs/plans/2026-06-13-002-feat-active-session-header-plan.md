---
title: Active session header in SessionList
type: feat
date: 2026-06-13
origin: docs/brainstorms/2026-06-13-active-session-header-requirements.md
---

## Summary

Add a pinned, visually distinct header above the scrolling session list that shows the active session. The active session is removed from the list; all other sessions keep their existing order. Rename and WIP-toggle actions work from the header via a shared row component.

## Problem Frame

`src/client/components/SessionList.tsx` renders every workspace session inside a single scrolling list. The active session can fall far from the top, forcing the user to scan for it. The origin requirements doc defines the desired behavior: keep the active session immediately visible without reordering the rest of the list.

## Requirements

Traceability to origin requirements in parentheses.

- R1. A pinned header is shown above the scrolling session list whenever a session is active. (origin R1)
- R2. The header displays the active session and only the active session. (origin R2)
- R3. The active session is not rendered inside the scrolling session list while it is active. (origin R3)
- R4. The header uses a visually distinct style from normal list rows. (origin R4)
- R5. The header exposes the same session actions as a normal row: rename and WIP toggle. (origin R5)
- R6. All sessions other than the active one keep their existing order in the scrolling list. (origin R6)
- R7. When no session is active, the header is hidden and the list behaves as it does today. (origin R7)

## Key Technical Decisions

- **Extract a shared `SessionListItem` component.** Both the pinned header and the scrolling list render the same row content, status, badges, rename input, and context menu. A shared component avoids duplication and keeps the two surfaces consistent.
- **Pin the header outside the scrollable list container.** The header sits as a sibling above the `flex-1 overflow-y-auto` list, so it stays visible without `position: fixed` or scroll-event logic.
- **Filter the active session from the rendered array rather than reordering the store.** This preserves the existing list order and avoids mutating `chat-store` session arrays.
- **Reset rename state when the active session changes.** If a rename input is open and the active session changes, the edit is cancelled and the input disappears, matching the current list-row behavior. This prevents renaming the wrong session after a switch.
- **Pass `preview` as a prop to `SessionListItem`.** The component receives the already-computed preview string instead of reading `messages` directly, keeping it pure and avoiding extra re-renders.
- **Pinned header styling uses a bottom border separator and a left accent border.** The pinned variant uses the same background as the active list row (`bg-surface-active`) plus a bottom border (`border-b border-border/50`) to separate it from the scrolling list and a left accent border (`border-l-2 border-accent`) to make it visually distinct.

## Implementation Units

### U1. Extract reusable `SessionListItem` component

**Goal:** Encapsulate session row rendering so the pinned header and scrolling list share the same markup, actions, and event handling.

**Requirements:** R4, R5

**Dependencies:** None

**Files:**
- Create: `src/client/components/SessionListItem.tsx`
- Modify: `src/client/components/SessionList.tsx`

**Approach:**
- Move the existing row JSX into a new component. Props include: `session`, `variant` (`'list'` | `'pinned'`), `isActive`, `preview`, `editingSessionId`, `editingName`, `onStartEdit`, `onCommitEdit`, `onCancelEdit`, `onSetEditingName`, `onContextMenu`, `onActivate`, `t`, `ts`.
- The `'list'` variant keeps the existing hover-reveal pencil behavior. The `'pinned'` variant shows the rename pencil persistently because the header has no row group for hover-reveal and is always visible.
- Keep all existing behavior: click to activate, right-click for context menu, inline rename with Enter/Escape/Blur, status indicator, badges, and timestamp.
- Use `StatusIndicator`, `cn` from `src/client/components/ui/utils`, and `lucide-react` icons. Compute `rowState` inside the item from props.
- Leave the New Session button, toolbar, and context-menu overlay in `SessionList.tsx`.

**Patterns to follow:**
- `src/client/components/ui/button.tsx` and `src/client/components/ui/badge.tsx` for Tailwind token usage and `cn()` class merging.
- `docs/design/ui-ux-design.md` for color tokens and spacing; the pinned header adds a new treatment (bottom separator + left accent border) that should stay within the existing token set.

**Test scenarios:**
- Happy path: renders a non-active session with name, preview, timestamp, and hover-only rename button.
- Edge case: renders an active session with `bg-surface-active` and an accent-colored `MessageSquare` icon.
- Edge case: the `'pinned'` variant renders a persistent rename pencil (not hover-reveal) and a left accent border.
- Edge case: edit mode renders the input with `autoFocus` and commits on Enter, cancels on Escape/Blur.
- Edge case: right-click triggers the supplied context-menu handler.
- Integration: WIP badge and `StatusIndicator` render based on current store state.

**Verification:**
- `SessionList.tsx` still renders list rows unchanged.
- TypeScript and lint pass.

### U2. Add pinned active-session header and filter the list

**Goal:** Render the active session in a pinned header above the scrolling list and remove it from the list.

**Requirements:** R1, R2, R3, R5, R6, R7; advances R5 via the shared component from U1.

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/SessionList.tsx`

**Approach:**
- Compute `activeSession` from `sessions.find(s => s.id === activeSessionId)`. If `activeSession` is undefined (including during loading or when the ID is stale), do not render the header.
- Between the New Session button area and the `flex-1 overflow-y-auto` list, conditionally render `<SessionListItem variant="pinned" ...>` when `activeSession` exists. The pinned wrapper adds a bottom border to separate it from the scrolling list.
- In the list, filter out the active session: `sessions.filter(s => s.id !== activeSessionId).map(...)`.
- Reuse the existing `editingSessionId`, `editingName`, and `contextMenu` state so rename and WIP toggle work from the header without extra state.
- Reset the rename state (`editingSessionId` and `editingName`) whenever `activeSessionId` changes, so a stale rename does not move to the wrong session in the header.
- The pinned header container has `tabIndex={0}`, `role="button"`, and an `aria-label` describing it as the active session; it activates on Enter/Space as well as click.
- Use the same fixed-position context menu logic for the header; right-clicking anywhere on the header opens the menu at the cursor.
- Creating a new session does not change the active session or the pinned header; the new session appears in the list as an inactive item.
- Do not reorder or rewrite the `sessions` array in `chat-store`.

**Patterns to follow:**
- Existing `SessionList.tsx` toolbar/overlay pattern for modal state.
- `src/client/components/ui/badge.tsx` if a new "active" badge is added to the header.
- `docs/design/ui-ux-design.md` color tokens; use the existing 250ms `cubic-bezier(0.4, 0, 0.2, 1)` timing token if a transition is added, otherwise render the header immediately.

**Test scenarios:**
- Happy path (Covers AE1): clicking a session makes it appear in the pinned header and disappear from the scrolling list.
- Edge case (Covers AE2): starting a rename on the active session, then switching active sessions, cancels the rename and shows the new session in the header.
- Edge case (Covers AE3): when no session is active, the header is hidden and the full list is visible.
- Edge case: while sessions are loading, the header is hidden even if a stale `activeSessionId` exists.
- Integration (Covers AE4): right-clicking the header opens the context menu and toggling WIP updates the header badge.
- Edge case: the pinned header remains visible while the list is scrolled.
- Edge case: pressing Tab reaches the pinned header; pressing Enter/Space activates it.

**Verification:**
- Manual smoke test in the dev build: active session pinned, other sessions unchanged, rename and WIP work from the header.
- Lint and TypeScript build pass.

## Acceptance Examples

- AE1. **Selecting a session moves it to the header.**
  - **Given:** a workspace with multiple sessions and none selected.
  - **When:** the user clicks a session in the list.
  - **Then:** the clicked session appears in the pinned header and disappears from its original list position.

- AE2. **Rename is cancelled when the active session changes.**
  - **Given:** the user is renaming the active session inline.
  - **When:** the active session changes to a different session.
  - **Then:** the rename input is cancelled and the newly active session appears in the header.

- AE3. **No active session hides the header.**
  - **Given:** the workspace has sessions but none is selected.
  - **Then:** the pinned header is not rendered and the full session list is visible.

- AE4. **WIP toggle works from the header.**
  - **Given:** a session is active and shown in the header.
  - **When:** the user opens the context menu on the header and toggles WIP.
  - **Then:** the session's WIP state updates and the header reflects the change.

## Scope Boundaries

### Out of scope

- Sorting or reordering the remaining sessions by recency or activity.
- Pinning more than one session at a time.
- A user setting to disable the pinned header (deferred unless accessibility feedback requires it).
- Server-side changes to session storage or APIs.
- Animation/transition of the header appearance or list-item removal in v1.

### Deferred to follow-up work

- Adopting a client-side component test runner, followed by automated tests for `SessionList` and `SessionListItem`.

## Sources & Research

- **Origin document:** `docs/brainstorms/2026-06-13-active-session-header-requirements.md`
- **Target component:** `src/client/components/SessionList.tsx`
- **Design tokens and spacing:** `docs/design/ui-ux-design.md`
- **Commit convention:** `docs/solutions/conventions/commit-plan-and-brainstorm-files-with-code-changes.md`
- **Related prior plans:** `docs/plans/2026-05-26-003-feat-session-title-editing-plan.md` (rename inline input pattern), `docs/plans/2026-05-26-004-feat-session-work-in-progress-tag-plan.md` (WIP context-menu pattern)
