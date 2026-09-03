# smartsheet-add-records API

Add records (rows) to a smartsheet.

## CLI usage

```bash
wecom doc:smartsheet-add-records [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--sheet-id` | string | Yes | Sheet ID |
| `--records` | string | Yes | JSON array of record objects |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-add-records --docid DOCID --sheet-id SHEET --records '[{"field_values":{"fld_1":"Alice","fld_2":"Done"}}]'
```

Via JSON:

```bash
wecom doc:smartsheet-add-records --json '{"docid":"DOCID","sheet_id":"SHEET","records":[{"field_values":{"fld_1":"Alice","fld_2":"Done"}}]}'
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

- `field_values` keys are `field_id` values. Use `smartsheet-get-fields` to look them up.
- Wrap the JSON array in single quotes.
