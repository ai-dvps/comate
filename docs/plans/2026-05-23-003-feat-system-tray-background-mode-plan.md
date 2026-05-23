---
title: System Tray and Background-Running Mode
type: feat
status: completed
date: 2026-05-23
origin: docs/brainstorms/2026-05-23-system-tray-background-mode-requirements.md
---

# System Tray and Background-Running Mode

## Summary

Add a Tauri-native system tray icon, intercept the main window's close request to hide instead of destroy, and route the lone "Quit Claude Code GUI" path through a single shutdown function that tears down the sidecar and exits the process. On macOS, hiding the window flips `NSApplicationActivationPolicy` to Accessory so the Dock icon disappears; showing it restores Regular. Two tray menu lines (WeCom bot status, active session count) read from existing in-process services via a thin sidecar HTTP endpoint that the Rust side polls every 5 seconds.

---

## Problem Frame

Today the app's window-close handler at `src-tauri/src/lib.rs:131-144` kills the sidecar and exits. That tears down WeCom bot connections, aborts in-flight Claude sessions, and forces a cold start on the next launch. The brainstorm establishes the close-to-tray model — see [origin](../brainstorms/2026-05-23-system-tray-background-mode-requirements.md) for the full pain narrative.

---

## Requirements

- R1. Tray icon present on macOS, Windows, and Linux whenever the app is running.
- R2. Tray icon stays visible regardless of window state — not a "hidden-only" indicator.
- R3. Tray click semantics: right-click opens the menu on Win/Linux; on macOS the menu opens on left-click (OS convention). Where the OS supports a default-action click, left-click opens/focuses the window.
- R4. OS close control on the main window hides the window — Tauri process and sidecar keep running.
- R5. Cmd-W / Ctrl-W behaves the same as the close control.
- R6. On macOS, hiding the window switches `NSApplicationActivationPolicy` to Accessory (Dock icon hidden); showing the window restores Regular.
- R7. Hiding the window does not touch session runtimes, the WeCom bot, or the sidecar.
- R8. "Open Claude Code GUI" shows, focuses, and raises the main window. Already-visible-but-unfocused windows get raised.
- R9. Reopen is visibly instant on a warm process — the implementation MUST use `Window::hide`/`show` (preserves the webview, no rehydration cost), not close-and-recreate.
- R10. Tray menu items in order: Open → WeCom bot status (read-only) → Active session count (read-only) → separator → Quit.
- R11. WeCom status line reflects per-workspace bot configured/connected state, polled every ~5s.
- R12. Active session count reflects live `SessionRuntime` instances in `ChatService`, polled on the same cadence.
- R13. "Quit Claude Code GUI" cleanly stops session runtimes, terminates the sidecar, and exits.
- R14. Every fresh launch shows the window and shows the Dock icon. No persisted hidden-to-tray state.
- R15. Launch-at-login is out of scope (carried from origin; no work).
- R16. OS-level kill paths (Cmd-Q while focused, "End Task", SIGTERM/SIGINT) reuse the same shutdown sequence as tray Quit. No sidecar leaks.
- R17. Existing sidecar crash behavior is preserved as-is (no new recovery work).

**Origin acceptance examples:** AE1 (covers R4, R6, R7), AE2 (covers R8, R9), AE3 (covers R10–R12), AE4 (covers R13), AE5 (covers R14).

---

## Scope Boundaries

- No launch-at-login.
- No tray actions beyond Open/Quit (no "Pause WeCom bot", no "New chat" entry points).
- No native OS notifications or unread-count badges.
- No per-OS tray icon theming (template icon variants, light/dark mode) — reuse `src-tauri/icons/32x32.png` for now.
- No persisted "stayed hidden last time" launch state.
- No multi-window support — the tray manages the single `main` window.
- No user-facing toggle for "hide Dock when window hidden" on macOS — fixed behavior.
- No tray menu localization (app is English-only).

---

## Context & Research

### Relevant Code and Patterns

- `src-tauri/src/lib.rs:131-144` — current `WindowEvent::Destroyed` handler that kills sidecar and exits. The shutdown logic needs to move into a dedicated function callable from both tray Quit and OS-level signal paths.
- `src-tauri/src/lib.rs:38-127` — sidecar spawn block. The `CommandChild` is stored in `AppState.sidecar_child` (a `Mutex<Option<CommandChild>>`). The shutdown function will lock and kill it the same way the existing handler does.
- `src-tauri/src/lib.rs:11-15` — `get_api_port` Tauri command. The tray status poller (Rust-side) reads this same port to call the sidecar's status endpoint over HTTP — keeps tray state plumbing on the same channel the frontend already uses.
- `src-tauri/Cargo.toml:24` — `tauri = { version = "2.11.2", features = [] }`. Add `tray-icon` feature; verify by build.
- `src-tauri/tauri.conf.json` — single `main` window declaration, all three bundle targets present.
- `src/server/services/wecom-bot-service.ts:114-119` — `getStatus(workspaceId)` returns `'connected' | 'disconnected' | 'error' | 'not_configured'`. New summary endpoint aggregates across workspaces.
- `src/server/services/chat-service.ts:23` — `private runtimes = new Map<string, SessionRuntime>()`. Active session count is `runtimes.size`. Add a public `getActiveSessionCount()` getter rather than exposing the map.
- `src/server/routes/workspaces.ts:78-91` — existing `GET /api/workspaces/:id/bot/status` pattern. New `GET /api/system/tray-status` follows the same Express router style.
- `src/server/index.ts:99-109` — sidecar's existing graceful shutdown on SIGTERM/SIGINT. The Tauri side already sends a kill signal via `CommandChild::kill()`, which surfaces as one of these signals on the Node side.

### Institutional Learnings

- `docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md` — recent SSE-reconnect work touched chat-service streaming. Not directly affected, but the active-session count needs to remain accurate while clients reconnect (runtimes don't churn on transient SSE drops).

### External References

- Tauri 2 tray icon API: `tauri::tray::TrayIconBuilder` with `MenuBuilder` for the menu. The `tray-icon` feature must be enabled on the `tauri` crate.
- Tauri 2 `App::set_activation_policy(ActivationPolicy::Accessory | ActivationPolicy::Regular)` — macOS-only API for switching Dock visibility at runtime. Available via `tauri::AppHandle::set_activation_policy` (gated behind `#[cfg(target_os = "macos")]`).
- Tauri 2 window close interception: handle `WindowEvent::CloseRequested`, call `api.prevent_close()`, then `window.hide()`.

---

## Key Technical Decisions

- **Hide, don't close-and-recreate (resolves origin's R9 deferred question).** `Window::hide()` keeps the webview process alive, so reopen restores instantly and React state is preserved. Memory cost is bounded by the already-running webview; close-and-recreate would force a full page reload and lose any unsaved input.
- **Single shutdown function, two callers (resolves R16 deferred plumbing question).** Extract the current `WindowEvent::Destroyed` body into `fn perform_shutdown(app_handle: &AppHandle)`. Tray "Quit" calls it directly. The existing `WindowEvent::Destroyed` handler also calls it (covers Cmd-Q on macOS and force-quit/End-Task on Win/Linux, all of which still raise a destroy event before the process exits). A flag on `AppState` (`is_shutting_down: AtomicBool`) prevents the destroy handler from running shutdown twice when Quit was the trigger.
- **Sidecar exposes one new aggregated endpoint, not two (resolves origin's R11/R12 routing question).** `GET /api/system/tray-status` returns `{ wecomBot: 'connected' | 'partial' | 'disconnected' | 'not_configured', activeSessions: number }`. Aggregation rule for the bot string: `connected` if at least one configured workspace has a connected bot; `partial` if some configured workspaces are connected and others are not; `disconnected` if all configured workspaces are disconnected/error; `not_configured` if no workspace has the bot enabled. One endpoint keeps the polling traffic to a single round-trip every 5s.
- **Rust polls the sidecar; Rust pushes to the tray.** Spawn a `tokio::time::interval(Duration::from_secs(5))` task at startup that calls `http://127.0.0.1:{api_port}/api/system/tray-status` and updates the two read-only menu item labels. Keeps frontend out of the loop entirely (the tray must work whether or not the window is open).
- **Tray click on macOS triggers menu only (resolves R3 deferred question).** macOS menu-bar items conventionally open the menu on left-click — no separate default action. On Windows and Linux, left-click on the tray icon shows/focuses the main window; right-click opens the menu. Tauri's `TrayIconBuilder::on_tray_icon_event` discriminates between `Click { button: Left, .. }` and menu open events; the macOS arm is a no-op (the menu's "Open Claude Code GUI" item is the user's path).
- **Tray icon reuses `src-tauri/icons/32x32.png`.** No new asset. Visual polish (template icons, dark-mode variant) is explicitly out of scope per origin Scope Boundaries.
- **Activation policy on macOS is event-driven, not coupled to click.** `App::set_activation_policy(Accessory)` is called inside the `CloseRequested` handler immediately after `window.hide()`. `Regular` is restored at the start of the tray "Open" handler, before `window.show()` and `set_focus()`. Wrap calls in `#[cfg(target_os = "macos")]` so Windows/Linux compile cleanly.

---

## Open Questions

### Resolved During Planning

- *(R9 hide vs close-and-recreate, R11/R12 routing, R3 click semantics, R6 activation policy API, R16 quit plumbing — all moved into Key Technical Decisions above.)*

### Deferred to Implementation

- **Exact menu item update API.** Whether to call `MenuItem::set_text(...)` on the existing item handle or rebuild the submenu each poll is a Tauri 2 API detail — both work, pick whichever is less brittle once the code lands.
- **Linux tray availability fallback.** Some Linux desktops lack a status notifier host. If `TrayIconBuilder::build` returns an error on Linux, log and continue without a tray. Window close-to-hide remains active; only the tray is absent. No special UI is required to communicate this.

---

## Implementation Units

### U1. Add `tray-icon` Tauri feature and verify build

**Goal:** Make tray APIs available to the rest of the work.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src-tauri/Cargo.toml`

**Approach:**
- Change `tauri = { version = "2.11.2", features = [] }` to `tauri = { version = "2.11.2", features = ["tray-icon"] }`.
- Run `cargo check` from `src-tauri/` to confirm the feature resolves cleanly. Re-build `Cargo.lock` if `cargo` requests it.

**Patterns to follow:**
- `src-tauri/Cargo.toml:24` — existing single-line feature list.

**Test scenarios:**
- Test expectation: none — pure dependency-features change. Verified by a clean `cargo check` in U6 and onward.

**Verification:**
- `cargo check` succeeds. `tauri::tray::TrayIconBuilder` resolves in editor / `rust-analyzer`.

---

### U2. Sidecar `/api/system/tray-status` aggregation endpoint

**Goal:** Provide a single HTTP read for both tray status lines.

**Requirements:** R11, R12

**Dependencies:** None (parallel-safe with U1, U3)

**Files:**
- Create: `src/server/routes/system.ts`
- Modify: `src/server/index.ts` (mount the new router)
- Modify: `src/server/services/chat-service.ts` (add `getActiveSessionCount(): number`)
- Modify: `src/server/services/wecom-bot-service.ts` (add `getAggregateStatus(): { state: 'connected'|'partial'|'disconnected'|'not_configured' }`)
- Test: `src/server/routes/system.test.ts`

**Approach:**
- `wecom-bot-service.getAggregateStatus()` iterates `workspaceStore.list()` and inspects `settings.wecomBotEnabled` + the live `connections` map status, returning the aggregation rule defined in Key Technical Decisions.
- `chat-service.getActiveSessionCount()` returns `this.runtimes.size`.
- Route handler is a small composition: `res.json({ wecomBot: wecomBotService.getAggregateStatus().state, activeSessions: chatService.getActiveSessionCount() })`.
- Mount under `/api/system` in `src/server/index.ts` next to the existing routers.

**Patterns to follow:**
- `src/server/routes/workspaces.ts:78-91` — route shape, error handling style.
- `src/server/index.ts` — existing router mount pattern.

**Test scenarios:**
- Happy path: zero workspaces configured for the bot, zero active sessions → `{ wecomBot: 'not_configured', activeSessions: 0 }`.
- Happy path: one workspace configured + connected, two active sessions → `{ wecomBot: 'connected', activeSessions: 2 }`.
- Edge case: two workspaces configured, one connected and one in error → `{ wecomBot: 'partial', ... }`.
- Edge case: bot service not initialized yet (cold sidecar boot before `initialize()`) — endpoint should still respond with `'not_configured'` rather than throwing.

**Verification:**
- Endpoint returns the documented shape under each scenario. Existing `/api/workspaces/:id/bot/status` continues to work unchanged.

---

### U3. Extract `perform_shutdown` and gate `WindowEvent::Destroyed`

**Goal:** Single shutdown path, callable from tray Quit and from OS-level destroy events, with double-fire protection.

**Requirements:** R13, R16

**Dependencies:** None (parallel-safe with U1, U2)

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Approach:**
- Add `is_shutting_down: AtomicBool` to `AppState`; initialize to `false`.
- Introduce `fn perform_shutdown(app_handle: &tauri::AppHandle)` that: (a) compare-and-swaps the flag, returning early if already shutting down; (b) locks `sidecar_child`, takes the child, calls `kill()`; (c) calls `app_handle.exit(0)`.
- Rewrite the existing `WindowEvent::Destroyed` block to call `perform_shutdown(&window.app_handle())`. The block's current body becomes a one-liner.
- This unit does not yet add any new caller — U4 wires the tray menu, U5 wires the close interception.

**Execution note:** This is a refactor that should leave behavior unchanged for the existing window-close-quits-app flow. Verify by running the app in dev mode, clicking the window's close button, and confirming the sidecar exits and the process exits — same as today.

**Patterns to follow:**
- `src-tauri/src/lib.rs:131-144` — current handler shape, locking style.

**Test scenarios:**
- Test expectation: manual smoke test only. Rust-side integration tests for Tauri's window lifecycle are not part of the existing test surface in `src-tauri/`, and adding a Tauri test harness for one refactor is disproportionate.

**Verification:**
- `cargo check` and `cargo build` succeed. Manual: `npm run tauri dev`, close window → process exits, sidecar dies.

---

### U4. Build the tray icon and menu, wire Open/Quit

**Goal:** Tray icon present on all three OSes; menu items work; status lines exist (placeholders for now).

**Requirements:** R1, R2, R3, R8, R10, R13

**Dependencies:** U1, U3

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Approach:**
- Inside `setup`, after sidecar spawn is initiated, construct the tray:
  - `MenuBuilder::new(app)` with items in order: `MenuItem::with_id("open", "Open Claude Code GUI", true, None)`, `MenuItem::with_id("bot_status", "WeCom bot: …", false, None)`, `MenuItem::with_id("session_count", "Active sessions: …", false, None)`, `PredefinedMenuItem::separator(app, None)`, `MenuItem::with_id("quit", "Quit Claude Code GUI", true, None)`.
  - Disabled (`enabled = false`) items render as read-only labels on all three OSes — this is how Tauri/muda exposes non-interactive lines.
  - `TrayIconBuilder::new()` with icon from `app.default_window_icon()` (which already loads from `src-tauri/icons/`), then `.menu(menu)`, `.show_menu_on_left_click(cfg!(target_os = "macos"))`, `.on_menu_event(...)`, `.on_tray_icon_event(...)`, `.build(app)`.
- `on_menu_event`: match `event.id().as_ref()` — `"open"` runs the show-window helper (defined in U5), `"quit"` calls `perform_shutdown(&app.app_handle())`. The status items are disabled and won't fire events.
- `on_tray_icon_event`: only handle `TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }` and only on Windows/Linux — call the show-window helper. macOS arm is a no-op.
- Store `TrayIcon` and the two label `MenuItem` handles in `AppState` (new fields, both `Mutex<Option<...>>`) so U7's poller can update them.
- On Linux, wrap `.build(app)` in a match so failure (no status notifier host) is logged but doesn't abort startup.

**Patterns to follow:**
- `src-tauri/src/lib.rs:27-37` — Tauri builder + setup callback style.

**Test scenarios:**
- Test expectation: manual. Tray UI cannot be asserted from Rust unit tests at a useful level.
- Happy path (manual, macOS): launch app → menu bar shows tray icon → click → menu has 5 entries in correct order → "Open" focuses window → "Quit" exits cleanly.
- Happy path (manual, Windows): same checks plus left-click on tray icon shows/focuses window.
- Edge case (manual, Linux on a desktop without StatusNotifier): app still launches, window opens normally, no crash.

**Verification:**
- Tray icon visible alongside the window on first launch. Menu order matches R10. Quit exits the process cleanly with sidecar gone.

---

### U5. Intercept window close: hide instead of destroy, manage macOS Dock

**Goal:** Close-to-tray behavior + macOS Dock policy switching.

**Requirements:** R4, R5, R6, R7, R9

**Dependencies:** U4 (Open handler shares the show-window helper)

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Approach:**
- Add a small helper `fn show_main_window(app_handle: &AppHandle)` that:
  - `#[cfg(target_os = "macos")] app_handle.set_activation_policy(ActivationPolicy::Regular).ok();`
  - `if let Some(window) = app_handle.get_webview_window("main") { window.show().ok(); window.unminimize().ok(); window.set_focus().ok(); }`
- Add the `CloseRequested` handler inside the existing `.on_window_event(...)` closure:
  - `WindowEvent::CloseRequested { api, .. }` → `api.prevent_close()`, then `window.hide().ok()`, then `#[cfg(target_os = "macos")] window.app_handle().set_activation_policy(ActivationPolicy::Accessory).ok();`.
- Keep the `WindowEvent::Destroyed` arm (calls `perform_shutdown`) — it only fires on the genuine teardown path (tray Quit, Cmd-Q in the rare case it bypasses CloseRequested, OS-level kill).
- Cmd-W on macOS / Ctrl-W on Win/Linux already lower into `CloseRequested` by default in Tauri; no extra binding required.
- U4 calls `show_main_window` from the "open" menu handler and from the Windows/Linux tray-click handler.

**Patterns to follow:**
- `src-tauri/src/lib.rs:131-144` — existing window-event handler position and style.

**Test scenarios:**
- Test expectation: manual.
- Happy path (manual, macOS): click red traffic light → window disappears, Dock icon disappears within ~1 frame, tray icon still visible, `ps aux | grep sidecar-node` still shows the child. Cmd-W behaves the same.
- Happy path (manual, macOS): tray "Open" → window reappears within ~300ms (no spinner, no reload), Dock icon reappears, previously-selected workspace/session still active.
- Edge case (manual, macOS): with WeCom bot configured, hide window, send a bot message from the WeCom side, reopen window → message is present in the chat history (AE1).
- Edge case (manual, all OSes): Cmd-W / Ctrl-W → window hides, not quits.

**Verification:**
- AE1, AE2, AE5 from origin pass on macOS. Equivalent behavior verified on Windows and Linux (no Dock check there).

---

### U6. Periodic tray status poller in Rust

**Goal:** WeCom bot status and active session count labels update every ~5s from the sidecar.

**Requirements:** R11, R12

**Dependencies:** U2 (endpoint must exist), U4 (menu item handles stored in state)

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml` (add `reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }`)

**Approach:**
- After sidecar reports `ready` and `api_port` is set, spawn a `tauri::async_runtime::spawn` task that loops on `tokio::time::sleep(Duration::from_secs(5))`.
- Each tick: read `api_port` from `AppState`; if missing, skip the tick. Call `reqwest::get(format!("http://127.0.0.1:{port}/api/system/tray-status"))`, parse JSON into a small struct.
- Map response to display strings:
  - `wecomBot: 'not_configured'` → `"WeCom bot: not configured"`
  - `wecomBot: 'connected'` → `"WeCom bot: connected"`
  - `wecomBot: 'partial'` → `"WeCom bot: partially connected"`
  - `wecomBot: 'disconnected'` → `"WeCom bot: disconnected"`
  - `activeSessions: n` → `format!("Active sessions: {n}")`
- Update the two stored `MenuItem` handles via `set_text(...)`.
- On HTTP failure, leave the previous text in place (don't flash a transient error label) and continue.
- Stop the loop when `is_shutting_down` is set (poll the flag at the top of each iteration).

**Patterns to follow:**
- `src-tauri/src/lib.rs:38-127` — existing `tauri::async_runtime::spawn` block style.

**Test scenarios:**
- Test expectation: manual. The poller's correctness collapses to "endpoint returns the right shape" (covered by U2's unit tests) plus "labels render the expected text" (manual UI check).
- Happy path (manual): launch app with no WeCom configured → both labels populate within ~5s as "WeCom bot: not configured" / "Active sessions: 0".
- Happy path (manual): configure a WeCom bot in a workspace, wait → label flips to "WeCom bot: connected".
- Happy path (manual): start a chat that streams, leave it streaming, open tray menu → "Active sessions: 1".

**Verification:**
- AE3 from origin passes. Tray labels reflect live state within one poll cycle of changes.

---

### U7. Verify OS-level kill paths preserve clean shutdown

**Goal:** Confirm R16 — Cmd-Q (when applicable), kill signals, and process termination still run `perform_shutdown`. No leaked sidecar.

**Requirements:** R16, R17

**Dependencies:** U3, U4, U5

**Files:**
- Modify: `src-tauri/src/lib.rs` (only if a gap surfaces during verification — most likely no code change is needed because `WindowEvent::Destroyed` already routes to `perform_shutdown`).

**Approach:**
- Walk through the kill matrix manually and confirm each path either triggers `WindowEvent::Destroyed` (and thus `perform_shutdown`) or has some other handler the macOS/Win/Linux runtime invokes.
- If a path leaks the sidecar (e.g., SIGTERM to the Tauri PID on Linux while window is hidden doesn't raise Destroyed), add a Rust-side `tokio::signal::ctrl_c()` or `signal_hook` handler that calls `perform_shutdown`. Hold this as a fallback only — preferred is to confirm Tauri already covers it.
- Document the verified matrix in a single comment block above `perform_shutdown`.

**Execution note:** Verification-first. Do not add signal handlers preemptively; confirm whether they're needed by observing actual behavior.

**Test scenarios:**
- Manual, macOS: window hidden → Cmd-Q from another app focus (Activity Monitor "Force Quit") → `ps aux | grep sidecar-node` shows no residual.
- Manual, macOS: window visible → Cmd-Q → same check.
- Manual, Windows: window hidden → Task Manager "End Task" → no residual sidecar.
- Manual, Linux: window hidden → `kill <pid>` of the Tauri process → no residual sidecar.

**Verification:**
- AE4 from origin passes. No path leaves the sidecar running. The verified matrix is captured in code comments.

---

## System-Wide Impact

- **Interaction graph:** `WindowEvent::CloseRequested` (new) intercepts before Tauri's default close. `WindowEvent::Destroyed` (existing) now only fires on the true teardown path. The tray's `on_menu_event` and `on_tray_icon_event` are new entry points into `show_main_window` and `perform_shutdown`.
- **Error propagation:** Tray poller HTTP failures are silent (previous label persists). Sidecar `/api/system/tray-status` errors return 500; the poller logs and skips the tick.
- **State lifecycle risks:** Double-shutdown is the main hazard — Quit triggers `perform_shutdown`, which calls `app_handle.exit(0)`, which raises `WindowEvent::Destroyed`. The `is_shutting_down` `AtomicBool` short-circuits the second call. Without it, the sidecar `kill()` would run on an already-taken `Option<CommandChild>` (panic-safe — it's `None` the second time — but `app_handle.exit(0)` called twice may misbehave).
- **API surface parity:** Frontend remains unchanged. `/api/workspaces/:id/bot/status` keeps working for the chat UI. The new `/api/system/tray-status` is Rust-only consumer for now; documenting it is fine but no client code in `src/client/` calls it.
- **Integration coverage:** AE1's "WeCom message lands while window is hidden" path crosses Tauri ↔ sidecar ↔ WeCom WebSocket ↔ ChatService — verified manually because the assertion is "the message is present after reopen", which is the same end-to-end signal the existing app already proves when the window stays open. No new test harness is justified.
- **Unchanged invariants:** Existing window contract (single `main` window labeled `"main"`), existing sidecar HTTP API, existing SSE streaming, existing `/api/workspaces/:id/bot/status` shape, existing dev/build/bundle pipeline. None of these change.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Tauri's tray-icon feature on Linux requires `libayatana-appindicator` or similar at runtime; missing on minimal desktops. | Wrap `TrayIconBuilder::build` failures, log, continue without tray (U4). Window-close-to-hide still works; user loses Quit-from-tray, can still kill the process. |
| `set_activation_policy` is a no-op or absent on non-macOS targets. | Calls are gated behind `#[cfg(target_os = "macos")]`. Windows/Linux compile cleanly. |
| Polling every 5s adds steady CPU/HTTP traffic. | One small JSON request per 5s on localhost is negligible. No backoff needed. |
| Reused `32x32.png` icon may look heavy in a macOS template-icon menu bar. | Acknowledged in Scope Boundaries; visual polish deferred. |
| The `reqwest` dependency adds binary size to `src-tauri`. | Use `default-features = false` + `rustls-tls` to avoid pulling OpenSSL. Acceptable given the alternative (hand-rolling an HTTP call with `hyper`) is more code for the same result. |

---

## Documentation / Operational Notes

- README and any in-app help should mention "closing the window keeps the app running in the tray; use the tray menu to fully quit." Out of scope for this plan; capture as a follow-up if onboarding feedback shows confusion.
- No telemetry, no rollout flag — feature is unconditional once shipped.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-23-system-tray-background-mode-requirements.md](../brainstorms/2026-05-23-system-tray-background-mode-requirements.md)
- Related code: `src-tauri/src/lib.rs`, `src/server/services/wecom-bot-service.ts`, `src/server/services/chat-service.ts`, `src/server/routes/workspaces.ts`
- Tauri tray API: https://docs.rs/tauri/2.11.2/tauri/tray/index.html
- Tauri activation policy: https://docs.rs/tauri/2.11.2/tauri/struct.AppHandle.html#method.set_activation_policy
