---
date: 2026-06-02
topic: shell-env-initialization
---

# Shell Environment Initialization for SDK Sessions

## Summary

Spawn the user's shell as an interactive login shell to capture the full terminal environment — all exported variables, not just PATH — and use that as the base environment for Claude Code SDK sessions.

---

## Problem Frame

Users can run tools like `cargo` and `aidx` in Terminal.app or iTerm because those emulators spawn an interactive login shell, which sources `.zshrc` and `.bashrc`. The application currently spawns a non-interactive login shell to capture PATH, which skips interactive shell configuration files. This creates a gap where CLI tools installed or configured in `.zshrc` / `.bashrc` are invisible to SDK sessions even though they work fine in the terminal.

---

## Requirements

**Environment capture**
- R1. The application shall spawn the user's default shell as an interactive login shell to capture environment variables.
- R2. The capture mechanism shall collect all exported environment variables from the shell, not only PATH.
- R3. The captured shell environment shall be cached and used as the base environment for SDK session initialization.

**Environment composition**
- R4. Application-specific overrides (configuration directory paths, provider credentials, and custom PATH prefixes) shall be layered on top of the captured shell environment.
- R5. When shell environment capture fails or times out, the application shall fall back to the existing PATH enrichment behavior.

**Platform behavior**
- R6. Windows shall continue to use the current fallback-based PATH enrichment without shell spawning.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R3.** Given a macOS user whose PATH includes `~/.cargo/bin` via `.zshrc`, when the application initializes, the captured environment contains that directory in PATH, and subsequent SDK sessions can invoke `cargo`.
- AE2. **Covers R2, R3, R4.** Given a user who exports `RUSTUP_HOME` in `.bashrc`, when an SDK session starts, that variable is present in the session environment alongside application-managed variables like `CLAUDE_CONFIG_DIR`.

---

## Success Criteria

- CLI tools available in the user's terminal (e.g., `cargo`, `aidx`) are available in SDK sessions without manual PATH configuration.
- The application degrades gracefully when shell capture fails — SDK sessions still start with the existing fallback environment.
- No regression in Windows environment handling.

---

## Scope Boundaries

- Per-workspace environment overrides
- User-configurable shell selection or profile paths
- Changes to the Tauri Rust sidecar process spawning
- Modifying Windows PATH enrichment behavior beyond the existing fallback logic

---

## Key Decisions

- **Interactive login shell over non-interactive login shell:** Terminal emulators use interactive login shells; matching that behavior is the most reliable way to ensure SDK sessions see the same environment as the terminal.
- **Full environment capture over PATH-only capture:** PATH was the immediately visible gap, but other exported variables (e.g., `RUSTUP_HOME`, `JAVA_HOME`) will eventually matter. Capturing the full env prevents a class of follow-up bugs.
- **Shell environment as the base, app overrides layered on top:** The macOS GUI application receives a sparse environment from launchd. Using the shell-captured environment as the base and applying application-specific overrides preserves user configuration while ensuring required app variables are present.

---

## Dependencies / Assumptions

- The user's `$SHELL` is configured and executable.
- The user's shell startup files do not produce output that corrupts the environment dump when run in the capture subprocess.
