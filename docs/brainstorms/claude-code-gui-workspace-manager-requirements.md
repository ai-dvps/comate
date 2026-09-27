---
date: 2026-05-15
topic: claude-code-gui-workspace-manager
---

# Claude Code GUI Workspace Manager

## Summary

A personal workspace manager and GUI for Claude Code, built as a Node.js local web server with a browser-based interface. The MVP delivers folder-backed workspace management with file explorer, multi-session chat via the Claude Code TypeScript SDK, and tabbed navigation across workspaces. A Tauri desktop wrapper and third-party integrations are deferred.

---

## Problem Frame

Developers using Claude Code across multiple projects face friction when switching context. Each project requires different settings (API keys, model preferences), installed skills, MCP servers, and hooks. The Claude Code CLI operates in a single directory at a time; moving between projects means exiting, changing directories, and re-establishing context. Session history exists but is not organized by project, making it hard to resume work or compare conversations across codebases. There is no persistent workspace concept that remembers per-project configuration, and no GUI for visual navigation of files alongside chat.

---

## Actors

- A1. Developer: The individual using the app to manage Claude Code workspaces across multiple local projects.

---

## Key Flows

- F1. Create workspace
  - **Trigger:** Developer clicks "New Workspace"
  - **Actors:** A1
  - **Steps:**
    1. Developer selects a local folder path via file picker
    2. Developer optionally edits workspace name and description
    3. Developer optionally configures Claude Code settings (model, API key, etc.)
    4. Developer optionally registers installed skills, MCP servers, and hooks
    5. Workspace is saved and appears in the workspace list
  - **Outcome:** A new workspace entry exists and can be opened in a tab
  - **Failure path:** If the selected folder is inaccessible or already associated with a workspace, display an error and abort
  - **Covered by:** R1, R2, R3, R4, R6

- F2. Open workspace and start chat
  - **Trigger:** Developer opens a workspace tab
  - **Actors:** A1
  - **Steps:**
    1. Workspace loads its persisted settings
    2. File explorer populates with the workspace folder structure
    3. Developer creates a new session or selects an existing one
    4. Developer sends a message via the chat interface
    5. Response streams back through the Claude Code TypeScript SDK
  - **Outcome:** Developer is in an active chat session within the workspace context
  - **Failure path:** If the SDK connection fails, display an error state in the chat panel
  - **Covered by:** R5, R7, R8, R10, R11, R12, R13

- F3. Switch between workspace tabs
  - **Trigger:** Developer clicks a different workspace tab
  - **Actors:** A1
  - **Steps:**
    1. Current workspace state is preserved
    2. Selected workspace becomes active
    3. File explorer updates to the selected workspace's folder
    4. Sessions from the selected workspace are displayed
  - **Outcome:** Developer is now in the context of a different project
  - **Covered by:** R5, R6, R12

---

## Requirements

**Workspace Management**
- R1. Developer can create a workspace by selecting a local folder path.
- R2. Each workspace has an editable name and description.
- R3. Each workspace stores Claude Code settings (e.g., model selection, API configuration).
- R4. Each workspace tracks its installed skills, MCP servers, and hooks.
- R5. Multiple workspaces can be open simultaneously in tabs.
- R6. Workspace configuration persists across app restarts.

**Session & Chat**
- R7. Each workspace supports multiple concurrent Claude Code sessions.
- R8. Chat is implemented via the Claude Code TypeScript SDK.
- R9. Session history is delegated to and managed by the Claude Code SDK.
- R10. Developer can create, name, and switch between sessions within a workspace.
- R11. Chat messages are streamed in real-time.

**File Explorer**
- R12. File explorer displays the workspace folder structure.
- R13. Developer can navigate directories and view file contents.
- R14. File explorer is read-only in the MVP.

---

## Success Criteria

- Developer can create two workspaces for different projects, switch between them in tabs, and each workspace retains its own settings and session list.
- A new developer can set up a workspace and start a chat session within 2 minutes.
- Session history for each workspace is accessible and delegates correctly to the SDK.
- The app runs locally without requiring external hosting.

---

## Scope Boundaries

### Deferred for later

- Tauri desktop application wrapper.
- Integrations with third-party services.
- IM connectivity (Slack, Discord, etc.).
- External triggers (webhooks, API calls from other systems).
- Write operations in the file explorer (create, edit, delete files).
- Multi-session concurrency limits or resource management.

### Outside this product's identity

- Multi-user or team collaboration features.
- Hosted or cloud-deployed version.
- Mobile interface.
- Advanced IDE features (code editing, debugging, linting, version control UI).
- Full replacement of the Claude Code CLI — the app is an alternative interface, not a superset.

---

## Key Decisions

- **Node.js runtime:** The user specified Node.js as the target platform, aligning with the Claude Code TypeScript SDK ecosystem.
- **Local web server + browser GUI:** Chosen over desktop-first to enable rapid iteration and a clear path to Tauri wrapping without rewriting the UI layer.
- **Tauri for desktop wrapper:** Explicit user preference over Electron, leveraging Rust-based native performance with a webview UI.
- **Session history delegates to SDK:** Rather than building a parallel history store, the app relies on the Claude Code SDK's native session management.
- **Single-user, no auth:** The personal power tool framing means multi-user features are out of scope, simplifying the product architecture.

---

## Dependencies / Assumptions

- The Claude Code TypeScript SDK exposes sufficient APIs for multi-session chat, history retrieval, and workspace-scoped configuration.
- The target developer's machine can run a local Node.js server and a modern browser.
- Claude Code CLI does not introduce equivalent built-in workspace management in the near term, which would reduce the app's differentiation.

---

## Outstanding Questions

### Resolve Before Planning

- None at this time.

### Deferred to Planning

- [Needs research] What specific Claude Code SDK APIs are available for session management and history access?
- [Technical] How should workspace settings map to SDK configuration options?
- [Technical] Should the local server use a specific port, and how should port conflicts be handled?
