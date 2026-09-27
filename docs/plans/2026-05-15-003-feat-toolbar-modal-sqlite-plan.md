---
title: Toolbar, Create Workspace Modal, and SQLite Persistence
type: feat
status: active
date: 2026-05-15
origin: docs/brainstorms/2026-05-15-toolbar-modal-sqlite-requirements.md
---

# Toolbar, Create Workspace Modal, and SQLite Persistence

## Summary

Add a top-right header toolbar with a dedicated Create Workspace modal. Migrate workspace storage from JSON flat file to SQLite with automatic data migration on first startup. Session metadata remains in JSON (delegated to the Claude Code SDK for conversation state).

---

## Problem Frame

Workspace creation is currently an inline form in the top-bar tabs, competing for space with tab labels. The settings button sits isolated in the header without toolbar context. Meanwhile, the JSON flat-file store rewrites the entire file on every mutation and lacks relational integrity as the data model grows.

---

## Requirements

- R1. Top-right header toolbar with icon buttons for Create Workspace, Settings, and User Profile placeholder.
- R2. Create Workspace button opens a centered modal with name, folder path, and description fields.
- R3. Creating a workspace via modal immediately opens it in a new tab.
- R4. Workspace data persists in SQLite.
- R5. Existing JSON workspace data auto-migrates to SQLite on first startup after the change. Session metadata stays in JSON (conversation state is delegated to the Claude Code SDK).

**Origin actors:** A1 (Developer)

**Origin flows:** F1 (Create workspace)

---

## Scope Boundaries

- User Profile is a UI placeholder only — no backend auth or profile data.
- No migration rollback or JSON export tool.
- No advanced SQLite tuning (WAL mode, connection pooling).
- Chat streaming, SDK integration, and file explorer behavior are unchanged.

### Deferred to Follow-Up Work

- Schema versioning and migration framework for future model changes.
- Populating the modal with additional fields (skills, MCP servers, hooks) — currently matches the inline form's scope.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/storage/json-store.ts` — current `JsonStore` class with `list`, `get`, `create`, `update`, `delete` methods for workspaces and sessions.
- `src/server/routes/workspaces.ts` — imports `store` from `json-store.js` and calls `store.list()`, `store.create()`, etc.
- `src/server/routes/chat.ts` — imports `chatService` which delegates to `store` for session CRUD.
- `src/server/models/workspace.ts` and `src/server/models/session.ts` — TypeScript interfaces defining the data shapes.
- `src/client/App.tsx` — header layout with logo, `WorkspaceTabs`, and settings button.
- `src/client/components/WorkspaceTabs.tsx` — contains inline workspace creation form that will be removed.
- `src/client/components/SettingsPanel.tsx` — existing modal pattern for workspace settings.

### External References

- `better-sqlite3` documentation for synchronous SQLite operations in Node.js.

---

## Key Technical Decisions

- **SQLite library: `better-sqlite3`**: Synchronous API simplifies the existing async/await storage pattern with minimal change. Well-maintained, native bindings, works with ESM and TypeScript.
- **Storage interface preservation**: The new `SqliteStore` implements the same method signatures as `JsonStore`. Server routes require no changes — only the import path changes.
- **Auto-migration on construction**: When `SqliteStore` initializes, it checks for the legacy JSON file. If present, it reads workspaces, inserts them into SQLite, and renames the JSON file to `.bak`. Session metadata remains in a separate JSON file since conversation state is delegated to the SDK.
- **Single-table schema with JSON columns**: Workspace settings, skills, MCP servers, and hooks are stored as JSON text columns rather than normalized tables. This preserves the current flexible schema without requiring migrations for nested data changes.

---

## Open Questions

### Resolved During Planning

- **SQLite library choice?** `better-sqlite3` — synchronous, simple, widely used.
- **How to handle nested workspace data (settings, skills, MCP, hooks)?** Store as JSON text columns for flexibility; normalize only if query patterns later demand it.

### Deferred to Implementation

- **Exact SQL schema details** (column types, indexes) — settle when writing `SqliteStore`.
- **Modal styling specifics** — follow existing `SettingsPanel` modal patterns.

---

## Implementation Units

### U1. Add SQLite Dependency and Create SqliteStore

**Goal:** Add `better-sqlite3` to the project and create a `SqliteStore` class that mirrors `JsonStore`'s interface using SQLite.

**Requirements:** R4, R5

**Dependencies:** None

**Files:**
- Create: `src/server/storage/sqlite-store.ts`
- Modify: `package.json`
- Test: `src/server/storage/sqlite-store.test.ts` (if test framework added; otherwise manual verification)

**Approach:**
- Add `better-sqlite3` and `@types/better-sqlite3` to dependencies.
- Create `SqliteStore` class with workspace methods only: `list`, `get`, `create`, `update`, `delete`.
- Schema: `workspaces` table with columns matching `Workspace` interface (settings/skills/mcpServers/hooks as JSON text). No sessions table in SQLite.
- On construction, create tables if they don't exist.

**Patterns to follow:**
- Mirror the existing `JsonStore` method signatures exactly so routes need no changes.
- Use `JSON.stringify` / `JSON.parse` for nested object columns.

**Test scenarios:**
- **Happy path:** Creating a workspace inserts a row; listing returns it.
- **Edge case:** Getting a non-existent workspace returns `null`.
- **Edge case:** Deleting a workspace does not affect sessions (sessions remain in JSON store).
- **Integration:** `create` → `list` → `get` → `update` → `delete` chain produces expected state at each step.

**Verification:**
- `npm install` succeeds and server builds.
- Manual smoke test: create, list, update, delete workspaces and sessions through API calls.

---

### U2. Swap Server Storage and Add Auto-Migration

**Goal:** Replace `JsonStore` with `SqliteStore` in server routes and add automatic JSON-to-SQLite data migration.

**Requirements:** R4, R5

**Dependencies:** U1

**Files:**
- Modify: `src/server/routes/workspaces.ts`
- Modify: `src/server/routes/chat.ts`
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/server/index.ts` (optional: init logging)

**Approach:**
- Change workspace route imports from `../storage/json-store.js` to `../storage/sqlite-store.js`.
- Keep `chat-service.ts` and chat routes using `json-store.js` for session operations (sessions stay in JSON).
- In `SqliteStore` constructor, after table creation: check if `~/.claude-code-gui/workspaces.json` exists. If yes, read workspaces from it, insert them into SQLite, then rename the JSON file to `workspaces.json.bak`. Session data in the same JSON file is preserved separately or left in a new `sessions.json`.

**Patterns to follow:**
- Keep route handler code unchanged — only the import path changes.
- Migration should be idempotent: if SQLite already has data, skip migration even if JSON file exists.

**Test scenarios:**
- **Happy path:** Server starts with no JSON file; SQLite workspace table created empty.
- **Happy path:** Server starts with existing JSON file; workspaces appear in SQLite after startup; JSON file is renamed to `.bak`.
- **Edge case:** Server starts with JSON file and existing SQLite workspace data; migration is skipped to avoid overwriting.
- **Integration:** `/api/workspaces` endpoints return correct data after migration. Session endpoints (`/api/workspaces/:id/sessions`) continue to work via JSON store.

**Verification:**
- Existing frontend interactions (create workspace, open workspace, create session, chat) work without code changes.
- `~/.claude-code-gui/data.db` is created and contains workspace data.
- Session JSON file remains functional for session operations.
- Legacy workspace JSON file is renamed to `.bak` after migration.

---

### U3. Create CreateWorkspaceModal Component

**Goal:** Build a modal dialog for creating workspaces that replaces the inline form.

**Requirements:** R2, R3

**Dependencies:** None

**Files:**
- Create: `src/client/components/CreateWorkspaceModal.tsx`
- Modify: `src/client/stores/workspace-store.ts`

**Approach:**
- Modal structure follows `SettingsPanel.tsx`: overlay, centered card with header, form fields, and footer actions.
- Fields: Name (text, required), Folder Path (text, required), Description (text, optional).
- "Create" button is disabled until name and path are non-empty.
- On submit: call `createWorkspace` from store, then `openWorkspace` with the new ID, then close modal.
- Add `createWorkspace` return type handling in store if needed (it already returns `Promise<Workspace | null>`).

**Patterns to follow:**
- Use the same modal overlay/backdrop pattern as `SettingsPanel` (`fixed inset-0`, `bg-black/60 backdrop-blur-sm`).
- Use existing Tailwind color tokens (`bg-surface`, `border-border`, `text-text-primary`, etc.).
- Use `Plus` icon from `lucide-react` for the Create button.

**Test scenarios:**
- **Happy path:** Fill name and path, click Create → modal closes, new workspace appears in tabs and is active.
- **Happy path:** Add optional description, click Create → workspace created with description.
- **Edge case:** Click Create with empty fields → button is disabled, no API call.
- **Edge case:** Click Cancel or backdrop → modal closes without creating workspace.
- **Error path:** API returns error (e.g., duplicate name) → error message displayed in modal.

**Verification:**
- Modal opens and closes correctly.
- Workspace creation flow works end-to-end.
- Keyboard shortcuts work: Enter submits (when valid), Escape closes.

---

### U4. Create HeaderToolbar and Integrate into App.tsx

**Goal:** Add a top-right toolbar with Create Workspace, Settings, and User Profile buttons.

**Requirements:** R1, R2

**Dependencies:** U3

**Files:**
- Create: `src/client/components/HeaderToolbar.tsx`
- Modify: `src/client/App.tsx`

**Approach:**
- Create `HeaderToolbar` component that renders three icon buttons in a horizontal flex group.
- Create Workspace: `Plus` icon, opens `CreateWorkspaceModal`.
- Settings: `Settings` icon, opens existing `SettingsPanel` (moved from direct App.tsx placement into toolbar).
- User Profile: placeholder avatar circle with "D" (or user initial), no-op for now.
- Each button uses `btn-ghost` styling (p-1.5, rounded-md, hover states).
- `App.tsx` imports `HeaderToolbar` and replaces the standalone settings button with the toolbar. State for modal visibility (`showCreateModal`) moves to `App.tsx`.

**Patterns to follow:**
- Match existing header button styling (`text-text-tertiary hover:text-text-secondary hover:bg-surface-hover transition-colors`).
- Toolbar sits in the right side of the header, maintaining `justify-between` layout.

**Test scenarios:**
- **Happy path:** Click Create Workspace icon → CreateWorkspaceModal opens.
- **Happy path:** Click Settings icon → SettingsPanel opens for active workspace.
- **Edge case:** No active workspace → Settings button is disabled or hidden (match current behavior).

**Verification:**
- Toolbar renders correctly in header.
- All three buttons have correct hover/active states.
- Create Workspace and Settings flows work end-to-end.

---

### U5. Remove Inline Workspace Creation from WorkspaceTabs

**Goal:** Clean up the inline workspace creation form from `WorkspaceTabs` since it's now in the modal.

**Requirements:** R3

**Dependencies:** U4

**Files:**
- Modify: `src/client/components/WorkspaceTabs.tsx`

**Approach:**
- Remove `showCreate`, `newName`, `newPath` state and related handlers.
- Remove `createWorkspace` and `openWorkspace` from the store selectors (keep `setActiveWorkspace` and `closeWorkspace`).
- Remove the inline create form JSX.
- Keep the workspace tab pills and close buttons.
- The `Plus` button next to tabs can be removed or repurposed; since toolbar now has create, remove it entirely.

**Patterns to follow:**
- Keep tab pill styling and close behavior unchanged.

**Test scenarios:**
- **Happy path:** Workspace tabs still render and switch correctly.
- **Happy path:** Close button on tabs still works.
- **Edge case:** No open workspaces → tabs area is empty (current behavior).

**Verification:**
- WorkspaceTabs renders only tab pills, no creation UI.
- Tab switching and closing still work.
- No console errors or visual regressions.

---

## System-Wide Impact

- **Storage layer swap:** Workspace operations go through SQLite; session operations remain in JSON. The `JsonStore` class continues to handle session CRUD for chat routes.
- **Error propagation:** SQLite errors (locked database, schema issues) will surface as 500 responses from existing route error handlers.
- **State lifecycle risks:** Auto-migration writes to SQLite on first startup. If migration fails, the JSON file is not renamed, allowing retry on next startup.
- **API surface parity:** No API changes — routes, request shapes, and response shapes are unchanged.
- **Unchanged invariants:** Chat streaming logic, file explorer, session management UI, and settings panel behavior are unaffected.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `better-sqlite3` native module fails to build on user's machine | Document `npm install` requirement; fallback to `sqlite3` if build issues arise |
| Migration corrupts or loses existing JSON data | Read JSON first, validate inserts, only rename JSON after successful commit |
| SQLite file locking in dev with `tsx watch` | Use WAL mode or accept that restart may briefly lock; document if observed |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-15-toolbar-modal-sqlite-requirements.md](docs/brainstorms/2026-05-15-toolbar-modal-sqlite-requirements.md)
- Related code: `src/server/storage/json-store.ts`, `src/client/components/SettingsPanel.tsx`, `src/client/components/WorkspaceTabs.tsx`
