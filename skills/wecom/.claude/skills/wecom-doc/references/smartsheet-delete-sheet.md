# smartsheet-delete-sheet API

Delete a sheet (tab) from a smartsheet document.

## CLI usage

```bash
wecom doc:smartsheet-delete-sheet [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--sheet-id` | string | Yes | Sheet ID to delete |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-delete-sheet --docid DOCID --sheet-id SHEET
```

Via JSON:

```bash
wecom doc:smartsheet-delete-sheet --json '{"docid":"DOCID","sheet_id":"SHEET"}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```

## Important

- Deleting a sheet also removes its fields and records. Confirm with the user before deleting.
