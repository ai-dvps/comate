---
type: fix
origin: none
status: completed
---

# Fix: Propagate Selected Provider via SDK Flag Settings

## Problem Frame

When a user selects a provider (e.g., GLM) in the GUI's provider selector, the spawned Claude Code process still connects to the provider configured in `~/.claude/settings.json` (e.g., Kimi). The current approach mutates `Options.env` directly with `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, etc., but upstream Claude Code calls `applyConfigEnvironmentVariables()` which overwrites these from `~/.claude/settings.json`.

## Root Cause

Claude Code's settings merge order is:

```
userSettings → projectSettings → localSettings → flagSettings → policySettings
```

The `applyConfigEnvironmentVariables()` function uses `Object.assign(process.env, filterSettingsEnv(getSettings_DEPRECATED()?.env))`, which overwrites `process.env.ANTHROPIC_API_KEY` with the merged settings env. Since our provider credentials were only set on `Options.env` (a copy of `process.env`), they get clobbered when the upstream CLI reapplies settings env vars.

`Options.settings` creates inline `flagSettings` via `setFlagSettingsInline()`. These are stored in module-level state and re-merged with highest priority on every settings reload. Even when `~/.claude/settings.json` changes and `onChangeAppState` re-calls `applyConfigEnvironmentVariables()`, the flag settings values persist and win during merge.

## Scope

Modify `buildSdkOptions()` in `src/server/services/chat-service.ts` to pass provider credentials through `Options.settings` (flag settings layer) instead of directly mutating `env`.

Out of scope:
- Changing how `buildClaudeEnv()` works — it remains responsible for base env setup (PATH, CLAUDE_CONFIG_DIR, WECOM_CLI_PATH)
- Changing provider storage or the provider selector UI
- Changing `loadClaudeSettings()` or `claude-settings.ts`

## Key Technical Decisions

- **Use `Options.settings.env` for provider credentials**: The SDK's `settings` option accepts a `Settings` object (or path) that loads into the flag settings tier. The `env` sub-key within settings maps to environment variables with highest user priority.
- **Keep `Options.env` for non-provider vars**: PATH enrichment, CLAUDE_CONFIG_DIR, WECOM_CLI_PATH, and diagnostic env vars remain on `Options.env` because they are not subject to the same upstream overwrite.
- **Log settings env separately**: Add diagnostic logging for the `settings.env` values so we can verify which provider is being passed through the flag layer.

## Implementation Units

### U1. Pass Provider Credentials via `Options.settings`

**Goal:** Route provider env vars through `Options.settings.env` so they survive upstream settings reloads.

**Files:**
- `src/server/services/chat-service.ts`

**Approach:**

In `buildSdkOptions()`, after resolving the active provider:

1. **Build a `settingsEnv` record** containing provider credentials:
   ```typescript
   const settingsEnv: Record<string, string> = {};
   settingsEnv.ANTHROPIC_BASE_URL = provider.baseUrl;
   settingsEnv.ANTHROPIC_API_KEY = provider.authToken;
   if (provider.model) settingsEnv.ANTHROPIC_MODEL = provider.model;
   if (provider.defaultOpusModel) settingsEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.defaultOpusModel;
   if (provider.defaultSonnetModel) settingsEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.defaultSonnetModel;
   if (provider.defaultHaikuModel) settingsEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = provider.defaultHaikuModel;
   if (provider.subagentModel) settingsEnv.CLAUDE_CODE_SUBAGENT_MODEL = provider.subagentModel;
   if (provider.effortLevel) settingsEnv.CLAUDE_CODE_EFFORT_LEVEL = provider.effortLevel;
   if (provider.customEnvVars) {
     for (const [key, value] of Object.entries(provider.customEnvVars)) {
       settingsEnv[key] = value;
     }
   }
   ```

2. **Remove the direct `env.ANTHROPIC_*` mutations** that currently happen after `buildClaudeEnv()`. The base `env` should no longer carry provider-specific credentials.

3. **Pass `settings` on the Options object**:
   ```typescript
   const options: import('@anthropic-ai/claude-agent-sdk').Options = {
     cwd: normalizedCwd,
     env,
     settings: { env: settingsEnv },
     // ... rest of options
   };
   ```

4. **Update diagnostic logging**:
   - Remove or repurpose the existing loop that logs `envSources` for ANTHROPIC_* keys (since those keys will no longer be on `env`)
   - Add a new log block that iterates `settingsEnv` and logs each key as `settings.env.<key>=<set>`
   - Keep the existing `buildClaudeEnv` source logging for non-provider keys (PATH, CLAUDE_CONFIG_DIR, etc.)

**Patterns to follow:**
- Existing provider resolution logic (session → default provider, error if none)
- Existing `options` object construction pattern in `buildSdkOptions()`

**Test scenarios:**

| Scenario | Expected behavior |
|----------|-------------------|
| Happy path — session with providerId | `Options.settings.env` contains the selected provider's credentials; upstream CLI uses them |
| Happy path — session without providerId | `Options.settings.env` contains default provider's credentials |
| No provider configured | `ChatError('PROVIDER_NOT_FOUND')` thrown before options are built (existing behavior) |
| Provider with customEnvVars | Custom env vars appear in `settingsEnv` alongside ANTHROPIC_* keys |
| Provider with all optional fields null | Only `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` are present in `settingsEnv` |

**Verification:**
- Start a session with a non-default provider selected
- Confirm in logs that `settings.env.ANTHROPIC_BASE_URL` and `settings.env.ANTHROPIC_API_KEY` reflect the selected provider
- Verify the Claude Code process connects to the selected provider, not the one in `~/.claude/settings.json`
- Modify `~/.claude/settings.json` while a session is running and confirm the session continues using the originally selected provider
