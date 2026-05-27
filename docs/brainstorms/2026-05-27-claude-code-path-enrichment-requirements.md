---
date: 2026-05-27
topic: claude-code-path-enrichment
---

# Claude Code PATH Enrichment

## Summary

Auto-enrich the PATH passed to Claude Code so user-installed CLI tools like `wnpm` are discoverable. The app will capture the shell's PATH at server startup, fall back to checking common install directories if shell capture fails, and let users manually add paths in Settings.

---

## Problem Frame

The Tauri GUI app → Node sidecar → SDK → Claude Code child process chain does not inherit the user's shell PATH. Terminal shells source `.zshrc`, `.bash_profile`, and similar initialization files, which add directories like `/opt/homebrew/bin`, `/usr/local/bin`, and `~/.local/bin`. GUI apps launched from the OS get a minimal system PATH instead. This means tools like `wnpm` that work fine in a terminal fail with "command not found" when Claude Code tries to invoke them. Users currently have to switch to a terminal and run commands manually, which breaks the flow of staying inside the app.

---

## Requirements

**PATH detection**

- R1. At server startup, attempt to capture the user's shell PATH by spawning their default login shell non-interactively and reading the PATH environment variable from its output.
- R2. If shell capture succeeds, cache the captured PATH for the lifetime of the server process.
- R3. If shell capture fails or times out, fall back to a platform-specific list of common binary directories and prepend any that exist to the process PATH.

**Settings UI**

- R4. The Settings UI must display the resolved PATH that will be passed to Claude Code.
- R5. The Settings UI must allow users to append additional directory paths manually.
- R6. Manually added paths must be persisted across app restarts.

**SDK integration**

- R7. When building SDK options for Claude Code, the enriched PATH must be merged with the process PATH and passed to the SDK.
- R8. The enriched PATH must compose cleanly with existing PATH injections (e.g., WeCom CLI directory prepending).

**Diagnostics**

- R9. The resolved PATH must be logged for diagnostic purposes.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R7.** Given the app starts on macOS with zsh configured to include `/opt/homebrew/bin`, when the sidecar initializes, then it captures the shell PATH, caches it, and subsequent Claude Code queries receive a PATH containing `/opt/homebrew/bin`.
- AE2. **Covers R3.** Given shell capture fails because the shell config writes errors to stdout, when the SDK options are built, then the PATH includes common directories like `/opt/homebrew/bin` and `~/.local/bin` if they exist.
- AE3. **Covers R5, R6.** Given a user adds `/custom/tools` in Settings and restarts the app, when a Claude Code session starts, then the SDK receives a PATH that includes `/custom/tools`.

---

## Success Criteria

- `wnpm` and similar user-installed CLI tools are discoverable by Claude Code without requiring terminal workarounds.
- Diagnostic logs show the enriched PATH so support can verify what the SDK sees.
- A downstream implementer can take this doc and plan it without inventing the detection strategy, fallback behavior, settings persistence, or composition rules.

---

## Scope Boundaries

- Per-workspace PATH overrides — PATH is a machine-level environment concern.
- Modifying system PATH or shell rc files — the app reads but never writes system configuration.
- Auto-installation of missing CLI tools.
- Support for environment variables beyond PATH.
- Real-time PATH monitoring without app restart.

---

## Key Decisions

- **Hybrid approach over shell-only or heuristics-only:** Shell capture alone is fragile if shell configs have errors; heuristics alone miss custom paths. The hybrid delivers "just works" for most users while being resilient.
- **App-level PATH setting over per-workspace:** PATH is a user-machine environment, not a project concern. A single app-level setting keeps the mental model simple.

---

## Dependencies / Assumptions

- The user's default shell is available and can be spawned non-interactively.
- The server process lifetime is long enough that caching PATH at startup is sufficient (no live PATH changes without app restart).
- The frontend has a mechanism to persist app-level settings and communicate them to the server, or the server can persist them independently.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R1][Technical] Exact shell invocation command and timeout duration per platform (macOS, Windows, Linux).
- [Affects R3][Technical] Platform-specific list of fallback directories and precedence order.
- [Affects R6][Technical] Persistence mechanism for manual PATH additions — localStorage + API, server-side config file, or other.
