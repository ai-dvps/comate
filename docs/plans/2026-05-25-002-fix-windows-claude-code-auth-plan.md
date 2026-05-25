---
title: "fix: Ensure Claude Code can authenticate on Windows by loading settings.json"
type: fix
created: 2026-05-25
---

## Problem Frame

On Windows 10 production builds, the bundled Claude Code binary (`claude.exe`) crashes with exit code 1 when the SDK starts a query. The `--version` diagnostic test passes, confirming the binary is executable and discoverable. The user's authentication credentials (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`) are stored in `C:\Users\<user>\.claude\settings.json`, but the sidecar logs show **no `ANTHROPIC_*` environment variables** are present when `buildSdkOptions` constructs the SDK environment.

Claude Code reads its configuration from `~/.claude/settings.json`. When spawned through the SDK from the pkg-bundled sidecar, the chain of environment propagation (Tauri app → sidecar → SDK → Claude Code child process) may fail to provide the correct `USERPROFILE`/`HOME` context, causing Claude Code to miss its settings file and exit during initialization.

## Scope Boundaries

### In Scope
- Read the user's Claude Code `settings.json` in the sidecar and inject `ANTHROPIC_*` values into the SDK environment
- Harden both `ChatService` and `CommandsService` to use the loaded settings
- Add diagnostic logging for the settings resolution path

### Out of Scope
- Changes to the Claude Code binary itself
- Changes to the Anthropic SDK
- UI changes for configuring auth settings
- Reading non-`ANTHROPIC_*` keys from settings.json (can be extended later if needed)

### Deferred to Follow-Up Work
- Surface Claude Code auth errors in the UI with a friendly message
- Allow workspace-level override of `ANTHROPIC_BASE_URL`

## Success Criteria
- Claude Code process no longer exits with code 1 on Windows when `settings.json` contains valid auth
- `sidecar.log` shows resolved `ANTHROPIC_*` values after the fix
- Commands service slash-command discovery works (it also uses `buildSdkOptions`)

## Key Technical Decisions

1. **Load settings.json in sidecar rather than fix env propagation**
   - *Rationale:* Environment propagation through Tauri → pkg sidecar → SDK → child process is fragile and platform-specific. Explicitly reading the file and injecting values is deterministic and testable.
2. **Env vars override settings file**
   - *Rationale:* If a user has explicitly set env vars (e.g., in a dev shell), those should take precedence over the global settings file.
3. **Only inject `ANTHROPIC_*` string values**
   - *Rationale:* These are the keys Claude Code uses for auth. Limiting the scope avoids accidentally passing unrelated config that might conflict with the SDK's own behavior.

## Implementation Units

### U1. Add `loadClaudeSettings()` utility

**Goal:** Create a reusable helper that reads `~/.claude/settings.json` and extracts `ANTHROPIC_*` string values.

**Files:**
- `src/server/utils/claude-settings.ts` (create)

**Approach:**
- Use `os.homedir()` (already used in `data-dir.ts` and `commands-service.ts`) to resolve the user's home directory
- Read `.claude/settings.json` with `fs.readFileSync`
- Parse with `JSON.parse`, wrapped in try/catch (follow `safeJsonParse` pattern from `sqlite-store.ts`)
- Return a `Record<string, string>` containing only keys that start with `ANTHROPIC_` and have string values
- Log the resolved path and whether values were found (use `sidecarLog`)

**Patterns to follow:**
- `src/server/storage/data-dir.ts` for `os.homedir()` usage
- `src/server/storage/sqlite-store.ts` for safe JSON parsing with fallback

**Test scenarios:**
- Happy path: settings.json exists with `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` → both returned
- Missing file: `~/.claude/settings.json` does not exist → returns `{}`
- Malformed JSON: file contains invalid JSON → returns `{}` (no crash)
- Non-string values: `ANTHROPIC_API_KEY` is a number → ignored (only strings injected)
- Missing ANTHROPIC keys: settings.json has only unrelated keys → returns `{}`

**Verification:**
- Unit test passes for all scenarios
- `sidecar.log` shows the resolved settings path when running in a workspace

---

### U2. Integrate settings into `ChatService.buildSdkOptions`

**Goal:** Merge loaded Claude settings into the environment before passing options to the SDK.

**Files:**
- `src/server/services/chat-service.ts` (modify)

**Approach:**
- Import `loadClaudeSettings` from the new utility
- In `buildSdkOptions`, change env construction from:
  ```ts
  const env: Record<string, string | undefined> = { ...process.env };
  ```
  to:
  ```ts
  const claudeSettings = loadClaudeSettings();
  const env: Record<string, string | undefined> = {
    ...claudeSettings,
    ...process.env,
  };
  ```
- This ensures env vars take precedence over the settings file
- The existing `ANTHROPIC_API_KEY` workspace override (line 315-317) continues to work because it runs after the spread
- Log loaded settings keys (without values, for privacy) in `buildSdkOptions`

**Patterns to follow:**
- Existing `buildSdkOptions` env construction in `chat-service.ts`

**Test scenarios:**
- Settings file has `ANTHROPIC_BASE_URL` and `process.env` does not → value is injected
- Both settings file and env have `ANTHROPIC_BASE_URL` → env var wins
- Workspace has `apiKey` set → `ANTHROPIC_API_KEY` from workspace overrides both settings and env
- No settings file and no env vars → env is just `process.env` (no regression)

**Verification:**
- `sidecar.log` shows `ANTHROPIC_*` keys present in `buildSdkOptions` output
- Claude Code query no longer exits with code 1 on Windows

---

### U3. Integrate settings into `CommandsService.buildSdkOptions`

**Goal:** Apply the same settings loading pattern to the commands service so slash-command discovery also works.

**Files:**
- `src/server/services/commands-service.ts` (modify)

**Approach:**
- Import `loadClaudeSettings` from the new utility
- In `buildSdkOptions` (line 211-238), apply the same merge pattern as U2
- Log the loaded settings summary via `sidecarLog`

**Patterns to follow:**
- Same pattern as U2

**Test scenarios:**
- SDK initialization for slash commands succeeds when auth is in settings.json
- No regression when settings.json is missing

**Verification:**
- `sidecar.log` shows `CommandsService.buildSdkOptions` with settings loaded
- `/api/health/claude` or command discovery no longer fails with auth errors

---

### U4. Add env propagation diagnostics

**Goal:** Log critical Windows environment variables (`USERPROFILE`, `HOME`, `HOMEDRIVE`, `HOMEPATH`) to help diagnose propagation issues.

**Files:**
- `src/server/services/chat-service.ts` (modify)
- `src/server/services/commands-service.ts` (modify)

**Approach:**
- In `buildSdkOptions` of both services, add logging for:
  - `USERPROFILE` (Windows primary home dir variable)
  - `HOME` (fallback)
  - `HOMEDRIVE` + `HOMEPATH` (Windows legacy fallback)
- This helps confirm whether the issue was missing env vars or just missing settings injection
- Log the resolved `os.homedir()` value as well

**Verification:**
- `sidecar.log` shows these env vars on Windows builds
- Diagnostics help confirm the root cause if future issues arise

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `os.homedir()` returns wrong directory in pkg binary | Use `process.env.USERPROFILE` / `HOME` as hints if needed; the utility logs the resolved path for verification |
| Settings file contains secrets that shouldn't be logged | Log only keys, never values |
| Env var injection conflicts with SDK's own settings handling | Only inject `ANTHROPIC_*` keys that Claude Code already reads from env; this is a supported configuration path |
| Performance: reading file on every query | The file is tiny (~1KB); read is synchronous and fast. Cache if profiling shows it's an issue. |

## Deferred Implementation Notes

- If performance becomes a concern, `loadClaudeSettings()` could cache the result with a file watcher. Not needed for initial fix.
- Future work could read the entire settings.json and pass it to Claude Code via stdin or a temp file, but env injection is the simplest supported path.
