# Skill management

Comate ships standard Skills under `skills/`. The installed Skills page shows local installations and prepares an editable `skill-manager` conversation. Installation, removal and updates run through the agent's existing execution permissions.

## Bundled resources

`skills/management/.claude/skills/skill-manager/` contains the management instructions. `skills/wecom/.claude/skills/` contains the business Skills migrated from Comate's former Claude plugin. These app resources are maintained by application updates. User installations and third-party plugin settings are preserved.

Claude loads these directories through its additional-directory discovery and explicit Skill references. Codex registers native Skill roots and sends selected paths through its Skill input protocol. OpenCode receives native `skills.paths`. Session prompts include the applicable bundled Skill catalog; business Skills still require the existing integration configuration, session identity and permissions.

The inventory discovers actual files in supported project and user roots. Lock records only supply available provenance and legacy expert-package metadata. Invocation names use the original Skill name without a generated suffix. Users resolve same-name installation conflicts. Shared targets appear once with their aliases. The installed list describes disk state; the picker additionally applies backend discovery and session policy. A changed native Skill can require a new session.

## Bundled CLI

`npm run build:cli:skills` builds `dist/skills-cli/bundle.cjs`. `build:sidecar` packages this as a separate Node 22 executable and copies the standard Skills and third-party notices into application resources. End users do not need a separate Node installation. Git sources still require Git.

The entry point in `scripts/skills-cli-entry.ts` reuses the pinned vendored Skills CLI 1.5.11. The vendor directory remains unchanged. Build-time transforms disable upstream telemetry and propagate both upstream partial-install failure branches to a nonzero exit code; a changed upstream anchor fails the build. `ThirdPartyNoticeText.txt` accompanies the packaged resources.

The wrapper requires explicit Skill, scope and agent choices, refuses implicit overwrites, checks shared aliases and protects bundled resources. Updating a shared installation requires its exact path and an explicit shared-path acknowledgement. The agent must inspect local changes before an update. A failed replacement can leave partial files; the manager checks the resulting contents before reporting completion. Generator-based repositories use their documented installer after confirming prerequisites and scope.

Run `npm run test:skills-cli` for actual install, shared-target protection, removal and partial-failure checks in temporary directories. `builtin-skills-runtime.test.ts` checks Claude and OpenCode native discovery; Codex app-server tests cover native roots and session environment. No test sends a real WeCom message.

## Contextual management

The installed page shows only the current project and user-level installations, with a separate Comate-owned group. Scope and Agent filters are independent; shared installations match every applicable Agent. The builtin group is independent of scope filtering. Same-name copies remain separate rows, while aliases of one real target share a row. Versions come from installed `SKILL.md` metadata.version; missing versions are shown as unknown.

Install Skill, per-row Update/Remove, and on-demand help prepare editable skill-manager drafts. Row drafts include the precise installation and all affected Agents regardless of the active filter. They never send automatically or overwrite existing drafts. Changes apply only to the selected installation; cross-project bulk operations require an explicit conversational request and selection of accessible installations.

List rows prioritize the Skill name and purpose, followed by scope and Agent applicability. Versions, source, full paths and shared aliases are disclosed in Installation details; paths can be copied. Installation paths appear only inside Installation details, including same-name installations within the same scope.

Project and user scopes use subtle blue and purple tags. Agent summaries include only currently available backends, matching the Agent selector; full compatibility remains in installation details and mutation drafts.

Search ranks exact name matches, name prefixes, name substrings, then description-only matches. Matching ignores case and surrounding query whitespace; ties retain inventory order. Empty searches restore inventory order. Scope and Agent filters remain independent, and builtin grouping is preserved.

Install actions open the existing New Chat page with the current workspace selected and its normal composer defaults. The skill-manager request is prepared in the workspace New Chat draft; no session is created until the user sends. Existing New Chat text and attachments are preserved, with the installation request appended for editing. Update/remove keep their existing draft handoff.

## Multi-provider discovery and Hub lifecycle

`comate skills find <query>` searches skills.sh, SkillsHub, iFlytek SkillHub, Tencent SkillHub. `--providers <comma-separated IDs>` restricts the query. JSON reports each provider and an overall available/partial/unavailable status; total failure exits nonzero. Provider API bases remain environment-configurable; there is no settings UI for source configuration.

Use the result's installSource with `add --list`, then select actual Skill names and scope/agents. Repository sources use the existing installer. xfyun and skillhub-cn coordinates use bounded, validated archive materialization before the same installer. Extraction requires unzip. Per-installation `.comate-skill-source.json` retains the original coordinate for future updates and takes precedence over name-keyed legacy locks. Update uses `add --replace --expected-path` for exactly one installation, with existing shared-path checks; download failure occurs before replacement. Removal continues to use exact logical and resolved paths. Expert-package orchestrators still require their dedicated workflow; they are not installed implicitly as individual Skills.
