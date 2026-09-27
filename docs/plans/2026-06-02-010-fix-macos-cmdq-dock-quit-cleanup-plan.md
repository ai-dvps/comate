---
title: Fix macOS Cmd+Q and dock menu quit not triggering cleanup
type: fix
status: active
date: 2026-06-02
origin: user bug report — PR #34 follow-up
---

# Fix macOS Cmd+Q and dock menu quit not triggering cleanup

## Summary

On macOS, quitting the application via Cmd+Q or the dock context menu "Quit" bypasses the `WindowEvent::Destroyed` handler, so the Rust `perform_shutdown()` function never runs. As a result, the Node sidecar child process is never killed, and the Claude Code CLI processes spawned by active sessions survive as zombies.

The fix is to add a Tauri `RunEvent::Exit` handler, which fires for **all** quit paths on macOS (Cmd+Q, dock Quit, tray Quit, and window close), and perform fast cleanup there. We also fix a latent HTTP method mismatch (Rust sends GET to a POST endpoint) discovered during investigation.

---

## Problem Frame

PR #34 added graceful shutdown logic wired to `WindowEvent::Destroyed`. This works for tray Quit (which calls `app_handle.exit(0)`, which in turn raises `WindowEvent::Destroyed` on some platforms) but **does not work for macOS-native quit paths**:

- **Cmd+Q** — macOS sends the `kEventAppleEvent` (`AEQuitApplication`) directly to the app. Tauri does not surface this as `WindowEvent::Destroyed`.
- **Dock → Quit** — same Apple event path, no `WindowEvent::Destroyed`.

When these paths are used, `perform_shutdown()` is never called. The Node sidecar keeps running, and because `SessionRuntime.close()` was never invoked, the underlying Claude Code CLI processes also survive as orphans.

Additionally, the HTTP graceful-shutdown request in `perform_shutdown()` sends **GET** to a **POST** endpoint (`/shutdown`), so the "graceful" path was never actually reaching Node. Tray Quit only appeared to work because `child.kill()` sends SIGKILL to the sidecar, and the CLI processes happen to die when their parent Node process is killed and pipes break.

---

## Requirements

- **R1.** macOS Cmd+Q must trigger cleanup (kill sidecar, terminate CLI children).
- **R2.** macOS dock menu "Quit" must trigger cleanup.
- **R3.** Tray Quit and existing quit paths must continue to work.
- **R4.** The HTTP graceful-shutdown request must use the correct method (POST).
- **R5.** Cleanup in `RunEvent::Exit` must not call `app_handle.exit(0)` (the app is already exiting) and must not block so long that macOS force-kills the process.
- **R6.** Double-entry idempotency must be preserved — `is_shutting_down` prevents concurrent cleanup.

---

## Scope Boundaries

- Changes are confined to `src-tauri/src/lib.rs`.
- The Node `/shutdown` endpoint in `src/server/index.ts` is already correct (POST); only the Rust caller changes.
- No changes to session runtime logic, stop-button behavior, or SSE streaming.
- No platform-specific macOS signal handling or `applicationShouldTerminate` hooks (Tauri does not expose them).

---

## Context & Research

### Relevant Code

- `src-tauri/src/lib.rs` — `perform_shutdown()` is the cleanup entry point. It currently relies on `WindowEvent::Destroyed`.
- `src/server/index.ts` — `POST /shutdown` endpoint. The Rust side sends `GET`, which returns 404/405.
- `src/server/services/chat-service.ts` — `closeAllRuntimes()` is triggered by Node's `shutdown()` handler.

### External Findings

- Tauri `WindowEvent::Destroyed` **does not fire** for Cmd+Q or dock Quit on macOS (tauri-apps/tauri#13778, tauri-apps/tauri#9198).
- `RunEvent::Exit` **does fire** for all quit paths on macOS, including Cmd+Q and dock Quit.
- `tauri-plugin-shell` `CommandChild::kill()` sends **SIGKILL** on Unix (confirmed from `shared_child` source: `self.child.lock().unwrap().kill()` → `std::process::Child::kill()` → `kill(pid, SIGKILL)`).
- Because SIGKILL cannot be caught, Node's `SIGTERM` handler never runs when `child.kill()` is called. The only way to guarantee CLI cleanup is:
  1. HTTP POST `/shutdown` → Node runs `shutdown()` → `chatService.closeAllRuntimes()` → `query.close()` kills CLI.
  2. Then `child.kill()` as a fallback.

---

## Key Technical Decisions

- **Use `RunEvent::Exit` as the universal cleanup hook.** It fires for every quit path on macOS and is more reliable than `WindowEvent::Destroyed`.
- **Keep `WindowEvent::Destroyed` as a defensive fallback.** Removing it is not necessary for this fix and avoids platform-specific regression risk.
- **Refactor `perform_shutdown()` into a shared `cleanup()` function.** Both tray Quit and `RunEvent::Exit` need the same logic (send HTTP shutdown, kill sidecar), but tray Quit can afford a 2-second grace period while `RunEvent::Exit` must be fast.
- **Fix the GET→POST mismatch in the same PR.** The HTTP request has been broken since PR #34; fixing it makes the graceful path actually work.

---

## Implementation Units

### U1. Add `RunEvent::Exit` handler for universal quit cleanup

**Goal:** Ensure Cmd+Q and dock Quit on macOS trigger the same cleanup as tray Quit.

**Requirements:** R1, R2, R3, R5, R6

**Dependencies:** None

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Approach:**

1. **Switch from `.run()` to `.build().expect().run(|app_handle, event| {...})`.**
   The current code ends with `.run(tauri::generate_context!())`. Change it to:
   ```rust
   .build(tauri::generate_context!())
   .expect("error while building tauri application")
   .run(|app_handle, event| match event {
       tauri::RunEvent::Exit => {
           perform_fast_shutdown(app_handle);
       }
       _ => {}
   });
   ```

2. **Extract shared cleanup logic from `perform_shutdown()`.**
   Create a `cleanup_sidecar(app_handle: &AppHandle, grace_period: Duration)` function that:
   - Checks `is_shutting_down` via compare-exchange (returns early if already true).
   - If `api_port` is known, spawns an async `reqwest::post` to `http://127.0.0.1:{port}/shutdown` with a 1-second timeout.
   - Sleeps for the provided `grace_period`.
   - Takes and kills the sidecar child via `child.kill()`.

3. **Update `perform_shutdown()` to use the shared function.**
   ```rust
   fn perform_shutdown(app_handle: &AppHandle) {
       cleanup_sidecar(app_handle, Duration::from_secs(2));
       app_handle.exit(0);
   }
   ```

4. **Add `perform_fast_shutdown()` for `RunEvent::Exit`.**
   ```rust
   fn perform_fast_shutdown(app_handle: &AppHandle) {
       cleanup_sidecar(app_handle, Duration::from_millis(500));
       // Do NOT call app_handle.exit(0) — the app is already exiting.
   }
   ```

5. **Keep `WindowEvent::Destroyed` handler as a fallback.**
   It continues to call `perform_shutdown(&window.app_handle())`. The `is_shutting_down` guard prevents double execution when `RunEvent::Exit` fires immediately after.

**Patterns to follow:**
- Existing `reqwest::Client::builder().timeout(...)` pattern in `run_tray_status_poller`.
- Existing `is_shutting_down` compare-exchange guard in `perform_shutdown()`.

**Test scenarios:**
- Happy path (Cmd+Q): macOS Cmd+Q triggers `RunEvent::Exit` → HTTP POST sent → 500ms pause → sidecar SIGKILL → no zombie Node or CLI processes remain.
- Happy path (dock Quit): Same as Cmd+Q.
- Happy path (tray Quit): Tray menu "Quit" → `perform_shutdown()` → HTTP POST sent → 2s pause → sidecar SIGKILL → app exits. `RunEvent::Exit` fires but `is_shutting_down` is already true → no-op.
- Edge case (double quit): Rapidly triggering quit twice → `is_shutting_down` prevents second execution.
- Edge case (no port known): `api_port` is `None` → skip HTTP request, proceed directly to `child.kill()`.
- Error path (HTTP fails): Node is unresponsive → request times out after 1s → grace period elapses → `child.kill()` still runs.

**Verification:**
1. Start app, create a session, note CLI PID.
2. Quit via Cmd+Q.
3. Verify Node sidecar PID and CLI PID are gone from Activity Monitor.

---

### U2. Fix HTTP method mismatch in `perform_shutdown()`

**Goal:** Make the graceful HTTP shutdown request actually reach Node.

**Requirements:** R4

**Dependencies:** U1 (shared `cleanup_sidecar` function)

**Files:**
- Modify: `src-tauri/src/lib.rs`

**Approach:**
In the shared `cleanup_sidecar` function, change:
```rust
let _ = client.get(&shutdown_url).send().await;
```
to:
```rust
let _ = client.post(&shutdown_url).send().await;
```

**Test scenarios:**
- Happy path: `POST /shutdown` returns 200, Node logs shutdown initiation.
- Regression guard: No other HTTP calls in the codebase are affected.

**Verification:**
- Start app, trigger tray Quit, check Node logs for `Received http, shutting down...` message.

---

## System-Wide Impact

- **Interaction graph:** All macOS quit paths (Cmd+Q, dock Quit, tray Quit, window close) now funnel through the same cleanup logic. Tray Quit uses the 2-second graceful path; `RunEvent::Exit` uses the 500ms fast path.
- **Error propagation:** If the HTTP POST fails, `child.kill()` (SIGKILL) is the fallback. CLI children may survive if Node dies before `query.close()` runs, but the 500ms grace period in `RunEvent::Exit` gives Node time to process the request in the common case.
- **State lifecycle risks:** The `is_shutting_down` atomic flag prevents race conditions when multiple quit events fire in quick succession.
- **Unchanged invariants:** `SessionRuntime.interrupt()`, stop-button UX, and SSE streaming are untouched. Node `SIGTERM/SIGINT` handlers continue to work.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 500ms grace period in `RunEvent::Exit` may be too short on heavily loaded systems, leaving CLI children alive. | Start with 500ms; increase to 1s if manual testing shows zombies. The fallback SIGKILL of Node is unavoidable on macOS. |
| 500ms block in `RunEvent::Exit` could trigger macOS "not responding" warnings on very slow systems. | 500ms is well below the macOS "not responding" threshold (~2s). |
| `RunEvent::Exit` might not fire on some older Tauri v2 versions or specific macOS configurations. | Verified by Tauri issues #13778 and #9198 that `RunEvent::Exit` is the most reliable event; `WindowEvent::Destroyed` is kept as fallback. |
| Changing `.run()` to `.build().expect().run()` could subtly alter startup or error behavior. | The `.run()` method in Tauri v2 is equivalent to `.build().expect().run(|_, _| {})`; adding a handler is safe. |

---

## Sources & References

- Related code: `src-tauri/src/lib.rs`, `src/server/index.ts`
- Tauri issues: [tauri-apps/tauri#13778](https://github.com/tauri-apps/tauri/issues/13778), [tauri-apps/tauri#9198](https://github.com/tauri-apps/tauri/issues/9198)
- Previous plan: `docs/plans/2026-05-31-009-fix-cleanup-claude-code-process-on-exit-plan.md`
