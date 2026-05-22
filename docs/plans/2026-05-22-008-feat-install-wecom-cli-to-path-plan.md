---
title: Install bundled WeCom CLI to user PATH
status: active
type: feat
date: 2026-05-22
origin: conversation
---

# Install bundled WeCom CLI to user PATH

## Summary

Add a one-click action that copies or symlinks the bundled `wecom` CLI from the application resources into a user-local `bin` directory (`~/.local/bin` on macOS/Linux, or an equivalent on Windows) so the user can run `wecom` from any terminal after installing the app.

---

## Problem Frame

The `@webank/wecom` CLI is already bundled with the Tauri application via `src-tauri/resources/`. It is injected into Claude Code sessions managed by the app through `WECOM_CLI_PATH`. However, a user who opens their own terminal outside the app cannot invoke `wecom` because it is not on their PATH. The app should offer a lightweight way to make the CLI globally available.

---

## Requirements

- R1. A server-side utility resolves the bundled CLI path and copies/symlinks it into a user-local binary directory.
- R2. A server endpoint exposes install and uninstall actions.
- R3. The frontend settings page shows whether the CLI is installed and offers Install / Uninstall buttons.
- R4. The installation directory is created if it does not exist.
- R5. The installation target is cross-platform (`~/.local/bin/wecom` on macOS/Linux, `%USERPROFILE%\.local\bin\wecom.exe` on Windows).

**Out of scope:**
- Modifying global system PATH (e.g. `/usr/local/bin`). User-local only.
- Auto-install on app launch. Installation is manual and opt-in.

---

## Context & Research

- `src/server/utils/resolve-wecom-cli.ts` already resolves the bundled CLI path across dev, production, and Tauri resource contexts.
- `src/server/routes/workspaces.ts` provides patterns for Express endpoints returning JSON.
- The settings page lives in the React frontend (location inferred from existing workspace settings UI).

---

## Key Technical Decisions

- **Copy instead of symlink on Windows** — Windows symlinks often require elevated privileges; a file copy is more reliable.
- **Copy on macOS/Linux too** — A copy avoids breakage when the app is moved or updated, at the cost of ~5KB disk space. If the user wants the latest CLI, they re-run Install.
- **`~/.local/bin` as the target** — Widely supported by modern shells and package managers. If it is not on the user's PATH, the UI will show a note with instructions.

---

## Implementation Units

### U1. Create CLI install utility and endpoint

**Goal:** Add a server utility that copies the bundled CLI to the user-local bin directory, and expose it via HTTP.

**Requirements:** R1, R2, R4, R5

**Dependencies:** None

**Files:**
- Create: `src/server/utils/install-wecom-cli.ts`
- Modify: `src/server/index.ts` (wire new route)
- Create: `src/server/routes/cli-install.ts`

**Approach:**
- `installWecomCli()`:
  1. Call `resolveWecomCliPath()` to find the bundled CLI.
  2. If not found, return `{ installed: false, error: 'CLI not found' }`.
  3. Determine target directory (`~/.local/bin` on macOS/Linux, `%USERPROFILE%\.local\bin` on Windows).
  4. Create the directory recursively if missing.
  5. Copy the CLI file to `wecom` (or `wecom.exe` on Windows).
  6. Make it executable on Unix (`chmod +x`).
  7. Return `{ installed: true, path: '<target>' }`.
- `uninstallWecomCli()`:
  1. Determine the same target path.
  2. If it exists, delete it.
  3. Return `{ installed: false }`.
- `checkWecomCliInstallation()`:
  1. Check if the target path exists.
  2. Return `{ installed: boolean, path?: string }`.
- Expose routes:
  - `GET /api/cli/status` → check status
  - `POST /api/cli/install` → install
  - `POST /api/cli/uninstall` → uninstall

**Test scenarios:**
- Happy path: install succeeds, file exists at target, executable bit is set.
- Happy path: uninstall removes the file.
- Edge case: CLI not bundled → install returns error.
- Edge case: target directory does not exist → created automatically.

**Verification:**
- `curl -X POST http://localhost:PORT/api/cli/install` returns `{ installed: true }` and `~/.local/bin/wecom` exists.

---

### U2. Add Install CLI section to settings UI

**Goal:** Surface the install action in the frontend so users can discover and trigger it.

**Requirements:** R3

**Dependencies:** U1

**Files:**
- Modify: frontend settings component (to be identified during implementation)

**Approach:**
- Add a new section in workspace or app settings titled "WeCom CLI".
- On mount, call `GET /api/cli/status` and show:
  - "Installed at ~/.local/bin/wecom" + Uninstall button (if installed)
  - "Not installed" + Install button (if not installed)
- On install success, show the path and a note: "Make sure ~/.local/bin is on your PATH."
- On error, show the error message.

**Test scenarios:**
- Happy path: Install button triggers POST, UI updates to show installed state.
- Happy path: Uninstall button triggers POST, UI updates to show uninstalled state.
- Error path: Install fails (e.g. CLI missing), UI shows error.

**Verification:**
- Clicking Install in the settings page creates `~/.local/bin/wecom` and updates the UI.

---

## System-Wide Impact

- The server gains a new route namespace `/api/cli/*`.
- No changes to the WeCom bot service, chat service, or sidecar build.
- The frontend settings page gains one new section.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `~/.local/bin` is not on the user's PATH | Show a clear note in the UI with shell-specific instructions. |
| Windows path handling differs | Use `process.platform` checks and `path.join` consistently. |
| Permission denied writing to target | Catch and surface the error in the UI. |

## Documentation / Operational Notes

- After installation, users may need to restart their terminal or run `hash -r` for the shell to discover the new `wecom` command.
