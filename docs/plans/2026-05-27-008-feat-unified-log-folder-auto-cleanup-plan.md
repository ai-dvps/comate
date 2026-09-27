---
title: Unified Log Folder with Automatic Cleanup
type: feat
status: active
date: 2026-05-27
origin: docs/brainstorms/unified-log-folder-with-auto-cleanup-requirements.md
---

# Unified Log Folder with Automatic Cleanup

## Summary

Move all server log files into a single `logs/` folder under the storage directory and add automatic cleanup that deletes files older than 7 days or caps total size at 100 MB. Cleanup runs at server startup and periodically via a background timer. Existing resolver log rotation is preserved.

---

## Problem Frame

Currently server logs are scattered: `sidecar.log` and `sse-diag.log` write to the storage directory root, while `wecom-resolver.log` already writes to `logs/`. Over time these files grow unbounded with no automatic reclamation. Developers must manually delete old logs to free space. This plan consolidates paths and adds cleanup to keep disk usage predictable.

---

## Requirements

- R1. All server log files write to the `logs/` folder under the storage directory.
- R2. Cleanup deletes files whose modification time is older than 7 days.
- R3. Cleanup caps total `logs/` folder size at 100 MB, deleting oldest files first.
- R4. Cleanup runs at server startup and periodically during uptime.
- R5. Cleanup errors are silently ignored to avoid disrupting server operations.
- R6. Existing resolver log rotation (10 MB per file) continues to work.

---

## Scope Boundaries

- Client-side browser logging behavior (POST to `/api/log`) stays unchanged.
- No new logging library (pino, winston, etc.) is introduced.
- Cleanup settings are hardcoded; no environment variables or UI configuration.
- Log content, format, and levels remain unchanged.
- No rotation is added to sidecar or diag loggers.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/utils/sidecar-logger.ts` — writes to `dataDir/sidecar.log` using `appendFileSync`
- `src/server/utils/diag-logger.ts` — writes to `dataDir/sse-diag.log` using `appendFileSync`
- `src/server/utils/resolver-logger.ts` — writes to `dataDir/logs/wecom-resolver.log` with 10 MB rotation
- `src/server/storage/data-dir.ts` — provides `getStorageDir()` which returns `COMATE_DATA_DIR` or `~/.comate`
- `src/server/index.ts` — server entry point with startup initialization and graceful shutdown
- `src/server/services/wecom-user-resolver.ts` — demonstrates the background timer pattern: `setInterval` with `.unref()`, stored timer handle, `shutdown()` cleanup

### Institutional Learnings

- Stale `dist/server/` build cache can hide server-side diagnostic changes — verify changes are executing by clearing or rebuilding before relying on log output.
- Background timers should call `.unref()` so they do not keep the Node.js process alive indefinitely.
- File system operations in server utils consistently use synchronous `fs` APIs with `try/catch` silent degradation.

---

## Key Technical Decisions

- **Shared cleanup utility module** rather than inline cleanup in each logger: keeps loggers focused on writing, makes cleanup logic reusable and testable in isolation.
- **Synchronous fs APIs for cleanup** (`readdirSync`, `statSync`, `unlinkSync`): matches the existing server utils convention used by all three loggers.
- **Background timer with `.unref()`** for periodic cleanup: follows the established `WeComUserIdResolver` pattern and avoids blocking process exit.
- **One-time legacy root log deletion** on startup: deletes `sidecar.log` and `sse-diag.log` from the storage root if they exist, satisfying the success criterion that no `.log` files remain in the root with minimal complexity.

---

## Open Questions

### Resolved During Planning

- None

### Deferred to Implementation

- Exact cleanup interval period: assumed to be 6 hours as a reasonable default, but the implementer may tune based on expected log volume.

---

## Implementation Units

### U1. Create shared log directory helper and cleanup utility

**Goal:** Centralize logs directory path and cleanup logic in a single utility module.

**Requirements:** R2, R3, R5

**Dependencies:** None

**Files:**
- Create: `src/server/utils/log-cleanup.ts`

**Approach:**
- Export `getLogsDir()` that returns `path.join(getStorageDir(), 'logs')`.
- Export `runLogCleanup()` that:
  1. Reads the `logs/` directory.
  2. Deletes files with `mtime` older than 7 days.
  3. If total folder size still exceeds 100 MB, deletes oldest files first until under the limit.
  4. Catches and ignores all errors.
- Use sync fs APIs throughout to match existing patterns.

**Patterns to follow:**
- Existing logger silent-error handling (`try { ... } catch { // ignore }`)
- `mkdirSync(..., { recursive: true })` for directory creation

**Test scenarios:**
- Happy path: folder with 3 files (8 days old, 6 days old, 1 day old). After cleanup, only the 8-day-old file is deleted.
- Edge case: folder totaling 150 MB with files of varying ages. After age cleanup, size-based cleanup removes oldest files until under 100 MB.
- Edge case: empty or non-existent `logs/` directory. Cleanup completes without error.
- Error path: read-only or locked file in `logs/`. Cleanup continues, error silently ignored.

**Verification:**
- `runLogCleanup()` handles all scenarios without throwing.
- Files older than 7 days are removed.
- Size cap is enforced when needed.

---

### U2. Update sidecar and diag logger paths

**Goal:** Move `sidecar.log` and `sse-diag.log` into the shared `logs/` folder.

**Requirements:** R1

**Dependencies:** U1

**Files:**
- Modify: `src/server/utils/sidecar-logger.ts`
- Modify: `src/server/utils/diag-logger.ts`

**Approach:**
- Import `getLogsDir()` from the new utility.
- Update `logFile` path to `path.join(getLogsDir(), 'sidecar.log')` and `path.join(getLogsDir(), 'sse-diag.log')` respectively.
- Ensure the directory exists before writing (the utility should create it, but each logger may also guard).

**Patterns to follow:**
- Existing `mkdirSync(..., { recursive: true })` guard pattern

**Test scenarios:**
- Happy path: after server starts, `logs/sidecar.log` and `logs/sse-diag.log` exist and receive new log lines.
- Integration: client POST to `/api/log` results in output appended to `logs/sse-diag.log`.
- Edge case: server starts when `logs/` does not exist; directory is created and logs write successfully.

**Verification:**
- Log files are created in `logs/` and not in the storage root.
- Existing console output behavior is preserved.

---

### U3. Update resolver logger to use shared directory helper

**Goal:** Ensure resolver logger uses the same `logs/` directory convention via the shared helper.

**Requirements:** R1, R6

**Dependencies:** U1

**Files:**
- Modify: `src/server/utils/resolver-logger.ts`

**Approach:**
- Import `getLogsDir()` from the new utility.
- Update `logsDir` to use the shared helper instead of computing the path independently.
- Preserve the existing 10 MB rotation behavior exactly.

**Patterns to follow:**
- Existing rotation logic in `resolver-logger.ts`

**Test scenarios:**
- Happy path: resolver logs write to `logs/wecom-resolver.log`.
- Happy path: when `logs/wecom-resolver.log` exceeds 10 MB, rotation to `.1` still works.
- Edge case: resolver log backup `.1` file is also subject to age and size cleanup on subsequent runs.

**Verification:**
- Resolver log behavior is unchanged except the directory path source.
- Rotation continues to work as before.

---

### U4. Wire cleanup into server startup and lifecycle

**Goal:** Run cleanup at server startup and schedule periodic execution while the server runs.

**Requirements:** R4, R5

**Dependencies:** U1

**Files:**
- Modify: `src/server/index.ts`

**Approach:**
- Import `runLogCleanup()` and `getLogsDir()` from the new utility.
- Call `runLogCleanup()` once during server startup (inside or near the `app.listen` callback).
- Schedule periodic cleanup with `setInterval` and call `.unref()` on the timer handle.
- On graceful shutdown, clear the interval timer.
- Also delete known legacy log files (`sidecar.log`, `sse-diag.log`) from the storage root if they exist, using silent error handling.

**Patterns to follow:**
- `WeComUserIdResolver` timer pattern: store handle, `.unref()`, clear on shutdown
- Existing startup initialization sequence in `app.listen` callback

**Test scenarios:**
- Happy path: server starts, cleanup runs without errors, interval is scheduled.
- Happy path: legacy `sidecar.log` and `sse-diag.log` in storage root are removed on startup.
- Error path: cleanup failure during startup does not prevent the server from listening.
- Integration: after extended uptime, old log files are deleted by periodic cleanup.

**Verification:**
- Cleanup runs at startup without crashing.
- Periodic interval is active and has `.unref()`.
- Server remains stable; shutdown clears the timer.

---

## System-Wide Impact

- **Interaction graph:** `diag-logger` is used by the `/api/log` endpoint and server startup logging. The path change is transparent to consumers.
- **Error propagation:** Cleanup errors are caught and ignored; no new failure modes are introduced for the server.
- **State lifecycle risks:** Cleanup may delete files while loggers have them open. Node.js `appendFileSync` handles append-only writes safely on most platforms; the brief race window is acceptable for diagnostic logs.
- **Unchanged invariants:** Client `/api/log` behavior, log formats, resolver rotation threshold, and all other server behavior remain unchanged.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Deleting wrong files in `logs/` | The folder is reserved for `.log` files only per the brainstorm decision. |
| Race between cleanup and active log write | Acceptable for diagnostic logs; `appendFileSync` is append-only and tolerant. |
| Legacy log deletion surprises users | Old logs are diagnostic only; the success criterion explicitly requires no `.log` files in the root. |

---

## Sources & References

- **Origin document:** [docs/brainstorms/unified-log-folder-with-auto-cleanup-requirements.md](docs/brainstorms/unified-log-folder-with-auto-cleanup-requirements.md)
- **Related code:** `src/server/utils/sidecar-logger.ts`, `src/server/utils/diag-logger.ts`, `src/server/utils/resolver-logger.ts`, `src/server/storage/data-dir.ts`, `src/server/index.ts`, `src/server/services/wecom-user-resolver.ts`
