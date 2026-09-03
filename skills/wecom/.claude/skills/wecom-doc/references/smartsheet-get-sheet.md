# smartsheet-get-sheet API

Get metadata for a smartsheet, including its sheets (tabs) and IDs.

## CLI usage

```bash
wecom doc:smartsheet-get-sheet [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-get-sheet --docid DOCID
```

Via JSON:

```bash
wecom doc:smartsheet-get-sheet --json '{"docid":"DOCID"}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "sheets": [
        {"sheet_id": "SHEET1", "title": "Sheet 1"}
    ]
}
```

## Important

- A smartsheet created with `doc:create-doc --doc-type 10` includes a default sheet. Use this command to find its `sheet_id`.
- `sheet_id` is required for most other smartsheet operations.
