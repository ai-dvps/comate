---
title: Workspace Switcher Search and Pin - Plan
type: feat
date: 2026-07-10
topic: workspace-switcher-search-pin
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Workspace Switcher Search and Pin - Plan

## Goal Capsule

- **Objective:** Make it fast to find and open a workspace when the workspace switcher contains many items, by adding search and a local pin-to-top feature.
- **Product authority:** This builds on the existing `WorkspaceSwitcher` component and the deferred pinning/reordering item from `docs/plans/2026-05-15-004-feat-workspace-switcher-and-sidebar-tabs-plan.md`.
- **Execution profile:** Software implementation — frontend UI changes in the desktop client.
- **Stop condition:** Users can search workspace names and pin commonly used workspaces to the top of the switcher; state persists across app restarts.
- **Tail ownership:** Client-side feature ownership stays with the Comate maintainers.
- **Product Contract preservation:** Product Contract unchanged.

## Product Contract

### Summary

Add a search box and a local pin-to-top feature to the workspace switcher. Pinned workspaces float to the top of a single flat list and display a pin icon; users pin and unpin via an icon that appears on hover. Search auto-focuses when the switcher opens and filters workspace names case-insensitively. Pin state is stored as a local user preference and does not sync across devices.

### Problem Frame

The workspace switcher currently lists every workspace in one scrollable panel. Users with a dozen or more workspaces must scroll and rely on memory to locate the one they want. There is no way to narrow the list or keep frequently used workspaces within immediate reach. This adds friction to a high-frequency action — switching context between projects.

### Requirements

#### Search

R1. The workspace switcher popover includes a text search input positioned above the workspace list.
R2. The search input receives focus automatically when the popover opens.
R3. Search filters workspaces by name using case-insensitive substring matching.
R4. When the search query is empty, the full workspace list is shown in its existing order.
R5. When the search query is non-empty, only workspaces whose names contain the query are shown.
R6. The search query is cleared when the popover closes.
R7. Pressing `Escape` while the search input is focused clears the query; pressing `Escape` again closes the popover.

#### Pinning

R8. Each workspace row reveals a pin icon on hover.
R9. Clicking the pin icon toggles the pinned state of that workspace.
R10. Pinned workspaces are sorted to the top of the list, preserving their relative order among pinned items.
R11. Unpinned workspaces appear below pinned workspaces, preserving their existing relative order.
R12. A pin icon is shown on pinned rows even when the row is not hovered.
R13. A pinned workspace that does not match the search query is hidden like any other non-matching workspace.

#### Persistence and lifecycle

R14. Pin state is persisted as a local user preference and survives app restarts.
R15. Pin state is scoped to the current user profile and does not sync across devices or installations.
R16. When a workspace is deleted, its pin entry is removed so the preference does not accumulate stale entries.
R17. Pinned workspaces have no explicit count limit.

#### Empty and feedback states

R18. When no workspaces match the search query, the switcher shows a "No matching workspaces" message.
R19. The existing "No workspaces yet" empty state remains unchanged when the user has no workspaces.

### Key Decisions

- **Compact flat list with hover-revealed pin icon.** A single list keeps the switcher visually light at the target scale of about a dozen workspaces. The pin icon appears only on hover so unpinned rows stay uncluttered; pinned rows still show the icon for recognition.
- **Pin state as local user preference, not workspace property.** Workspaces are local to the machine and the user, so storing pins locally matches the product model without adding server-side changes or affecting shared workspace data.
- **Search filters all workspaces, including pinned ones.** Search is treated as a find operation; pinned items that do not match the query are hidden. This keeps the filtered list short and avoids giving pinned items permanent visibility that would undermine search.

### Scope Boundaries

#### Deferred for later

- Pin order affecting the workspace tab bar order.
- Searching by workspace folder path or description.
- Cross-device or cross-profile synchronization of pinned state.
- Drag-to-reorder workspaces within the switcher.
- Keyboard-only pinning shortcut or context-menu alternative.

#### Outside this product's identity

- Server-side persistence of pin state.
- Workspace-level settings that all users of a workspace would see.

### Dependencies / Assumptions

- A local storage mechanism equivalent to `localStorage` is available to the React client.
- The existing `WorkspaceSwitcher` popover structure remains the container for this feature.
- New user-facing strings are added to both English and Chinese (`zh-CN`) `settings` namespaces.

### Acceptance Examples

- AE1. **Search narrows the list.** A user with workspaces named "claude-code-gui", "comate-website", and "playground" opens the switcher, types "claude", and only "claude-code-gui" remains visible.
- AE2. **Pin moves a workspace to the top.** The user hovers over "playground" and clicks the revealed pin icon; "playground" immediately moves above all unpinned workspaces.
- AE3. **Pinned state survives restart.** After pinning "comate-website", the user quits and reopens Comate; "comate-website" still appears at the top of the switcher.
- AE4. **Deleted workspace does not leave stale pin state.** The user pins "old-project", then deletes "old-project"; the pin preference for "old-project" is removed.
- AE5. **Pinned non-matches are hidden by search.** The user pins "comate-website" and searches "claude"; "comate-website" is hidden because it does not match the query.

---

## Planning Contract

### Key Technical Decisions

- **Dedicated localStorage-backed pin hook, not `useAppSettings` or server state.** Pin state is unrelated to general app settings and is local to the machine. A small hook following the `useResizableWidth` / `useAppSettings` shape keeps the logic isolated and testable without widening the app-settings schema or adding server fields. Stores an ordered array of workspace ids so pin order is preserved (R10).
- **Filter first, then sort pinned to top.** The visible list is derived in two steps: filter all workspaces by the trimmed, lowercased query against `name`, then order so pinned ids (in stored order) lead and unpinned ids follow, each group keeping the store's existing order. Filtering first guarantees R13 (pinned non-matches are hidden).
- **Search state resets when the popover closes.** A local `searchQuery` resets to empty whenever `isOpen` flips false, so each open starts clean (R6). Auto-focus is handled by focusing the input when the popover opens, working with Radix's focus management rather than fighting it.
- **Stale pins are pruned when the workspace list changes.** A `useEffect` keyed on the workspace id set drops pinned ids that no longer exist, satisfying R16 and AE4 without hooking into the delete action directly. The hook stays decoupled from the store.

### Assumptions

- The popover uses the existing Radix-based `Popover` primitive; focusing the search input on open will coordinate with Radix's default focus behavior.
- The store's existing workspace order is the baseline for unpinned items; this plan does not introduce a new default sort.

---

## Implementation Units

### U1. Workspace pin preference hook

**Goal:** Provide a localStorage-backed hook exposing the ordered set of pinned workspace ids, a toggle, and a prune helper.

**Requirements:** R10, R14, R15, R16, R17

**Dependencies:** None

**Files:**
- Create: `src/client/hooks/use-workspace-pins.ts`
- Create: `src/client/hooks/use-workspace-pins.test.ts`

**Approach:**
- Storage key `workspace-pins`; value is a JSON array of workspace ids in pin order.
- `useState` initializer reads and parses the key; corrupt or missing data falls back to `[]`.
- Expose `pinnedIds`, `isPinned(id)`, `togglePin(id)` (adds to end if absent, removes if present), and `prunePins(validIds)` (drops ids not in the valid set, preserving order of the survivors).
- Every mutation writes the next array back to `localStorage`, guarded against storage errors like `useResizableWidth`.

**Patterns to follow:** `src/client/hooks/use-resizable-width.ts` for the `useState` + `localStorage` shape and storage-error guards.

**Test scenarios:**
- **Happy path:** `togglePin('a')` adds `a` to the end; `togglePin('b')` appends `b`; `pinnedIds` returns `['a','b']` in order; `togglePin('a')` removes `a`.
- **Happy path:** `isPinned` reflects membership; `localStorage` is updated after each toggle.
- **Edge case:** corrupt JSON in storage initializes to `[]` without throwing.
- **Edge case:** `togglePin` for an id already present is idempotent and does not duplicate entries.
- **Integration:** `prunePins(['b'])` removes `a` and keeps `b`; surviving order is preserved.

**Verification:** Hook unit tests pass; reading `localStorage['workspace-pins']` after toggles shows the expected id array.

### U2. Search and pin UI in WorkspaceSwitcher

**Goal:** Add the search box and per-row pin toggle to the switcher popover, with auto-focus, reset-on-close, and stale-pin pruning.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R16, R18, R19; AE1, AE2, AE4, AE5

**Dependencies:** U1 (uses `use-workspace-pins`), U3 (uses the new i18n keys)

**Files:**
- Modify: `src/client/components/WorkspaceSwitcher.tsx`
- Modify: `src/client/components/WorkspaceSwitcher.test.tsx`

**Approach:**
- Add `searchQuery` state reset to `''` when `isOpen` becomes false; focus the input on open via Radix popover focus handling.
- Render the search row above the list: `Search` icon on the left, input, and an `X` clear button shown only when the query is non-empty — mirroring `SessionList` markup and styling tokens.
- Derive the visible list by filtering all workspaces by trimmed, lowercased query against `name`, then ordering pinned ids (in `pinnedIds` order) before unpinned ids, each group keeping store order.
- Each row adds a pin icon at the right of the existing indicator group: always visible on pinned rows, revealed on hover (`group-hover`) on unpinned rows. Clicking the pin icon calls `togglePin(id)` with `stopPropagation` so it does not select the workspace.
- `Escape` in the input clears the query when non-empty; otherwise Radix closes the popover.
- Add a `useEffect` keyed on the workspace id set that calls `prunePins(allWorkspaceIds)` to drop stale pins.
- Empty states: when `workspaces.length > 0` but the visible list is empty, show the "no matching" message; keep the existing "no workspaces yet" state unchanged.

**Patterns to follow:** `src/client/components/SessionList.tsx` for the search input, clear button, and `Escape`-to-clear behavior.

**Test scenarios:**
- Covers AE1. **Happy path:** typing `claude` leaves only the matching workspace visible.
- Covers AE2. **Happy path:** clicking a row's pin icon moves that workspace above unpinned workspaces and shows its pin icon without hover.
- Covers AE5. **Search behavior:** a pinned workspace whose name does not match the query is hidden.
- **Happy path:** the clear button empties the query and restores the full list.
- **Edge case:** the query resets to empty after the popover closes and reopens.
- **Edge case:** clicking the pin icon does not call `openWorkspace` (stopPropagation).
- **Edge case:** when no workspaces match the query, the "no matching" message renders instead of the list.
- Covers AE4. **Integration:** removing a pinned workspace from the store list drops it from `pinnedIds` via the prune effect.

**Verification:** jsdom tests pass; manual check that hover reveals the pin icon, search auto-focuses on open, and pinned state persists across an app restart (AE3).

### U3. i18n strings for search and pin

**Goal:** Add the English and Chinese strings the switcher needs for search and pinning.

**Requirements:** R1, R18; supports the Dependencies / Assumptions i18n note

**Dependencies:** None

**Files:**
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:** Under the existing `workspaceSwitcher` key, add `searchPlaceholder`, `clearSearch`, `noMatchingWorkspaces`, `pinWorkspace`, and `unpinWorkspace` in both locales.

**Test scenarios:** Test expectation: none — string-only change; WorkspaceSwitcher tests in U2 assert via the resolved keys.

**Verification:** Keys resolve in both `en` and `zh-CN` with no missing-key warnings when the switcher renders.

---

## Verification Contract

- **Component and hook tests:** `npm run test:client` covers `use-workspace-pins.test.ts` and `WorkspaceSwitcher.test.tsx`, including the AE-linked scenarios above.
- **Lint:** `npm run lint` passes with no new warnings.
- **No server or browser tests** — the change is client-only and jsdom-coverable.
- **Manual smoke:** open the switcher, search for a known workspace, pin a workspace, restart the app, and confirm the pin and ordering persist (AE3).

---

## Definition of Done

- R1–R19 are satisfied and traceable to U1–U3.
- AE1, AE2, AE4, and AE5 are covered by jsdom tests in U1 and U2; AE3 is covered by the manual restart smoke in the Verification Contract.
- `npm run test:client` and `npm run lint` both pass.
- Both `en` and `zh-CN` `settings.json` include the new `workspaceSwitcher` keys.
- Deleting a pinned workspace removes its pin entry (no stale state).
- Abandoned or experimental code from implementation attempts is removed before the change is considered complete.
