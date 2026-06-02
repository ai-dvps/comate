---
date: 2026-06-01
topic: plugin-manager
---

# Plugin Manager for Comate

## Summary

A plugin manager that brings Claude Code's `/plugin` experience into Comate, reading and writing the same config files and plugin cache that the CLI uses. Users browse and install plugin packages from Claude Code-compatible marketplaces or a custom app registry, scoped globally or per-workspace. Installed plugins contribute skills, agents, hooks, and MCP servers that fold into the existing workspace discovery system. Plugin management lives in a dedicated workspace settings page, accessed from a toolbar in the session list.

---

## Problem Frame

Comate already supports workspace-level extensions — skills, commands, MCP servers, and hooks — but configuring them is entirely manual. Users must create files in `.claude/skills/`, edit JSON for MCP servers, and manage hooks by hand. There is no discovery mechanism, no versioning, and no sharing. When teams want to standardize tools across workspaces, they resort to copying files or documenting setup steps.

Claude Code CLI solves this with a plugin ecosystem: discoverable packages that bundle multiple component types and install with a single command. Comate users who also use the CLI have access to this ecosystem in the terminal but not in the desktop app. Conversely, any plugin management built only into Comate would create a parallel, incompatible system. The gap is a unified plugin experience that works across both tools.

---

## Actors

- A1. **End user**: Uses Comate to browse, install, and manage plugins for their workspaces.
- A2. **Claude Code CLI**: Reads/writes the same settings files and plugin cache as Comate. Plugins installed by either tool are visible to both.
- A3. **Marketplace registry**: Provides plugin metadata and source resolution, whether a Claude Code-compatible marketplace or the custom app registry.

---

## Key Flows

- F1. **Browse and install a plugin**
  - **Trigger:** User opens the plugin settings page and switches to the Marketplace tab.
  - **Actors:** A1, A3
  - **Steps:**
    1. User selects a scope (Global or This Workspace).
    2. User browses or searches the marketplace.
    3. User clicks Install on a plugin.
    4. App resolves the plugin source, downloads it to the plugin cache, and writes the plugin entry to the appropriate settings file.
    5. Plugin appears in the Installed tab, enabled by default.
  - **Outcome:** The plugin is available in the current scope, and its components are discoverable in the workspace.
  - **Covered by:** R1–R7

- F2. **Update an installed plugin**
  - **Trigger:** App detects that a newer version of an installed plugin is available, or user manually checks for updates.
  - **Actors:** A1, A3
  - **Steps:**
    1. App compares the cached plugin version against the marketplace version.
    2. UI surfaces an update indicator.
    3. User clicks Update.
    4. App downloads the new version to the cache and updates the settings file.
  - **Outcome:** The plugin runs at the latest version; update indicator clears.
  - **Covered by:** R11, R12

- F3. **Uninstall a plugin**
  - **Trigger:** User clicks Uninstall on an installed plugin.
  - **Actors:** A1
  - **Steps:**
    1. User confirms uninstall.
    2. App removes the plugin from the settings file.
    3. App purges the cached plugin data (with optional grace period or explicit data cleanup).
  - **Outcome:** Plugin components are no longer available in the scope.
  - **Covered by:** R10

- F4. **Enable or disable a plugin**
  - **Trigger:** User toggles a plugin's enable state in the Installed tab.
  - **Actors:** A1
  - **Steps:**
    1. User flips the enable/disable toggle.
    2. App updates the plugin's state in the settings file.
    3. If disabled, the plugin's components are excluded from workspace discovery.
  - **Outcome:** Plugin state changes without removing it from the system.
  - **Covered by:** R9, R13–R16

---

## Requirements

**Marketplace and Discovery**
- R1. The app discovers plugins from Claude Code-compatible marketplaces configured in settings.
- R2. The app supports a custom app marketplace registry as a secondary source.
- R3. The marketplace browser displays plugin metadata: name, displayName, description, version, author, keywords, and source marketplace.
- R4. The marketplace browser supports searching plugins by name, keyword, or description.

**Plugin Installation and Management**
- R5. Users can install a plugin to global (user) scope or to the current workspace (project) scope.
- R6. Installing a plugin downloads and caches it to the Claude Code CLI-compatible plugin cache directory.
- R7. The app writes the installed plugin entry to the appropriate settings file (`~/.claude/settings.json` for global, `.claude/settings.json` for workspace).
- R8. The app supports installing a plugin from a direct source URL (git repository, zip archive) as a fallback when not found in marketplaces.

**Plugin Lifecycle and State**
- R9. Users can enable or disable an installed plugin without uninstalling it.
- R10. Users can uninstall a plugin, which removes it from the settings file and optionally purges cached data.
- R11. The app checks for plugin updates and surfaces update availability in the UI.
- R12. Users can update a plugin to the latest version, which replaces the cached copy and updates the settings file.

**Component Integration**
- R13. When a plugin is enabled for a workspace, its skills and commands are discovered alongside existing workspace skills and commands.
- R14. When a plugin is enabled for a workspace, its MCP server configurations are merged with workspace MCP server configurations.
- R15. When a plugin is enabled for a workspace, its hooks are merged with workspace hook configurations.
- R16. Plugin agents are made available to the Claude Agent SDK when the plugin is enabled.

---

## Acceptance Examples

- AE1. **Covers R5, R7.** Given a user viewing the marketplace for workspace "MyProject", when they select "Install to This Workspace" for plugin "formatter", then the plugin is added to `enabledPlugins` in the workspace's `.claude/settings.json`.
- AE2. **Covers R9, R13.** Given an enabled plugin "code-reviewer" with skill "review", when the user disables the plugin, then the `/review` command disappears from the command picker until re-enabled.
- AE3. **Covers R11, R12.** Given an installed plugin at version 1.0.0 where the marketplace lists 1.1.0, when the user clicks "Update", then the cached plugin is replaced with 1.1.0 and the update indicator clears.

---

## Success Criteria

- Users can browse, install, enable, disable, update, and uninstall plugins without leaving Comate.
- Plugins installed via Comate are usable in Claude Code CLI sessions for the same workspace, and vice versa.
- The existing workspace skills/commands/MCP/hooks functionality continues to work for workspaces without plugins.

---

## Scope Boundaries

- Plugin authoring tools (`plugin init`, `plugin validate`, `plugin tag`, scaffolding) are out of scope.
- LSP servers, monitors, and themes are out of scope — the app lacks the supporting infrastructure.
- Enterprise managed-scope with policy enforcement is out of scope.
- Plugin rating, review, and payment systems are out of scope.
- Dependency resolution between plugins is deferred to a later phase.

---

## Key Decisions

- **CLI-compatible settings files:** Comate reads/writes the same JSON settings files as Claude Code CLI to ensure interoperability. This constrains the plugin state format but eliminates data synchronization problems.
- **Two marketplace sources:** Both Claude Code marketplaces and a custom app registry are supported from v1 to maximize plugin availability without forcing users into one ecosystem.
- **User-configurable marketplaces:** Users can add any marketplace registry URL themselves. There is no hardcoded custom registry.
- **Open direct URL installs:** Users can install from any git or zip URL they provide. No domain allowlist is enforced in v1.
- **App-managed caching:** The Agent SDK does not expose plugin management APIs, so Comate implements its own download, caching, and manifest parsing logic.

---

## Dependencies / Assumptions

- The workspace's filesystem path is accessible to the Express backend for reading/writing `.claude/settings.json`.
- The user's home directory is accessible for reading/writing `~/.claude/settings.json` and `~/.claude/plugins/cache/`.
- Network access is available for fetching marketplace registries and plugin sources.
- The Claude Code plugin manifest schema (`plugin.json`) remains stable or backward-compatible.

---

## Outstanding Questions

### Resolve Before Planning
_Resolved:_
- ~~[Affects R2][User decision] What is the URL or source of the custom app marketplace registry?~~ → **Resolved:** Users can add any marketplace registry URL themselves.
- ~~[Affects R8][User decision] Should direct URL installs be limited to specific trusted domains, or open to any git/zip URL?~~ → **Resolved:** Open to any git/zip URL the user provides.

### Deferred to Planning
- [Affects R6][Technical] Should the plugin cache use exact CLI paths (`~/.claude/plugins/cache/`) or a Comate-specific subpath? CLI compatibility suggests the former.
- [Affects R13–R16][Technical] How do plugin components merge with manually-configured workspace components when names conflict?
