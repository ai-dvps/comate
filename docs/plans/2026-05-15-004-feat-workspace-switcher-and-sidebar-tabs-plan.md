---
title: Workspace Switcher and Sidebar Sessions/Files Tabs
type: feat
status: active
date: 2026-05-15
---

# Workspace Switcher and Sidebar Sessions/Files Tabs

## Summary

Add a workspace switcher dropdown on the left side of the header to reopen closed workspaces. Refactor the left sidebar to show tabbed navigation with a Sessions list and a Files tree, matching the `prototype.html` layout. Sessions become user-managed (visible, switchable, and explicitly creatable) rather than auto-created behind the scenes.

---

## Problem Frame

After creating a workspace it opens in a tab, but closing that tab leaves no way to reopen it. Meanwhile, chat sessions are invisible — `ChatPanel` auto-creates a "Default Session" with no UI affordance to switch, rename, or create additional sessions. The `prototype.html` shows a clear pattern: a sidebar with Sessions and Files tabs, where sessions are first-class UI elements.

---

## Requirements

**Workspace Switcher**
- R1. A button sits on the left side of the header, left of the `WorkspaceTabs`.
- R2. The button opens a dropdown overlay listing all persisted workspaces by name.
- R3. Clicking a workspace from the list opens it in a new tab.
- R4. Already-open workspaces are visually indicated in the list.
- R5. The dropdown closes on selection, Escape, or clicking outside.

**Sidebar Tabs**
- R6. The left sidebar displays tabbed navigation: **Sessions** and **Files**.
- R7. The Sessions tab lists all sessions for the active workspace (name, created-at).
- R8. Clicking a session sets it as the active session for that workspace.
- R9. The active session is visually highlighted in the list.
- R10. A "New Session" button at the top of the Sessions tab creates a new session.
- R11. The Files tab contains the existing `FileExplorer` behavior unchanged.

**Session Lifecycle**
- R12. Remove the auto-create-session logic from `ChatPanel`.
- R13. When a workspace is opened and has no sessions, show an empty state in the Sessions tab with a "New Session" prompt.
- R14. When switching workspaces, the sidebar fetches and displays that workspace's sessions.

---

## Scope Boundaries

- No backend changes — uses existing `/api/workspaces/:id/sessions` endpoints.
- No session deletion or renaming from the sidebar (deferred).
- No session search or filtering.
- File explorer behavior is unchanged beyond moving it into a tab.

### Deferred to Follow-Up Work

- Session deletion and renaming from the sidebar.
- Session search/filtering.
- Workspace reordering or pinning in the switcher dropdown.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/App.tsx` — header layout with logo, `WorkspaceTabs`, and `HeaderToolbar`. The switcher sits between the logo and tabs.
- `src/client/components/Sidebar.tsx` — currently renders `FileExplorer` directly. Will become a tabbed container.
- `src/client/components/FileExplorer.tsx` — existing file tree. Moves into the Files tab.
- `src/client/components/ChatPanel.tsx` — contains `fetchSessions`, `createSession`, and the auto-create-session useEffect that must be removed.
- `src/client/stores/chat-store.ts` — `sessions[workspaceId]`, `activeSessionIds[workspaceId]`, `fetchSessions`, `createSession`, `setActiveSession`.
- `src/client/stores/workspace-store.ts` — `workspaces`, `openWorkspace`, `activeWorkspaceId`.
- `prototype.html` — visual reference for sidebar tabs, session list styling, and layout.

---

## Key Technical Decisions

- **Tab state lives in Sidebar:** The active sidebar tab (Sessions vs Files) is local UI state, not global store state.
- **Sessions remain in chat-store:** No store refactoring needed — `chat-store` already tracks sessions per workspace and active session per workspace.
- **Auto-create removal:** `ChatPanel` no longer auto-creates sessions. The empty state and "New Session" button in the sidebar become the primary session creation path.
- **Dropdown for workspace switcher:** A compact dropdown matches the toolbar interaction model better than a modal for simple selection.

---

## Implementation Units

### U1. Refactor Sidebar with Tabbed Navigation

**Goal:** Restructure `Sidebar` to support two tabs — Sessions and Files — with the Files tab containing the existing `FileExplorer`.

**Requirements:** R6, R11

**Dependencies:** None

**Files:**
- Modify: `src/client/components/Sidebar.tsx`

**Approach:**
- Add local state `activeTab: 'sessions' | 'files'`.
- Render a tab bar at the top of the sidebar with two buttons.
- Below the tabs, conditionally render either the new Sessions content (placeholder for U2) or `FileExplorer`.
- Pass `onFileClick` and `onFileDoubleClick` through to `FileExplorer` unchanged.
- Follow `prototype.html` styling: tab buttons with `border-b-2 border-accent` for active state.

**Patterns to follow:**
- `SettingsPanel` tab pattern for the tab bar styling.
- `prototype.html` `.sidebar-tab` styling reference.

**Test scenarios:**
- **Happy path:** Sidebar renders with Sessions and Files tabs. Clicking Files shows the file tree.
- **Happy path:** Default active tab is Sessions.
- **Edge case:** No active workspace → both tabs show appropriate empty states.

**Verification:**
- Sidebar displays tab bar and switches between placeholder and FileExplorer.
- File click/double-click behavior still works in the Files tab.

---

### U2. Create SessionList Component

**Goal:** Build the Sessions tab content that lists, switches, and creates sessions.

**Requirements:** R7, R8, R9, R10

**Dependencies:** U1

**Files:**
- Create: `src/client/components/SessionList.tsx`
- Modify: `src/client/stores/chat-store.ts` (add `setActiveSession` if missing)

**Approach:**
- Read `sessions` and `activeSessionId` for the active workspace from `chat-store`.
- Render a scrollable list of session items. Each item shows the session name and creation time.
- Active session gets highlight styling (`bg-surface-active` or accent indicator).
- Clicking a session calls `setActiveSession(workspaceId, sessionId)`.
- "New Session" button at the top calls `createSession(workspaceId, 'New Session')` and sets it active.
- Empty state: when no sessions exist, show "No sessions yet" with a "Create your first session" button.

**Patterns to follow:**
- Match `prototype.html` `.session-item` styling: rounded-lg, hover state, active state with accent dot.
- Use existing Tailwind tokens.

**Test scenarios:**
- **Happy path:** Sessions list renders with names. Clicking switches active session. Chat panel updates.
- **Happy path:** Click "New Session" creates a session, adds it to the list, and sets it active.
- **Edge case:** No sessions → empty state with create button.
- **Edge case:** Switch workspaces → sidebar shows the new workspace's sessions.

**Verification:**
- Session switching updates the active session in the chat panel.
- New sessions appear in the list immediately.
- Empty state renders when appropriate.

---

### U3. Remove Auto-Create from ChatPanel and Wire Empty State

**Goal:** Remove the implicit session creation from `ChatPanel` so sessions are explicitly user-managed.

**Requirements:** R12, R13

**Dependencies:** U2

**Files:**
- Modify: `src/client/components/ChatPanel.tsx`

**Approach:**
- Remove the `useEffect` that auto-creates a "Default Session" when `sessions.length === 0`.
- Keep the `useEffect` that fetches sessions on workspace change.
- When there is no active session, the chat panel shows an empty state: "Select or create a session to start chatting" (instead of auto-creating one).
- The input area remains disabled until an active session exists.

**Patterns to follow:**
- Existing empty state pattern in `ChatPanel` (already has one for no active session).

**Test scenarios:**
- **Happy path:** Open workspace with no sessions → ChatPanel shows empty state, input disabled.
- **Happy path:** Create session via sidebar → ChatPanel shows input, messages work.
- **Edge case:** Close last session (if deletion exists later) → returns to empty state.

**Verification:**
- Opening a workspace with no sessions does not auto-create "Default Session".
- Chat input is disabled until a session is selected/created.

---

### U4. Create WorkspaceSwitcher Dropdown

**Goal:** Build the header button and dropdown for reopening existing workspaces.

**Requirements:** R1–R5

**Dependencies:** None (independent of sidebar work)

**Files:**
- Create: `src/client/components/WorkspaceSwitcher.tsx`

**Approach:**
- Button uses `LayoutGrid` or `List` icon from `lucide-react`.
- Click toggles a dropdown panel below the button.
- Dropdown lists `workspaces` from `workspace-store`. Each item shows workspace name.
- Already-open workspaces (checked via `openWorkspaceIds.includes(ws.id)`) show a checkmark.
- Clicking an item calls `openWorkspace(ws.id)` and closes the dropdown.
- Click outside or Escape closes the dropdown.

**Patterns to follow:**
- `btn-ghost` styling for the trigger.
- Dropdown panel uses `bg-surface`, `border-border`, `rounded-xl`, `shadow-lg`.
- Follow `SettingsPanel` backdrop/click-outside pattern.

**Test scenarios:**
- **Happy path:** Click button → dropdown appears → click workspace → opens in tab.
- **Edge case:** No workspaces → dropdown shows "No workspaces" placeholder.
- **Edge case:** Click already-open workspace → focuses tab, closes dropdown.
- **Edge case:** Escape and click-outside close dropdown.

**Verification:**
- Dropdown lists all workspaces.
- Selecting a workspace opens it in a tab.
- Dismissal behaviors work.

---

### U5. Integrate WorkspaceSwitcher into App.tsx Header

**Goal:** Place the workspace switcher button on the left side of the header.

**Requirements:** R1

**Dependencies:** U4

**Files:**
- Modify: `src/client/App.tsx`

**Approach:**
- Import `WorkspaceSwitcher`.
- Place it in the left flex group, between the logo block and `WorkspaceTabs`.

**Patterns to follow:**
- Keep existing `justify-between` header layout.

**Test scenarios:**
- **Happy path:** Button renders left of workspace tabs.
- **Edge case:** Responsive on narrow viewports.

**Verification:**
- Visual placement matches requirement.

---

## System-Wide Impact

- **Session lifecycle change:** Sessions are no longer auto-created. This is a user-facing behavior change — users must explicitly create sessions.
- **Sidebar real estate:** Adding tabs reduces vertical space for the file tree. The tab bar is small (~36px).
- **No API changes:** All endpoints already exist.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Removing auto-create breaks users who expect a session immediately | The empty state clearly prompts "Create your first session" |
| Sidebar tabs add cognitive load | Default to Sessions tab; files are one click away |
