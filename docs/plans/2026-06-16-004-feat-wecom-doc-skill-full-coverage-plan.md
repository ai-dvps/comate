---
topic: wecom-doc-skill-full-cli-coverage
date: 2026-06-16
origin: docs/brainstorms/2026-06-16-wecom-doc-skill-migration-requirements.md
---

# Plan: Expand WeCom Doc Skill to Cover All Migrated CLI Commands

## Summary

The migrated `wecom-doc` skill currently documents only 6 of the 22 `wecom doc:*` commands. This plan updates the skill to cover the full command surface exposed by `packages/wecom-cli/src/commands/doc`, including document content, smartpages, uploads, and the complete smartsheet CRUD family.

## Problem Frame

The TypeScript `@webank/wecom` CLI now exposes 22 `doc:*` subcommands. The skill must accurately describe how an agent should invoke each one, which flags are required, and when to use `--json` overrides. Without full coverage, agents will fall back to guessing parameters or miss smartsheet/upload capabilities entirely.

## Requirements

1. The skill must reference every command in `packages/wecom-cli/src/commands/doc` except `base-doc-command.ts`.
2. Each command must have a reference doc describing its flags, examples, and response shape.
3. The main `SKILL.md` must route users to the right command family based on intent and URL category.
4. The skill must preserve the existing plugin format (`objective`, `quick_start`, `workflow`, `examples`, `anti_patterns`, `success_criteria`).
5. The skill must remain in English, matching the `send-wecom-msg` plugin convention.

## Scope

### In Scope

- Update `claude-code-plugin/plugins/wecom/skills/wecom-doc/SKILL.md` to cover all command categories.
- Add reference docs for the 14 currently undocumented commands:
  - Upload: `upload-doc-image`, `upload-doc-file`
  - Smartsheet structure: `smartsheet-get-sheet`, `smartsheet-add-sheet`, `smartsheet-update-sheet`, `smartsheet-delete-sheet`
  - Smartsheet fields: `smartsheet-get-fields`, `smartsheet-add-fields`, `smartsheet-update-fields`, `smartsheet-delete-fields`
  - Smartsheet records: `smartsheet-get-records`, `smartsheet-add-records`, `smartsheet-update-records`, `smartsheet-delete-records`
  - Smartsheet auto-file helpers: `smartsheet-add-records-auto-file`, `smartsheet-update-records-auto-file`
- Add workflow steps and examples for smartsheet and upload operations.
- Run the plugin skill reviewer and address findings.

### Out of Scope

- Splitting smartsheet into a separate skill (deferred; can be revisited if the single skill becomes too large).
- Changes to the CLI or server implementations.
- Adding new CLI commands beyond the existing 22.

## Key Technical Decisions

- **Single skill, categories**: Keep one `wecom-doc` skill but organize content by command family (doc, smartpage, upload, smartsheet). This matches the CLI's `doc:*` namespace while keeping discovery simple.
- **One reference file per command**: Each command gets its own markdown file under `references/` for progressive disclosure, consistent with the existing 5 reference files.
- **Flag-driven examples**: Examples use the typed oclif flags exposed by each command and note the `--json` override where supported.

## Implementation Units

### U1. Update SKILL.md overview and command taxonomy

**Goal:** Expand the skill's front sections to reflect the full command surface.

**Files:**
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/SKILL.md`

**Approach:**
- Update the description to mention docs, smartpages, uploads, and smartsheets.
- Add a command taxonomy table or list near the top, grouped by family.
- Update `workflow` step 2 to route `/smartsheet/*` URLs to smartsheet tools (currently marked out of scope).
- Add a step for upload operations when the user wants to attach images/files to a doc.

**Test scenarios:**
- SKILL.md mentions all four command families.
- No `wecom-cli` string remains.
- `/smartsheet/*` routing is documented.

**Verification:**
- The skill reviewer reports no missing-category gaps.

### U2. Add reference docs for upload commands

**Goal:** Document `upload-doc-image` and `upload-doc-file`.

**Files:**
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/upload-doc-image.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/upload-doc-file.md`

**Approach:**
- Copy the flag definitions from the CLI source.
- Provide examples using `--docid` and `--file-path`.
- Note that `--json` is also supported.

**Test scenarios:**
- Each reference file lists all flags with types and required/optional status.
- Examples use the exact oclif flag names from the CLI source.

**Verification:**
- Reference files exist and are linked from SKILL.md.

### U3. Add reference docs for smartsheet structure commands

**Goal:** Document sheet-level CRUD.

**Files:**
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-get-sheet.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-add-sheet.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-update-sheet.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-delete-sheet.md`

**Approach:**
- Document shared concepts (`docid`, `sheet_id`).
- Explain that `doc:create-doc --doc-type 10` creates a smartsheet with a default sheet.
- Provide examples for each operation.

**Test scenarios:**
- Each command has a reference file.
- Flags match the CLI source exactly.

**Verification:**
- All four files are present and linked.

### U4. Add reference docs for smartsheet field commands

**Goal:** Document field/column CRUD.

**Files:**
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-get-fields.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-add-fields.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-update-fields.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-delete-fields.md`

**Approach:**
- Document JSON-array flags (`--fields`) and comma-separated flags (`--field-ids`).
- Provide examples showing how to pass field objects as a JSON string.

**Test scenarios:**
- Examples show `--fields '[{...}]'` and `--field-ids a,b` correctly.

**Verification:**
- All four files are present and linked.

### U5. Add reference docs for smartsheet record commands

**Goal:** Document record/row CRUD.

**Files:**
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-get-records.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-add-records.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-update-records.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-delete-records.md`

**Approach:**
- Document `--records` JSON array and `--record-ids` comma-separated string.
- Provide examples for each operation.

**Test scenarios:**
- Examples show `--records '[{...}]'` and `--record-ids a,b` correctly.

**Verification:**
- All four files are present and linked.

### U6. Add reference docs for smartsheet auto-file helpers

**Goal:** Document `smartsheet-add-records-auto-file` and `smartsheet-update-records-auto-file`.

**Files:**
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-add-records-auto-file.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-update-records-auto-file.md`

**Approach:**
- Note these commands use `--data` instead of `--json` because of an oclif built-in flag conflict.
- Document that `image_path`/`file_path` fields in records are resolved server-side.
- Provide examples.

**Test scenarios:**
- Reference files explicitly mention `--data` (not `--json`).
- Examples include records with `image_path` or `file_path`.

**Verification:**
- Both files are present and linked.

### U7. Add smartsheet and upload examples to SKILL.md

**Goal:** Provide concrete usage examples for the newly documented command families.

**Files:**
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/SKILL.md`

**Approach:**
- Add examples for uploading an image and adding a smartsheet record.
- Add anti-patterns for smartsheet flag quoting and JSON parsing.
- Update the reference doc index to include all new files.

**Test scenarios:**
- At least one example exists for upload and one for smartsheet records.
- Reference links include all new files.

**Verification:**
- The skill reviewer passes with no orphan references.

### U8. Run skill review and address findings

**Goal:** Validate the updated skill against plugin conventions.

**Files:**
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/SKILL.md`
- `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/*.md`

**Approach:**
- Run `plugin-dev:skill-reviewer`.
- Fix any reported format, language, or structure issues.

**Test scenarios:**
- Skill reviewer final assessment is "Pass".

**Verification:**
- Reviewer output shows no blocking issues.

## Risks and Dependencies

- **Risk:** The smartsheet reference docs will be large and may make the single skill unwieldy.
  - Mitigation: Keep detailed specs in reference files; SKILL.md stays high-level. Revisit splitting into a separate skill if review flags size issues.
- **Dependency:** None beyond the existing CLI command files in `packages/wecom-cli/src/commands/doc`.

## Acceptance Criteria

1. The `wecom-doc` skill references all 22 `wecom doc:*` commands.
2. Each command has a dedicated reference markdown file.
3. `SKILL.md` routes users to the correct command family based on URL category and intent.
4. The skill follows the plugin's English, XML-section format.
5. The skill reviewer passes with no blocking findings.
