# smartsheet-add-records-auto-file API

Add records to a smartsheet with automatic file upload. Any `image_path` or `file_path` fields in the records are resolved server-side into WeCom media IDs.

## CLI usage

```bash
wecom doc:smartsheet-add-records-auto-file [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--sheet-id` | string | Yes | Sheet ID |
| `--data` | string | Yes | Raw JSON request body with records containing `image_path`/`file_path` fields |

## Important

- This command uses `--data`, **not** `--json`, because oclif reserves `--json` as a built-in boolean flag.
- Paths in `image_path`/`file_path` are relative to the workspace root.

## Examples

```bash
wecom doc:smartsheet-add-records-auto-file --docid DOCID --sheet-id SHEET --data '{
  "records": [
    {"field_values": {"fld_photo": {"image_path": "images/photo.png"}}}
  ]
}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "record_ids": ["rec_1"]
}
```

## Important

- File size limits apply (images 30 MB, files 10 MB per server-side rules).
- The server uploads the referenced files and substitutes `image_path`/`file_path` with the resulting WeCom media identifiers.
