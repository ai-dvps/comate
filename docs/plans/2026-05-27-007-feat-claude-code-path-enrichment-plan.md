---
title: "feat: Enrich PATH for Claude Code SDK to discover user-installed CLI tools"
type: feat
status: completed
date: 2026-05-27
origin: docs/brainstorms/2026-05-27-claude-code-path-enrichment-requirements.md
---

# feat: Enrich PATH for Claude Code SDK to discover user-installed CLI tools

## Summary

Extract shared environment utilities and add automatic PATH enrichment for the Claude Code SDK child process. Capture the user's shell PATH at sidecar startup, fall back to known directories, expose the resolved PATH in Settings, and allow manual additions persisted server-side.

---

## Problem Frame

The Tauri GUI app → Node sidecar → SDK → Claude Code chain inherits only the minimal OS PATH, missing directories added by shell initialization files like `.zshrc` and `.bash_profile`. Tools installed via Homebrew, npm global, or custom paths fail when Claude Code tries to invoke them. (see origin)

---

## Requirements

- R1. Capture shell PATH at server startup
- R2. Cache captured PATH for server lifetime
- R3. Fallback to known directories if shell capture fails
- R4. Display resolved PATH in Settings UI
- R5. Allow manual PATH additions in Settings
- R6. Persist custom paths across restarts
- R7. Merge enriched PATH into SDK options
- R8. Compose cleanly with existing WeCom CLI PATH injection
- R9. Log resolved PATH for diagnostics

**Origin acceptance examples:** AE1, AE2, AE3

---

## Scope Boundaries

- Per-workspace PATH overrides — PATH is a machine-level environment concern.
- Modifying system PATH or shell rc files — the app reads but never writes system configuration.
- Auto-installation of missing CLI tools.
- Support for environment variables beyond PATH.
- Real-time PATH monitoring without app restart.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/services/chat-service.ts` and `src/server/services/commands-service.ts` each contain duplicate `buildClaudeEnv`, `prependEnvPath`, and `getPathEnvKey` logic. Both construct SDK options independently.
- `src/server/index.ts` boots the Express server; no PATH capture happens today.
- `src/server/utils/claude-settings.ts` demonstrates the team's preferred pattern for fragile env propagation: explicitly read a file and inject values rather than fix the propagation chain.
- `src/server/utils/normalize-windows-path.ts` strips extended-length path prefixes for Windows `spawn`/`exec` compatibility.
- `src/server/storage/data-dir.ts` resolves the app data directory (`~/.comate` or `$COMATE_DATA_DIR`).
- `src/client/hooks/use-app-settings.ts` persists app-level settings to `localStorage`; the server cannot read `localStorage`.
- `src/client/components/SettingsPanel.tsx` contains the `WeComCliSection` component, which follows the pattern of fetching status from an API and triggering install/uninstall actions.
- No test framework is configured in this repository.

### Institutional Learnings

- The Windows auth fix (`docs/plans/2026-05-25-002-fix-windows-claude-code-auth-plan.md`) established that environment propagation through Tauri → sidecar → SDK → child process is fragile and platform-specific. Explicit read-and-inject is the team's chosen mitigation.
- The WeCom CLI installation plan (`docs/plans/2026-05-22-008-feat-install-wecom-cli-to-path-plan.md`) uses `~/.local/bin` as the user-local bin directory on macOS/Linux and `%USERPROFILE%\.local\bin` on Windows. These same directories should appear in the fallback list.

---

## Key Technical Decisions

- **Extract shared env utilities as a prerequisite:** `buildClaudeEnv`, `prependEnvPath`, and `getPathEnvKey` are duplicated between `chat-service.ts` and `commands-service.ts`. Extracting them first eliminates duplication and ensures PATH enrichment applies consistently to both chat queries and command discovery.
- **Server-side file persistence for custom paths:** The sidecar cannot read the frontend's `localStorage`. A JSON file in the app data directory is simple, server-accessible, and consistent with the existing `loadClaudeSettings` pattern.
- **Hybrid detection (shell capture + heuristics):** Matches the origin's hybrid approach. Shell capture gives the exact terminal PATH; heuristics provide resilience when shell configs are broken or the shell is unavailable.
- **Best-effort Windows shell capture:** Windows lacks a standard login-shell mechanism. The plan relies on `process.env.PATH` (which already includes the registry user PATH) plus known-directory heuristics rather than spawning a shell.

---

## Open Questions

### Resolved During Planning

- **Shell invocation strategy:** macOS/Linux spawn the user's default login shell with a short timeout; fallback to common shells (zsh, bash, sh). Windows uses `process.env.PATH` as the base.
- **Fallback directories:** macOS (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`), Linux (`~/.local/bin`, `/usr/local/bin`), Windows (`%USERPROFILE%\.local\bin`, `%APPDATA%\npm`).
- **Persistence mechanism:** A JSON file in the app data directory (`~/.comate` or `$COMATE_DATA_DIR`).

### Deferred to Implementation

- ~~Exact timeout duration for shell capture~~ → **Resolved:** 5 seconds.
- ~~Whether to deduplicate overlapping directories in the merged PATH~~ → **Resolved:** Deduplicate to prevent PATH bloat; maintain precedence order (first occurrence wins).

---

## Implementation Units

### U1. Extract shared SDK environment utilities

**Goal:** Deduplicate `buildClaudeEnv`, `prependEnvPath`, and `getPathEnvKey` into a shared module.

**Requirements:** R7, R8

**Dependencies:** None

**Files:**
- Create: `src/server/utils/sdk-env.ts`
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/server/services/commands-service.ts`

**Approach:**
- Move `buildClaudeEnv`, `prependEnvPath`, and `getPathEnvKey` into the new shared module.
- Export them for use by both services.
- Update `chat-service.ts` and `commands-service.ts` to import from the shared module.
- Preserve exact behavior: no changes to env construction, PATH prepending, or Windows case handling.

**Patterns to follow:**
- Existing env construction in `chat-service.ts` and `commands-service.ts`
- Service singleton pattern

**Test scenarios:**
- Happy path: `ChatService.buildSdkOptions` still produces correct env with `ANTHROPIC_API_KEY`, `CLAUDE_CONFIG_DIR`, and `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
- Happy path: `CommandsService.buildSdkOptions` still produces correct env.
- Integration: WeCom CLI directory still prepends correctly after extraction.
- Edge case: Windows `Path` / `PATH` case handling still works.

**Verification:**
- Both services build SDK options without error.
- `sidecar.log` shows identical env construction as before the extraction.

---

### U2. Capture shell PATH and implement fallback heuristics

**Goal:** Create a utility that resolves the user's full shell PATH at startup with platform-aware fallback.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Create: `src/server/utils/resolve-shell-path.ts`
- Modify: `src/server/index.ts`

**Approach:**
- At server startup, attempt shell PATH capture:
  - macOS/Linux: spawn the user's default login shell non-interactively with a 5-second timeout, kill the process if it exceeds the timeout, and parse `PATH` from stdout; fallback to zsh, bash, then sh.
  - Windows: start from `process.env.PATH` as the base (already includes registry user PATH) and prepend any existing fallback directories not already present.
- If shell capture fails or times out, use platform-specific known directories filtered by existence:
  - macOS: `/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin`, `/usr/local/sbin`, `~/.local/bin`
  - Linux: `~/.local/bin`, `/usr/local/bin`, `/usr/local/sbin`
  - Windows: `%USERPROFILE%\.local\bin`, `%APPDATA%\npm`
- Cache the resolved PATH string for the server process lifetime.
- Export a `getResolvedShellPath()` function that returns the cached string.
- Log the capture source and result via `sidecarLog`.

**Patterns to follow:**
- `loadClaudeSettings` pattern: explicit read-and-inject rather than fixing propagation.
- `sidecarLog` diagnostic pattern.

**Test scenarios:**
- Happy path (macOS/Linux): shell capture returns a PATH containing expected directories like `/opt/homebrew/bin`.
- Happy path (Windows): `process.env.PATH` used as the base with existing fallback directories prepended.
- Error path: shell capture times out; process is killed and fallback directories are used.
- Error path: shell not found; fallback directories are used.
- Edge case: no fallback directories exist; returns an empty string so the base `process.env.PATH` is used unchanged.

**Verification:**
- `sidecar.log` shows the resolved PATH and its source (shell capture, fallback, or none) at startup.
- The cache returns the same result on subsequent calls without re-spawning the shell.

---

### U3. Add server API for custom PATH management

**Goal:** Persist and serve user-defined custom PATH additions.

**Requirements:** R4, R5, R6

**Dependencies:** None (can be developed in parallel with U1–U2)

**Files:**
- Create: `src/server/utils/path-config.ts`
- Modify: `src/server/routes/system.ts`
- Modify: `src/server/index.ts`

**Approach:**
- `path-config.ts`:
  - Read and write `path-config.json` in the app data directory.
  - Schema: `{ customPaths: string[] }`.
  - Safe read with fallback to an empty array on missing or corrupt files.
- `system.ts` routes:
  - `GET /api/system/path` → returns `{ resolvedPath: string, customPaths: string[], sources: { shell: string[] | null, fallback: string[] | null } }`.
  - `POST /api/system/path` → accepts `{ customPaths: string[] }`, validates that each entry is a non-empty absolute path, persists to the JSON file, and returns the updated state in the same shape as `GET`.
- Wire the new routes in `src/server/index.ts`.

**Patterns to follow:**
- `src/server/storage/data-dir.ts` for resolving the app data directory.
- Existing API route patterns in `system.ts` and `cli-install.ts`.
- Safe JSON parsing pattern from `sqlite-store.ts`.

**Test scenarios:**
- Happy path: `GET` returns `{ resolvedPath, customPaths: [], sources }` on first call.
- Happy path: `POST` persists custom paths; subsequent `GET` returns them in `customPaths`.
- Error path: `POST` with invalid input (empty string, relative path) returns a 400 response.
- Edge case: config file missing or corrupt → returns empty `customPaths`, no crash.

**Verification:**
- `curl` or equivalent returns the structured response with `resolvedPath`, `customPaths`, and `sources`.
- The config file in the app data directory reflects changes.

---

### U4. Integrate enriched PATH into SDK options and add diagnostics

**Goal:** Merge captured, fallback, and custom PATHs into the SDK environment and log diagnostics.

**Requirements:** R7, R8, R9

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `src/server/utils/sdk-env.ts`
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/server/services/commands-service.ts`

**Approach:**
- In the shared `sdk-env.ts`, `buildClaudeEnv` builds the enriched PATH with this precedence (highest → lowest among what it controls):
  1. User custom paths from `path-config.ts`.
  2. Shell-captured or fallback directories from `resolve-shell-path.ts`.
  3. Base `process.env.PATH`.
- Both services consume `buildClaudeEnv` identically.
- `chat-service.ts` continues to prepend the WeCom CLI directory via `prependEnvPath` after calling `buildClaudeEnv`, giving WeCom CLI the highest overall precedence.
- Deduplicate overlapping directories while preserving precedence (first occurrence wins) to prevent PATH bloat.
- Filter out non-existent directories from custom paths before merging (directories may be added to config before they exist; silently skip missing ones rather than failing).
- Read custom paths from `path-config.ts` on each invocation so Settings changes are effective immediately for new sessions; only the shell-captured/fallback portion is cached at startup.
- Log the final enriched PATH, its sources (shell, fallback, custom, wecom), and any errors via `sidecarLog` in both services' `buildSdkOptions`.

**Patterns to follow:**
- `prependEnvPath` composition pattern.
- Existing diagnostic logging in `buildSdkOptions`.

**Test scenarios:**
- Happy path: Both `ChatService` and `CommandsService` SDK options contain the enriched PATH with shell-captured directories.
- Integration: WeCom CLI directory still prepends correctly and takes highest precedence.
- Happy path: Custom paths from `path-config.ts` are included.
- Edge case: Empty enrichment leaves `PATH` unchanged.
- Error path: `path-config.ts` read failure is logged; execution continues with default enrichment.
- Precedence: WeCom CLI > custom paths > shell/fallback > base PATH.

**Verification:**
- `sidecar.log` shows the enriched PATH in `buildSdkOptions` for both `ChatService` and `CommandsService`.
- Claude Code can resolve tools from enriched directories.

---

### U5. Add PATH display and editing to Settings UI

**Goal:** Show the resolved PATH and allow adding custom directory paths in the Settings UI.

**Requirements:** R4, R5, R6

**Dependencies:** U3

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:**
- In the General tab of `SettingsPanel.tsx`, add a PATH configuration section:
  - Display the resolved PATH (fetched from `GET /api/system/path`) in a scrollable monospace block, including a breakdown of its sources (shell capture, fallback directories, custom paths) so users understand why it looks the way it does.
  - List current custom paths with delete buttons.
  - Provide an input field and an Add button for new paths.
  - On mount, fetch the current state from the API and show a loading state until data arrives.
  - On add or remove, call `POST /api/system/path` and refresh the display immediately (auto-save; no dirty-tracking needed because each row is an independent mutation).
  - Validate new paths client-side (non-empty, absolute path) before calling the API to give fast feedback; rely on server validation as the guard.
  - Show a static hint explaining that shell-captured PATH is refreshed only at app startup, while custom paths take effect for new Claude Code sessions immediately.
- Add i18n keys for labels, hints, button text, and PATH-refresh messaging.

**Patterns to follow:**
- `WeComCliSection` in `SettingsPanel.tsx` (fetch status, POST actions, loading states).
- Existing i18n pattern in `settings.json`.

**Test scenarios:**
- Happy path: Settings page shows the resolved PATH and its sources on load.
- Happy path: Adding a path updates the list, calls the API, and reflects immediately without dirty-tracking.
- Happy path: Removing a path updates the list and calls the API.
- Error path: API error shows a friendly message.
- Error path: Client-side validation rejects empty or relative paths before calling the API.
- Edge case: Empty custom paths shows an appropriate empty state.
- Edge case: PATH source breakdown is readable when no shell capture occurred (fallback-only).

**Verification:**
- The Settings UI displays the resolved PATH.
- Added paths appear in the list and persist after a page reload.
- `sidecar.log` shows custom paths in the enriched PATH after the app restarts.

---

## System-Wide Impact

- **Interaction graph:** The enriched PATH affects every Claude Code SDK spawn (chat queries and command discovery). No callbacks or observers are affected.
- **Error propagation:** Shell capture failure is non-fatal — it falls back to heuristics. `path-config.ts` read failure is non-fatal — it continues with an empty custom path list.
- **State lifecycle risks:** The shell-captured/fallback PATH is cached at startup and requires an app restart to refresh. Custom paths are read per-session and take effect immediately for new Claude Code sessions.
- **API surface parity:** Both `chat-service` and `commands-service` use the same shared utility, ensuring parity.
- **Integration coverage:** Verify that enriched PATH + WeCom CLI prepend + custom paths all compose correctly in a real SDK spawn.
- **Unchanged invariants:** Existing env var injection (`ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`) is untouched. Existing WeCom CLI prepend behavior is preserved.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Shell capture hangs or is slow | Use a 5-second timeout; spawn non-interactively. |
| Windows PATH case sensitivity | Reuse `getPathEnvKey` logic; ensure a single `PATH` key on Windows. |
| Custom paths contain invalid or non-existent directories | Validate inputs; filter non-existent directories before merging. |
| Config file corruption | Safe JSON parse with fallback to an empty array. |
| Duplicated `buildClaudeEnv` drift | Extract to a shared module in U1 before adding enrichment. |

---

## Documentation / Operational Notes

- Users may need to restart the app after installing new CLI tools for them to appear in the enriched PATH (no real-time monitoring).
- Support can check `sidecar.log` to see what PATH the SDK received and which sources contributed (shell capture, fallback directories, custom paths).

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-27-claude-code-path-enrichment-requirements.md](docs/brainstorms/2026-05-27-claude-code-path-enrichment-requirements.md)
- **Related code:** `src/server/services/chat-service.ts`, `src/server/services/commands-service.ts`
- **Related plans:** [docs/plans/2026-05-25-002-fix-windows-claude-code-auth-plan.md](docs/plans/2026-05-25-002-fix-windows-claude-code-auth-plan.md), [docs/plans/2026-05-22-008-feat-install-wecom-cli-to-path-plan.md](docs/plans/2026-05-22-008-feat-install-wecom-cli-to-path-plan.md)
