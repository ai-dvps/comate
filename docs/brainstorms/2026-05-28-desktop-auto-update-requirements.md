---
date: 2026-05-28
topic: desktop-auto-update
---

# Desktop Auto-Update

## Summary

A built-in auto-updater for the Comate desktop app that checks GitHub Releases for new versions on startup, downloads updates in the background, and prompts the user to install and restart. This eliminates the current manual distribution workflow where users receive packages via IM and must uninstall and reinstall for every release.

---

## Problem Frame

Comate is currently distributed manually — the developer sends install packages via IM, and users uninstall the old version before installing the new one. This is high friction for both sides: the developer must remember to notify everyone and transfer files, while users must interrupt their work to manually replace the application. As Comate moves toward broader distribution beyond the internal team, this scale breaks. An in-app auto-updater reduces distribution friction to near-zero and ensures users stay on current versions without manual intervention.

---

## Actors

- A1. End user: Runs the Comate desktop application and interacts with update prompts.
- A2. GitHub Releases: Hosts versioned application binaries and a static update manifest.
- A3. Tauri updater runtime: Performs background version checks, downloads, and installation orchestration.

---

## Key Flows

- F1. Startup update check
  - **Trigger:** User launches the Comate desktop app
  - **Actors:** A1, A2, A3
  - **Steps:**
    1. App starts and initializes the update checker
    2. Updater fetches the latest version metadata from GitHub Releases
    3. If the fetched version is newer than the running version, the updater signals availability
    4. UI shows a non-intrusive notification that an update is available
    5. If no update is available, the flow completes silently
  - **Outcome:** User is aware of available updates without being blocked from using the app
  - **Covered by:** R1, R2, R3

- F2. Download and install update
  - **Trigger:** User clicks "Update" or "Install" on the update notification
  - **Actors:** A1, A2, A3
  - **Steps:**
    1. Updater begins downloading the new version in the background
    2. UI shows download progress
    3. Download completes and the updater stages the new version
    4. App prompts the user to restart to complete installation
    5. User confirms restart; app shuts down, installs the update, and relaunches
  - **Outcome:** App is running the new version after restart
  - **Covered by:** R4, R5, R6

- F3. User defers update
  - **Trigger:** User dismisses the update notification or clicks "Later"
  - **Actors:** A1
  - **Steps:**
    1. User dismisses the update prompt
    2. App continues normal operation
    3. Update remains available and will be re-presented on the next check (startup or periodic poll)
  - **Outcome:** User stays on the current version; update is not forgotten
  - **Covered by:** R7

---

## Requirements

**Update discovery**
- R1. On application startup and periodically while running, the app checks GitHub Releases for a newer version.
- R2. The version check must not block the main application from loading or functioning.
- R3. If a newer version exists, the app shows a non-blocking notification to the user.

**Download and installation**
- R4. The user can initiate the download from the update notification.
- R5. While downloading, the app shows visible progress to the user.
- R6. After download completes, the app prompts the user to restart to install the update.

**User control**
- R7. The user can dismiss or defer the update notification without installing.
- R8. The user can check for updates manually via a menu or settings action, in addition to the automatic startup check.

**Error handling**
- R9. If the version check fails (network error, unreachable manifest), the app fails silently and does not show an error to the user.
- R10. If a download fails, the app surfaces an actionable error message and allows the user to retry.

**Platform support**
- R11. The updater works on macOS, Windows, and Linux.
- R12. The periodic background check runs at a reasonable interval and does not degrade performance or battery life.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3.** Given the user launches Comate v0.0.1 and GitHub Releases has v0.0.2, when the app starts, the main window loads immediately and a "Update available: v0.0.2" banner appears.
- AE2. **Covers R4, R5, R6.** Given an update is available and the user clicks "Update Now," when the download completes, a "Restart to install" dialog appears and the user can confirm to restart.
- AE3. **Covers R7.** Given an update notification is visible, when the user clicks "Later," the notification dismisses and the app continues normal operation.
- AE4. **Covers R9.** Given the user has no network connection, when the app starts, no update error is shown and the app functions normally.

---

## Success Criteria

- Users no longer need to manually uninstall and reinstall Comate to receive updates.
- A user on an old version sees an update prompt within one app launch of a new release being published.
- The implementer can verify the updater works by publishing a test release and observing the update flow end-to-end.

---

## Scope Boundaries

- Silent automatic installation without user consent — updates always prompt the user before installing.
- Delta/patch updates — the updater downloads full binaries, not incremental patches.
- Two-tier updates where the Node.js sidecar updates independently of the Tauri shell.
- Distribution via OS package managers (Homebrew, WinGet, etc.) as a primary channel.
- Automatic rollback to previous versions if the new version fails.
- Update scheduling (e.g., "install tonight").

---

## Key Decisions

- Use Tauri's built-in updater plugin rather than a custom update mechanism — it is the standard, well-supported path for Tauri v2 and handles cross-platform complexity.
- Host update manifests and binaries on GitHub Releases — the repository is already public and this avoids additional infrastructure cost.
- User-prompted installation over silent background updates — respects user control, especially important while the app is gaining trust with a broader audience.
- Periodic background checks in addition to startup — ensures users discover updates without needing to restart the app.

---

## Dependencies / Assumptions

- GitHub Releases will be used as the update source with a static JSON manifest.
- Release binaries must be built and attached to GitHub Releases for the updater to function.
- On macOS and Windows, code-signed binaries are assumed to be in place or treated as a fast-follow to avoid Gatekeeper/SmartScreen friction.

---

## Outstanding Questions

### Resolve Before Planning

_No blocking questions remain._

### Deferred to Planning

- [Affects R1][Technical] What is the exact update JSON format and endpoint URL pattern for GitHub Releases?
- [Affects R6][Needs research] Does Tauri's updater support a "restart and install" flow out of the box, or does the app need custom restart logic?
