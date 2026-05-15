---
title: Refactor Client UI to Match Prototype Layout
type: refactor
status: active
date: 2026-05-15
origin: prototype.html
---

# Refactor Client UI to Match Prototype Layout

## Summary

Refactor the client UI layout to align with the `prototype.html` design reference. The key change is moving session management into the sidebar (alongside files) and making the chat panel permanently visible in the main area. File viewing shifts from replacing chat to a slide-out drawer or pinned side-by-side panel.

## Problem Frame

The current UI has structural friction: sessions are hidden inside a dropdown in the chat panel header, and opening a file replaces the chat entirely. The `prototype.html` reference shows a more ergonomic layout where sessions and files are peers in the sidebar, chat is always accessible, and files can be viewed alongside the conversation.

## Requirements

- **R1.** Sidebar tabs are "Sessions" and "Files" (not "Workspaces" and "Files").
- **R2.** Session list renders in the sidebar with preview text, date, and active indicator.
- **R3.** Chat panel is always visible in the main area for the active workspace.
- **R4.** File viewer appears as a slide-out drawer from the sidebar edge (overlay on chat) or as a pinned side-by-side panel.
- **R5.** Double-clicking a file attaches it to the chat context; single-click previews it.
- **R6.** Workspace creation/management remains accessible via top-bar tabs and settings.

## Scope Boundaries

### Deferred for later
- Keyboard shortcuts (already in prototype but not wired in current app).
- File attachment to chat context (UI placeholder only; backend support deferred).
- Mobile/responsive behavior refinements beyond the desktop layout.

### Outside this refactor's identity
- Changes to backend APIs or data models.
- Changes to chat streaming logic or SDK integration.
- Changes to workspace CRUD behavior.

## Context & Research

### Relevant Code and Patterns

The current layout is defined in:
- `src/client/App.tsx` — root layout with `viewedFile` state that switches between file viewer and chat.
- `src/client/components/Sidebar.tsx` — tab switcher with "Workspaces" / "Files", renders `WorkspaceList` or `FileExplorer`.
- `src/client/components/ChatPanel.tsx` — contains `SessionSelector` dropdown in its header.
- `src/client/components/SessionSelector.tsx` — dropdown-based session switcher.
- `src/client/stores/chat-store.ts` — session state and message streaming.

The `prototype.html` reference shows:
- Sidebar tab switcher: "Sessions" / "Files".
- Sessions tab: "New Session" button + scrollable session list with title, preview, date, and active dot.
- Files tab: file tree with click-to-preview, double-click-to-attach behaviors.
- File drawer: fixed-position panel sliding from the right edge of the sidebar, with Copy/Attach/Pin/Close actions.
- File panel: pinned side-by-side view between sidebar and chat.
- Chat: always in the main area, with a header showing session title and model name.

## Key Technical Decisions

- **Chat panel is permanently mounted:** The main `<main>` area always renders `<ChatPanel>`. File viewing is handled by overlay/panel components, not by replacing the main content.
- **Session list moves to sidebar:** Extract the session list rendering from `SessionSelector` into a new `SessionList` component used by `Sidebar`. `ChatPanel` header is simplified to show only the active session title and model.
- **File viewer as drawer + panel:** Support both modes — a temporary slide-out drawer (default) and a pinned side-by-side panel. State lives in `App.tsx`.
- **No new backend work:** This is a pure frontend refactor; all required data is already available through existing stores and APIs.

## Implementation Units

### U1. Extract SessionList Component and Wire Into Sidebar

**Goal:** Move session rendering from the `SessionSelector` dropdown into a sidebar-friendly list component, and update `Sidebar` to show "Sessions" / "Files" tabs.

**Files:**
- Create: `src/client/components/SessionList.tsx`
- Modify: `src/client/components/Sidebar.tsx`
- Modify: `src/client/components/ChatPanel.tsx`
- Modify: `src/client/components/SessionSelector.tsx` (remove or simplify)
- Delete: `src/client/components/WorkspaceList.tsx` (if workspace list is no longer in sidebar)

**Approach:**
- Create `SessionList` that renders sessions similarly to the prototype: title, preview, date, active dot, and click-to-switch. Include a "New Session" button at the top.
- Update `Sidebar` tabs from `('workspaces' | 'files')` to `('sessions' | 'files')`. When "Sessions" is active, render `<SessionList>`; when "Files", render `<FileExplorer>`.
- Simplify `ChatPanel` header: remove `<SessionSelector>` dropdown. Show only the active session name and model.
- `SessionSelector` can be removed or reduced to a minimal component if still needed elsewhere.

**Patterns to follow:**
- Match styling from `prototype.html` for session items (`session-item`, `active` state with accent dot).
- Reuse existing `chat-store` actions (`fetchSessions`, `createSession`, `setActiveSession`, `deleteSession`).

**Test scenarios:**
- **Happy path:** Switching sidebar to "Sessions" shows the session list. Clicking a session switches the active session and updates the chat header.
- **Happy path:** Creating a new session via the "New Session" button adds it to the list and sets it active.
- **Edge case:** Session list empty state shows a helpful message.
- **Edge case:** Deleting the active session switches focus to another available session.

**Verification:**
- Sidebar renders "Sessions" and "Files" tabs.
- Session list appears in sidebar with correct styling.
- Chat panel header no longer contains a session dropdown.

---

### U2. Refactor File Viewing Into Drawer + Panel

**Goal:** Replace the current "file replaces chat" behavior with a slide-out drawer and optional pinned side-by-side panel.

**Files:**
- Create: `src/client/components/FileDrawer.tsx`
- Create: `src/client/components/FilePanel.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/FileExplorer.tsx`

**Approach:**
- Create `FileDrawer`: a fixed-position panel that slides from the right edge of the sidebar over the chat area. Includes file name header, content display, and actions (Copy, Attach, Pin side-by-side, Close).
- Create `FilePanel`: a pinned panel between the sidebar and chat, visible when a file is "pinned". Includes the same header/actions.
- Update `App.tsx`: remove `viewedFile` state from main content switching logic. The main area always renders `<ChatPanel>`. Add `drawerFile` and `pinnedFile` state. Render `<FileDrawer>` and `<FilePanel>` as siblings when active.
- Update `FileExplorer`: change `onFileClick` to open the file drawer on single-click. Add `onFileDoubleClick` prop for future attach behavior (can be a no-op or toast for now).

**Patterns to follow:**
- Use CSS transitions for drawer slide animation (`transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)` per prototype).
- File content rendering uses the same `<pre>`/line-number approach as current `App.tsx` file viewer.

**Test scenarios:**
- **Happy path:** Clicking a file in the file explorer opens the file drawer with correct content.
- **Happy path:** Clicking "Pin" in the drawer closes the drawer and opens the side-by-side file panel.
- **Happy path:** Clicking "Close" on the pinned panel un-pins the file.
- **Edge case:** Opening a binary file shows a placeholder instead of raw bytes.
- **Edge case:** Clicking a file while another is pinned shows the drawer without affecting the pinned panel.

**Verification:**
- Chat panel is always visible when a workspace is active.
- File drawer slides in and out smoothly.
- Pinned file panel appears between sidebar and chat.
- File content displays correctly in both drawer and panel.

---

### U3. Simplify ChatPanel Header and Polish Layout

**Goal:** Clean up the `ChatPanel` header to match the prototype (session title + model name, no dropdown), and ensure the overall layout spacing is consistent.

**Files:**
- Modify: `src/client/components/ChatPanel.tsx`
- Modify: `src/client/components/MessageList.tsx`
- Modify: `src/client/App.tsx`

**Approach:**
- Replace the `ChatPanel` header: remove `<SessionSelector>` and session count. Show `chat-session-title` (active session name) and model name (from workspace settings or default).
- Ensure `MessageList` scroll container and input area match prototype proportions.
- Verify `App.tsx` layout: sidebar (`w-72`) + optional file panel (`w-96`) + flex-1 chat area. No regressions in settings modal or top bar.

**Patterns to follow:**
- Prototype styling for chat header: centered title with model name as secondary text.

**Test scenarios:**
- **Happy path:** Chat header shows the active session name.
- **Happy path:** Switching sessions updates the chat header title.
- **Integration:** Opening settings modal still works correctly from the top bar.

**Verification:**
- ChatPanel header displays session title and model name.
- Layout is visually consistent with the prototype reference.
- No console errors or visual regressions.
