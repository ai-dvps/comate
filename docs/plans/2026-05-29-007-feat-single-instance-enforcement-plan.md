---
title: feat: Enforce single application instance
type: feat
status: completed
date: 2026-05-29
---

# feat: Enforce single application instance

## Summary

Use the official `tauri-plugin-single-instance` plugin to prevent multiple Comate processes from running simultaneously. When a user attempts to launch a second instance, the existing window is brought to the foreground instead.

---

## Problem Frame

Currently, users can launch multiple copies of the Comate desktop app, each spawning its own sidecar and competing for system resources. This leads to port conflicts, duplicated tray icons, and confusing UX.

---

## Requirements

- R1. Only one Comate desktop process may run per computer at a time.
- R2. Launching a second instance must focus the existing main window rather than starting a new process.
- R3. The solution must work across all supported desktop platforms (macOS, Windows, Linux).

---

## Scope Boundaries

- No changes to server-side behavior or sidecar spawning logic.
- No deep-link or CLI argument forwarding from second instance to first (not currently supported).
- No web/browser mode changes; this applies to the Tauri desktop build only.

---

## Context & Research

### Relevant Code and Patterns

- `src-tauri/src/lib.rs` — Tauri app builder and `show_main_window()` helper already exist.
- `src-tauri/capabilities/default.json` — existing permissions array.
- `src-tauri/Cargo.toml` — dependency declarations.

### External References

- [Tauri Plugin Single Instance docs](https://docs.rs/tauri-plugin-single-instance/latest/tauri_plugin_single_instance/) — official Tauri v2 plugin for singleton enforcement.

---

## Key Technical Decisions

- **Use `tauri-plugin-single-instance` rather than a custom lockfile/mutex.** This is the idiomatic Tauri v2 approach; it handles platform differences (named mutex on Windows, Unix socket on Linux, app bundle behavior on macOS) without custom code.

---

## Implementation Units

### U1. Add single-instance plugin dependency and callback

**Goal:** Integrate `tauri-plugin-single-instance` into the Tauri app lifecycle.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- `src-tauri/Cargo.toml`
- `src-tauri/src/lib.rs`

**Approach:** Add `tauri-plugin-single-instance = "2"` to Cargo.toml dependencies. In `lib.rs`, chain `.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| { show_main_window(app); }))` into the existing `tauri::Builder` chain before `.run()`. Reuse the existing `show_main_window` helper to ensure macOS `ActivationPolicy` is handled consistently.

**Patterns to follow:** Existing plugin initialization chain in `lib.rs` (e.g., `tauri_plugin_shell::init()`).

**Test scenarios:**
- Happy path: Launch app → launch second instance → existing window gains focus, no new process appears in Task Manager/Activity Monitor.
- Edge case: App is hidden/minimized to tray → second launch unhides and focuses the window.
- Edge case: App is in the middle of shutdown → second launch should not create a new process (plugin handles this natively).

**Verification:** Build the app (`npm run tauri:build` or `tauri build`), run the binary, then attempt to launch it again — only one process should exist and the window should focus.

### U2. Grant single-instance plugin capability

**Goal:** Allow the plugin to function within Tauri v2's permission model.

**Requirements:** R1, R3

**Dependencies:** U1

**Files:**
- `src-tauri/capabilities/default.json`

**Approach:** Append `"single-instance:default"` to the `permissions` array in `default.json`.

**Test expectation:** none — pure capability scaffolding, verified implicitly by U1's integration test.

**Verification:** App builds successfully without capability errors.

---

## Open Questions

### Deferred to Implementation

- None.
