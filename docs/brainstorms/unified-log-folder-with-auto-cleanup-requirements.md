---
date: 2026-05-27
topic: unified-log-folder-with-auto-cleanup
---

# Unified Log Folder with Automatic Cleanup

## Summary

Move all server log files into a single `logs/` folder and add automatic cleanup that removes files older than 7 days or when the total folder size exceeds 100 MB. Existing resolver log rotation is preserved.

---

## Problem Frame

Server logs are currently scattered across the data directory: `sidecar.log` and `sse-diag.log` write to the data directory root, while `wecom-resolver.log` already writes to `logs/`. Over time these files grow unbounded, consuming disk space with no automatic reclamation. Developers must manually delete old logs to free space, which is easy to forget and leads to unpredictable disk usage.

---

## Requirements

**Log directory consolidation**
- R1. `sidecar-logger` writes to `logs/sidecar.log` instead of `sidecar.log` in the data directory root.
- R2. `diag-logger` writes to `logs/sse-diag.log` instead of `sse-diag.log` in the data directory root.
- R3. `resolver-logger` continues writing to `logs/wecom-resolver.log` (no path change).

**Automatic cleanup**
- R4. On server startup, scan the `logs/` folder and delete files whose modification time is older than 7 days.
- R5. After age-based cleanup, if the total size of the `logs/` folder still exceeds 100 MB, delete the oldest files first until the folder is under the limit.
- R6. Cleanup also runs periodically while the server is running to catch logs created during long uptimes.
- R7. Cleanup errors are silently ignored to avoid disrupting server operations.

---

## Success Criteria

- All server logs are found in the `logs/` folder; no `.log` files remain in the data directory root.
- A server running for weeks without manual intervention does not accumulate log files older than 7 days or exceeding 100 MB total.
- Existing resolver log rotation (10 MB per file) continues to work.

---

## Scope Boundaries

- Client-side browser logging behavior (POST to `/api/log`) stays unchanged.
- No new logging library (pino, winston, etc.) is introduced.
- Cleanup settings are hardcoded; no environment variables or UI configuration for retention period or size cap.
- Log content, format, and levels remain unchanged.

---

## Key Decisions

- Minimal-change approach over shared logger module: preserves existing logger internals and reduces regression risk.
- Hardcoded cleanup policy (7 days / 100 MB) over configurability: simpler surface area; can be made configurable later if needed.
- No file extension filter on cleanup: the `logs/` folder is reserved for `.log` files only.

---

## Dependencies / Assumptions

- The data directory (`COMATE_DATA_DIR` or `getStorageDir()`) is writable and has sufficient space for normal operation.
- The server process has permission to delete files in the `logs/` folder.
- Cleanup frequency (periodic interval) will be set to a reasonable default during planning.
