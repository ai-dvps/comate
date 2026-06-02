---
title: "Fix nvm/npm Global Binaries Missing from Captured Shell Environment"
type: fix
status: active
date: 2026-06-02
origin: docs/plans/2026-06-02-002-feat-shell-env-initialization-plan.md
---

# Fix nvm/npm Global Binaries Missing from Captured Shell Environment

## Summary

Add a user-configurable `shellInitCommand` setting that runs inside the interactive login shell before `env -0`, allowing nvm (and similar lazy-loaded version managers) to fully initialize and export their PATH modifications. Store the setting alongside `customPaths` in the existing `path-config.json`.

---

## Problem Frame

The interactive login shell capture (`-ilc 'env -0'`) successfully finds tools like `cargo` that are added to PATH directly in `.zshrc` or `.bash_profile`. However, nvm often uses a lazy-loading pattern where `.zshrc` only defines wrapper shell functions (`nvm`, `node`, `npm`) without actually sourcing `nvm.sh`. Since `env -0` never calls any of those functions, `nvm.sh` is never loaded and the npm global bin directory never joins PATH. As a result, npm-installed global binaries like `aidx` remain invisible to SDK sessions even though they work in Terminal.app.

---

## Requirements

- R1. Allow users to configure a shell command that runs before `env -0` during shell environment capture.
- R2. Store the setting in the existing app-specific config file (`~/.comate/path-config.json`).
- R3. Expose the setting via the existing `/api/system/path` REST endpoint.
- R4. When a shell init command is configured, run it in the same shell process before `env -0` so its exported variables are captured.
- R5. Preserve all existing behavior when no shell init command is configured.

---

## Scope Boundaries

- Auto-detecting nvm or other version managers (out of scope — user-configurable command covers all cases)
- UI for editing the setting (out of scope — API-only for now; can be added to settings page later)
- Windows-specific changes (out of scope — shell capture is already skipped on Windows)
- Changing the shell used for capture (out of scope — continues to use `$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh`)

---

## Context & Research

### Relevant Code and Patterns

- `src/server/utils/resolve-shell-env.ts` — spawns `$SHELL -ilc 'env -0'` and parses null-delimited output. The command is hardcoded on line 45.
- `src/server/utils/path-config.ts` — loads/saves `~/.comate/path-config.json` with `customPaths: string[]`. Simple JSON read/write pattern using `getStorageDir()`.
- `src/server/routes/system.ts` — `GET /api/system/path` returns `{ resolvedPath, customPaths, sources }`. `POST /api/system/path` accepts `{ customPaths }`, validates, persists, and returns updated state.
- `src/server/utils/resolve-shell-env.test.ts` — existing tests mock `child_process.spawn`; the command string is an implementation detail not currently asserted.

### Institutional Learnings

- `path-config.json` is the established location for app-specific server configuration (precedent: `customPaths`).
- Shell capture failures are silent and fall back to `process.env`; the same grace should apply if the init command fails.
- The `/api/system/path` endpoint is already used by the frontend for diagnostics; extending it keeps diagnostics accurate.

---

## Key Technical Decisions

- **Extend `path-config.json` rather than `~/.claude/settings.json`:** The setting is app-specific server configuration, not a Claude Code SDK setting. Keeping it in `path-config.json` avoids conflating the two config domains.
- **User-configurable command, not hardcoded nvm activation:** A generic `shellInitCommand` covers nvm, rbenv, pyenv, and any future tool. The trade-off is a one-time user configuration step. For nvm, the typical value is `export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use default`.
- **Run init command in the same `-ilc` shell:** `spawnShellForEnv` constructs the command as `${initCommand}; env -0` (or just `env -0` when unset). This keeps the spawn logic simple and ensures exports affect the captured environment.
- **Do not validate the init command:** The shell will report errors naturally; we log stderr on non-zero exit and fall back to `null` (then `process.env`). Adding validation would require re-implementing shell syntax parsing.

---

## Implementation Units

### U1. Add `shellInitCommand` to path-config.ts

**Goal:** Extend the config file schema and loader/saver to support `shellInitCommand`.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `src/server/utils/path-config.ts`

**Approach:**
- Extend `PathConfig` interface to `interface PathConfig { customPaths: string[]; shellInitCommand?: string; }`.
- Add `loadShellInitCommand(): string | undefined` that reads `shellInitCommand` from the config file, defaulting to `undefined`.
- Update `saveCustomPaths` to `savePathConfig(config: PathConfig)` (or keep `saveCustomPaths` and add `saveShellInitCommand`). Evaluate which pattern is cleaner — since `customPaths` and `shellInitCommand` live in the same file, a unified save is less racy.

**Patterns to follow:**
- Existing `loadCustomPaths` / `saveCustomPaths` read/write pattern in `path-config.ts`.

**Test scenarios:**
- Config file missing: returns `undefined` for shellInitCommand.
- Config file with only `customPaths`: returns `undefined` for shellInitCommand.
- Config file with `shellInitCommand`: returns the configured string.
- Config file with `shellInitCommand` set to empty string: returns empty string ( caller decides whether to treat as unset).

**Verification:**
- `loadShellInitCommand()` returns `undefined` when config file is missing.
- `loadShellInitCommand()` returns the saved value after it is persisted.

---

### U2. Use shellInitCommand in resolve-shell-env.ts

**Goal:** Read the configured init command and prepend it to the shell spawn command.

**Requirements:** R1, R4, R5

**Dependencies:** U1

**Files:**
- Modify: `src/server/utils/resolve-shell-env.ts`

**Approach:**
- Import `loadShellInitCommand` from `./path-config.js`.
- In `spawnShellForEnv`, read the init command before spawning.
- Build the shell command:
  - If `initCommand` is set and non-empty: `${initCommand}; env -0`
  - Otherwise: `env -0`
- Pass the constructed command to `_spawn(shell, ['-ilc', command], ...)`.
- When the shell exits non-zero, the existing error path already logs stderr and resolves `null`, which correctly falls back to `process.env`.

**Patterns to follow:**
- Existing `spawnShellForEnv` structure: timeout, finish guard, stdout/stderr accumulation, close/error handlers.

**Test scenarios:**
- With init command configured: mock spawn receives `['-ilc', 'echo setup; env -0']` (or equivalent).
- With no init command configured: mock spawn receives `['-ilc', 'env -0']` — preserves existing behavior.
- Init command fails (non-zero exit): falls back to `null` via existing error handling.
- Init command outputs to stderr: stderr is logged but does not prevent env capture if exit code is 0.

**Verification:**
- When `shellInitCommand` is set, the spawned shell command includes it before `env -0`.
- When `shellInitCommand` is unset, behavior is identical to before this change.

---

### U3. Expose shellInitCommand via system API

**Goal:** Allow the frontend (or manual API consumers) to read and write the `shellInitCommand` setting.

**Requirements:** R3

**Dependencies:** U1

**Files:**
- Modify: `src/server/routes/system.ts`

**Approach:**
- Import `loadShellInitCommand` from `path-config.ts`.
- Update `GET /api/system/path` response to include `shellInitCommand: loadShellInitCommand()`.
- Update `POST /api/system/path` to accept optional `shellInitCommand` in the body.
- If `shellInitCommand` is present and is a string, save it alongside `customPaths`.
- If `shellInitCommand` is `null` or omitted, leave the existing value unchanged.
- Consider whether to unify the save function in `path-config.ts` to write both fields atomically.

**Patterns to follow:**
- Existing `POST /api/system/path` validation pattern for `customPaths`.

**Test scenarios:**
- GET returns `shellInitCommand: undefined` when not configured.
- POST with `{ customPaths: [...], shellInitCommand: "echo test" }` persists both fields.
- POST with only `customPaths` leaves `shellInitCommand` unchanged.

**Verification:**
- `GET /api/system/path` includes `shellInitCommand` in the JSON response.
- `POST /api/system/path` with a `shellInitCommand` string persists it to `path-config.json`.

---

### U4. Add tests for shellInitCommand integration

**Goal:** Cover the new behavior in `resolve-shell-env.test.ts` and ensure the init command is correctly threaded through the spawn.

**Requirements:** R1, R4, R5

**Dependencies:** U2

**Files:**
- Modify: `src/server/utils/resolve-shell-env.test.ts`

**Approach:**
- Add tests that mock `loadShellInitCommand` (or mock the config file) to return a command string.
- Assert that the spawned command includes the init command.
- Add a test for the fallback when `loadShellInitCommand` returns `undefined`.
- Since the existing tests mock `_spawn` directly, use `__setSpawnForTesting` and inspect the arguments received.

**Test scenarios:**
- Configured init command is prepended to `env -0` in the spawn args.
- Unconfigured init command results in exactly `env -0` in the spawn args.
- Init command + successful env capture: parsed env includes variables exported by the init command.

**Verification:**
- `npx tsx --test src/server/utils/resolve-shell-env.test.ts` passes.

---

## System-Wide Impact

- **Interaction graph:** `path-config.ts` is read by `resolve-shell-env.ts` (at startup) and `system.ts` (on API calls). `sdk-env.ts` is unaffected directly — it continues to consume `getResolvedShellEnv()`.
- **Error propagation:** If the init command causes the shell to exit non-zero, the existing fallback to `process.env` applies. SDK sessions still start.
- **State lifecycle risks:** Changing `shellInitCommand` requires restarting the app to take effect because shell env is cached at startup. Document this in any future UI.
- **API surface parity:** `/api/system/path` gains one new field; existing consumers that ignore unknown fields are unaffected.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Init command is user-supplied and could be destructive | The command runs in a short-lived shell spawn with the same privileges as the app. This is identical to the trust model of `customPaths` and shell env capture generally. |
| Init command causes the shell to hang | The existing 5s timeout still applies to the entire spawn. |
| Adding `shellInitCommand` to `path-config.json` breaks older app versions that read the file | Older versions ignore unknown JSON keys. The `loadCustomPaths()` function only reads `customPaths`, so it is unaffected. |

---

## Sources & References

- **Parent plan:** [docs/plans/2026-06-02-002-feat-shell-env-initialization-plan.md](docs/plans/2026-06-02-002-feat-shell-env-initialization-plan.md)
- Related code: `src/server/utils/resolve-shell-env.ts`, `src/server/utils/path-config.ts`, `src/server/routes/system.ts`
