---
date: 2026-05-23
topic: system-tray-background-mode
---

# System Tray and Background-Running Mode

## Summary

Add a system tray entry (menu bar item on macOS, taskbar tray on Windows, status notifier on Linux) so the user can close the main window without quitting the application. The sidecar Node process keeps running in the background — WeCom bot stays reachable, in-flight Claude sessions keep streaming, and reopening the window is instant because nothing has to cold-start. The tray menu exposes "Open Claude Code GUI", a small read-only status line, and "Quit". On macOS, the Dock icon hides when the window is closed so the app behaves as a background utility; the tray is then the only re-entry point. Every fresh app launch unconditionally shows the window.

---

## Problem Frame

Today the app's only window is the `main` window declared in `src-tauri/tauri.conf.json`. Closing it terminates the Tauri process and tears down the `sidecar-node` child along with it. Three things break the moment the user clicks the red close button:

1. **WeCom bot stops receiving.** The bot is implemented in the Node sidecar; once the sidecar dies, incoming WeCom messages have nowhere to land.
2. **In-flight Claude sessions abort.** A streaming agent response, a long tool call, or any session runtime owned by `ChatService` dies mid-stream.
3. **Reopen is slow.** Cold-starting the sidecar, rehydrating SQLite, and rebuilding the React surface costs noticeable time on each open.

The user wants a "close to tray, not quit" model: the window is dismissible, but the work the app is doing keeps doing it. Quitting must still be possible, but it should be a deliberate act through the tray, not a side-effect of closing the window.

---

## Requirements

**Tray presence**

- R1. The application MUST register a system tray icon on macOS, Windows, and Linux (the three OSes the build already targets per `src-tauri/tauri.conf.json` bundle targets).
- R2. The tray icon MUST be present whenever the application is running, including when the main window is visible. It is not a "shown only while hidden" indicator.
- R3. Clicking (left-click on macOS/Linux, left-click on Windows) the tray icon MUST open or focus the main window. Right-clicking opens the menu (this is the OS-native pattern; macOS treats left-click as the menu trigger on the menu bar, which is acceptable).

**Window close behavior**

- R4. Clicking the main window's OS close control (red traffic-light on macOS, X on Windows/Linux) MUST hide the window instead of quitting the application. The Tauri process and the `sidecar-node` child MUST keep running.
- R5. Cmd-W / Ctrl-W (close window) MUST behave the same as clicking the close control: hide the window, do not quit.
- R6. On macOS, hiding the main window MUST also hide the Dock icon (NSApplicationActivationPolicyAccessory). Showing the window again MUST restore the Dock icon (NSApplicationActivationPolicyRegular).
- R7. Hiding the window MUST NOT terminate or pause any active session runtimes, the WeCom bot listener, or the sidecar process. State carries through transparently.

**Reopening the window**

- R8. Selecting "Open Claude Code GUI" in the tray menu MUST show, focus, and bring to front the main window. If the window is already visible but not focused, it MUST be brought to front.
- R9. Reopening the window MUST be visibly instant on a warm process — no perceptible delay from sidecar restart, SQLite reopen, or full UI rehydration. The DOM state from before the hide MAY be preserved; if not preserved, the reopen still completes within ~300ms because the sidecar and HTTP layer are already up.

**Tray menu**

- R10. The tray menu MUST contain exactly these items, in this order:
  1. "Open Claude Code GUI" (action)
  2. A read-only status line for the WeCom bot, e.g. "WeCom bot: connected" or "WeCom bot: not configured" (no action, no submenu)
  3. A read-only active-session count, e.g. "Active sessions: 2" (no action)
  4. Separator
  5. "Quit Claude Code GUI" (action)
- R11. The status line in R10.2 MUST reflect whether the workspace user has configured a WeCom bot and whether the bot's SSE subscription is currently live. It MAY update on a coarse schedule (poll every ~5s) — real-time push is not required.
- R12. The active-session count in R10.3 MUST reflect the number of `SessionRuntime` instances currently owned by `ChatService` across all workspaces. Same update cadence as R11 is acceptable.
- R13. Selecting "Quit Claude Code GUI" MUST cleanly shut down session runtimes, terminate the sidecar, and exit the Tauri process. This is the only path to fully quit the app once the user has hidden the window.

**Launch behavior**

- R14. Every fresh launch of the application (including launch-after-quit) MUST start with the main window visible and the Dock icon visible. The hidden-to-tray state from a previous session MUST NOT persist across full quits.
- R15. Launch-at-login is NOT in scope for this feature.

**Lifecycle and safety**

- R16. If the user attempts to quit via OS-level mechanisms while the window is hidden (Cmd-Q on macOS while the app has focus, "End Task" on Windows, kill signals on Linux), the app MUST follow the same clean shutdown path as the tray "Quit" item (R13). It MUST NOT silently leak the sidecar or session runtimes.
- R17. The sidecar's existing crash/recovery behavior MUST continue to work while the window is hidden. If the sidecar dies, the next "Open" action SHOULD either show the window with an error state or restart the sidecar — current behavior MAY be preserved as-is; no new recovery work is required.

---

## Acceptance Examples

- AE1. **Covers R4, R6, R7.** Given a WeCom bot is configured and actively receiving messages, when the user clicks the macOS close button on the main window: the window disappears, the Dock icon disappears, the menu bar tray icon remains, and incoming WeCom messages continue to be processed (verified by sending a test message from WeCom and seeing it land in the chat history after reopening).
- AE2. **Covers R8, R9.** Given the app is running with the window hidden, when the user clicks the tray icon and selects "Open Claude Code GUI": the window appears within ~300ms, the Dock icon reappears on macOS, the workspace and session previously selected are still active, and any chat messages received while hidden are present in the session.
- AE3. **Covers R10, R11, R12.** Given the user opens the tray menu, the menu shows "Open Claude Code GUI", a WeCom status line reflecting the actual configured/connected state, a session count matching the number of live SessionRuntime instances, a separator, and "Quit Claude Code GUI" — in that order.
- AE4. **Covers R13.** Given the window is hidden and a session is streaming, when the user selects "Quit Claude Code GUI" from the tray menu: the session runtime stops cleanly, the sidecar exits, and `ps aux | grep sidecar-node` shows no residual process.
- AE5. **Covers R14.** Given the user previously quit-to-tray (window closed, app still running) and then selected "Quit", when they relaunch the app: the main window appears immediately, the Dock icon is visible, and there is no tray-only "ghost" launch.

---

## Success Criteria

- A WeCom user sending a message to the bot gets a response whether or not the GUI window is open. The window's visibility is decoupled from the app's functional liveness.
- An in-flight chat session that the user started, then closed the window on, then reopened minutes later still shows the streaming response (or the completed response if it finished while hidden) without any "session lost" surface.
- Reopening the window from the tray feels instant — no spinner, no reconnect message, no visible cold-start cost.
- The user always has exactly one obvious way to fully quit the app while the window is hidden: the tray's "Quit Claude Code GUI" item.
- On macOS, the app does not leave a stale Dock icon when hidden, and does not leave the user unable to find the app when they want it back.
- `ce-plan` can pick up this document without inventing menu items, choosing between close-to-tray vs. minimize-to-tray, or guessing whether the Dock should hide.

---

## Scope Boundaries

- **Launch-at-login** (start the app silently when the OS boots) — not part of this feature.
- **Tray controls beyond Open/Quit** (e.g., "Pause WeCom bot", "Mute notifications", "New chat") — explicitly rejected; tray stays minimal.
- **Native OS notifications / badges** (unread count on the tray icon, banner on new message) — separate feature.
- **Per-OS tray icon theming** (light vs. dark menu bar, monochrome template icon variants) — best-effort using whatever icon ships today; visual polish can come later.
- **Persisting the hidden-to-tray state across quits** — explicitly rejected; every launch starts with the window visible.
- **Multi-window support** (a second main window from the tray) — not in scope. There is one main window; the tray opens or focuses it.
- **A "Show in Dock / Hide from Dock" user setting on macOS** — not configurable in this feature; hiding the Dock when the window is hidden is the fixed behavior.
- **Tray menu localization** — out of scope; the app is currently English-only.

---

## Key Decisions

- **Close-to-tray, not minimize-to-tray.** Pressing the OS close control hides the window; the minimize button retains its OS-native minimize behavior (dock/taskbar). This matches Slack, Discord, and 1Password, and avoids the surprise of "where did my minimize go?"
- **Sidecar lives independent of the window.** The Tauri process owns the sidecar; the window is just one consumer of it. Hiding the window does not signal anything to the sidecar.
- **macOS Dock hides when window is hidden.** Makes the app feel like a background utility while hidden, and avoids a misleading "click the Dock icon to open" affordance when clicking the Dock won't show a window. The tray is the single re-entry point in that mode.
- **Tray is always present, even when the window is visible.** Avoids the "where did the tray go" failure mode and gives the user a consistent place to find Quit.
- **Read-only status in the menu, not interactive toggles.** The tray's job is "let me get back to the app and let me quit"; configuration belongs in the main UI. Read-only status earns its slot because both signals (bot health, session activity) answer "is the background work actually happening?" — the exact question the user has when the window is closed.
- **No persisted hidden-launch state.** A second-time user re-launching the app should see the app, not wonder why nothing happened. The cost of always showing the window is one extra click for the rare power user; the cost of a silent launch is "I think it's broken".
- **Quit must be a single deliberate path while hidden.** Cmd-Q semantics on macOS get tricky once the Dock is gone; the tray's "Quit Claude Code GUI" is the authoritative quit path. OS-level kill paths (R16) must reuse the same cleanup, but the user-discoverable path is the tray.

---

## Dependencies / Assumptions

- Tauri 2.11.x (already on `tauri = "2.11.2"` in `src-tauri/Cargo.toml`) supports tray icons natively via its `tray-icon` feature; no additional plugin is required. `Cargo.lock` already pulls in `tray-icon`.
- The Tauri APIs to switch macOS `NSApplicationActivationPolicy` between Regular and Accessory at runtime are available; planning will confirm the exact call shape.
- The sidecar HTTP server exposes (or can cheaply expose) endpoints that report (a) WeCom bot configured/connected state per workspace and (b) live session-runtime count. The tray's status lines pull from these. If a suitable endpoint does not yet exist, adding a minimal one is in scope at planning time — but the brainstorm assumes this is a thin addition, not a redesign.
- The existing single-window contract (`label: "main"` in `src-tauri/tauri.conf.json`) is the only window the tray needs to manage.
- "Quit" via the tray triggers the same shutdown logic as today's window-close-quits-the-app path; planning will move that logic so it can be invoked by either source. No new shutdown sequencing is needed beyond plumbing the trigger.

---

## Outstanding Questions

### Resolve Before Planning

- _(none — all blocking decisions resolved during brainstorming)_

### Deferred to Planning

- [Affects R11, R12][Technical] Decide whether the tray reads bot/session status via a new sidecar HTTP endpoint or via a Tauri command that the Rust side proxies to the sidecar. Either works; the choice is a routing detail.
- [Affects R3][Technical] Confirm exact tray click semantics on each OS — macOS menu bar items conventionally open the menu on left-click rather than performing a default action. Planning may adjust R3 to match OS conventions and document the resulting per-OS behavior.
- [Affects R6][Technical] Verify the Tauri 2 API for runtime `NSApplicationActivationPolicy` changes (or fall back to a Rust `objc2` call). Planning confirms the exact path; no behavioral decision left.
- [Affects R9][Technical] Decide whether to truly hide the window (Tauri `Window::hide`) versus close-and-recreate. Hiding preserves DOM state and meets the "instant reopen" bar more easily; planning chooses based on memory cost on long-running sessions.
- [Affects R16][Technical] Plumb the existing shutdown sequence so it is reachable from both Cmd-Q (when applicable) and the tray's Quit item, with the sidecar teardown unchanged. Mechanical, not a product decision.
