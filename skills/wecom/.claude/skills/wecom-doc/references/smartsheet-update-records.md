# smartsheet-update-records API

Update records (rows) in a smartsheet.

## CLI usage

```bash
wecom doc:smartsheet-update-records [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--sheet-id` | string | Yes | Sheet ID |
| `--records` | string | Yes | JSON array of record objects to update |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-update-records --docid DOCID --sheet-id SHEET --records '[{"record_id":"rec_1","field_values":{"fld_2":"In Progress"}}]'
```

Via JSON:

```bash
wecom doc:smartsheet-update-records --json '{"docid":"DOCID","sheet_id":"SHEET","records":[{"record_id":"rec_1","field_values":{"fld_2":"In Progress"}}]}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```

## Important

- Each record object must include its `record_id`.
- Wrap the JSON array in single quotes.
