---
date: 2026-06-24
topic: wecom-cli-smartsheet-export
---

## Summary

Add a WeCom CLI command that exports every smartsheet in a WeCom document into a single `.xlsx` workbook. The export is composed server-side from existing smartsheet get APIs; the CLI writes the returned file to a caller-supplied path.

## Problem Frame

WeCom smart-documents provide a web UI export for smartsheets, but the smart-document MCP exposed to agents and bots does not include a native export tool. Users who want to analyze or transform smartsheet data with an LLM must currently download the file manually from the web. A CLI command closes this gap by letting scripts and agents pull the data directly.

## Key Decisions

- **Server-side composition.** The CLI remains a thin wrapper; the server fetches sheet metadata, fields, and records, handles pagination, and builds the workbook. This keeps complex orchestration and Excel generation in one place and makes the export reusable by other clients later.
- **Explicit output path with abort-on-failure cleanup.** The caller passes `--output` as the full destination file path. If any sheet fails, the command aborts and deletes any partially written file.
- **Typed values and smartsheet-title worksheet names.** Cell values preserve WeCom field types where possible, and each worksheet is named after the smartsheet title with Excel-safe sanitization and collision handling.

## Requirements

### CLI interface

- R1. The command is registered under the `doc:` namespace (e.g., `doc:smartsheet-export-excel`) and follows the existing oclif command pattern in `packages/wecom-cli/src/commands/doc/`.
- R2. Required flags: `--docid <document-id>` and `--output <file-path>`. Optional flag: `--force`.
- R3. In interactive mode, if `--output` already exists and `--force` is not passed, the command prompts for confirmation. In non-interactive mode, it fails with a clear error unless `--force` is passed.

### Export behavior

- R4. The command exports every smartsheet in the specified document. `smartsheet-get-sheet` returns `sheet_list` with `sheet_id`, `title`, `is_visible`, and `type`; only entries whose `type` is `smartsheet` are exported.
- R5. Each smartsheet becomes a separate worksheet in the workbook, named after the `title` from `sheet_list`. Titles are sanitized for Excel worksheet rules and deduplicated if necessary.
- R6. Each worksheet includes a header row derived from the smartsheet fields, followed by all records.
- R7. Records are requested with `key_type` set to `CELL_VALUE_KEY_TYPE_FIELD_ID` so cell keys align with the `field_id` values from `smartsheet-get-fields`.
- R8. Records are fetched exhaustively using `offset`/`limit` pagination. The implementation follows every page while the response indicates more records (`has_more` / `next`), with a page size up to the API maximum of 1000.
- R9. Cell values are written with types preserved where the WeCom field type maps cleanly to an Excel scalar: numbers, dates (Unix ms timestamp), booleans, phone, email, barcode, and similar scalar types. Complex values (images, attachments, users, URLs, multi-select, location, reference, auto-number) are flattened to a readable text representation. Formula fields are exported as their evaluated text value.

### Output and completion

- R10. On success, the command writes the complete workbook to `--output` and prints the absolute file path to stdout.
- R11. On failure, the command exits with a non-zero status, prints a concise error to stderr, and does not leave a partially written file.

## Key Flows

- F1. Export a document
  - **Trigger:** User runs `wecom doc:smartsheet-export-excel --docid <id> --output <path>`.
  - **Steps:** CLI loads context; server lists all smartsheets in the document; for each sheet, server fetches fields and all records; server builds workbook; CLI writes bytes to `--output`; CLI prints absolute path.
  - **Outcome:** A single `.xlsx` file exists at `--output` with one worksheet per smartsheet.
  - **Failure:** Any step fails → CLI deletes partial output and exits non-zero.

## Acceptance Examples

- AE1. Output file already exists
  - **Covers:** R3
  - **Given:** `--output ./report.xlsx` already exists and no `--force`.
  - **When:** Running interactively.
  - **Then:** The CLI prompts to overwrite; if confirmed, it proceeds; otherwise it exits without writing.

- AE2. Non-interactive overwrite
  - **Covers:** R3
  - **Given:** `--output ./report.xlsx` exists and stdout is not a TTY.
  - **When:** The command is invoked without `--force`.
  - **Then:** It exits immediately with a clear error and does not touch the file.

- AE3. Partial failure cleanup
  - **Covers:** R11
  - **Given:** The first two sheets export successfully but the third sheet fetch fails.
  - **When:** The command aborts.
  - **Then:** The output file is deleted (if it was created) and stderr contains the failure reason.

- AE4. Duplicate worksheet titles
  - **Covers:** R5
  - **Given:** Two smartsheets are both titled "Q2 Plan".
  - **When:** The workbook is built.
  - **Then:** The worksheets are named "Q2 Plan" and "Q2 Plan (2)" (or another deterministic deduplication scheme).

## Scope Boundaries

- **Deferred for later:** Exporting only selected sheets or record ranges; CSV export; exposing the command through the `wecom-doc` skill; preserving formatting, formulas, attachments, or cell colors; scheduling or incremental exports.
- **Outside this product's identity:** Building a generic spreadsheet editor or a WeCom-document sync tool.

## Dependencies / Assumptions

- WeCom smart-sheet API documentation defines the shapes used:
  - `smartsheet-get-sheet` returns `sheet_list` entries with `sheet_id`, `title`, `is_visible`, and `type`. Only entries whose `type` is `"smartsheet"` are exported.
  - `smartsheet-get-fields` returns `fields` with `field_id`, `field_title`, and `field_type`, paginated with `offset`/`limit` and a `total` count.
  - `smartsheet-get-records` returns `records` with `field_values`, paginated with `offset`/`limit` and continuation signals `has_more` / `next`.
- Records are requested with `key_type: CELL_VALUE_KEY_TYPE_FIELD_ID` so cell keys match `field_id` values.
- The field-type enum uses string values such as `FIELD_TYPE_TEXT`, `FIELD_TYPE_NUMBER`, `FIELD_TYPE_CHECKBOX`, `FIELD_TYPE_DATE_TIME`, etc.
- No existing Excel-generation library is in the repo; adding one is acceptable.

## Sources / Research

- Existing smartsheet read commands: `packages/wecom-cli/src/commands/doc/smartsheet-get-sheet.ts`, `packages/wecom-cli/src/commands/doc/smartsheet-get-fields.ts`, `packages/wecom-cli/src/commands/doc/smartsheet-get-records.ts`.
- Skill reference docs: `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-get-sheet.md`, `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-get-fields.md`, `claude-code-plugin/plugins/wecom/skills/wecom-doc/references/smartsheet-get-records.md`.
- WeCom smart-sheet API docs: `https://developer.work.weixin.qq.com/document/path/101154` (get sheets), `https://developer.work.weixin.qq.com/document/path/101157` (get fields), `https://developer.work.weixin.qq.com/document/path/101158` (get records).
- CLI command registration: `packages/wecom-cli/src/index.ts`.
- Server doc proxy: `src/server/routes/wecom-doc.ts`, `src/server/services/wecom-doc-service.ts`.
- No existing Excel/CSV generation: `packages/wecom-cli/package.json` and grep results for `excel|xlsx|csv` in `packages/wecom-cli/src/` and `src/server/`.
