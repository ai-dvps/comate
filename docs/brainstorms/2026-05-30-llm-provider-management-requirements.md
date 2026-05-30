---
date: 2026-05-30
topic: llm-provider-management
---

# LLM Provider Management

## Summary

A global provider registry for Anthropic-compatible proxy endpoints. Users create named providers with full env var configuration (base URL, auth token, model, default subagent models, effort level, and custom env vars), set one as the app-wide default, and select a provider per-session from a dropdown in the chat input box. The app auto-detects existing Claude Code configuration on first launch and validates provider connectivity before saving.

---

## Problem Frame

Switching between Anthropic-compatible proxies today requires manually editing workspace settings. This is friction-heavy and does not allow different sessions within the same workspace to use different endpoints. There is no structured way to manage multiple auth tokens, base URLs, models, or other Claude Code env vars — users either create redundant workspaces or repeatedly edit raw settings. Workspace-level configuration also forces a single proxy per workspace, which breaks down when a user needs one session hitting a corporate gateway and another hitting a personal LiteLLM instance within the same project.

---

## Actors

- A1. User: Creates and manages providers, selects providers for sessions, and sends messages.
- A2. System: Auto-detects existing Claude Code configuration, validates provider connectivity, and resolves the active provider for a session runtime.

---

## Key Flows

- F1. First-launch auto-detection
  - **Trigger:** App launches with zero providers in storage.
  - **Actors:** A2
  - **Steps:**
    1. System reads `~/.claude/settings.json` for auth token, base URL, model, and other Claude Code env vars.
    2. If incomplete, system checks `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL` environment variables.
    3. If a valid auth token is found, system creates a provider named "Default" with the detected values and marks it as default.
    4. If detection fails or finds only partial config, system shows an empty state with guidance to manually create a provider.
  - **Outcome:** Either a default provider exists or the user sees the empty state.
  - **Covered by:** R11, R12, R13

- F2. Creating a provider
  - **Trigger:** User clicks "Add Provider" in settings.
  - **Actors:** A1, A2
  - **Steps:**
    1. User enters name, base URL, auth token, and model.
    2. User optionally fills default opus/sonnet/haiku models, subagent model, effort level, and custom env vars.
    3. User clicks Save.
    4. System runs a connectivity health check against the endpoint with the provided auth token.
    5. If health check passes, the provider is saved and appears in the list and selector.
    6. If health check fails, an error is shown and the save is blocked.
  - **Outcome:** A new provider is available for selection.
  - **Covered by:** R1, R1a, R1b, R5, R14, R15

- F3. Starting a session with provider selection
  - **Trigger:** User creates a new session or opens a draft session.
  - **Actors:** A1, A2
  - **Steps:**
    1. New session starts with the global default provider pre-selected in the input box selector.
    2. While the session is still draft, the user can change the selected provider via the dropdown.
    3. User sends the first message.
    4. Session runtime starts, resolving the selected provider and passing its config to the SDK subprocess.
  - **Outcome:** The session is bound to the chosen provider for its lifetime.
  - **Covered by:** R7, R8, R9, R10, R16, R17

- F4. Deleting the default provider
  - **Trigger:** User deletes the currently default provider.
  - **Actors:** A1, A2
  - **Steps:**
    1. User deletes the default provider.
    2. System allows the deletion.
    3. Sessions that had no explicit provider selection will error on next runtime start because no default exists.
  - **Outcome:** The provider is removed; orphan sessions error until a new default is set or an explicit provider is chosen.
  - **Covered by:** R2, R18

---

## Requirements

**Provider data model**
- R1. A Provider entity has: id, name, baseUrl, authToken, model, isDefault. Provider names are unique and non-empty.
- R1a. A Provider optionally includes: defaultOpusModel, defaultSonnetModel, defaultHaikuModel, subagentModel, effortLevel.
- R1b. A Provider optionally includes custom env vars as a key-value map for fields not covered by the standard schema.
- R2. Exactly one provider is marked as default at any time.
- R3. Providers persist across app restarts.

**Provider management UI**
- R4. The settings panel includes a provider management section listing all providers.
- R5. Users can add, edit, and delete providers. Auth tokens and other sensitive fields are masked (password input) in the UI.
- R6. Users can set any provider as the default.

**Chat provider selection**
- R7. The chat input area includes a provider selector dropdown showing all providers.
- R8. The selector displays the currently active provider for the session.
- R9. Draft sessions allow changing the selected provider; active sessions show it read-only.
- R10. New sessions start with the global default provider selected.

**Auto-detection**
- R11. On first launch with zero providers, the app attempts to parse `~/.claude/settings.json` and environment variables for auth token, base URL, model, default opus/sonnet/haiku models, subagent model, effort level, and any other `ANTHROPIC_*` or `CLAUDE_CODE_*` env vars.
- R12. If a valid auth token is found, the app auto-creates a provider named "Default" with all detected values and marks it as default.
- R13. If auto-detection fails or finds only partial config, the app displays an empty state guiding the user to manual configuration.

**Health checks**
- R14. Saving a new or edited provider triggers a connectivity validation against its endpoint with the provided auth token.
- R15. If health check fails, the save is blocked with a clear error message.

**Runtime integration**
- R16. Session runtime resolves the active provider by: session's selected provider, falling back to the global default.
- R17. The resolved provider's configured env vars (base URL, auth token, model, default models, effort level, and any custom env vars) are passed to the SDK subprocess via the `env` option.
- R18. If no provider can be resolved for a non-draft session, the runtime emits an error explaining that no provider is configured.

**Workspace settings**
- R19. Workspace settings no longer expose model, auth token, max tokens, or temperature fields.
- R20. Existing workspace values for these fields are ignored and not migrated.

---

## Acceptance Examples

- AE1. **Covers R11, R12.** Given a fresh install with no providers and `~/.claude/settings.json` containing a valid auth token, when the app launches, a provider named "Default" is auto-created with the detected values and marked as default.
- AE2. **Covers R11, R13.** Given a fresh install with no providers and no Claude settings or env vars present, when the app launches, the provider management UI shows an empty state with a "Create your first provider" call-to-action.
- AE3. **Covers R14, R15.** Given a user enters a provider with base URL `https://invalid-proxy.example.com`, when they click Save, the health check fails and the save is blocked with an error message.
- AE4. **Covers R9, R16, R17.** Given a draft session with Provider A selected, when the user sends the first message, the session runtime starts with Provider A's full env var configuration passed to the SDK subprocess.
- AE5. **Covers R18.** Given an active session with no explicit provider and the default provider was deleted, when the session tries to resume, it emits an error stating that no provider is configured.

---

## Success Criteria

- A user can create multiple providers and switch between them without editing workspace settings or restarting the app.
- A user with existing Claude Code configuration sees a working default provider on first launch without manual setup.
- Invalid provider configs are caught at save time via health checks, not at runtime during a session.
- A downstream planner can implement this without inventing product behavior — all flows, error states, and UX decisions are specified.

---

## Scope Boundaries

- Custom headers on provider configs.
- Workspace-level provider lists or per-workspace defaults.
- Auto-migration of existing workspace settings.
- Usage tracking, billing, or token counting per provider.
- Provider versioning, history, or rollback.
- Mid-session provider switching for active (non-draft) sessions.

---

## Key Decisions

- **Global providers over workspace-scoped:** Chosen because the core pain point is workspace juggling. Global providers let users stay in one workspace while using different proxies per session.
- **Start fresh with no migration:** Existing workspace settings are ignored. The auto-detection flow on first launch replaces the need for migration by harvesting existing Claude config.
- **Two-level resolution (session → default):** Workspace settings are completely removed from the LLM configuration chain. This simplifies the mental model and removes ambiguity about which setting wins.
- **Expanded env var schema:** Provider configs support the full set of Claude Code env vars (base URL, auth token, model, default subagent models, effort level, and custom env vars) rather than a minimal subset. This aligns with how proxy providers actually configure the CLI.
- **Auto-detection from `~/.claude/settings.json` and env vars:** Reduces first-setup friction for users who already have Claude Code working.
- **Health checks at save time:** Catches misconfiguration early rather than failing silently at session runtime.
- **Read-only selector for active sessions:** Prevents complexity around mid-session provider switching and runtime restart in v1.

---

## Dependencies / Assumptions

- The Claude Code CLI respects `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` for proxy endpoints. *(Unverified — needs validation during planning.)*
- Health checks can use a lightweight Anthropic API call to validate that an endpoint is reachable and the auth token is accepted. *(Unverified — needs validation during planning.)*
- The `@anthropic-ai/claude-agent-sdk` accepts per-query `env` overrides, which gives natural process-level isolation per session runtime. *(Verified — `Options.env` is passed to the CLI subprocess.)*
- [cc-switch](https://github.com/farion1231/cc-switch) is referenced as a prior art pattern for provider management, SQLite-backed SSOT, and env var switching.

---

## Outstanding Questions

### Resolve Before Planning

*(None — all product decisions are resolved.)*

### Deferred to Planning

- [Affects R14][Technical] Exact health check endpoint and request shape for validating Anthropic-compatible proxies.
- [Affects R9][Technical] Whether provider selection for draft sessions is persisted to the database immediately or held in UI state until first message.
- [Affects R17][Needs research] Confirm that `ANTHROPIC_BASE_URL` is the correct env var for the bundled Claude Code CLI version.
