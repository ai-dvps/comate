# smartsheet-add-sheet API

Add a new sheet (tab) to a smartsheet document.

## CLI usage

```bash
wecom doc:smartsheet-add-sheet [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--title` | string | No | Title of the new sheet |
| `--index` | integer | No | Insertion position index |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-add-sheet --docid DOCID --title "Q3 Tasks" --index 0
```

Via JSON:

```bash
wecom doc:smartsheet-add-sheet --json '{"docid":"DOCID","title":"Q3 Tasks","index":0}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "sheet_id": "SHEET_ID"
}
```

## Important

- Save the returned `sheet_id`; it is needed for field and record operations.
