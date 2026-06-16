---
topic: wecom-doc-skill-migration
date: 2026-06-16
status: ready-for-planning
---

# WeCom Doc Skill Migration Requirements

Migrate the `wecomcli-doc` skill from the Rust `wecom-cli` project into the `claude-code-plugin` WeCom plugin.

## Problem Frame

The new TypeScript `@webank/wecom` CLI now exposes the `doc:*` subcommands implemented in `packages/wecom-cli`. The Claude Code plugin needs a matching skill so agents can discover and invoke these document/smartpage operations through the new CLI. The source skill lives in the legacy Rust project and references `wecom-cli doc <tool> '<json>'`; the migrated skill must reference the new oclif-style `wecom doc:<tool>` commands.

## Source and Destination

- **Source**: `RustProjects/wecom-cli/skills/wecomcli-doc/` (SKILL.md + references/)
- **Destination**: `claude-code-plugin/plugins/wecom/skills/wecom-doc/`
- **Existing pattern**: `claude-code-plugin/plugins/wecom/skills/send-wecom-msg/SKILL.md`

## Scope

### In Scope

1. Create the destination skill directory and `SKILL.md`.
2. Migrate the five reference docs from the source skill:
   - `get-doc-content.md`
   - `create-doc.md`
   - `edit-doc-content.md`
   - `smartpage-create.md`
   - `smartpage-export.md`
3. Adapt CLI invocation examples from `wecom-cli doc <tool> '<json>'` to the new oclif command syntax:
   - `wecom doc:get-doc-content --docid DOCID --type 2`
   - `wecom doc:get-doc-content --json '{"docid":"DOCID","type":2}'`
   - `wecom doc:create-doc --doc-type 3 --doc-name "Name"`
   - `wecom doc:edit-doc-content --docid DOCID --content "# ..." --content-type 1`
   - `wecom doc:smartpage-create --title T --data '<pages-json>'`
   - `wecom doc:smartpage-export-task --docid DOCID --content-type 1`
   - `wecom doc:smartpage-get-export-result --task-id ID`
4. Preserve the source skill's routing rules:
   - `/doc/*` and `/sheet/*` → `doc:get-doc-content`
   - `/smartpage/*` → `doc:smartpage-export-task` + `doc:smartpage-get-export-result`
   - `/smartsheet/*` → explicitly out of scope for this skill
5. Preserve the doc vs smartpage trigger rule: only invoke smartpage tools when the user explicitly says 「智能文档」 or 「智能主页」.
6. Follow the destination skill format: YAML frontmatter + `<objective>`, `<quick_start>`, `<workflow>`, `<examples>`, `<anti_patterns>`, `<success_criteria>` sections.
7. Update `requires.bins` from `wecom-cli` to `wecom` and `cliHelp` to `wecom doc --help`.

### Out of Scope

- Smartsheet operations (migrated separately, if ever).
- Changes to the CLI implementation or server endpoints.
- New tools beyond the five already covered by the source skill.

## Acceptance Criteria

1. `claude-code-plugin/plugins/wecom/skills/wecom-doc/SKILL.md` exists and validates against the destination plugin's skill format.
2. All five reference files exist under `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/`.
3. The skill references only the new `wecom` CLI (no `wecom-cli` string remains in examples or metadata).
4. URL routing, doc/smartpage trigger rules, and asynchronous polling guidance are preserved.
5. The skill is a faithful translation of the source content with no loss of tool-specific constraints (e.g., `content_type` values, file size limits, `+` prefix note for smartpage_create).
