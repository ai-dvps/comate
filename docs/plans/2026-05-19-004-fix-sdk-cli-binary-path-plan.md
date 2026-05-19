---
title: "fix: SDK initialization fails when optional native CLI binary is missing"
type: fix
status: active
date: 2026-05-19
---

# fix: SDK initialization fails when optional native CLI binary is missing

## Summary

The `@anthropic-ai/claude-agent-sdk` package ships its native CLI binary as an optional dependency. When that optional dep is not installed, the SDK falls back to searching for a `claude` executable in PATH. On macOS (darwin-arm64) this fallback fails because the SDK does not locate the Homebrew-installed binary, causing slash-command initialization to crash with:

> SDK initialization failed: Native CLI binary for darwin-arm64 not found.

The fix auto-detects the `claude` executable in common install locations and PATH, passes it to the SDK via `pathToClaudeCodeExecutable`, and exposes a workspace setting so users can override the detected path.

---

## Requirements

- **R1.** Slash commands initialize successfully even when the SDK's optional native binary is absent.
- **R2.** The `claude` CLI is auto-detected from the system `PATH` and common install prefixes (`/opt/homebrew/bin`, `/usr/local/bin`).
- **R3.** Users can manually override the detected path via workspace settings.
- **R4.** The fix applies to all SDK call sites (`chat-service.ts` and `commands-service.ts`).

---

## Scope Boundaries

- In scope: auto-detection logic, workspace settings extension, SDK options wiring, settings UI field.
- Out of scope: reinstalling the SDK with optional dependencies, changing how slash commands are discovered or executed, cross-platform binary bundling.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/models/workspace.ts` — `WorkspaceSettings` interface currently holds `model`, `apiKey`, `maxTokens`, `temperature`. Settings are stored as JSON in SQLite (`TEXT` column), so adding a field requires no schema migration.
- `src/server/services/chat-service.ts:248` — `buildSdkOptions` constructs the SDK `Options` object but does not set `pathToClaudeCodeExecutable`.
- `src/server/services/commands-service.ts:209` — duplicate `buildSdkOptions` with the same omission.
- `src/client/components/SettingsPanel.tsx` — workspace settings UI with existing Model and API Key fields in the "Settings" tab.
- `node_modules/@anthropic-ai/claude-agent-sdk/` — no `optional/` directory present, confirming the native binary was not installed. However, `claude` is available at `/opt/homebrew/bin/claude` on the host system.
- The SDK `Options` type accepts `pathToClaudeCodeExecutable?: string`.

### External References

- `@anthropic-ai/claude-agent-sdk` README — mentions `pathToClaudeCodeExecutable` as the fallback when optional binaries are missing.

---

## Key Technical Decisions

- **Auto-detect at runtime rather than build time.** The `claude` binary location varies by install method (Homebrew, npm, manual). Detecting via `which` and a short list of common paths at server startup keeps the fix environment-agnostic.
- **Pass the resolved path in `buildSdkOptions`, not at import time.** Both `chat-service.ts` and `commands-service.ts` construct SDK options per workspace, so the path is resolved when options are built and can respect a per-workspace override.
- **Add `claudeCodePath?: string` to `WorkspaceSettings`.** This follows the existing pattern for `model` and `apiKey` and requires no database migration because settings are stored as JSON.

---

## Implementation Units

### U1. Add `claudeCodePath` to `WorkspaceSettings` and auto-detect helper

**Goal:** Extend the settings type and provide a utility that resolves the `claude` executable path.

**Requirements:** R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/server/models/workspace.ts`
- Create: `src/server/utils/claude-path.ts`

**Approach:**
1. Add `claudeCodePath?: string` to `WorkspaceSettings`.
2. Create `resolveClaudeCodePath(settings?: WorkspaceSettings): string | undefined` in a new utility file:
   - If `settings.claudeCodePath` is set, return it.
   - Otherwise try `which claude` via `child_process.execSync` (or `spawnSync`) and return the trimmed stdout if successful.
   - If `which` fails, check a small hard-coded list of common paths (`/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `/usr/bin/claude`).
   - Return `undefined` if nothing is found, letting the SDK fall back to its own logic.

**Patterns to follow:**
- Existing workspace settings optional-prop convention (`model?: string`).
- Keep the utility synchronous and side-effect-free so it can be called from `buildSdkOptions`.

**Test scenarios:**
- **Happy path:** `claude` is in PATH → helper returns the absolute path.
- **Happy path:** `claudeCodePath` is set in workspace settings → helper returns the configured path.
- **Edge case:** `claude` is not in PATH but exists at `/opt/homebrew/bin/claude` → helper returns that path.
- **Edge case:** neither PATH nor common paths contain `claude` → helper returns `undefined`.
- **Edge case:** configured path points to a non-existent file → helper still returns it (let the SDK surface the error so the user knows their override is wrong).

**Verification:**
- TypeScript compiles without errors.
- Unit test for the helper covers the scenarios above.

---

### U2. Wire `pathToClaudeCodeExecutable` into SDK options

**Goal:** Ensure both chat and command services pass the resolved path to the SDK.

**Requirements:** R1, R4

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/chat-service.ts`
- Modify: `src/server/services/commands-service.ts`

**Approach:**
1. Import `resolveClaudeCodePath` into both files.
2. In each `buildSdkOptions` method, call `resolveClaudeCodePath(workspace.settings)` and spread the result into the SDK options:
   ```typescript
   const claudePath = resolveClaudeCodePath(workspace.settings);
   const options: Options = {
     // ...existing options
     ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
   };
   ```

**Patterns to follow:**
- The existing `buildSdkOptions` pattern in both files.
- Conditional spreading of optional properties (same as `mcpServers`).

**Test scenarios:**
- **Integration:** Starting a chat session with a workspace that has no `claudeCodePath` set and `claude` in PATH → SDK initializes successfully.
- **Integration:** Slash command discovery (`fetchInitialization`) works without the optional native binary.

**Verification:**
- TypeScript compiles.
- Manual test: trigger slash command input and confirm no SDK initialization error.

---

### U3. Add `claudeCodePath` field to workspace settings UI

**Goal:** Let users view and override the auto-detected path.

**Requirements:** R3

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`

**Approach:**
1. Add local state `claudeCodePath` initialized from `workspace.settings.claudeCodePath`.
2. Add an input field in the "Settings" tab below the API Key field:
   - Label: "Claude Code CLI Path"
   - Placeholder: e.g. `/opt/homebrew/bin/claude`
   - Helper text: "Path to the `claude` executable. Leave empty to auto-detect."
3. Include `claudeCodePath: claudeCodePath || undefined` in the `handleSave` payload.

**Patterns to follow:**
- Existing model and API Key input patterns in the same file.

**Test scenarios:**
- **Happy path:** User enters a custom path, saves, and the setting persists across reloads.
- **Happy path:** User clears the input, saves, and auto-detection resumes.

**Verification:**
- The settings panel renders the new field.
- Saving persists the value and it round-trips on reopen.

---

## System-Wide Impact

- **Unchanged invariants:** Chat streaming, session management, MCP server wiring, and existing workspace settings are unaffected.
- **API surface parity:** Not applicable — no public API changes.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `resolveClaudeCodePath` fails silently on Windows | The helper is designed to return `undefined` when detection fails, which leaves the SDK to its own fallback logic. No regression. |
| `execSync('which claude')` throws on Windows | Wrap in `try/catch`; Windows users rely on the manual override or the SDK's own resolution. |

---

## Sources & References

- Related code: `src/server/services/chat-service.ts`
- Related code: `src/server/services/commands-service.ts`
- Related code: `src/server/models/workspace.ts`
- Related code: `src/client/components/SettingsPanel.tsx`
