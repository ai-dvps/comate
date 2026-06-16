# smartsheet-get-records API

Get records (rows) from a smartsheet.

## CLI usage

```bash
wecom doc:smartsheet-get-records [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--sheet-id` | string | Yes | Sheet ID |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-get-records --docid DOCID --sheet-id SHEET
```

Via JSON (with optional filters):

```bash
wecom doc:smartsheet-get-records --json '{"docid":"DOCID","sheet_id":"SHEET","limit":100}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "records": [
        {"record_id": "rec_1", "field_values": {"fld_1": "Alice", "fld_2": "Done"}}
    ]
}
```

## Important

- Use `smartsheet-get-fields` first if you need to map `field_id` values to column titles.
