# smartsheet-export-excel API

Export **every** smartsheet in a document to a single `.xlsx` workbook — one worksheet per smartsheet. Unlike the other smartsheet commands (thin MCP passthroughs that print JSON), this command is composed server-side from `smartsheet-get-sheet` + `smartsheet-get-fields` + `smartsheet-get-records`, and writes a **binary file** to disk.

## CLI usage

```bash
wecom doc:smartsheet-export-excel [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--output` | string | Yes | Destination `.xlsx` file path (relative paths resolve against the current directory) |
| `--force` | boolean | No | Overwrite the output file if it already exists |

> This command does **not** accept `--json`. It produces a workbook, not a JSON response, so there is no request body to override.

## Examples

```bash
wecom doc:smartsheet-export-excel --docid DOCID --output ./export.xlsx
```

Overwrite an existing file without prompting:

```bash
wecom doc:smartsheet-export-excel --docid DOCID --output ./export.xlsx --force
```

## Output

On success the command writes the workbook to `--output` and prints its absolute path to stdout:

```
/Users/me/work/export.xlsx
```

Each smartsheet (tab) in the document becomes one worksheet: row 1 holds the field titles, and every record follows. Worksheet names are sanitized to Excel's rules (max 31 chars, no `\ / ? * [ ] :`) and de-duplicated.

## Important

- `--output` is required and the file is written locally — there is no `media_id` or `url` in the result, just the path on disk.
- If the output file already exists and `--force` is not given: in an interactive TTY the command prompts `Overwrite ...? [y/N]`; when non-interactive (e.g. scripts/CI) it exits `1` without touching the file.
- If the export fails part-way, any partial file the command created is removed, so a failed run never leaves a half-written workbook behind.
- All records are fetched with pagination, so large smartsheets export fully.
- Exit codes follow the CLI convention: `0` success, `1` invalid args / overwrite-without-force, `3` server/HTTP error, `4` network error.
