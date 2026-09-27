---
title: Register Built-In Marketplace via Native Claude Code Settings
type: feat
status: active
date: 2026-06-12
origin: none
---

# Register Built-In Marketplace via Native Claude Code Settings

## Summary

Comate currently surfaces its built-in `wecom` plugin through a custom app-layer registry (`registerBuiltInMarketplace` in `MarketplaceService`). The native Claude Code integration point for a private or bundled marketplace is `extraKnownMarketplaces` in `~/.claude/settings.json`, and plugin enablement is expressed through `enabledPlugins` using the `<pluginId>@<marketplaceName>` key. This plan migrates the built-in marketplace to that native mechanism so Comate behaves like a standard Claude Code client and the `wecom` plugin is enabled as `wecom@comate-built-in`.

## Problem Frame

Claude Code CLI recognizes marketplaces listed under `extraKnownMarketplaces` and plugins enabled under `enabledPlugins`. Comate’s current implementation bypasses the first setting by hard-coding a built-in registry in the app’s `MarketplaceService`. That works for discovery inside the Plugin Manager, but it does not write the marketplace into the user’s global settings, so the CLI itself never sees the `comate-built-in` marketplace and the plugin is not enabled in the native format. We need to shift from an app-private registry to the CLI-native settings layer while preserving the bundled marketplace folder and its packaging behavior.

## Requirements

- R1. The bundled `claude-code-plugin/` folder continues to ship with the app build (Tauri resources / pkg sidecar fallbacks).
- R2. On server startup, Comate registers `comate-built-in` in the user’s `~/.claude/settings.json` under `extraKnownMarketplaces` with `source: "directory"` and `path` pointing to the resolved bundled marketplace folder.
- R3. The write is non-destructive: existing `extraKnownMarketplaces` entries are preserved, and the `comate-built-in` key is updated only if its path differs.
- R4. The Plugin Manager discovers `comate-built-in` plugins by reading `extraKnownMarketplaces` from settings, including directory-type sources.
- R5. When `known_marketplaces.json` cache exists on disk, custom registries from `extraKnownMarketplaces` are still merged into the marketplace response.
- R6. Installing the `wecom` plugin from the built-in marketplace writes `"wecom@comate-built-in": true` to the selected scope’s `enabledPlugins`.
- R7. The legacy app-layer built-in registry (`registerBuiltInMarketplace`, `fetchBuiltInMarketplaces`, etc.) is removed.
- R8. Direct-source installs and GitHub-based `extraKnownMarketplaces` continue to work unchanged.

## Scope Boundaries

- Out of scope: changing the plugin cache layout, download logic, or skill discovery beyond the settings key format.
- Out of scope: modifying how Claude Code CLI itself interprets `extraKnownMarketplaces`; we align with the existing CLI behavior.
- Out of scope: supporting write-back of `enabledPlugins` from the CLI into Comate’s rich `pluginManager.plugins` format beyond what `readPluginSettings` already does.

## Context & Research

### Relevant Code and Patterns

- `src/server/utils/resolve-builtin-marketplace-path.ts` — Resolves the bundled `claude-code-plugin` folder across dev, `tauri dev`, and packaged app (`TAURI_RESOURCE_DIR`, repo-root, and `process.execPath` fallbacks).
- `src/server/utils/claude-settings.ts` — Reads/writes `~/.claude/settings.json` and workspace settings. Already parses `enabledPlugins` (object and array formats) and `extraKnownMarketplaces` (GitHub-only). `writePluginSettings` merges atomically via temp file + rename.
- `src/server/services/marketplace-service.ts` — Currently has a custom `builtInRegistries` array and `fetchBuiltInMarketplaces()`. `fetchAllMarketplaces()` loads `known_marketplaces.json` and merges built-ins only when cache exists.
- `src/server/routes/plugins.ts` — `loadCustomMarketplaces()` reads `extraKnownMarketplaces` from global settings but only emits GitHub registries.
- `src/client/components/PluginMarketplaceTab.tsx` + `ScopePickerModal.tsx` — Marketplace install passes `plugin.sourceUrl` as the install `source`; this causes `enabledPlugins` keys like `wecom@<absolute-path>` instead of `wecom@comate-built-in`.
- `src/server/services/plugin-settings-service.ts` — `addPlugin(scope, pluginId, version, source, workspacePath)` writes to the scope settings via `writePluginSettings`, which derives the `@marketplaceId` from `source`.
- `src-tauri/tauri.conf.json` — Bundles `src-tauri/resources` as Tauri resources; the build already copies `claude-code-plugin` into `src-tauri/resources`.

### Institutional Learnings

- `fileURLToPath(import.meta.url)` crashes in pkg-bundled sidecars; path resolution already guards this and falls back to `process.execPath`.
- Settings writes must be atomic and preserve unrelated keys because the user (and the CLI) may edit `~/.claude/settings.json` concurrently.

## Key Technical Decisions

- **Native settings are the source of truth.** The app no longer maintains a separate built-in registry object. Discovery flows from `extraKnownMarketplaces` just like user-added marketplaces.
- **Directory-type marketplace sources are first-class.** `extraKnownMarketplaces` entries with `source: "directory"` are parsed, surfaced in the marketplace response, and treated as local-path registries.
- **Custom registries always merge.** `fetchAllMarketplaces` will merge `extraKnownMarketplaces` plugins regardless of whether `known_marketplaces.json` cache exists, ensuring the built-in marketplace is visible even after the CLI has populated its cache.
- **Marketplace name is the install source.** For marketplace installs, the client sends `source: <marketplaceName>` rather than `sourceUrl`. The backend resolves the download URL/path from the marketplace result. This makes `enabledPlugins` keys stable and marketplace-scoped (`wecom@comate-built-in`).
- **Startup registration is idempotent.** The server writes the `comate-built-in` entry once per startup only if the resolved bundled path exists and differs from the current value; otherwise it leaves user settings untouched.

## Open Questions

### Resolved During Planning

- **Where to register the marketplace?** In `src/server/index.ts` on startup, using the existing path resolver and a new settings helper.
- **What happens when cache exists?** Custom registries are merged alongside cached marketplaces; built-in registry removal is compensated by treating the startup-registered directory as a custom registry.
- **What source value produces `wecom@comate-built-in`?** The marketplace name `comate-built-in`, passed from the client for marketplace installs.

### Deferred to Implementation

- **Error handling when settings.json is malformed:** Use existing `readPluginSettings` fallback (empty object) and surface a diagnostic log; no user-facing error is required for v1.
- **Behavior if user manually removes `comate-built-in` from settings:** It will be re-added on next server startup. This is acceptable for a bundled, required marketplace, but may be revisited if users want an opt-out.

## Implementation Units

### U1: Extend `claude-settings.ts` for directory-type `extraKnownMarketplaces`

**Goal:** Parse and write `extraKnownMarketplaces` entries whose source is a local directory, and provide an idempotent helper to add the bundled marketplace.

**Files:**
- Modify: `src/server/utils/claude-settings.ts`
- Create test: `src/server/utils/claude-settings.test.ts` (or extend existing)

**Approach:**
1. Broaden `KnownMarketplace` to a discriminated union:
   - `{ source: { source: 'github'; repo: string } }`
   - `{ source: { source: 'directory'; path: string } }`
2. Update `readPluginSettings` to parse both shapes; ignore entries with unsupported/missing source fields.
3. Add `addExtraKnownMarketplace(name, marketplace): void` that:
   - Resolves the global settings path.
   - Reads current settings via `readPluginSettings`.
   - Sets `extraKnownMarketplaces[name]` only if the value is missing or the path differs.
   - Writes back via `writePluginSettings`, preserving `enabledPlugins`, `pluginManager`, and `pluginConfigs`.
4. Keep `writePluginSettings` behavior of preserving existing `extraKnownMarketplaces` when the input object has none.

**Test scenarios:**
- Parse settings with GitHub and directory marketplaces; both appear in `extraKnownMarketplaces`.
- Parse settings with malformed marketplace entries; they are ignored.
- `addExtraKnownMarketplace` adds a new entry when absent.
- `addExtraKnownMarketplace` updates the path when it changes.
- `addExtraKnownMarketplace` does not rewrite the file when the entry already matches.
- `addExtraKnownMarketplace` preserves unrelated keys and existing marketplace entries.

**Verification:** Unit tests pass; existing `plugin-settings-service.test.ts` tests still pass.

### U2: Update marketplace discovery to support directory registries and always merge custom sources

**Goal:** `extraKnownMarketplaces` directory sources appear in the Plugin Manager, even when `known_marketplaces.json` cache exists.

**Files:**
- Modify: `src/server/routes/plugins.ts`
- Modify: `src/server/services/marketplace-service.ts`
- Create/modify test: `src/server/services/marketplace-service.test.ts`

**Approach:**
1. In `plugins.ts`, extend `loadCustomMarketplaces()` to handle `source.source === 'directory'` by returning a registry with `localPath: marketplace.source.path`.
2. In `marketplace-service.ts`:
   - Remove `builtInRegistries`, `registerBuiltInMarketplace`, `getBuiltInMarketplaces`, and `fetchBuiltInMarketplaces`.
   - Update `fetchMarketplaces` to remove built-in merging (it already receives custom registries).
   - Update `fetchAllMarketplaces` so that when `known_marketplaces.json` cache exists, it still fetches and merges plugins from `customRegistries` before deduplicating.
3. Keep `fetchLocalMarketplace` and the local-path source-type handling unchanged.

**Test scenarios:**
- `loadCustomMarketplaces` returns a `localPath` registry for a directory marketplace.
- `loadCustomMarketplaces` still returns a GitHub registry for a GitHub marketplace.
- `fetchAllMarketplaces` with a populated `known_marketplaces.json` and a directory custom registry returns plugins from both.
- `fetchAllMarketplaces` with no cache uses the live fetch path and includes custom registries.
- Deduplication prefers the higher-version entry when the same plugin appears in cache and a custom registry.

**Verification:** Unit tests pass; marketplace route returns the `wecom` plugin when `comate-built-in` is configured as a directory marketplace.

### U3: Register `comate-built-in` on startup via native settings

**Goal:** Replace the custom built-in registry startup call with a native `extraKnownMarketplaces` write.

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/server/utils/resolve-builtin-marketplace-path.ts` (keep, minor rename of registration function if needed)

**Approach:**
1. In `src/server/index.ts`, replace `registerBuiltInMarketplace()` with `ensureComateBuiltInMarketplace()` that:
   - Calls `resolveBuiltInMarketplacePath()`.
   - If a path is found, calls `addExtraKnownMarketplace('comate-built-in', { source: { source: 'directory', path: resolvedPath } })`.
   - Logs via `diagLog` on success or when the folder is not found.
2. Remove the `marketplaceService` import if it is no longer used in `index.ts`.
3. Keep `resolveBuiltInMarketplacePath` and its tests intact.

**Test scenarios:**
- Startup with a resolvable marketplace path writes the `comate-built-in` directory entry to `~/.claude/settings.json`.
- Startup with a missing marketplace path logs a warning and does not crash.
- Existing `extraKnownMarketplaces` entries are preserved.

**Verification:** Manual end-to-end check in dev server; resolver unit tests pass.

### U4: Fix marketplace install source handling

**Goal:** Marketplace installs record the marketplace name as the plugin source so `enabledPlugins` uses `<pluginId>@<marketplaceName>`.

**Files:**
- Modify: `src/client/components/PluginMarketplaceTab.tsx`
- Modify: `src/client/components/ScopePickerModal.tsx`
- Modify: `src/client/stores/plugin-store.ts` (signature)

**Approach:**
1. Change the `ScopePickerModal` props to accept `sourceMarketplace: string` in addition to `sourceUrl` (or replace `sourceUrl` for marketplace installs; direct install still needs the raw URL).
2. In `PluginMarketplaceTab.handleInstall`, pass `plugin.sourceMarketplace` (the marketplace name) to the modal instead of `plugin.sourceUrl`.
3. In `ScopePickerModal.handleInstall`, call `installPlugin(pluginId, sourceMarketplace, selectedScope, workspaceId)` for marketplace installs; direct install continues to use the raw URL.
4. Update `installPlugin` store signature to accept either a marketplace name or a URL/path as the `source` string; behavior on the backend is already distinguished by the install route.

**Test scenarios:**
- Installing `wecom` from the built-in marketplace sends `source: "comate-built-in"`.
- Direct install still sends the raw URL/path.
- After install, the selected scope’s `settings.json` contains `"wecom@comate-built-in": true`.

**Verification:** Manual install/uninstall in dev server; inspect resulting `settings.json`.

### U5: Cleanup legacy built-in registry code and tests

**Goal:** Remove the now-unused app-layer built-in registry surface.

**Files:**
- Modify: `src/server/services/marketplace-service.ts`
- Modify: `src/server/index.ts`
- Delete/modify: `src/server/utils/resolve-builtin-marketplace-path.test.ts` (keep resolver tests, remove any built-in-registry-specific assertions if present)

**Approach:**
1. Delete `registerBuiltInMarketplace`, `getBuiltInMarketplaces`, `fetchBuiltInMarketplaces`, and the `builtIn` flag plumbing from `MarketplaceService` if no longer referenced.
2. Keep the `builtIn?: boolean` field on `MarketplacePlugin`/`MarketplaceRegistry` if the UI still uses it to badge marketplaces; otherwise remove it.
3. Remove the `registerBuiltInMarketplace` call from `index.ts`.
4. Update tests to assert the directory-source discovery path instead of the removed built-in registry path.

**Test scenarios:**
- No references to `registerBuiltInMarketplace` or `fetchBuiltInMarketplaces` remain.
- Marketplace service tests cover directory custom registries.

**Verification:** `grep -R` confirms no leftover built-in registry calls; test suite passes.

### U6: End-to-end verification and documentation

**Goal:** Confirm the built-in marketplace and plugin work in dev, `tauri dev`, and packaged app builds.

**Files:**
- Modify: any relevant README or `docs/` notes about built-in plugin distribution

**Approach:**
1. Dev server: start server, open Plugin Manager, confirm `comate-built-in` marketplace visible with `wecom` plugin.
2. Install `wecom` to user scope; verify `~/.claude/settings.json` has both `extraKnownMarketplaces.comate-built-in` and `enabledPlugins["wecom@comate-built-in"]: true`.
3. `tauri dev`: repeat visibility check.
4. Packaged app: confirm `claude-code-plugin` is in `src-tauri/resources` and `TAURI_RESOURCE_DIR` resolves it; repeat install check.
5. Uninstall removes the `enabledPlugins` key and `pluginManager.plugins.wecom` entry from the scope settings.

**Verification:** All scenarios above pass manually; automated tests from U1–U5 pass.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Overwriting user’s `extraKnownMarketplaces` or other settings keys | Use `writePluginSettings` merge behavior; add targeted tests for preservation. |
| Path resolution failing in packaged app | Reuse the already-tested `resolveBuiltInMarketplacePath` with pkg fallback; include packaged-app verification in U6. |
| `known_marketplaces.json` cache shadows custom registries | Fix `fetchAllMarketplaces` to always merge custom registries (U2). |
| Concurrent writes between Comate and CLI corrupt settings | Keep atomic temp-file + rename write; last-write-wins is acceptable for v1. |
| Client sends wrong `source` for marketplace installs | Update modal/tab props and verify the install payload in U4 tests. |

## Output Structure

- `src/server/utils/claude-settings.ts` — extended with directory marketplace parsing and `addExtraKnownMarketplace` helper.
- `src/server/routes/plugins.ts` — `loadCustomMarketplaces` supports directory sources.
- `src/server/services/marketplace-service.ts` — removed built-in registry; custom registries always merged.
- `src/server/index.ts` — startup writes `comate-built-in` to native settings instead of registering app-layer built-in.
- `src/client/components/PluginMarketplaceTab.tsx` + `ScopePickerModal.tsx` — marketplace installs pass marketplace name as source.
- Tests for settings parsing, marketplace service, and resolver.
