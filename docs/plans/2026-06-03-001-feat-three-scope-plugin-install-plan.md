---
date: 2026-06-03
status: active
---

# feat: Three-Scope Plugin Installation (User / Project / Local)

## Summary

Expand Comate's plugin manager from two scopes (global/workspace) to three scopes matching Claude Code CLI: user, project, and local. Add `.claude/settings.local.json` discovery, rename existing scope terminology, and introduce a scope-picker modal that requires explicit user choice at install time with loading states and error recovery.

---

## Problem Frame

Comate's plugin manager currently supports two scopes — global (all workspaces) and workspace (per-workspace) — but Claude Code CLI has three: user, project, and local. The `local` scope writes to `.claude/settings.local.json`, a per-user, per-repo file that is not committed to version control. Comate does not read this file, so plugins installed locally via the CLI are invisible in the app. Additionally, Comate uses `global`/`workspace` terminology while the CLI uses `user`/`project`, creating cognitive friction for users who switch between tools. The install flow also lacks explicit scope choice — the marketplace hardcodes workspace scope — which can lead to accidentally sharing personal plugins with the team.

---

## Requirements Traceability

| Origin ID | Requirement | Implementation Units |
|---|---|---|
| R5 | Install to user, project, or local scope | U1, U2, U4, U7 |
| R7 | Write to correct settings file per scope | U1, U2 |
| R17 | Scope picker modal with no pre-selected default | U7 |
| R18 | Installing state in modal | U7 |
| R19 | Error state with Retry/Cancel | U7 |
| R20 | Uninstall button when already installed in any scope | U4, U7 |
| R21 | Installed tab shows all 3 scope badges | U6 |
| R22 | Read `.claude/settings.local.json` | U1, U2, U3 |
| AE1, AE2 | Scope-specific settings file paths | U1, U2, U9 |
| AE5 | Error handling with retry | U7, U9 |
| AE6, AE7 | Visibility across all scopes | U2, U3, U4, U6 |

---

## System-Wide Impact

- **Backend API contract**: `POST /api/plugins/install` and sibling endpoints change valid `scope` values from `global`/`workspace` to `user`/`project`/`local`. The frontend is the sole consumer; no external API consumers exist.
- **Plugin discovery**: `commands-service.ts` and `chat-service.ts` must include local-scope plugins in discovery. Workspace-local components still take precedence over plugin components on name conflict.
- **Settings file I/O**: A new file (`<workspace>/.claude/settings.local.json`) enters the read/write surface. It follows the same JSON schema as `.claude/settings.json`.
- **i18n**: Both English and Chinese translation files gain new keys for the third scope and modal text.

---

## Key Technical Decisions

- **Rename scopes to match CLI**: `global` → `user`, `workspace` → `project`, and add `local`. This is safe because `pluginManager.plugins` entries do not store scope as a field — scope is implicit in which file an entry lives in. No data migration is required.
- **Local settings path**: `resolveLocalClaudeSettingsPath(workspacePath)` returns `<workspace>/.claude/settings.local.json`, mirroring the existing workspace settings helper.
- **Download-first install order**: The existing backend endpoint already downloads and caches the plugin before writing settings (unlike the CLI's settings-first approach). This prevents orphaned settings entries on download failure and aligns with R19's Retry/Cancel behavior.
- **One plugin per workspace context**: The marketplace shows Uninstall if a plugin is already installed in any scope for the current workspace. The scope picker does not offer scopes where the plugin is already installed.
- **Modal state machine**: The scope picker modal uses a 3-state model — `choosing` → `installing` → `result` (success or error) — managed with local React state, not a separate store.

---

## Implementation Units

### U1. Rename scope types and add local settings path resolution

**Goal:** Establish the three-scope type system and settings file path resolution across the backend.

**Requirements:** R5, R7

**Dependencies:** None

**Files:**
- `src/server/services/plugin-settings-service.ts`
- `src/server/utils/claude-settings.ts`

**Approach:**
1. Change `PluginScope` from `'global' | 'workspace'` to `'user' | 'project' | 'local'`.
2. Add `resolveLocalClaudeSettingsPath(workspacePath: string): string` to `claude-settings.ts`, returning `join(workspacePath, '.claude', 'settings.local.json')`.
3. Update `resolveSettingsPath()` in `plugin-settings-service.ts` to handle the `local` branch using the new helper.
4. Update all method signatures in `plugin-settings-service.ts` (`getInstalledPlugins`, `getInstalledPlugin`, `addPlugin`, `removePlugin`, `setPluginEnabled`, `updatePluginVersion`, `getPluginConfig`, `setPluginConfig`) to accept the renamed scope values.
5. Add a runtime validation helper `assertPluginScope(scope: string): asserts scope is PluginScope` used by API routes.

**Patterns to follow:**
- Mirror the existing `resolveWorkspaceClaudeSettingsPath` pattern exactly for the local variant.
- Atomic file writes via `writePluginSettings` are already in place; no change needed.

**Test scenarios:**
- `resolveSettingsPath('user')` returns `~/.claude/settings.json`
- `resolveSettingsPath('project', '/path/to/ws')` returns `/path/to/ws/.claude/settings.json`
- `resolveSettingsPath('local', '/path/to/ws')` returns `/path/to/ws/.claude/settings.local.json`
- `assertPluginScope` accepts `'user'`, `'project'`, `'local'`; rejects `'global'`, `'workspace'`, `'managed'`

**Verification:** TypeScript compilation passes; unit tests for path resolution pass.

---

### U2. Extend plugin-settings-service for local-scope I/O

**Goal:** Enable reading and writing plugin state from `.claude/settings.local.json` through the existing service abstraction.

**Requirements:** R5, R7, R22

**Dependencies:** U1

**Files:**
- `src/server/services/plugin-settings-service.ts`
- `src/server/services/plugin-settings-service.test.ts`

**Approach:**
1. Verify that `getInstalledPlugins('local', workspacePath)` correctly reads from `.claude/settings.local.json` via the updated `resolveSettingsPath`.
2. Verify that `addPlugin('local', ...)` writes to `.claude/settings.local.json` and creates the file if missing.
3. Verify that `removePlugin('local', ...)`, `setPluginEnabled('local', ...)`, and `updatePluginVersion('local', ...)` all target the correct file.
4. The service already uses `readPluginSettings` and `writePluginSettings`, which are file-agnostic — the scope-to-path mapping is the only change needed.
5. Add test coverage for local-scope CRUD operations following the existing test pattern (temp dirs, `process.env.HOME` override).

**Patterns to follow:**
- Existing tests create temp directories and override `process.env.HOME` to isolate global settings.
- For local settings, create a temp workspace directory and pass it as `workspacePath`.

**Test scenarios:**
- Happy path: `addPlugin('local', 'test-plugin', '1.0.0', 'github', '/tmp/ws')` creates `/tmp/ws/.claude/settings.local.json` with the entry
- `getInstalledPlugins('local', '/tmp/ws')` returns the added plugin
- `removePlugin('local', 'test-plugin', '/tmp/ws')` removes the entry
- `setPluginEnabled('local', 'test-plugin', false, '/tmp/ws')` updates the enabled flag
- File creation: writing to a workspace without an existing `.claude/settings.local.json` creates the file and parent directory

**Verification:** `plugin-settings-service.test.ts` passes with new local-scope cases.

---

### U3. Update backend discovery services for 3-scope plugin enumeration

**Goal:** Ensure plugin skills, commands, MCP servers, and hooks are discovered from all three scopes, with proper precedence.

**Requirements:** R13–R16, R22

**Dependencies:** U2

**Files:**
- `src/server/services/commands-service.ts`
- `src/server/services/chat-service.ts`
- Any other service that calls `pluginSettingsService.getInstalledPlugins()`

**Approach:**
1. In `commands-service.ts`, update `loadPluginEntries()` to query `getInstalledPlugins('local', workspacePath)` in addition to `user` and `project`, then deduplicate by plugin ID.
2. In `chat-service.ts`, update `loadPluginMcpServers()` to merge local-scope MCP configs alongside user and project.
3. Maintain existing precedence: workspace-local (manual) components override plugin components on name conflict. Within plugin sources, the most specific scope wins if the same plugin is somehow present in multiple scopes (though the UI prevents this).
4. Search the codebase for any other consumers of `getInstalledPlugins` or references to `'global'`/`'workspace'` scope strings and update them.

**Patterns to follow:**
- The existing deduplication uses a `seenPlugins` Set by plugin ID.
- MCP merge uses object spread; later keys override earlier ones.

**Test scenarios:**
- A plugin installed in `local` scope contributes its skills to the command palette
- A plugin installed in `local` scope contributes its MCP servers to the workspace config
- Duplicate plugin IDs across scopes are deduplicated (local takes precedence over project over user)
- Discovery gracefully handles missing or corrupted `.claude/settings.local.json`

**Verification:** Plugin discovery in a workspace with local-scope plugins surfaces the plugin's skills and MCP servers.

---

### U4. Update API routes for 3-scope support

**Goal:** Expose all three scopes through the REST API, merge local plugins into the installed list, and enforce the one-plugin-per-scope rule in the marketplace.

**Requirements:** R5, R7, R17–R20

**Dependencies:** U1, U2, U3

**Files:**
- `src/server/routes/plugins.ts`

**Approach:**
1. Update scope validation in all endpoints (`/install`, `/uninstall`, `/update`, `/enable`) to accept `'user'`, `'project'`, `'local'` and reject the old names `'global'`, `'workspace'`.
2. Update `GET /installed` to query all three scopes and merge them into a single response array. Local plugins are read using the workspace path.
3. Update `POST /install` to check whether the plugin is already installed in ANY scope (not just the requested scope). If already installed, return `409` with a clear error message. The frontend will use this to show Uninstall instead of Install.
4. The install endpoint already downloads first, then writes settings — no change to sequencing needed.
5. Update `GET /updates` to check all three scopes for installed plugins.

**Patterns to follow:**
- Existing validation pattern: `if (scope !== 'user' && scope !== 'project' && scope !== 'local')` return 400.
- Existing merge pattern in `/installed`: concatenate arrays from multiple scopes, enriching each with manifest data.

**Test scenarios:**
- `GET /installed?workspaceId=xxx` returns plugins from user, project, and local scopes
- `POST /install` with `scope: 'local'` writes to `.claude/settings.local.json`
- `POST /install` returns `409` if plugin already installed in any scope
- `POST /uninstall` with `scope: 'local'` removes from `.claude/settings.local.json`
- Old scope values (`'global'`, `'workspace'`) return `400`

**Verification:** API integration tests pass; manual curl against `/installed` shows local-scope plugins.

---

### U5. Update frontend types and Zustand store

**Goal:** Align the frontend type system and store with the three backend scopes.

**Requirements:** R5, R21

**Dependencies:** U4

**Files:**
- `src/client/stores/plugin-store.ts`

**Approach:**
1. Update `InstalledPlugin.scope` from `'global' | 'workspace'` to `'user' | 'project' | 'local'`.
2. Update all store action signatures (`installPlugin`, `uninstallPlugin`, `updatePlugin`, `setPluginEnabled`) to accept the new scope type.
3. Remove or rename `selectedScope` state if it still uses old terminology. If it was used to pre-select a scope for installation, it can be removed since the modal now handles scope selection.
4. Update the `installedPlugins` filter logic to handle the new scope values.

**Patterns to follow:**
- The store uses optimistic updates for `setPluginEnabled` (reverts on failure).
- The `isSaving` flag disables UI during async operations.

**Test scenarios:**
- Store's `installPlugin` action accepts `'local'` scope and passes it to the API
- Store's `uninstallPlugin` correctly filters by the new scope values
- `installedPlugins` state contains entries with `'user'`, `'project'`, and `'local'` scopes

**Verification:** TypeScript compilation passes for the store file; no type errors in components that consume the store.

---

### U6. Update installed tab UI for 3 scope badges

**Goal:** Display the third scope badge in the Installed tab and handle the renamed scope values.

**Requirements:** R21

**Dependencies:** U5

**Files:**
- `src/client/components/PluginSettingsPage.tsx`

**Approach:**
1. Update the inline `ScopeBadge` component to handle `'user'`, `'project'`, and `'local'`.
2. Assign a distinct color and icon to the local scope (e.g., amber + `User` icon from lucide-react, or another appropriate icon).
3. Update scope label rendering to use the new i18n keys (`scopeUser`, `scopeProject`, `scopeLocal`).
4. Verify that the installed plugin list key (`${plugin.id}-${plugin.scope}`) still works correctly.

**Patterns to follow:**
- Existing color coding: user/global = blue, project/workspace = emerald. Local should be visually distinct.
- The scope badge is an inline component used in both `PluginSettingsPage` and `PluginMarketplaceTab`.

**Test scenarios:**
- A user-scope plugin displays the blue badge with "User" label
- A project-scope plugin displays the emerald badge with "Project" label
- A local-scope plugin displays the amber badge with "Local" label
- Badge renders correctly in both English and Chinese

**Verification:** Visual inspection of the Installed tab with plugins in all three scopes.

---

### U7. Build scope picker modal and update marketplace install flow

**Goal:** Replace the hardcoded workspace-scope install with a modal that requires explicit scope selection, shows installation progress, and handles errors.

**Requirements:** R17, R18, R19, R20

**Dependencies:** U5

**Files:**
- `src/client/components/ScopePickerModal.tsx` (new)
- `src/client/components/PluginMarketplaceTab.tsx`

**Approach:**
1. Create `ScopePickerModal` as a new component:
   - Props: `pluginId`, `pluginName`, `sourceUrl`, `isOpen`, `onClose`, `onSuccess`
   - State: `phase: 'choosing' | 'installing' | 'result'`, `selectedScope`, `error`
   - Choosing phase: three radio cards (User, Project, Local) with descriptions. No pre-selection. Install button disabled until selected.
   - Installing phase: overlay with spinner, disabled inputs, status text.
   - Result phase: success message with auto-close timer, or error message with Retry and Cancel buttons.
2. Update `PluginMarketplaceTab`:
   - `handleInstall` no longer calls `installPlugin` directly. Instead, it opens the scope picker modal.
   - `getInstalledScopes` checks all three scopes. If any scope contains the plugin, show Uninstall.
   - `handleUninstall` finds whichever scope the plugin is installed in and uninstalls it.
3. The modal calls `installPlugin(pluginId, source, selectedScope, workspaceId)` from the store.
4. On error, the modal stays open in the `result` phase with `error` set. Retry resets to `choosing` phase. Cancel closes the modal.

**Patterns to follow:**
- Modal styling follows `PluginSettingsPage.tsx` (fixed inset-0, backdrop blur, rounded-xl container).
- Keyboard handling: Escape cancels, Enter confirms when appropriate.
- Use existing `isSaving` flag from the store to disable actions during install.

**Test scenarios:**
- Happy path: click Install → modal opens → select Project → click Install → modal shows Installing → closes on success → plugin appears in Installed tab
- No default: modal opens with no scope selected; Install button is disabled
- Error path: network fails during download → modal shows error with Retry and Cancel → Retry reopens at Choosing phase
- Already installed: marketplace card shows Uninstall for a plugin in user scope; clicking Uninstall removes it
- Scope descriptions: each radio card shows a one-line description of who the scope affects

**Verification:** Manual walkthrough of install, error-retry, and uninstall flows in the UI.

---

### U8. Add i18n translations for 3 scopes and modal text

**Goal:** Provide localized labels for the new scope names and modal UI text.

**Requirements:** R5, R17, R18, R19

**Dependencies:** U6, U7

**Files:**
- `src/client/i18n/en/settings.json`
- `src/client/i18n/zh-CN/settings.json`

**Approach:**
1. Rename existing keys:
   - `scopeGlobal` → `scopeUser`
   - `scopeWorkspace` → `scopeProject`
2. Add new keys:
   - `scopeLocal`: "Local" / "本地"
   - `selectScope`: "Select Installation Scope" / "选择安装范围"
   - `scopeUserDescription`: "Available in all your workspaces" / "在所有工作区可用"
   - `scopeProjectDescription`: "Shared with collaborators in this repository" / "与仓库协作者共享"
   - `scopeLocalDescription`: "Only for you, in this repository" / "仅在此仓库中为您自己使用"
   - `installing`: "Installing…" / "正在安装…"
   - `installSuccess`: "Installed successfully" / "安装成功"
   - `retry`: "Retry" / "重试"
3. Update all component references to use the renamed keys.

**Patterns to follow:**
- Keep translations concise; modal UI has limited horizontal space.
- Maintain parity between English and Chinese files.

**Test scenarios:**
- UI renders correct English labels when language is English
- UI renders correct Chinese labels when language is Chinese
- No missing-key warnings in the browser console

**Verification:** Visual inspection of the modal and Installed tab in both languages.

---

### U9. Add backend test coverage for 3-scope behavior

**Goal:** Ensure the local scope and renamed scopes work correctly through the service layer.

**Requirements:** R5, R7, R19, R22

**Dependencies:** U2

**Files:**
- `src/server/services/plugin-settings-service.test.ts`
- `src/server/routes/plugins.ts` (indirectly, via route-level tests if they exist)

**Approach:**
1. Extend `plugin-settings-service.test.ts` with test cases for the `local` scope.
2. Add tests for the renamed `user` and `project` scopes (formerly `global` and `workspace`).
3. Test the full CRUD cycle for local scope: add, get, enable, disable, remove.
4. Test that `getInstalledPlugins('local', workspacePath)` returns an empty array when `.claude/settings.local.json` does not exist.
5. If route-level tests exist for `plugins.ts`, add cases for the new scope validation and the 409 conflict response.

**Patterns to follow:**
- Existing test setup: create temp directory, override `process.env.HOME`, override `cacheDir` via type cast.
- For local scope tests, create a temp workspace directory and use it as `workspacePath`.

**Test scenarios:**
- `addPlugin('local', ...)` writes to the correct file path
- `getInstalledPlugins('local', ...)` reads from the correct file path
- `removePlugin('local', ...)` deletes the entry
- `setPluginEnabled('local', ...)` updates the enabled flag
- Missing `.claude/settings.local.json` returns empty array, not an error
- Invalid scope values (`'global'`, `'workspace'`) are rejected at runtime

**Verification:** `npm test` or `node --test src/server/services/plugin-settings-service.test.ts` passes.

---

## Scope Boundaries

- Plugin authoring tools (`plugin init`, `plugin validate`) are out of scope.
- LSP servers, monitors, and themes are out of scope.
- Enterprise managed-scope with policy enforcement is out of scope.
- Plugin rating, review, and payment systems are out of scope.
- Dependency resolution between plugins is out of scope.
- Moving an installed plugin from one scope to another without uninstall/reinstall is out of scope.
- Progress streaming during download (e.g., % complete, bytes transferred) is out of scope — the modal shows a binary "Installing…" spinner.

---

## Deferred to Follow-Up Work

- Update the existing plugin manager implementation plan (`docs/plans/2026-06-01-002-feat-plugin-manager-plan.md`) to reflect the 3-scope model once this work lands.
- Add per-plugin configuration UI scoped to the installation scope.
- Add a "Change scope" action that moves a plugin without full uninstall/reinstall.

---

## Assumptions

- `.claude/settings.local.json` follows the same schema as `.claude/settings.json` (both use `enabledPlugins` object format and optionally `pluginManager.plugins`).
- The user's filesystem permissions allow creating `.claude/settings.local.json` in the workspace directory.
- No other code outside the identified files hardcodes `'global'` or `'workspace'` scope strings. A project-wide search during implementation will verify this.
- The frontend is the only consumer of the plugin REST API, so renaming scope values in the API contract does not break external integrations.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Missing scope string references in undiscovered files | Medium | Medium | Run a project-wide grep for `'global'`, `'workspace'`, `'global'\|'workspace'` during implementation |
| Local settings file not gitignored, causing accidental commits | Low (user config) | Low | Document that `.claude/settings.local.json` should be gitignored; this is standard Claude Code behavior |
| Scope picker modal UX feels heavy for frequent installs | Medium | Low | Modal is lightweight (3 radio cards); future work could add a "remember my choice" preference |
| Existing `pluginManager.plugins` entries with old scope names in Comate-specific files | Low | High | Verify scope is not stored in entry objects; if found, add read-time alias mapping |
