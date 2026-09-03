# smartsheet-delete-records API

Delete records (rows) from a smartsheet.

## CLI usage

```bash
wecom doc:smartsheet-delete-records [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--sheet-id` | string | Yes | Sheet ID |
| `--record-ids` | string | Yes | Comma-separated record IDs to delete |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-delete-records --docid DOCID --sheet-id SHEET --record-ids rec_1,rec_2
```

Via JSON:

```bash
wecom doc:smartsheet-delete-records --json '{"docid":"DOCID","sheet_id":"SHEET","record_ids":["rec_1","rec_2"]}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```

## Important

- Deletion is permanent. Confirm with the user before deleting records.
