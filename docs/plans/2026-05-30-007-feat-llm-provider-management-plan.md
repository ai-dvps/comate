---
title: feat: Add LLM Provider Management
type: feat
status: active
date: 2026-05-30
origin: docs/brainstorms/2026-05-30-llm-provider-management-requirements.md
---

# feat: Add LLM Provider Management

## Summary

Add a global provider registry for Anthropic-compatible proxy endpoints. Providers are stored in SQLite and exposed via CRUD API routes. The session runtime resolves a provider per-session (explicit selection or global default) and passes its full env var configuration to the SDK subprocess. A new settings UI tab manages providers with health checks, and a dropdown in the chat input box shows the active provider per session.

---

## Problem Frame

Switching between Anthropic-compatible proxies requires manually editing workspace settings. There is no way to use different proxies for different sessions within the same workspace. Workspace-level model and API key settings force a single configuration per workspace, which breaks down when users need one session on a corporate gateway and another on a personal LiteLLM instance.

---

## Requirements

- R1. A Provider entity has: id, name, baseUrl, authToken, model, isDefault. Provider names are unique and non-empty.
- R1a. A Provider optionally includes: defaultOpusModel, defaultSonnetModel, defaultHaikuModel, subagentModel, effortLevel.
- R1b. A Provider optionally includes custom env vars as a key-value map.
- R2. Exactly one provider is marked as default at any time.
- R3. Providers persist across app restarts.
- R4. The settings panel includes a provider management section listing all providers.
- R5. Users can add, edit, and delete providers. Auth tokens are masked in the UI.
- R6. Users can set any provider as the default.
- R7. The chat input area includes a provider selector dropdown showing all providers.
- R8. The selector displays the currently active provider for the session.
- R9. Draft sessions allow changing the selected provider; active sessions show it read-only.
- R10. New sessions start with the global default provider selected.
- R11. On first launch with zero providers, the app attempts to parse `~/.claude/settings.json` and environment variables.
- R12. If a valid auth token is found, the app auto-creates a provider named "Default" with detected values and marks it as default.
- R13. If auto-detection fails or finds only partial config, the app displays an empty state guiding the user to manual configuration.
- R14. Saving a new or edited provider triggers a connectivity validation against its endpoint with the provided auth token.
- R15. If health check fails, the save is blocked with a clear error message.
- R16. Session runtime resolves the active provider by: session's selected provider, falling back to the global default.
- R17. The resolved provider's configured env vars are passed to the SDK subprocess via the `env` option.
- R18. If no provider can be resolved for a non-draft session, the runtime emits an error.
- R19. Workspace settings no longer expose model, auth token, max tokens, or temperature fields.
- R20. Existing workspace values for these fields are ignored and not migrated.

**Origin actors:** A1 (User), A2 (System)
**Origin flows:** F1 (First-launch auto-detection), F2 (Creating a provider), F3 (Starting a session with provider selection), F4 (Deleting the default provider)
**Origin acceptance examples:** AE1 (auto-detection success), AE2 (auto-detection empty state), AE3 (health check failure), AE4 (runtime binding), AE5 (orphan session error)

---

## Scope Boundaries

- Custom headers on provider configs.
- Workspace-level provider lists or per-workspace defaults.
- Auto-migration of existing workspace settings.
- Usage tracking, billing, or token counting per provider.
- Provider versioning, history, or rollback.
- Mid-session provider switching for active (non-draft) sessions.

### Deferred to Follow-Up Work

- Provider import/export (e.g., share provider configs as JSON).
- Provider preset templates (pre-filled configs for popular proxies).

---

## Context & Research

### Relevant Code and Patterns

- **Data models:** `src/server/models/workspace.ts`, `src/server/models/session.ts` — pure TypeScript interfaces with Create/Update input types.
- **SQLite storage:** `src/server/storage/sqlite-store.ts` — `better-sqlite3` with inline migrations via `PRAGMA table_info()` + `ALTER TABLE`. JSON columns for nested data.
- **API routes:** `src/server/routes/chat.ts`, `src/server/routes/system.ts` — Express `Router` with manual validation and `ChatError` typed errors.
- **Services:** `src/server/services/chat-service.ts` — `buildSdkOptions()` constructs SDK `Options`, including `env` overrides.
- **SDK env building:** `src/server/utils/sdk-env.ts`, `src/server/utils/claude-settings.ts` — merge `process.env` with `~/.claude/settings.json` values.
- **Client stores:** `src/client/stores/workspace-store.ts` — Zustand store with async CRUD actions.
- **Settings UI:** `src/client/components/SettingsPanel.tsx` — tabbed shell with dirty tracking, explicit save/cancel, and confirmation dialogs.
- **Chat input:** `src/client/components/PromptInput.tsx` — auto-expanding textarea with top toolbar (CommandPicker, FilePicker, ApprovalModeToggle).
- **App settings:** `src/client/hooks/use-app-settings.ts` — `localStorage`-backed hook for global preferences.
- **i18n:** `src/client/i18n/en/settings.json`, `src/client/i18n/zh-CN/settings.json` — namespace-based translations.

### Institutional Learnings

- SQLite migrations should be idempotent and inline (check `PRAGMA table_info` before `ALTER TABLE`).
- Settings UI uses shell-component form state passed to tabs via props, with deep-comparison dirty tracking.
- SDK `options.env` replaced the entire environment in SDK 0.2.113; the codebase already spreads `process.env` explicitly.
- Environment propagation through Tauri → sidecar → SDK → child process is fragile; explicit read-and-inject is the chosen mitigation.

### External References

- [cc-switch](https://github.com/farion1231/cc-switch) — prior art for provider management and env var switching patterns.

---

## Key Technical Decisions

- **SQLite over JSON file for providers:** Providers must be queryable by the server at runtime (for `buildSdkOptions`), so they live in SQLite alongside workspaces and sessions. App-level settings that the frontend owns (like theme) use `localStorage`.
- **Dedicated Zustand store for providers:** A new `provider-store.ts` is cleaner than adding provider state to `workspace-store.ts`, since providers are global and not tied to the active workspace.
- **HTTP probe for health checks:** Making a lightweight authenticated request to the provider's base URL is faster and simpler than spawning the Claude binary. If the proxy exposes an Anthropic-compatible `/models` endpoint, a HEAD or GET request validates reachability and auth.
- **Session table stores provider_id:** Per-session provider selection is persisted on the `sessions` table so it survives page refreshes and reconnects.
- **Two-level resolution in buildSdkOptions:** The provider resolution order is `session.providerId` → `defaultProvider` → error. Workspace settings are removed from this chain entirely.

---

## Open Questions

### Resolved During Planning

- **Where do provider routes mount?** `/api/providers` as top-level routes (not under workspaces) because providers are global.
- **Should health checks spawn the Claude binary?** No — use an HTTP probe to the provider's base URL for speed and simplicity.

### Deferred to Implementation

- **Exact health check endpoint shape:** The implementing agent should verify whether the target proxy supports `/v1/models` or another lightweight health endpoint. Fallback to a generic HEAD request on the base URL if no standard endpoint exists.
- **Custom env var UI shape:** A simple key-value table in the provider form is sufficient for v1; advanced nested objects can be deferred.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```mermaid
graph TD
    A[Provider Management UI<br/>SettingsPanel / ProviderSection] -->|CRUD| B[/api/providers]
    C[Chat Input<br/>PromptInput / ProviderSelector] -->|GET| B
    D[App Init] -->|POST /api/providers/detect| E[ProviderDetectionService]
    E -->|reads| F[~/.claude/settings.json]
    E -->|reads| G[process.env]
    B --> H[ProviderStore<br/>SQLite]
    H --> I[sessions.provider_id]
    J[ChatService.buildSdkOptions] -->|resolves| H
    J -->|env + model| K[SDK Subprocess]
```

---

## Implementation Units

### U1. Provider Data Layer

**Goal:** Create the Provider model, SQLite table, and session column.

**Requirements:** R1, R1a, R1b, R2, R3

**Dependencies:** None

**Files:**
- Create: `src/server/models/provider.ts`
- Modify: `src/server/storage/sqlite-store.ts`
- Test: none — structural scaffolding

**Approach:**
- Define `Provider`, `CreateProviderInput`, `UpdateProviderInput` interfaces following the existing model pattern.
- Add `providers` table creation in `SqliteStore` constructor with `CREATE TABLE IF NOT EXISTS`.
- Use a JSON text column for optional fields (`defaultOpusModel`, `defaultSonnetModel`, etc.) and custom env vars to avoid schema churn.
- Add provider CRUD methods to `SqliteStore`: `listProviders`, `getProvider`, `createProvider`, `updateProvider`, `deleteProvider`.
- Add `provider_id` column to `sessions` table via `PRAGMA table_info` migration.
- Ensure `isDefault` uniqueness by clearing the flag from other rows when setting a new default.

**Patterns to follow:**
- `src/server/models/todo.ts` — model + input interface pattern
- `src/server/storage/sqlite-store.ts` — existing table creation and migration patterns

**Test scenarios:**
- Test expectation: none — pure data layer scaffolding with no behavioral logic

**Verification:**
- `providers` table exists in `~/.comate/data.db` with correct schema.
- `sessions` table has `provider_id` column.
- `SqliteStore` provider CRUD methods return correct shapes.

---

### U2. Provider Backend

**Goal:** Implement API routes, auto-detection service, and health checks.

**Requirements:** R5, R11, R12, R13, R14, R15

**Dependencies:** U1

**Files:**
- Create: `src/server/routes/providers.ts`, `src/server/services/provider-detection.ts`
- Modify: `src/server/index.ts`
- Test: `src/server/services/provider-detection.test.ts`

**Approach:**
- Create `ProviderDetectionService` that reads `~/.claude/settings.json` via `loadClaudeSettings()` and checks `process.env` for `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_MODEL`.
- If a valid auth token is found (non-empty string), auto-create a provider named "Default" with all detected values.
- Expose `POST /api/providers/detect` to trigger auto-detection on demand (used by app init).
- Create `providers.ts` route file with:
  - `GET /api/providers` — list all
  - `POST /api/providers` — create (with health check)
  - `PUT /api/providers/:id` — update (with health check)
  - `DELETE /api/providers/:id` — delete
  - `POST /api/providers/:id/health` — validate connectivity
- Health check: make an authenticated HTTP request to the provider's base URL (e.g., `{baseUrl}/v1/models` or a HEAD request). Block save on non-2xx or timeout.
- Mount routes in `src/server/index.ts` at `/api/providers`.

**Patterns to follow:**
- `src/server/routes/system.ts` — route structure and error handling
- `src/server/utils/claude-settings.ts` — settings.json parsing pattern
- `src/server/services/chat-service.ts` — `testClaudeBinary` spawn pattern as fallback reference

**Test scenarios:**
- **Happy path:** Auto-detection finds `ANTHROPIC_API_KEY` in env and creates a default provider.
- **Happy path:** Health check returns 200 and provider saves successfully.
- **Edge case:** Auto-detection finds partial config (base URL without auth token) and returns empty result.
- **Edge case:** Health check times out after 5 seconds.
- **Error path:** Health check returns 401 and save is blocked with clear error.
- **Error path:** Deleting the last provider is allowed; subsequent sessions will error.

**Verification:**
- `curl /api/providers` returns list.
- `POST /api/providers/detect` creates default provider when env vars exist.
- Saving a provider with invalid base URL is blocked.

---

### U3. Runtime Integration

**Goal:** Wire providers into session runtime and remove workspace LLM settings.

**Requirements:** R16, R17, R18, R19, R20

**Dependencies:** U1, U2

**Files:**
- Modify: `src/server/services/chat-service.ts`, `src/server/models/workspace.ts`, `src/server/models/session.ts`, `src/server/routes/chat.ts`
- Test: none — integration-heavy, verified via end-to-end behavior

**Approach:**
- Remove `apiKey`, `model`, `maxTokens`, `temperature` from `WorkspaceSettings` in `src/server/models/workspace.ts`.
- Add `providerId?: string` to `CreateSessionInput` and `UpdateSessionInput` in `src/server/models/session.ts`.
- Update `chat.ts` route `POST /api/workspaces/:id/sessions` to accept `providerId` from the request body and pass it to `chatService.createSession`.
- Update `chat.ts` route `PUT /api/workspaces/:id/sessions/:sessionId` to allow updating `providerId`.
- Modify `ChatService.buildSdkOptions`:
  - Look up `session.providerId` in `SqliteStore`; if missing, look up the default provider.
  - If no provider found, throw a `ChatError` with a clear message.
  - Set `env.ANTHROPIC_BASE_URL`, `env.ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`), `env.ANTHROPIC_MODEL`, and any other configured env vars from the resolved provider.
  - Set `options.model` from the provider.
  - Remove the existing workspace `apiKey` and `model` injection logic.
- Update `chatService.createSession` to accept and store `providerId`.
- Update `SessionRuntime` or `ChatService.getOrCreateRuntime` to pass provider-aware options.

**Patterns to follow:**
- `src/server/services/chat-service.ts` — existing `buildSdkOptions` structure
- `src/server/utils/sdk-env.ts` — env var construction and precedence

**Test scenarios:**
- **Happy path:** Draft session with explicit provider starts runtime with that provider's env vars.
- **Happy path:** Session without explicit provider falls back to default provider.
- **Edge case:** Workspace previously had `apiKey` and `model` set — these are now ignored.
- **Error path:** No provider resolved and session is non-draft — runtime emits error.

**Verification:**
- Sending a message in a draft session uses the selected provider's base URL and auth token.
- Server logs show the correct provider env vars being injected (log keys only, never values).
- Existing sessions without a providerId fall back to the default provider.

---

### U4. Provider Settings UI

**Goal:** Build the client-side provider management interface in the settings panel.

**Requirements:** R4, R5, R6, R14, R15

**Dependencies:** U2

**Files:**
- Create: `src/client/stores/provider-store.ts`, `src/client/components/ProviderSection.tsx`
- Modify: `src/client/components/SettingsPanel.tsx`, `src/client/i18n/en/settings.json`, `src/client/i18n/zh-CN/settings.json`
- Test: none — UI behavior

**Approach:**
- Create `provider-store.ts` Zustand store with actions: `fetchProviders`, `createProvider`, `updateProvider`, `deleteProvider`, `setDefaultProvider`, `runHealthCheck`.
- Add a new top-level settings tab (or section) for "Providers" in `SettingsPanel.tsx`.
- Create `ProviderSection.tsx` with:
  - Provider list (name, base URL, model, default badge, health status).
  - Add/Edit form with fields: name, base URL, auth token (password input), model, optional fields (opus, sonnet, haiku, subagent, effort), custom env vars (key-value table).
  - Save button triggers health check; on success, persists. On failure, shows error inline.
  - Delete button with confirmation dialog.
  - Set as Default toggle/button.
- Follow existing settings UI patterns: dirty tracking via snapshot comparison, explicit save, cancel discards.
- Add i18n keys for all provider UI strings in both English and Chinese.

**Patterns to follow:**
- `src/client/stores/workspace-store.ts` — Zustand async store pattern
- `src/client/components/SettingsPanel.tsx` — tab shell, dirty tracking, save/cancel flow
- `src/client/components/SettingsPanel.tsx` `ModelApiSection` — form field layout (to be replaced)

**Test scenarios:**
- **Happy path:** User creates a provider, health check passes, provider appears in list.
- **Happy path:** User edits a provider and saves; list updates.
- **Happy path:** User sets a provider as default; default badge moves.
- **Edge case:** User enters duplicate name; form validation blocks save.
- **Error path:** Health check fails; inline error shown, save blocked.

**Verification:**
- Provider list renders with all created providers.
- Auth token field is masked.
- Health check spinner/indicator appears during validation.
- i18n strings display correctly in both languages.

---

### U5. Chat Selector and App Initialization

**Goal:** Add per-session provider selection to the chat input and handle first-launch empty state.

**Requirements:** R7, R8, R9, R10, R12, R13

**Dependencies:** U2, U4

**Files:**
- Create: `src/client/components/ProviderSelector.tsx`
- Modify: `src/client/components/PromptInput.tsx`, `src/client/stores/chat-store.ts`, `src/client/i18n/en/chat.json`, `src/client/i18n/zh-CN/chat.json`
- Test: none — UI behavior

**Approach:**
- Create `ProviderSelector.tsx`: a dropdown showing all providers with the current selection highlighted. Displays provider name + model. Disabled (read-only) when session is active.
- Integrate `ProviderSelector` into `PromptInput.tsx` toolbar, next to `ApprovalModeToggle`.
- Update `chat-store.ts`:
  - Track `selectedProviderId` per session (or derive from session data).
  - On `createSession`, default to the global default provider.
  - On `sendMessage`, include `providerId` in the POST body.
- First-launch flow:
  - On app init, `provider-store` fetches providers. If empty, call `POST /api/providers/detect`.
  - If detection succeeds, providers list populates automatically.
  - If detection fails, show an empty state in the provider selector and settings panel with a "Create your first provider" CTA.
- Empty state UI: a prominent card in the provider selector (when no providers exist) with a button to open settings.

**Patterns to follow:**
- `src/client/components/PromptInput.tsx` — toolbar layout and popover patterns
- `src/client/components/ApprovalModeToggle.tsx` — dropdown/popover interaction pattern
- `src/client/stores/chat-store.ts` — per-session state management

**Test scenarios:**
- **Happy path:** New draft session shows default provider in selector.
- **Happy path:** User changes provider in draft session; subsequent messages use the new provider.
- **Happy path:** First launch with existing Claude config auto-populates default provider.
- **Edge case:** Active session shows provider name as read-only; dropdown is disabled.
- **Edge case:** Provider deleted while session references it; selector shows error state or fallback.
- **Error path:** No providers exist; empty state CTA is visible.

**Verification:**
- Provider selector appears in chat input toolbar.
- Draft sessions allow provider switching.
- Active sessions display provider name without interaction.
- Empty state appears when no providers are configured.
- i18n strings display correctly in both languages.

---

## System-Wide Impact

- **Interaction graph:** The provider store interacts with settings UI, chat input, and the chat store. The server-side provider routes interact with the SQLite store and the detection service. `buildSdkOptions` now queries the provider store instead of workspace settings.
- **Error propagation:** Provider resolution failures in `buildSdkOptions` throw `ChatError`, which surfaces as a 500 to the client. The client should show these as toast notifications or inline errors.
- **State lifecycle risks:** If a provider is deleted while sessions reference it, those sessions will error on next runtime start. This is accepted behavior per the requirements.
- **API surface parity:** The `commands-service.ts` also constructs SDK options independently (for slash command discovery). It must be updated to use the same provider resolution logic, or at minimum not depend on removed workspace fields.
- **Integration coverage:** End-to-end validation should cover: creating a provider → selecting it for a draft session → sending a message → verifying the correct env vars reach the SDK subprocess.
- **Unchanged invariants:** Workspace folder paths, MCP servers, skills, hooks, WeCom settings, and approval modes are untouched. Only model/auth/token/temperature fields are removed from workspace settings.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Health checks on proxies that don't expose `/v1/models` may fail falsely | Use a configurable health check endpoint or fallback to HEAD request on base URL. Document the behavior. |
| Removing workspace `apiKey`/`model` breaks existing users with saved workspace configs | No auto-migration per requirements. Empty state and auto-detection on first launch reduce friction. |
| `commands-service.ts` also reads workspace settings for SDK options | Audit and update `commands-service.ts` to use provider resolution, or ensure it doesn't break when workspace fields are removed. |
| Provider env var names may conflict with `buildClaudeEnv` defaults | Ensure provider env vars overwrite `buildClaudeEnv` defaults, not the other way around. |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-30-llm-provider-management-requirements.md](docs/brainstorms/2026-05-30-llm-provider-management-requirements.md)
- Related code: `src/server/services/chat-service.ts`, `src/server/storage/sqlite-store.ts`, `src/client/components/SettingsPanel.tsx`, `src/client/components/PromptInput.tsx`
- External reference: [cc-switch](https://github.com/farion1231/cc-switch) — prior art for provider env var switching
