---
date: 2026-06-11
topic: extract-wecom-skill-to-plugin
---

# Extract WeCom Skill to a Standard Claude Code Plugin

## Summary

Move the bundled `send-wecom-msg` skill out of the application binary and into a co-located Claude Code plugin named `wecom`. Users will install and enable the plugin manually through the Plugin Manager; the skill will be invoked as `/wecom:send-wecom-msg`. The current runtime skill file management in `WeComBotService` will be removed.

---

## Problem Frame

Today the `send-wecom-msg` skill is embedded in the app as a TypeScript string constant (`src/server/assets/wecom-skill.ts`) generated at build time from `src/server/assets/send-wecom-msg.md`. `WeComBotService` writes this content into every workspace's `.claude/skills/send-wecom-msg/SKILL.md` whenever the WeCom bot connects, and deletes it on disconnect. This means any skill update requires a full application release and rebuild, and the skill lifecycle is tightly coupled to bot connection state.

The goal is to make the skill independently versionable and updatable without shipping a new app build.

---

## Key Flows

- F1. **Install the WeCom plugin**
  - **Trigger:** User opens the Plugin Manager in a workspace where they want to send WeCom messages.
  - **Actors:** End user.
  - **Steps:**
    1. User selects the local `wecom` plugin from the available plugin list (or installs it from the repo-local path).
    2. User chooses installation scope (user, project, or local).
    3. The app copies or references the plugin into the plugin cache and records it in the appropriate settings file.
    4. The skill `/wecom:send-wecom-msg` becomes available in that workspace.
  - **Outcome:** The user can invoke the WeCom send skill without the app having written any skill files under `.claude/skills/`.
  - **Covered by:** R1, R3, R6.

---

## Requirements

**Plugin packaging**
- R1. Create a new top-level directory `claude-code-plugin/` that conforms to the standard Claude Code plugin layout:
  - `claude-code-plugin/.claude-plugin/plugin.json` with `name: "wecom"`, `description`, and `version`.
  - `claude-code-plugin/SKILL.md` containing the `send-wecom-msg` skill content.
- R2. Migrate the current skill content from `src/server/assets/send-wecom-msg.md` (and its generated `src/server/assets/wecom-skill.ts`) into the plugin. The skill content remains functionally identical; only its packaging and invocation name change.

**Application cleanup**
- R3. Remove the inline skill deployment logic from `WeComBotService`, specifically `writeSkillFiles()` and `removeSkillFiles()`.
- R4. Remove the build-time generation script `scripts/generate-wecom-skill.ts`.
- R5. Remove the now-unused server assets `src/server/assets/send-wecom-msg.md` and `src/server/assets/wecom-skill.ts`.

**Discovery and installation**
- R6. The plugin must be installable through the existing Plugin Manager using the co-located plugin source path. After installation and enablement, the skill is discoverable as `/wecom:send-wecom-msg`.
- R7. Update any in-app hints, documentation, or skill references that still point to the old `/send-wecom-msg` invocation name.

---

## Success Criteria

- The WeCom skill is available as `/wecom:send-wecom-msg` after a user installs and enables the `wecom` plugin.
- The app no longer writes, watches, or removes `send-wecom-msg` skill files under workspace `.claude/skills/` directories.
- Skill updates can be made by editing `claude-code-plugin/SKILL.md` and rebuilding/reinstalling the plugin, without changing the app release.
- Existing WeCom bot functionality (message sending, queue processing, bot connection) continues to work unchanged.

---

## Scope Boundaries

- Auto-installation or auto-uninstallation of the plugin based on WeCom bot connection state is deferred for later.
- Marketplace publishing or external registry distribution is not part of this work.
- The plugin contains only the skill; no slash commands, MCP servers, hooks, LSP servers, or background monitors are included.
- Changes to the `@webank/wecom` CLI package itself are out of scope.

---

## Key Decisions

- **Co-located plugin source:** The plugin source lives in this repository rather than a separate repo or published package. This avoids maintaining a separate release pipeline while still separating the skill lifecycle from the app binary.
- **Plugin namespace:** `wecom`. The skill invocation becomes `/wecom:send-wecom-msg`.
- **Manual installation:** Users install and enable the plugin themselves through the Plugin Manager. Bot-state-coupled auto-install is intentionally deferred.
- **Single-skill root layout:** The plugin uses a root-level `SKILL.md` rather than `skills/send-wecom-msg/SKILL.md` because the plugin ships exactly one skill.

---

## Dependencies / Assumptions

- The Plugin Manager supports installing a plugin from a local directory path inside the repo.
- The existing plugin discovery path (`CommandsService.loadPluginEntries`) can resolve and load skills from a plugin installed this way.
- Users understand they must install the plugin in each workspace where they want to use the WeCom send skill.

---

## Outstanding Questions

### Deferred to Planning
- [Needs research] Does the Plugin Manager's local-path installation flow require the plugin to be copied to `~/.claude/plugins/cache/`, or can it be referenced in place? This affects whether the plugin needs a startup-time copy step.
- [Technical] Should the plugin `version` field start at `0.1.0` to match the current `@webank/wecom` CLI version, or at `1.0.0` as a fresh plugin release?
