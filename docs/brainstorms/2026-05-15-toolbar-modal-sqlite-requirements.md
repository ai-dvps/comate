---
date: 2026-05-15
topic: toolbar-modal-sqlite
---

# Toolbar, Create Workspace Modal, and SQLite Persistence

## Summary

Add a top-right header toolbar with a Create Workspace button that opens a dedicated modal dialog. Replace the current inline workspace creation form in the top-bar tabs. Migrate workspace and session persistence from a JSON flat file to SQLite.

---

## Problem Frame

The current workspace creation is an inline form squeezed into the top-bar tabs — it competes for space with tab labels and feels cramped. The header's settings button sits isolated without surrounding toolbar context. Meanwhile, workspace data is stored in a single JSON file (`~/.claude-code-gui/workspaces.json`), which becomes brittle as the data model grows: no querying, no relational integrity, and the entire file is rewritten on every mutation.

---

## Requirements

**Toolbar**
- R1. The top-right header area displays a horizontal toolbar with icon buttons.
- R2. Toolbar actions: Create Workspace (plus icon), Workspace Settings (gear icon), User Profile placeholder (avatar circle).
- R3. Toolbar buttons use consistent hover/active states matching the existing `btn-ghost` pattern.
- R4. Settings button opens the existing SettingsPanel modal (moved from standalone header position into the toolbar).

**Create Workspace Modal**
- R5. Clicking the Create Workspace toolbar button opens a centered modal overlay.
- R6. The modal contains fields: Workspace Name (required), Folder Path (required, text input), Description (optional).
- R7. The modal has primary "Create" and secondary "Cancel" actions.
- R8. Creating a workspace immediately opens it in a new tab and sets it active.
- R9. The inline workspace creation form in `WorkspaceTabs` is removed.

**SQLite Persistence**
- R10. Workspace and session data persist in a local SQLite database file (`~/.claude-code-gui/data.db`).
- R11. On first startup after the change, if the legacy JSON store exists, its data is auto-imported into SQLite and the JSON file is retired.
- R12. The existing storage interface (`JsonStore`) is replaced or adapted so that server routes and services require no changes.
- R13. Session table maintains its relation to workspace via `workspace_id` foreign key.

---

## Success Criteria

- A developer can click the toolbar's plus icon, fill the modal, and create a workspace without touching the tab bar.
- Existing workspaces from the JSON file appear in SQLite after the first post-migration launch.
- The server test suite (if any) or manual smoke test passes with SQLite backend.

---

## Scope Boundaries

- Deferred: Full user auth / profile backend (R2 User Profile is a UI placeholder only).
- Deferred: Migration rollback or JSON export tool.
- Deferred: Advanced SQLite features (migrations, connection pooling, WAL mode tuning).
- Outside this work: Changes to the chat streaming logic, SDK integration, or file explorer behavior.

---

## Key Decisions

- **Modal over inline form:** A dedicated modal provides room for future fields (skills, MCP, hooks) without crowding the tab bar.
- **SQLite over JSON:** SQLite gives relational integrity, atomic updates, and query capability as sessions and workspace metadata grow.
- **Auto-migration on first run:** Zero-friction upgrade for existing users; no manual export/import step.

---

## Dependencies / Assumptions

- A Node.js SQLite library is available and compatible with the project's ESM / TypeScript setup.
- The `~/.claude-code-gui` directory is writable at runtime.
- The existing `Workspace` and `ChatSession` models map cleanly to SQL table schemas.

---

## Outstanding Questions

### Deferred to Planning

- [Technical] Which SQLite library to use (`better-sqlite3`, `sqlite3`, `bun:sqlite`, etc.)?
- [Technical] Should we use a lightweight query builder or raw SQL for the storage layer?
- [Technical] How to handle schema versioning for future model changes?
