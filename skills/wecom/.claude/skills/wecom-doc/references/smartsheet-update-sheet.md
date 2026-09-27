# smartsheet-update-sheet API

Update a smartsheet's sheet (tab) metadata, such as its title.

## CLI usage

```bash
wecom doc:smartsheet-update-sheet [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--sheet-id` | string | Yes | Sheet ID to update |
| `--title` | string | No | New sheet title |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-update-sheet --docid DOCID --sheet-id SHEET --title "Updated Title"
```

Via JSON:

```bash
wecom doc:smartsheet-update-sheet --json '{"docid":"DOCID","sheet_id":"SHEET","title":"Updated Title"}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```
