---
title: Debug Toggle Setting
type: feat
status: active
date: 2026-06-02
---

# Debug Toggle Setting

## Summary

Add a persistent `debugEnabled` boolean setting to the GUI application, disabled by default. When enabled, the `CLAUDE_CODE_DEBUG_LOGS_DIR` environment variable is injected into the Claude Agent SDK options so debug logs are written to the application's standard logs folder (`~/.comate/logs`).

---

## Problem Frame

Diagnosing issues like the Windows auto-compact behavior requires inspecting Claude Code SDK debug logs. Currently there is no in-app way to enable debug logging for SDK sessions spawned by the GUI wrapper. Users must manually set environment variables before launching the application.

---

## Requirements

- R1. A toggle in Settings > General enables or disables Claude Code SDK debug logging.
- R2. The toggle is off by default.
- R3. When enabled, `CLAUDE_CODE_DEBUG_LOGS_DIR` is set to the app's logs directory (`~/.comate/logs`) for every new or resumed SDK session.
- R4. Pre-existing `CLAUDE_CODE_DEBUG_LOGS_DIR` or `DEBUG` environment variables in the shell or Claude Code settings take precedence over the toggle (the toggle is a convenience, not an override).
- R5. The setting survives application restarts.
- R6. The setting is toggleable without restarting the application (applies to the next session start/resume).

---

## Scope Boundaries

- Does not implement log viewing or log tailing UI in the application.
- Does not change the default debug log path when the toggle is off.
- Does not retroactively enable logging for already-running SDK sessions.
- Does not add log level controls (only on/off for the SDK debug log directory).

---

## Context & Research

### Relevant Code and Patterns

- Server-side JSON config persistence: `src/server/utils/path-config.ts` uses `getStorageDir()` and reads/writes a JSON file in `~/.comate/`.
- Logs directory helpers: `src/server/utils/log-cleanup.ts` exports `getLogsDir()` and `ensureLogsDir()`.
- SDK option construction: `src/server/services/chat-service.ts` (`buildSdkOptions`) merges env vars via `buildClaudeEnv()` and then injects provider settings and PATH enrichment.
- System API routes: `src/server/routes/system.ts` hosts `/api/system/path` GET/POST as the pattern for server-side settings.
- Self-contained settings section UI: `PathConfigSection` in `src/client/components/SettingsPanel.tsx` fetches server state on mount and POSTs updates independently.
- Toggle button pattern: `GeneralTab` uses `bg-accent`/`bg-border` toggle buttons for boolean settings.

### Institutional Learnings

- `src/server/utils/claude-settings.ts` shows that the SDK already respects externally-set `CLAUDE_CODE_*` env vars; we only need to inject ours before `buildClaudeEnv` returns or directly into the merged `env` object.

---

## Key Technical Decisions

- **Server-side JSON file over localStorage or SQLite**: The setting must be readable by the Node server when constructing SDK options. Following the existing `path-config.json` pattern keeps the change lightweight and avoids adding a new SQLite table for a single boolean.
- **Inject into `env` after `buildClaudeEnv`**: `buildClaudeEnv` reads the user's Claude Code `settings.json`. To respect R4 (precedence), we inject `CLAUDE_CODE_DEBUG_LOGS_DIR` only if it is not already present in the merged `env` object.
- **Self-contained UI section**: Rather than threading the toggle through `useAppSettings` (which is localStorage-only and client-side), the UI section fetches and persists via the system API, mirroring `PathConfigSection`.

---

## Open Questions

### Resolved During Planning

- **Where should the setting be persisted?** → Server-side JSON file (`~/.comate/app-settings.json`), following the `path-config.json` pattern.
- **What takes precedence if the user already has `DEBUG` set?** → Existing `CLAUDE_CODE_DEBUG_LOGS_DIR` and `DEBUG` env vars win; the toggle only sets the directory variable when absent.

---

## Implementation Units

### U1. Server-Side App Settings Module and API

**Goal:** Add a persistent server-side app settings file and expose read/write endpoints.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Create: `src/server/utils/app-settings.ts`
- Modify: `src/server/routes/system.ts`

**Approach:**
- Create `app-settings.ts` with `loadAppSettings()` and `saveAppSettings()` reading/writing `app-settings.json` in `getStorageDir()`.
- Default shape: `{ debugEnabled: false }`.
- Add `GET /api/system/app-settings` and `POST /api/system/app-settings` to `system.ts`.

**Patterns to follow:**
- `src/server/utils/path-config.ts` (file I/O and error handling)
- `src/server/routes/system.ts` (existing `/path` GET/POST handlers)

**Test scenarios:**
- Happy path: GET returns default `{ debugEnabled: false }` when file missing.
- Happy path: POST updates value and subsequent GET reflects it.
- Edge case: corrupt JSON file is treated as default and overwritten on next save.

**Verification:**
- `curl /api/system/app-settings` returns `{ debugEnabled: false }` on a fresh install.
- POST `{ debugEnabled: true }` and GET returns `{ debugEnabled: true }`.

---

### U2. SDK Env Injection

**Goal:** When `debugEnabled` is true, set `CLAUDE_CODE_DEBUG_LOGS_DIR` to the app's logs directory in SDK options.

**Requirements:** R2, R3, R4, R6

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/chat-service.ts`

**Approach:**
- In `buildSdkOptions`, after `const { env } = buildClaudeEnv(...);`, call `loadAppSettings()`.
- If `debugEnabled` and `env.CLAUDE_CODE_DEBUG_LOGS_DIR` is absent, set it to `getLogsDir()`.
- Also ensure `DEBUG` is not already set in `env` or `process.env` before deciding to inject (to satisfy R4).
- Log the injection via `sidecarLog` for diagnostics.

**Patterns to follow:**
- Existing `sidecarLog` diagnostic lines in `buildSdkOptions`.

**Test scenarios:**
- Happy path: `debugEnabled=true` and no existing `CLAUDE_CODE_DEBUG_LOGS_DIR` → env contains the logs dir.
- Edge case: `debugEnabled=true` but `CLAUDE_CODE_DEBUG_LOGS_DIR=~/custom` already set → custom value preserved.
- Edge case: `debugEnabled=false` → no injection occurs.

**Verification:**
- Server logs show `CLAUDE_CODE_DEBUG_LOGS_DIR=<logsDir>` when enabled and absent.
- Server logs do not show injection when disabled or when env var already present.

---

### U3. Settings UI and i18n

**Goal:** Add a toggle in Settings > General that fetches and updates the server-side debug setting.

**Requirements:** R1, R2, R5

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:**
- Add a self-contained `DebugSettingSection` component inside `SettingsPanel.tsx` (similar to `PathConfigSection`).
- On mount, `fetch('/api/system/app-settings')` to load the current value.
- Render a toggle button and label following the existing `GeneralTab` toggle style.
- On toggle, `POST /api/system/app-settings` with the new value.
- Add translation keys under `general.debugLogging`, `general.debugLoggingHint`.

**Patterns to follow:**
- `PathConfigSection` for server-side fetch/POST lifecycle.
- `GeneralTab` toggle for visual styling (`bg-accent`/`bg-border`, translate-x-4).

**Test scenarios:**
- Happy path: toggle fetches initial state, reflects it, and updates on click.
- Edge case: network error on fetch → falls back to off state without crashing.
- Edge case: network error on save → toggle reverts or shows no-op (consistent with `PathConfigSection` error handling).

**Verification:**
- Opening Settings > General shows the debug toggle matching the persisted state.
- Clicking the toggle updates the server-side file immediately.

---

## System-Wide Impact

- **Interaction graph:** The system routes module gains two new endpoints. `chat-service.ts` reads app settings on every `buildSdkOptions` invocation (session start and resume).
- **Error propagation:** JSON parse/write errors in `app-settings.ts` fall back to defaults silently, matching `path-config.ts` behavior.
- **State lifecycle risks:** None. The setting is read at SDK session construction time; no partial-write or cache invalidation concerns.
- **API surface parity:** N/A — this is an internal app setting.
- **Integration coverage:** Toggle off → verify no `CLAUDE_CODE_DEBUG_LOGS_DIR` in SDK env. Toggle on with pre-existing env var → verify original value preserved.
- **Unchanged invariants:** The default Claude Code debug log path (`~/.claude/debug/`) and the `DEBUG` env variable behavior remain unchanged when the toggle is off.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| File I/O race if two server instances run concurrently | Acceptable: this is a single-user desktop app; concurrent writes to `app-settings.json` are extremely unlikely. If needed later, add file locking or migrate to SQLite. |
| Toggle confusion if user also sets `DEBUG` without `CLAUDE_CODE_DEBUG_LOGS_DIR` | Documented in R4: the toggle only sets the log directory. It does not gate debug output itself; Claude Code's own `isDebugMode` logic still controls whether debug output is produced. |

---

## Documentation / Operational Notes

- No runbook or rollout steps required. The setting is user-facing and self-service.

---

## Sources & References

- `src/server/utils/path-config.ts` — persistence pattern
- `src/server/utils/log-cleanup.ts` — logs directory helpers
- `src/server/services/chat-service.ts` — SDK option construction
- `src/server/routes/system.ts` — API route pattern
- `src/client/components/SettingsPanel.tsx` — UI pattern (`PathConfigSection`, toggle styling)
