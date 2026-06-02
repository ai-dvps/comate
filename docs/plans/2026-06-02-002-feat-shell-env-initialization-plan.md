---
title: "Shell Environment Initialization for SDK Sessions"
type: feat
status: active
date: 2026-06-02
origin: docs/brainstorms/shell-env-initialization-requirements.md
---

# Shell Environment Initialization for SDK Sessions

## Summary

Replace the non-interactive login shell PATH capture with an interactive login shell that captures the full terminal environment. Use the captured shell environment as the base for SDK sessions, layering application-specific overrides on top. Preserve the existing `resolve-shell-path.ts` API for backward compatibility and keep Windows behavior unchanged.

---

## Problem Frame

SDK sessions currently spawn with a sparse GUI-app environment because `resolve-shell-path.ts` uses a non-interactive login shell (`-lc`). Terminal emulators use interactive login shells (`-ilc`), which source `.zshrc` and `.bashrc`. This causes tools like `cargo` and `aidx` — configured in interactive shell startup files — to be missing from SDK sessions. Prior PATH enrichment work only solved the PATH subset; other exported variables (e.g., `RUSTUP_HOME`) remain invisible.

---

## Requirements

- R1. Spawn the user's default shell as an interactive login shell for environment capture.
- R2. Collect all exported environment variables, not only PATH.
- R3. Cache the captured shell environment and use it as the base for SDK session initialization.
- R4. Layer application-specific overrides on top of the captured shell environment.
- R5. Fall back to the existing PATH enrichment behavior when shell capture fails or times out.
- R6. Continue using fallback-based PATH enrichment on Windows without shell spawning.

**Origin acceptance examples:** AE1 (covers R1, R2, R3), AE2 (covers R2, R3, R4)

---

## Scope Boundaries

- Per-workspace environment overrides
- User-configurable shell selection or profile paths
- Changes to the Tauri Rust sidecar process spawning
- Modifying Windows PATH enrichment behavior beyond the existing fallback logic

---

## Context & Research

### Relevant Code and Patterns

- `src/server/utils/resolve-shell-path.ts` — existing shell PATH capture with 5s timeout, fallback directories, and caching
- `src/server/utils/sdk-env.ts` — `buildClaudeEnv()` constructs the env record passed to the SDK; currently starts from `process.env`
- `src/server/index.ts` — calls `initializeResolvedShellPath()` at server startup
- `src/server/routes/system.ts` — exposes `/api/system/path` using `getResolvedShellPath()` for frontend diagnostics
- `src/server/services/chat-service.ts` — `buildSdkOptions()` calls `buildClaudeEnv()` and passes `env` to SDK `Options`
- Existing tests use Node.js built-in `node:test` and `node:assert` (see `src/client/lib/keyboard.test.ts`)

### Institutional Learnings

- "Explicit read-and-inject is the team's chosen mitigation" for environment propagation fragility through the Tauri → sidecar → SDK chain.
- SDK `options.env` replaces the entire child environment; the spread of `process.env` in `buildClaudeEnv()` is intentional and must be preserved.
- Shell capture runs once at startup and is cached for the server lifetime; custom paths are read per-session.

---

## Key Technical Decisions

- **`env -0` for capture:** `env -0` outputs null-delimited key-value pairs, which safely handles multi-line environment values. It is available in both GNU coreutils and macOS BSD `env`.
- **Interactive login shell (`-ilc`):** Matches Terminal.app and iTerm behavior. The `-i` flag ensures `.zshrc` and `.bashrc` are sourced alongside `.zprofile` and `.bash_profile`.
- **Shell env as base, app overrides on top:** The captured shell environment replaces `process.env` as the base in `buildClaudeEnv()`. This is safe because macOS GUI apps receive a minimal launchd environment, and the shell env is a superset.
- **Backward compatibility for `resolve-shell-path.ts`:** The existing exports (`getResolvedShellPath`, `initializeResolvedShellPath`) are preserved by delegating to the new `resolve-shell-env.ts` internally. This avoids changing `system.ts` or any frontend consumers.

---

## Implementation Units

### U1. Create full shell environment capture utility

**Goal:** Add a new utility that spawns an interactive login shell and captures all exported environment variables.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Create: `src/server/utils/resolve-shell-env.ts`
- Test: `src/server/utils/resolve-shell-env.test.ts`

**Approach:**
- Spawn the user's shell with `['-ilc', 'env -0']`.
- Parse stdout by splitting on null bytes (`\0`) into `key=value` pairs.
- Handle timeout (5s), missing shell, and non-zero exit codes by returning `null`.
- Cache the successful result.
- On Windows, return `null` immediately without spawning.
- Use `sidecarLog` for diagnostics, following the existing logging prefix convention.

**Patterns to follow:**
- `resolve-shell-path.ts` for timeout handling, shell discovery order (`$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh`), and fallback behavior.

**Test scenarios:**
- Happy path: Mock shell that outputs null-delimited env; parsing returns the correct `Record<string, string>`.
- Edge case: Multi-line env value with embedded newlines; `env -0` parsing preserves the newlines.
- Error path: Shell times out; returns `null` and logs the timeout.
- Error path: Shell exits with non-zero code; returns `null` and logs the failure.
- Edge case: Empty env output; returns empty record, not `null`.

**Verification:**
- `getResolvedShellEnv()` returns a populated env record after initialization on macOS/Linux.
- `getResolvedShellEnv()` returns `null` on Windows or after a spawn failure.

---

### U2. Integrate shell environment into SDK env building

**Goal:** Use the captured shell environment as the base in `buildClaudeEnv()`, falling back to `process.env` when shell capture is unavailable.

**Requirements:** R3, R4, R5, R6

**Dependencies:** U1

**Files:**
- Modify: `src/server/utils/sdk-env.ts`

**Approach:**
- Import `getResolvedShellEnv` from `resolve-shell-env.ts`.
- In `buildClaudeEnv()`, start with `getResolvedShellEnv() ?? { ...process.env }` as the base.
- Preserve all existing override logic: `CLAUDE_CONFIG_DIR`, `ANTHROPIC_*` from settings, provider credentials via `settingsEnv`, WeCom CLI injection, custom PATH prefixes.
- PATH enrichment should source from the base env's PATH (shell-captured or process.env), then apply the existing precedence: custom paths → shell/fallback → base.

**Patterns to follow:**
- Existing `buildClaudeEnv()` override layering in `sdk-env.ts`.
- `prependEnvPath()` for injecting WeCom CLI directory.

**Test scenarios:**
- Integration: When `getResolvedShellEnv()` returns a record with `RUSTUP_HOME`, `buildClaudeEnv()` preserves it and layers `CLAUDE_CONFIG_DIR` on top.
- Integration: When `getResolvedShellEnv()` returns `null`, `buildClaudeEnv()` falls back to `process.env` and existing PATH enrichment.
- Integration: Custom paths are still prepended with highest precedence among `buildClaudeEnv()`-controlled PATH sources.

**Verification:**
- `cargo` and `aidx` are available in SDK sessions when configured in `.zshrc`.
- `CLAUDE_CONFIG_DIR` is still set correctly regardless of shell capture success.

---

### U3. Preserve `resolve-shell-path.ts` API via delegation

**Goal:** Keep the existing `resolve-shell-path.ts` exports unchanged so `system.ts` and the frontend continue to work.

**Requirements:** R5, R6

**Dependencies:** U1

**Files:**
- Modify: `src/server/utils/resolve-shell-path.ts`

**Approach:**
- Replace the internal spawn-and-parse logic with delegation to `resolve-shell-env.ts`.
- `initializeResolvedShellPath()` calls `initializeResolvedShellEnv()`.
- `getResolvedShellPath()` calls `getResolvedShellEnv()`, extracts `PATH`, and reconstructs the `ResolvedPath` shape (`path`, `source`, `shellDirs`, `fallbackDirs`).
- Preserve the existing Windows fallback logic in `getResolvedShellPath()` when shell env is unavailable.

**Patterns to follow:**
- Existing `ResolvedPath` interface and return shape.

**Test scenarios:**
- Happy path: `getResolvedShellPath()` returns a `ResolvedPath` with `source: 'shell'` when shell env capture succeeds.
- Error path: `getResolvedShellPath()` returns a `ResolvedPath` with `source: 'fallback'` when shell env capture fails.

**Verification:**
- `/api/system/path` continues to return the same JSON shape without frontend changes.
- Existing `getResolvedShellPath()` consumers compile without modification.

---

### U4. Update server initialization

**Goal:** Switch the server startup call from PATH initialization to full env initialization.

**Requirements:** R3

**Dependencies:** U1

**Files:**
- Modify: `src/server/index.ts`

**Approach:**
- Replace `import { initializeResolvedShellPath } from './utils/resolve-shell-path.js'` with `import { initializeResolvedShellEnv } from './utils/resolve-shell-env.js'`.
- Replace the `initializeResolvedShellPath()` call with `initializeResolvedShellEnv()`.
- Update the error log message to match.

**Test scenarios:**
- Test expectation: none — this is a wiring change with no behavioral surface of its own.

**Verification:**
- Server starts without errors.
- Diagnostic logs show `[resolve-shell-env]` instead of `[resolve-shell-path]` during startup.

---

### U5. Add tests for shell environment capture

**Goal:** Provide test coverage for the new `resolve-shell-env.ts` utility.

**Requirements:** R1, R2, R5

**Dependencies:** U1

**Files:**
- Create: `src/server/utils/resolve-shell-env.test.ts`

**Approach:**
- Use Node.js built-in `node:test` and `node:assert` to match the project's existing client-side test convention.
- Mock `child_process.spawn` to simulate shell output, timeouts, and errors.
- Reset the internal cache between tests.

**Test scenarios:**
- Happy path: Shell outputs null-delimited env; parser returns the correct record.
- Happy path: PATH contains multiple directories; all are preserved.
- Edge case: Value contains `=` sign; parser splits only on the first `=`.
- Edge case: Value is empty string; parser preserves it as an empty value.
- Error path: Spawn throws immediately; returns `null`.
- Error path: Process exits with code 1; returns `null`.
- Error path: stdout is empty; returns empty record (not `null`).
- Edge case: Rapid successive calls; only one spawn occurs due to caching.

**Verification:**
- `node --test src/server/utils/resolve-shell-env.test.ts` passes.

---

## System-Wide Impact

- **Interaction graph:** `resolve-shell-env.ts` is called at server startup and by `sdk-env.ts` during session creation. No other direct consumers.
- **Error propagation:** Shell capture failures are silent (logged via `sidecarLog`); downstream code falls back to `process.env`. SDK sessions always start.
- **State lifecycle risks:** The env cache is populated once at startup and never refreshed. If a user changes their shell config while the app is running, they must restart the app to pick up changes. This matches the existing PATH caching behavior.
- **API surface parity:** The `/api/system/path` endpoint is unchanged. No frontend changes required.
- **Unchanged invariants:** Windows behavior, custom paths per-session loading, provider credential routing through `Options.settings.env`, and the `ResolvedPath` interface shape are all preserved.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `-ilc` triggers slow shell plugins (oh-my-zsh, powerlevel10k) and hits the 5s timeout | Keep the existing timeout; log clearly; fallback to `process.env` ensures sessions still work |
| `-i` causes some shells to print interactive-only noise (prompts, MOTD) that corrupts `env -0` parsing | The parser splits on null bytes, so stray text before the first env entry or after the last is discarded naturally |
| `env -0` is unavailable on unusual systems | The command is POSIX and available on macOS and Linux; if a system lacks it, spawn fails gracefully and falls back |
| Replacing `process.env` with shell env removes system variables set by launchd but not by the shell | The shell env is typically a superset; on the off chance a GUI-only variable is needed, `process.env` can be merged as a secondary source |

---

## Sources & References

- **Origin document:** [docs/brainstorms/shell-env-initialization-requirements.md](docs/brainstorms/shell-env-initialization-requirements.md)
- Related code: `src/server/utils/resolve-shell-path.ts`, `src/server/utils/sdk-env.ts`, `src/server/index.ts`
- Related plans: `docs/plans/2026-05-27-007-feat-claude-code-path-enrichment-plan.md`
