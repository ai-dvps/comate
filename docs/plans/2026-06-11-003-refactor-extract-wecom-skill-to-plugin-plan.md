---
title: Extract WeCom Skill to Built-in Local Marketplace Plugin
type: refactor
status: completed
date: 2026-06-11
origin: docs/brainstorms/2026-06-11-extract-wecom-skill-to-plugin-requirements.md
---

# Extract WeCom Skill to Built-in Local Marketplace Plugin

## Summary

Move the bundled `send-wecom-msg` skill into a standard Claude Code plugin named `wecom`, distributed through a built-in, non-removable local marketplace shipped inside the app bundle. The marketplace folder `claude-code-plugin/` contains the marketplace metadata and the plugin. The Plugin Manager gains support for local-directory marketplaces, and the app removes all inline skill file management.

---

## Problem Frame

Today the skill is embedded in the app binary as `src/server/assets/wecom-skill.ts` and written to every workspace's `.claude/skills/send-wecom-msg/SKILL.md` whenever the WeCom bot connects. Updating the skill requires a full app rebuild, and the skill lifecycle is tightly coupled to bot connection state. This plan decouples the skill from the app binary by packaging it as a plugin inside a built-in local marketplace, making it installable through the Plugin Manager without rebuilding the app for future content-only updates.

See the origin requirements doc for the full problem frame and constraints.

---

## Requirements

- R1. Create a built-in local marketplace folder `claude-code-plugin/` with a valid `.claude-plugin/marketplace.json` and the `wecom` plugin inside it.
- R2. Move the `send-wecom-msg` skill content into the plugin so it is invoked as `/wecom:send-wecom-msg`.
- R3. Add local-directory marketplace support to the Plugin Manager backend so it can read `marketplace.json` from a filesystem path.
- R4. Add local-directory plugin source support so plugins listed with relative paths in a local marketplace can be copied into the plugin cache.
- R5. Register the built-in marketplace automatically on app startup and make it non-removable in the Plugin Manager UI.
- R6. Remove the inline skill deployment logic from `WeComBotService` and the build-time generation script.
- R7. Ship the marketplace folder inside the final app bundle so it is available after installation.
- R8. Update any in-app hints or documentation that reference the old `/send-wecom-msg` invocation.

**Origin requirements:** R1–R8 trace to the origin doc's R1–R7.

---

## Scope Boundaries

- Auto-installation or auto-uninstallation based on WeCom bot connection state is deferred for later.
- Remote marketplace publishing or network distribution is not part of this work.
- The plugin contains only the skill; no slash commands, MCP servers, hooks, LSP servers, or background monitors are included.
- Changes to the `@webank/wecom` CLI package itself are out of scope.

### Deferred to Follow-Up Work

- Remote marketplace for out-of-band skill updates without an app release.
- Auto-enabling the plugin for workspaces that have a WeCom bot configured.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/assets/send-wecom-msg.md` — current skill markdown source of truth.
- `scripts/generate-wecom-skill.ts` — build-time generator that produces `src/server/assets/wecom-skill.ts`.
- `src/server/assets/wecom-skill.ts` — generated string constant imported by `WeComBotService`.
- `src/server/services/wecom-bot-service.ts` — writes/removes the skill file on bot connect/disconnect via `writeSkillFiles()` and `removeSkillFiles()`.
- `src/server/services/marketplace-service.ts` — fetches marketplace plugins from network registries and Claude Code's cached marketplace data. Does not currently support local filesystem marketplaces.
- `src/server/utils/plugin-downloader.ts` — downloads plugins from git or zip URLs. Does not currently support local directory sources.
- `src/server/routes/plugins.ts` — install/update/uninstall/enable API endpoints.
- `src/server/services/plugin-settings-service.ts` — manages installed plugin entries and cache paths.
- `src/server/services/commands-service.ts` — discovers plugin skills from `~/.claude/plugins/cache/<pluginId>/`.
- `src-tauri/tauri.conf.json` — bundles `resources/resources` via Tauri's `bundle.resources` config.
- `package.json` — build scripts include `generate:skills` which must be removed.

### External References

- [Claude Code plugins](https://code.claude.com/docs/en/plugins) — plugin layout, manifest format, skill frontmatter.
- [Claude Code plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) — `marketplace.json` schema, local marketplace directories, relative plugin sources.

---

## Key Technical Decisions

- **Built-in local marketplace:** The marketplace ships inside the app bundle under `claude-code-plugin/`. This gives users a discoverable installation path through the Plugin Manager without requiring network access or a remote registry.
- **`claude-code-plugin/` as marketplace folder:** The folder follows the official local-marketplace layout: `.claude-plugin/marketplace.json` at the root and the plugin inside `plugins/wecom/`. This is distinct from a single-plugin folder.
- **Copy plugin to cache on install:** Local marketplace plugins are copied into `~/.claude/plugins/cache/<pluginId>/` on install, matching how git/zip plugins are handled today. This avoids path-resolution fragility when the app bundle path changes.
- **Non-removable built-in marketplace:** The marketplace is registered in a separate, app-managed list rather than user-added marketplaces, and the UI disables the remove action for it.
- **Root-level single skill in plugin:** The `wecom` plugin uses a root-level `SKILL.md` because it ships exactly one skill.

---

## Open Questions

### Resolved During Planning

- **What should the marketplace folder be named?** `claude-code-plugin/`. It acts as the marketplace folder, not the plugin folder.
- **What is the plugin namespace?** `wecom`. Skill invocation becomes `/wecom:send-wecom-msg`.
- **How is the marketplace shipped?** Via Tauri `bundle.resources`, placing the folder under `resources/claude-code-plugin/` or equivalent and copying it into the app bundle at build time.

### Deferred to Implementation

- **Exact Tauri resource path at runtime:** The runtime path of bundled resources differs by platform. Implementation must use Tauri's resource resolution API (`app_handle.path().resource_dir()` or `tauri::api::path::resolve_resource`) to locate the marketplace folder.
- **Marketplace display name and branding:** Final marketplace name, description, and owner fields in `marketplace.json` can be finalized during implementation.
- **Plugin version strategy:** Whether to start at `0.1.0` (matching `@webank/wecom` CLI) or `1.0.0` can be decided during implementation.

---

## Output Structure

```text
claude-code-plugin/                        # built-in marketplace folder
├── .claude-plugin/
│   └── marketplace.json                   # marketplace catalog
└── plugins/
    └── wecom/                             # plugin folder
        ├── .claude-plugin/
        │   └── plugin.json                # plugin manifest
        └── SKILL.md                       # send-wecom-msg skill

resources/                                 # Tauri resources (existing)
└── claude-code-plugin/                    # copy of marketplace shipped with app
```

---

## Implementation Units

### U1. Create the built-in marketplace folder and plugin

**Goal:** Establish the local marketplace folder structure and move the skill content into a properly formatted plugin.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Create: `claude-code-plugin/.claude-plugin/marketplace.json`
- Create: `claude-code-plugin/plugins/wecom/.claude-plugin/plugin.json`
- Create: `claude-code-plugin/plugins/wecom/SKILL.md`
- Delete: `src/server/assets/send-wecom-msg.md`
- Delete: `src/server/assets/wecom-skill.ts`
- Delete: `scripts/generate-wecom-skill.ts`
- Modify: `package.json`

**Approach:**
- Create `claude-code-plugin/` as a local marketplace with `.claude-plugin/marketplace.json` referencing the `wecom` plugin at `./plugins/wecom`.
- Create the `wecom` plugin with `plugin.json` (name `wecom`, version, description) and root-level `SKILL.md`.
- Copy the current skill content from `src/server/assets/send-wecom-msg.md` into the plugin's `SKILL.md`, preserving the frontmatter `description` and adding `name: send-wecom-msg` so the skill invocation is `/wecom:send-wecom-msg`.
- Remove the old markdown asset, generated TypeScript asset, and the build script.
- Remove the `generate:skills` script from `package.json` and from the `build` / `build:server` scripts.

**Patterns to follow:**
- Official Claude Code plugin layout from [Plugins](https://code.claude.com/docs/en/plugins).
- Official local marketplace layout from [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces).

**Test scenarios:**
- Happy path: `claude-code-plugin/.claude-plugin/marketplace.json` parses as valid JSON with required `name`, `owner`, and `plugins` fields.
- Happy path: `claude-code-plugin/plugins/wecom/.claude-plugin/plugin.json` has valid `name` and `version`.
- Happy path: `claude-code-plugin/plugins/wecom/SKILL.md` has valid frontmatter with `description`.
- Edge case: No references to `src/server/assets/wecom-skill.ts` or `scripts/generate-wecom-skill.ts` remain in the codebase.

**Verification:**
- The marketplace and plugin files exist with valid manifests.
- The old assets and generation script are gone.
- `npm run build` no longer depends on skill generation.

---

### U2. Add local-directory marketplace support to MarketplaceService

**Goal:** Enable `MarketplaceService` to read a `marketplace.json` from a local filesystem directory and return its plugins.

**Requirements:** R3

**Dependencies:** U1

**Files:**
- Modify: `src/server/services/marketplace-service.ts`
- Create: `src/server/services/marketplace-service.test.ts` (if not existing)

**Approach:**
- Extend `MarketplaceRegistry` to support a `localPath` source type in addition to `url`/`githubRepo`.
- Add a `fetchLocalMarketplace(marketplacePath, marketplaceName)` method that reads `.claude-plugin/marketplace.json` from the given directory and parses its plugin entries.
- Update `fetchMarketplaces` to dispatch to the local fetcher when a registry entry has a local path.
- Update `loadCachedMarketplaces` to handle local paths from `known_marketplaces.json` if needed.
- For relative plugin sources in local marketplaces, compute the absolute source path relative to the marketplace root.

**Technical design:**
Registry entry for built-in marketplace:
```json
{
  "name": "comate-built-in",
  "localPath": "/path/to/claude-code-plugin"
}
```

**Patterns to follow:**
- Existing `parseMarketplaceJson` and `normalizeMarketplaceEntry` logic.
- Existing `MarketplacePlugin` type; add a `sourceType: 'local'` option.

**Test scenarios:**
- Happy path: `fetchLocalMarketplace` returns the `wecom` plugin from a valid local marketplace directory.
- Happy path: Relative plugin source `./plugins/wecom` resolves to the correct absolute path.
- Edge case: Missing `marketplace.json` returns an empty list and records an error.
- Error path: Invalid JSON in `marketplace.json` is handled gracefully.
- Integration: `fetchMarketplaces` includes plugins from both built-in local and remote marketplaces.

**Verification:**
- A local marketplace path can be passed to `MarketplaceService` and its plugins are returned.
- The built-in marketplace plugins appear in marketplace search results.

---

### U3. Add local-directory plugin source support to PluginDownloader

**Goal:** Enable the plugin installer to copy a plugin from a local directory into the plugin cache.

**Requirements:** R4

**Dependencies:** U2

**Files:**
- Modify: `src/server/utils/plugin-downloader.ts`
- Modify: `src/server/routes/plugins.ts`
- Create: `src/server/utils/plugin-downloader.test.ts` (if not existing)

**Approach:**
- Add `downloadLocal(pluginId, localPath)` to `PluginDownloader` that copies the local directory into `~/.claude/plugins/cache/<pluginId>/`.
- Validate the plugin manifest before copying, consistent with git/zip flows.
- Update `plugins.ts` install route to detect local source paths (e.g., `sourceType === 'local'` or a `file://` / absolute path) and use the local downloader.
- Ensure the copied plugin is discovered by `CommandsService.loadPluginEntries()`.

**Patterns to follow:**
- Existing `PluginDownloader.downloadGit` and `downloadZip` validation and copy semantics.
- Use `fs.cp` or equivalent recursive copy.

**Test scenarios:**
- Happy path: Installing the `wecom` plugin from the local marketplace copies it to the cache and records it in settings.
- Happy path: After install, `pluginSettingsService.readPluginManifest('wecom')` returns the plugin metadata.
- Edge case: Installing from a local path with an invalid plugin manifest fails with a clear error.
- Error path: Source directory missing is handled gracefully.
- Integration: Installing from the built-in marketplace flows through local download, settings write, and skill discovery.

**Verification:**
- The install API can install a plugin whose source is a local directory.
- The cached plugin contains the expected `SKILL.md` and `plugin.json`.

---

### U4. Register the built-in marketplace on startup

**Goal:** Automatically register the shipped marketplace on app startup and expose it as non-removable.

**Requirements:** R5

**Dependencies:** U2, U7 (runtime path resolution)

**Files:**
- Modify: `src/server/services/marketplace-service.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/utils/claude-settings.ts` (if needed for known marketplaces format)

**Approach:**
- At server startup, resolve the runtime path of the shipped `claude-code-plugin/` marketplace folder.
- Register it as a built-in marketplace in `MarketplaceService` with a stable name (e.g., `comate-built-in`).
- Persist or surface the built-in status so the Plugin Manager UI can disable removal.
- Avoid adding it to user-managed `known_marketplaces.json` so users cannot accidentally remove it.

**Patterns to follow:**
- Existing `MarketplaceService` registry handling.

**Test scenarios:**
- Happy path: On app startup, the built-in marketplace is registered and its plugins are fetchable.
- Happy path: `MarketplaceService` distinguishes built-in marketplaces from user-added ones.
- Edge case: If the bundled marketplace folder is missing, log a warning but do not crash.

**Verification:**
- `GET /api/plugins/marketplace` returns the `wecom` plugin from the built-in marketplace.
- The built-in marketplace cannot be removed via the remove-marketplace API.

---

### U5. Remove inline WeCom skill deployment

**Goal:** Remove the runtime skill file writing and deletion logic from `WeComBotService`.

**Requirements:** R6

**Dependencies:** U1 (new plugin exists), U3/U4 (installation path works)

**Files:**
- Modify: `src/server/services/wecom-bot-service.ts`

**Approach:**
- Remove the `SKILL_MD` import.
- Remove `writeSkillFiles()` and `removeSkillFiles()` methods.
- Remove the calls to these methods in the `authenticated` and `disconnected` event handlers.
- Keep the context file writing logic unchanged.

**Patterns to follow:**
- Existing bot service event handling.

**Test scenarios:**
- Happy path: Connecting a WeCom bot no longer writes `.claude/skills/send-wecom-msg/SKILL.md`.
- Happy path: Disconnecting a WeCom bot no longer removes the skill file.
- Integration: WeCom bot connection/disconnection still writes/removes the context file.

**Verification:**
- No code in `wecom-bot-service.ts` references skill file paths or `SKILL_MD`.
- Bot connect/disconnect flows continue to function for messaging.

---

### U6. Update Plugin Manager UI for built-in marketplaces

**Goal:** Display the built-in marketplace in the Plugin Manager and prevent users from removing it.

**Requirements:** R5

**Dependencies:** U4

**Files:**
- Modify: `src/client/components/PluginMarketplaceTab.tsx`
- Modify: `src/client/stores/plugin-store.ts`
- Modify: `src/client/i18n/en/settings.json` and `zh-CN/settings.json`

**Approach:**
- Extend marketplace-related API types/state to include a `builtIn` or `removable` flag.
- Render built-in marketplaces with a distinct indicator (e.g., "Built-in" badge).
- Disable or hide the remove action for built-in marketplaces.
- Add translation keys for built-in marketplace labeling if needed.

**Patterns to follow:**
- Existing marketplace tab UI and plugin store patterns.

**Test scenarios:**
- Happy path: The built-in marketplace appears in the marketplace list.
- Happy path: The built-in marketplace does not show a remove button.
- Edge case: User-added marketplaces still show remove buttons.

**Verification:**
- The built-in marketplace is visible but not removable in the Plugin Manager.
- Existing marketplace functionality for user-added marketplaces remains intact.

---

### U7. Ship the marketplace folder with the app build

**Goal:** Ensure the `claude-code-plugin/` marketplace folder is included in the packaged app and accessible at runtime.

**Requirements:** R7

**Dependencies:** U1

**Files:**
- Create: `resources/claude-code-plugin/` (copy or symlink of top-level marketplace)
- Modify: `src-tauri/tauri.conf.json`
- Modify: Build scripts as needed

**Approach:**
- Place a copy of `claude-code-plugin/` under `resources/claude-code-plugin/` so Tauri includes it in the bundle.
- Update `src-tauri/tauri.conf.json` `bundle.resources` if needed to include the marketplace folder.
- At runtime, resolve the bundled resource path using Tauri's resource API and pass it to `MarketplaceService` as the built-in marketplace path.

**Patterns to follow:**
- Existing Tauri resource bundling for `resources/resources`.

**Test scenarios:**
- Happy path: After `npm run build` / `tauri build`, the marketplace folder exists in the app bundle.
- Happy path: In development, the server resolves the local marketplace path from the repo root.
- Edge case: Missing bundled marketplace folder logs a warning instead of crashing.

**Verification:**
- The app bundle contains the marketplace folder and plugin.
- The server can locate the marketplace folder both in development and in the packaged app.

---

### U8. Update skill invocation references and documentation

**Goal:** Ensure users and documentation refer to the new namespaced skill invocation.

**Requirements:** R8

**Dependencies:** U1

**Files:**
- Modify: Any docs or UI strings referencing `/send-wecom-msg`
- Modify: `docs/brainstorms/2026-06-11-extract-wecom-skill-to-plugin-requirements.md` if needed

**Approach:**
- Search the codebase and docs for references to `send-wecom-msg` or `/send-wecom-msg`.
- Update any user-facing hints, README sections, or skill examples to use `/wecom:send-wecom-msg`.
- Update the plugin's `SKILL.md` examples if they reference the old invocation.

**Test scenarios:**
- Happy path: No stale `/send-wecom-msg` references remain in user-facing surfaces.
- Happy path: The plugin's own `SKILL.md` examples use the namespaced invocation.

**Verification:**
- Grep for `send-wecom-msg` returns only the new plugin files, docs about the migration, and historical plan docs.

---

## System-Wide Impact

- **Interaction graph:** `WeComBotService` no longer writes skill files; skill discovery moves entirely to `CommandsService` via the plugin system. The Plugin Manager UI and marketplace service gain a new built-in source type.
- **Error propagation:** Missing bundled marketplace folder is logged as a warning; plugin installation failures are surfaced through the existing install API error path.
- **State lifecycle risks:** When users uninstall the `wecom` plugin, the cached plugin directory is removed. The skill will not be available until reinstalled. There is no longer any bot-state-coupled cleanup.
- **API surface parity:** Plugin install/update endpoints need to handle local source types. Marketplace fetch returns local plugins alongside remote ones.
- **Unchanged invariants:** WeCom bot connection, message queue processing, user ID resolution, and context file management remain unchanged. Only skill deployment changes.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Local marketplace path resolution differs between dev and packaged app | Use Tauri resource API at runtime; provide fallback to repo root in development. |
| Plugin Manager UI assumes all marketplaces are removable | Add a `builtIn` flag and conditionally render remove actions. |
| Built-in marketplace conflicts with a user-added marketplace of the same name | Use a reserved, app-specific marketplace name (e.g., `comate-built-in`). |
| Removing inline deployment before the plugin install path works leaves users without the skill | Sequence U3/U4 before U5 and verify end-to-end before merging. |
| Tauri resource bundling may not preserve symlinks or deep directory structures | Test bundle on target platforms; copy files rather than symlink if needed. |

---

## Documentation / Operational Notes

- Update the development README to mention the new `claude-code-plugin/` marketplace and how to test it.
- Document that the skill is now installed via the Plugin Manager from the built-in marketplace.
- Note that future remote marketplace updates will require publishing the plugin to a registry and updating the built-in marketplace source.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-11-extract-wecom-skill-to-plugin-requirements.md](docs/brainstorms/2026-06-11-extract-wecom-skill-to-plugin-requirements.md)
- **Related code:** `src/server/services/wecom-bot-service.ts`, `src/server/services/marketplace-service.ts`, `src/server/utils/plugin-downloader.ts`, `src/server/routes/plugins.ts`
- **External docs:** [Claude Code plugins](https://code.claude.com/docs/en/plugins), [Claude Code plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
