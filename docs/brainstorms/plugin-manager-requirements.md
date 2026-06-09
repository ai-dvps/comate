---
date: 2026-06-03
topic: plugin-manager
---

# Plugin Manager for Comate

## Summary

A plugin manager that brings Claude Code's `/plugin` experience into Comate, reading and writing the same config files and plugin cache that the CLI uses. Users browse and install plugin packages from Claude Code-compatible marketplaces scoped to user, project, or local. Installed plugins contribute skills, agents, hooks, and MCP servers that fold into the existing workspace discovery system. Plugin management lives in a dedicated workspace settings page, accessed from a toolbar in the session list.

---

## Problem Frame

Comate already supports workspace-level extensions — skills, commands, MCP servers, and hooks — but configuring them is entirely manual. Users must create files in `.claude/skills/`, edit JSON for MCP servers, and manage hooks by hand. There is no discovery mechanism, no versioning, and no sharing. When teams want to standardize tools across workspaces, they resort to copying files or documenting setup steps.

Claude Code CLI solves this with a plugin ecosystem: discoverable packages that bundle multiple component types and install with a single command. The CLI supports three installation scopes — user, project, and local — but Comate currently only recognizes two (`global` and `workspace`), mapping to `user` and `project`. The `local` scope (`.claude/settings.local.json`) is invisible in Comate, meaning plugins installed locally via the CLI do not appear in the app's installed list. Additionally, Comate's current two-scope model allows the same plugin to exist in both global and workspace simultaneously, which the CLI does not permit within a workspace context. The gap is a unified plugin experience that matches the CLI's three-scope model and makes scope choice explicit at install time.

---

## Actors

- A1. **End user**: Uses Comate to browse, install, and manage plugins for their workspaces.
- A2. **Claude Code CLI**: Reads/writes the same settings files and plugin cache as Comate. Plugins installed by either tool are visible to both.
- A3. **Marketplace registry**: Provides plugin metadata and source resolution, whether a Claude Code-compatible marketplace or the custom app registry.
- A4. **Team collaborator**: Benefits from project-scope plugins committed to the repository via `.claude/settings.json`.

---

## Key Flows

- F1. **Browse and install a plugin**
  - **Trigger:** User opens the plugin settings page and switches to the Marketplace tab.
  - **Actors:** A1, A3
  - **Steps:**
    1. User browses or searches the marketplace.
    2. User clicks Install on a plugin card.
    3. A scope picker modal opens with three options (User, Project, Local). No option is pre-selected; the primary action is disabled until a scope is chosen.
    4. User selects a scope and clicks Install in the modal.
    5. The modal transitions to an Installing state (spinner, disabled inputs).
    6. App resolves the plugin source, downloads it to the plugin cache, and writes the plugin entry to the appropriate settings file.
    7. On success, the modal shows a success summary and closes. On failure, the modal displays the error with Retry and Cancel buttons.
    8. Plugin appears in the Installed tab, enabled by default.
  - **Outcome:** The plugin is available in the chosen scope, and its components are discoverable in the workspace.
  - **Covered by:** R1–R8, R17–R20

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
- R5. Users can install a plugin to one of three scopes: user (all workspaces), project (shared with collaborators via `.claude/settings.json`), or local (per-user, per-repo via `.claude/settings.local.json`).
- R6. Installing a plugin downloads and caches it to the Claude Code CLI-compatible plugin cache directory.
- R7. The app writes the installed plugin entry to the appropriate settings file (`~/.claude/settings.json` for user, `.claude/settings.json` for project, `.claude/settings.local.json` for local).
- R8. The app supports installing a plugin from a direct source URL (git repository, zip archive) as a fallback when not found in marketplaces.
- R17. Clicking Install on a marketplace plugin opens a scope picker modal. The modal presents three radio-card options (User, Project, Local). No option is pre-selected, and the Install button is disabled until the user selects a scope.
- R18. After the user selects a scope and clicks Install, the modal transitions to an Installing state: scope selection is disabled, the button shows a loading spinner with text like "Installing…", and a status line indicates the current operation (e.g., "Downloading from GitHub…").
- R19. If installation fails (network error, disk write error, corrupt manifest), the modal remains open and transitions to an Error state. The Error state displays the failure reason and offers two actions: Retry (re-attempts the full install from scratch) and Cancel (closes the modal, leaving no partial installation state).
- R20. If a plugin is already installed in any scope, its marketplace card shows an Uninstall button instead of Install. Clicking Uninstall removes the plugin from whichever scope it is installed in.

**Plugin Discovery and Scope Visibility**
- R21. The Installed tab displays plugins from all three scopes that apply to the current workspace. Each entry shows a scope badge indicating whether it is user, project, or local.
- R22. The app reads `.claude/settings.local.json` in the workspace root to discover local-scope plugins. Plugins installed locally via the CLI are visible in the Installed tab.

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

- AE1. **Covers R5, R7, R17.** Given a user viewing the marketplace for workspace "MyProject", when they click Install on "formatter", then the scope picker modal opens. When they select "Project" scope and click Install, the modal shows "Installing…" and then closes on success. The plugin is added to `enabledPlugins` in `.claude/settings.json`.
- AE2. **Covers R5, R7, R17.** Given the same scenario, when the user selects "Local" scope, the plugin is added to `enabledPlugins` in `.claude/settings.local.json` instead.
- AE3. **Covers R9, R13.** Given an enabled plugin "code-reviewer" with skill "review", when the user disables the plugin, then the `/review` command disappears from the command picker until re-enabled.
- AE4. **Covers R11, R12.** Given an installed plugin at version 1.0.0 where the marketplace lists 1.1.0, when the user clicks "Update", then the cached plugin is replaced with 1.1.0 and the update indicator clears.
- AE5. **Covers R19.** Given a user in the Installing state of the scope modal, when the network connection drops and the git clone fails, then the modal shows an error message "Failed to download: network error" with Retry and Cancel buttons. Clicking Retry re-attempts the install from the beginning.
- AE6. **Covers R20, R22.** Given a plugin "linter" installed in user scope, when the user views the marketplace for any workspace, the "linter" card shows Uninstall. When the user opens the Installed tab, "linter" appears with a "User" scope badge.
- AE7. **Covers R22.** Given a plugin "custom-tool" installed at local scope via `claude plugin add custom-tool --scope local`, when the user opens Comate's Installed tab for that workspace, "custom-tool" appears with a "Local" scope badge.

---

## Success Criteria

- Users can browse, install, enable, disable, update, and uninstall plugins without leaving Comate.
- Plugins installed via Comate are usable in Claude Code CLI sessions for the same workspace, and vice versa.
- Local-scope plugins installed via the CLI are visible and manageable in Comate.
- The scope picker modal prevents accidental installs by requiring explicit scope selection.
- Install failures surface clear errors in-context with Retry/Cancel, never leaving partial or confusing state.
- The existing workspace skills/commands/MCP/hooks functionality continues to work for workspaces without plugins.

---

## Scope Boundaries

- Plugin authoring tools (`plugin init`, `plugin validate`, `plugin tag`, scaffolding) are out of scope.
- LSP servers, monitors, and themes are out of scope — the app lacks the supporting infrastructure.
- Enterprise managed-scope with policy enforcement is out of scope.
- Plugin rating, review, and payment systems are out of scope.
- Dependency resolution between plugins is deferred to a later phase.
- Moving an installed plugin from one scope to another (e.g., Project → Local) without uninstall/reinstall is deferred.

---

## Key Decisions

- **CLI-compatible settings files:** Comate reads/writes the same JSON settings files as Claude Code CLI to ensure interoperability. This constrains the plugin state format but eliminates data synchronization problems.
- **Three scopes matching CLI:** Comate adopts the CLI's `user`/`project`/`local` terminology and file mapping (`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`). The previous `global`/`workspace` naming is retired.
- **No pre-selected default scope:** The scope picker modal never pre-selects an option. The user must explicitly choose, preventing accidental project-scope installs that get committed to the repo.
- **Download-first, then write settings:** Unlike the CLI's settings-first approach, Comate's install endpoint downloads and caches the plugin before writing to settings. This ensures that install failures never leave orphaned settings entries.
- **One plugin per scope per workspace:** Within a workspace context, a plugin can only exist in one scope at a time. The marketplace shows Uninstall if already installed anywhere.
- **Open direct URL installs:** Users can install from any git or zip URL they provide. No domain allowlist is enforced in v1.
- **App-managed caching:** The Agent SDK does not expose plugin management APIs, so Comate implements its own download, caching, and manifest parsing logic.

---

## Dependencies / Assumptions

- The workspace's filesystem path is accessible to the Express backend for reading/writing `.claude/settings.json` and `.claude/settings.local.json`.
- The user's home directory is accessible for reading/writing `~/.claude/settings.json` and `~/.claude/plugins/cache/`.
- Network access is available for fetching marketplace registries and plugin sources.
- The Claude Code plugin manifest schema (`plugin.json`) remains stable or backward-compatible.
- `.claude/settings.local.json` follows the same schema as `.claude/settings.json` (both use `enabledPlugins` object format).

---

## Outstanding Questions

### Resolve Before Planning
_Resolved:_
- ~~[Affects R2][User decision] What is the URL or source of the custom app marketplace registry?~~ → **Resolved:** Users can add any marketplace registry URL themselves.
- ~~[Affects R8][User decision] Should direct URL installs be limited to specific trusted domains, or open to any git/zip URL?~~ → **Resolved:** Open to any git/zip URL the user provides.
- ~~[Affects R5][User decision] Should the scope picker have a default selection?~~ → **Resolved:** No default — force explicit choice.

### Deferred to Planning
- [Affects R6][Technical] Should the plugin cache use exact CLI paths (`~/.claude/plugins/cache/`) or a Comate-specific subpath? CLI compatibility suggests the former.
- [Affects R13–R16][Technical] How do plugin components merge with manually-configured workspace components when names conflict?
- [Affects R18][Technical] Should the install endpoint stream progress events to the frontend for real-time modal updates, or is a simple loading spinner sufficient?
