---
name: wecom-doc
description: Manage WeCom documents, smartpages, uploads, and smartsheets via the wecom CLI. Use when the user wants to read, create, edit, export, upload to, or manage WeCom docs, sheets, or smartpages, or when a doc.weixin.qq.com URL is mentioned.
---

<objective>
Manage WeCom documents, smartpages (formerly "智能主页" / "智能文档"), uploads, and smartsheets through the `wecom doc:*` subcommands. Help the agent route URLs to the correct tool family, build oclif flag commands, and poll async export/read tasks to completion.
</objective>

<quick_start>
Read a document or sheet:

```bash
wecom doc:get-doc-content --docid DOCID --type 2
```

Create a document:

```bash
wecom doc:create-doc --doc-type 3 --doc-name "Weekly Report"
```

Upload an image to a document:

```bash
wecom doc:upload-doc-image --docid DOCID --file-path "images/chart.png"
```

Get smartsheet metadata:

```bash
wecom doc:smartsheet-get-sheet --docid DOCID
```

Add a record to a smartsheet:

```bash
wecom doc:smartsheet-add-records --docid DOCID --sheet-id SHEET --records '[{"field_values":{"Field1":"Value1"}}]'
```

If `wecom` is not in PATH, use `npx wecom` or `${WECOM_CLI_PATH}`.
</quick_start>

<workflow>
1. **Verify CLI version**: Before any operation, check the installed CLI version:
   ```bash
   wecom --version
   ```
   Expected: `1.2.0` or higher. If lower, advise the user to update:
   ```bash
   npm install -g @webank/wecom@latest
   ```
   If `wecom` is not found, check `npx wecom --version` or `${WECOM_CLI_PATH} --version`.
   If the CLI is not installed at all, advise installation:
   ```bash
   npm install -g @webank/wecom
   ```
2. **Identify the URL category** before reading or modifying anything:
   - `/doc/*` or `/sheet/*` → use `wecom doc:get-doc-content`
   - `/smartpage/*` → use `wecom doc:smartpage-export-task` + `wecom doc:smartpage-get-export-result`
   - `/smartsheet/*` → use the smartsheet tools (`wecom doc:smartsheet-*`)
3. **Decide the tool family**:
   - **Smartpages**: Only when the user explicitly uses the terms 「智能文档」 (smart document) or 「智能主页」 (smart homepage).
   - **Smartsheets**: When the URL is `/smartsheet/*` or the user asks about smart tables/records/fields.
   - **Uploads**: When the user wants to attach an image or file to a document or smartsheet record.
   - **Standard docs**: All other "document" scenarios use `doc:get-doc-content`, `doc:create-doc`, or `doc:edit-doc-content`.
4. **Build the command**:
   - Prefer typed flags (`--docid`, `--url`, `--type`, etc.).
   - When passing complex JSON or fields not covered by flags, use `--json '{"key":"value"}'` to override.
   - The smartsheet auto-file helpers (`smartsheet-add-records-auto-file` and `smartsheet-update-records-auto-file`) use `--data` instead of `--json` because oclif reserves `--json` as a built-in boolean flag.
5. **Create smartpages**: When explicitly requested, use `doc:smartpage-create` with a local Markdown file path or `--json` for multi-page input. Save the returned docid.
6. **Handle uploads**: For images/files attached directly to a doc, use `doc:upload-doc-image` or `doc:upload-doc-file`. For records that include image/file fields, prefer the auto-file helpers (`doc:smartsheet-add-records-auto-file`, `doc:smartsheet-update-records-auto-file`).
7. **Handle async polling**: `get-doc-content`, `smartpage-export-task`, and `smartpage-get-export-result` are async:
   - First call returns a `task_id`.
   - If `task_done` is `false`, call again with the `task_id` until `task_done` is `true`.
8. **Execute and report**: Show the command and the outcome. If `errcode` is non-zero, surface `errcode` and `errmsg` to the user and retry once.
</workflow>

<examples>
<example number="1">
<input>Read the content of document DOC123</input>
<output>
```bash
wecom doc:get-doc-content --docid DOC123 --type 2
```
</output>
</example>

<example number="2">
<input>Create a document called "Weekly Report"</input>
<output>
```bash
wecom doc:create-doc --doc-type 3 --doc-name "Weekly Report"
```
Save the returned docid.
</output>
</example>

<example number="3">
<input>Set DOC123 content to "# Weekly Report\n\nAll done"</input>
<output>
```bash
wecom doc:edit-doc-content --docid DOC123 --content "# Weekly Report\n\nAll done" --content-type 1
```
</output>
</example>

<example number="4">
<input>Create a smartpage from docs/overview.md</input>
<output>
```bash
wecom doc:smartpage-create --title "Overview" --page-filepath "docs/overview.md"
```
Save the returned docid.
</output>
</example>

<example number="5">
<input>Export the smartpage at https://doc.weixin.qq.com/smartpage/xxx as Markdown</input>
<output>
Start the export task:
```bash
wecom doc:smartpage-export-task --url "https://doc.weixin.qq.com/smartpage/xxx" --json '{"content_type":1}'
```

Poll for the result:
```bash
wecom doc:smartpage-get-export-result --json '{"task_id":"TASK_ID"}'
```
Repeat until `task_done` is true.
</output>
</example>

<example number="6">
<input>Upload an image to document DOC123</input>
<output>
```bash
wecom doc:upload-doc-image --docid DOC123 --file-path "images/chart.png"
```
Save the returned `url` or `media_id` for use in document content.
</output>
</example>

<example number="7">
<input>Add a record to smartsheet DOC123 / sheet SHEET1</input>
<output>
```bash
wecom doc:smartsheet-add-records --docid DOC123 --sheet-id SHEET1 --records '[{"field_values":{"Status":"Done","Owner":"Alice"}}]'
```
</output>
</example>

<example number="8">
<input>Add a smartsheet record with an image file</input>
<output>
```bash
wecom doc:smartsheet-add-records-auto-file --docid DOC123 --sheet-id SHEET1 --data '{"records":[{"field_values":{"Photo":"images/photo.png"}}]}'
```
The server resolves `image_path`/`file_path` fields to WeCom media IDs.
</output>
</example>
</examples>

<anti_patterns>
<pitfall name="mixing_url_categories">
Different URL categories map to different tools. Never mix them:
- `/doc/*`, `/sheet/*` → `doc:get-doc-content`
- `/smartpage/*` → `doc:smartpage-export-task` + `doc:smartpage-get-export-result`
- `/smartsheet/*` → `doc:smartsheet-*` tools
</pitfall>

<pitfall name="smartpage_mis trigger">
Only use `smartpage_*` tools when the user explicitly says 「智能文档」 or 「智能主页」. For all other "document" requests, use the standard WeCom doc tools.
</pitfall>

<pitfall name="ignoring_async_polling">
`get-doc-content` and `smartpage-export-task` return a `task_id` on the first call. You must poll with that `task_id` until `task_done` is true before the content is available.
</pitfall>

<pitfall name="plus_prefix">
The legacy Rust CLI required `+smartpage_create`. The new TypeScript CLI uses `wecom doc:smartpage-create` without any `+` prefix.
</pitfall>

<pitfall name="json_vs_data">
Most commands accept `--json` to override the request body. The smartsheet auto-file helpers (`smartsheet-add-records-auto-file` and `smartsheet-update-records-auto-file`) use `--data` instead because oclif reserves `--json` as a built-in boolean flag. Passing `--json` to those commands will fail.
</pitfall>

<pitfall name="quoting_json_flags">
Flags like `--fields`, `--records`, `--data` expect JSON strings. Always wrap the JSON in single quotes on the shell to avoid expansion issues:
```bash
wecom doc:smartsheet-add-fields --docid DOCID --sheet-id SHEET --fields '[{"title":"Name","type":1}]'
```
</pitfall>

<pitfall name="ignoring_exit_code">
The wecom CLI returns specific exit codes:
- `0`: Success
- `1`: Invalid arguments or context file error
- `2`: No WeCom bot context found
- `3`: HTTP request failed
- `4`: Network error
Report the actual exit code and meaning to the user.
</pitfall>
</anti_patterns>

<success_criteria>
- URL category is correctly routed to the appropriate `doc:*` tool
- Smartpage tools are only used when explicitly triggered
- Smartsheet tools are used for `/smartsheet/*` URLs and smart-table operations
- Uploads are handled via `doc:upload-doc-image`, `doc:upload-doc-file`, or auto-file helpers as appropriate
- Async tasks are polled until `task_done` is true
- Complex parameters are passed correctly via `--json` (or `--data` for auto-file helpers)
- The executed CLI command is shown in the response
- Error codes and messages are reported clearly
</success_criteria>

## Command taxonomy

| Family | Commands |
|---|---|
| Document content | `doc:get-doc-content`, `doc:create-doc`, `doc:edit-doc-content` |
| Smartpages | `doc:smartpage-create`, `doc:smartpage-export-task`, `doc:smartpage-get-export-result` |
| Uploads | `doc:upload-doc-image`, `doc:upload-doc-file` |
| Smartsheet structure | `doc:smartsheet-get-sheet`, `doc:smartsheet-add-sheet`, `doc:smartsheet-update-sheet`, `doc:smartsheet-delete-sheet` |
| Smartsheet fields | `doc:smartsheet-get-fields`, `doc:smartsheet-add-fields`, `doc:smartsheet-update-fields`, `doc:smartsheet-delete-fields` |
| Smartsheet records | `doc:smartsheet-get-records`, `doc:smartsheet-add-records`, `doc:smartsheet-update-records`, `doc:smartsheet-delete-records` |
| Smartsheet export | `doc:smartsheet-export-excel` |
| Smartsheet auto-file helpers | `doc:smartsheet-add-records-auto-file`, `doc:smartsheet-update-records-auto-file` |

## Reference docs

- [get-doc-content.md](references/get-doc-content.md)
- [create-doc.md](references/create-doc.md)
- [edit-doc-content.md](references/edit-doc-content.md)
- [smartpage-create.md](references/smartpage-create.md)
- [smartpage-export.md](references/smartpage-export.md)
- [upload-doc-image.md](references/upload-doc-image.md)
- [upload-doc-file.md](references/upload-doc-file.md)
- [smartsheet-get-sheet.md](references/smartsheet-get-sheet.md)
- [smartsheet-add-sheet.md](references/smartsheet-add-sheet.md)
- [smartsheet-update-sheet.md](references/smartsheet-update-sheet.md)
- [smartsheet-delete-sheet.md](references/smartsheet-delete-sheet.md)
- [smartsheet-get-fields.md](references/smartsheet-get-fields.md)
- [smartsheet-add-fields.md](references/smartsheet-add-fields.md)
- [smartsheet-update-fields.md](references/smartsheet-update-fields.md)
- [smartsheet-delete-fields.md](references/smartsheet-delete-fields.md)
- [smartsheet-get-records.md](references/smartsheet-get-records.md)
- [smartsheet-add-records.md](references/smartsheet-add-records.md)
- [smartsheet-update-records.md](references/smartsheet-update-records.md)
- [smartsheet-delete-records.md](references/smartsheet-delete-records.md)
- [smartsheet-add-records-auto-file.md](references/smartsheet-add-records-auto-file.md)
- [smartsheet-update-records-auto-file.md](references/smartsheet-update-records-auto-file.md)
