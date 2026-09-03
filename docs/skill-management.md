# Skill management

Comate ships standard Skills under `skills/`. The installed Skills page shows local installations and prepares an editable `skill-manager` conversation. Installation, removal and updates run through the agent's existing execution permissions.

## Bundled resources

`skills/management/.claude/skills/skill-manager/` contains the management instructions. `skills/wecom/.claude/skills/` contains the business Skills migrated from Comate's former Claude plugin. These app resources are maintained by application updates. User installations and third-party plugin settings are preserved.

Claude loads these directories through its additional-directory discovery and explicit Skill references. Codex registers native Skill roots and sends selected paths through its Skill input protocol. OpenCode receives native `skills.paths`. Session prompts include the applicable bundled Skill catalog; business Skills still require the existing integration configuration, session identity and permissions.

The inventory discovers actual files in supported project and user roots. Lock records only supply available provenance and legacy expert-package metadata. Stable invocation aliases distinguish same-name installations. Shared targets appear once with their aliases. The installed list describes disk state; the picker additionally applies backend discovery and session policy. A changed native Skill can require a new session.

## Bundled CLI

`npm run build:cli:skills` builds `dist/skills-cli/bundle.cjs`. `build:sidecar` packages this as a separate Node 22 executable and copies the standard Skills and third-party notices into application resources. End users do not need a separate Node installation. Git sources still require Git.

The entry point in `scripts/skills-cli-entry.ts` reuses the pinned vendored Skills CLI 1.5.11. The vendor directory remains unchanged. Build-time transforms disable upstream telemetry and propagate both upstream partial-install failure branches to a nonzero exit code; a changed upstream anchor fails the build. `ThirdPartyNoticeText.txt` accompanies the packaged resources.

The wrapper requires explicit Skill, scope and agent choices, refuses implicit overwrites, checks shared aliases and protects bundled resources. Updating a shared installation requires its exact path and an explicit shared-path acknowledgement. The agent must inspect local changes before an update. A failed replacement can leave partial files; the manager checks the resulting contents before reporting completion. Generator-based repositories use their documented installer after confirming prerequisites and scope.

Run `npm run test:skills-cli` for actual install, shared-target protection, removal and partial-failure checks in temporary directories. `builtin-skills-runtime.test.ts` checks Claude and OpenCode native discovery; Codex app-server tests cover native roots and session environment. No test sends a real WeCom message.
