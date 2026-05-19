---
date: 2026-05-19
topic: tauri-desktop-wrap-v1
---

# Tauri Desktop Wrap v1

## Summary

A desktop build of the existing Claude Code GUI using Tauri: the current React/Vite frontend runs in a WebView while the Node.js/Express backend is bundled as a sidecar process. v1 targets macOS + Windows, ships unsigned to the user and a small set of trusted people, and leaves notifications, tray residency, and Keychain integration for v1.1.

---

## Problem Frame

The existing Claude Code GUI is a web application started with `npm run dev` — it requires both a running terminal and a browser tab. This friction makes it hard to share with non-developers (even within a small circle), impossible to run without a Node environment, and fragile to port conflicts or accidental tab closure. The user wants a self-contained desktop application that can be installed and launched like any native app, without requiring recipients to install Node or know how to run servers.

---

## Actors

- A1. Dev (maintainer): the user who builds and distributes the app. Responsible for creating installers and sharing them with trusted people.
- A2. Trusted user: a non-technical friend or colleague who receives the installer and runs the app. They have Claude CLI installed and authenticated already (or are walked through setup by the dev).

---

## Key Flows

- F1. **Install and first launch**
  - **Trigger:** Trusted user downloads and opens the installer (`.dmg` or `.msi`)
  - **Actors:** A2 (user)
  - **Steps:**
    1. User mounts the `.dmg` (macOS) or runs the installer (Windows)
    2. User drags the app to Applications / clicks through install wizard
    3. User launches the app (unsigned: right-click → Open on macOS, SmartScreen bypass on Windows)
    4. App opens a single window showing the Claude Code GUI
    5. App verifies Claude CLI is configured (or surfaces a friendly error if not)
  - **Outcome:** User has a running desktop app ready to use
  - **Covered by:** R2, R3, R4, R5, R6, R9

- F2. **Day-to-day use**
  - **Trigger:** User clicks the app icon or switches to it in the dock/taskbar
  - **Actors:** A2 (user)
  - **Steps:**
    1. App window shows existing workspace
    2. User sends a message to Claude through the existing UI
    3. App streams responses via the sidecar Node process
    4. User closes the window
    5. App and sidecar process terminate cleanly
  - **Outcome:** Claude interaction is seamless and window closure ends everything
  - **Covered by:** R7, R8

---

## Requirements

**Packaging and distribution**

- R1. The Tauri app bundles the built React frontend assets into the WebView.
- R2. The Tauri app bundles the Node.js/Express backend as a sidecar process that starts when the app launches and terminates when the app quits.
- R3. The sidecar process runs on a dynamically assigned localhost port (not hardcoded) to avoid port conflicts with other local servers.
- R4. Native modules required by the backend (`better-sqlite3`) ship with prebuilt binaries for darwin-arm64, darwin-x64, and win-x64.
- R5. Distribution produces unsigned `.dmg` (macOS) and `.msi` or `.exe` installer (Windows) for manual sharing.
- R6. The app targets macOS (Apple Silicon + Intel) and Windows (x64) in v1.

**Application behavior**

- R7. The WebView loads the app at startup, either from bundled static assets or via the sidecar's served frontend, with API calls routed to the sidecar's localhost port.
- R8. Closing the application window terminates both the WebView and the sidecar process (no background lifecycle in v1).
- R9. The app detects whether Claude CLI is configured and surfaces a friendly error if credentials are missing, rather than crashing silently.

**Data and state**

- R10. Per-user application data (SQLite database and any local state) lives in the platform-standard per-user directory: `~/Library/Application Support/ClaudeCodeGUI/` on macOS and `%APPDATA%\ClaudeCodeGUI\` on Windows.
- R11. Secrets (Claude API credentials) remain stored in the user's existing Claude CLI configuration directory, not migrated to Keychain or Credential Manager in v1.
- R12. The SQLite schema and existing data model remain unchanged; no migration is needed beyond the data location change.

---

## Acceptance Examples

- AE1. **Covers R2, R3, R7.** Given a freshly launched app on macOS, when the app window appears, then the React UI loads and shows a workspace list loaded from the sidecar's `/api/workspaces` endpoint on a dynamically assigned localhost port.

- AE2. **Covers R8.** Given a running app with an active Claude session streaming, when the user clicks the red close button (macOS) or X button (Windows), then the stream terminates, the sidecar Node process exits, and the app no longer appears in the dock.

- AE3. **Covers R9, R5.** Given a trusted user on a clean machine with no Claude CLI configured, when they launch the app, then a friendly error message explains "Claude CLI must be installed and authenticated" rather than a blank screen or terminal crash.

- AE4. **Covers R10.** Given an existing dev workspace with `workspaces.db` in the project root, when the desktop app launches, then it creates and uses a fresh database in the platform's per-user directory rather than trying to use or migrate the dev-tree database.

---

## Success Criteria

- A trusted user can install and run the app on macOS or Windows without installing Node.js, running `npm install`, or opening a terminal.
- The app opens, connects to the Claude Agent SDK through the sidecar, and behaves identically to the existing `npm run dev` experience for all v1-scope features.
- The dev workflow (`npm run dev` for active development) remains completely unaffected by the existence of the Tauri build.

---

## Scope Boundaries

- Tray-resident background mode and native notifications — deferred to v1.1
- OS Keychain / Windows Credential Manager integration for secrets — deferred to v1.1
- Code signing and notarization — not needed for this audience; deferred indefinitely
- Auto-update mechanism — not needed for manual distribution
- Linux support — deferred indefinitely; only macOS + Windows in v1
- Porting the backend to Rust — deferred indefinitely; v1 uses Node sidecar
- Reimplementing Claude Agent SDK in Rust — deferred indefinitely
- Multiple workspace windows, global hotkey, deep links, URL schemes — not in v1
- Polished first-run onboarding wizard — not in v1
- Changes to the React frontend UI or UX beyond what Tauri window chrome requires — not in scope

---

## Key Decisions

- **Node sidecar over Rust port:** The cheapest path to a working desktop build is to spawn the existing Node.js/Express server as a sidecar process. A Rust port would require reimplementing SDK integration and the SQLite layer. Decision: accept the ~50MB binary size impact and revisit if pain materializes in v1.1.
- **Window-resident over tray-resident:** Closing the window quits the app in v1. This intentionally defers notifications and Keychain to v1.1, since both features pair naturally with a background process.
- **Unsigned over signed:** The audience is the user plus trusted people who will right-click → Open or bypass SmartScreen. Signing and notarization costs are deferred.
- **Per-user data directory over dev-tree data (always separate):** Shipped installs must not read/write from the project tree. The desktop app and the dev-tree instance each have independent databases. A fresh per-user directory is used for the desktop install, leaving existing dev data untouched.

---

## Dependencies / Assumptions

- Trusted users have Claude CLI installed and authenticated (the SDK depends on this).
- `better-sqlite3` prebuilt binaries exist for all target platforms (darwin-arm64, darwin-x64, win-x64).
- The current Express server's CORS configuration will work when the WebView loads from a `tauri://` or `http://localhost` origin against the sidecar's `http://localhost` origin.
- Tauri's sidecar capability supports spawning a Node.js process and terminating it on app exit.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Technical] How are native modules (`better-sqlite3`) packaged for the sidecar — bundled into node_modules, or standalone via `pkg`/`nexe`? Evaluate which produces a smaller, more reliable bundle.
- [Affects R2, R7][Technical] Does the frontend connect to the sidecar via Tauri's asset protocol (bundled static files) or does the sidecar serve both frontend + API? The latter is simpler but means two localhost origins; the former is more idiomatic Tauri but needs CORS tweaks.
- [Affects R9][Needs research] Can the app detect a missing Claude CLI configuration gracefully, or does the SDK crash on import before detection is possible?
