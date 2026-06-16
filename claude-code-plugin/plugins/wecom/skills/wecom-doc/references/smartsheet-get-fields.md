# smartsheet-get-fields API

Get the fields (columns) of a smartsheet.

## CLI usage

```bash
wecom doc:smartsheet-get-fields [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--sheet-id` | string | Yes | Sheet ID |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-get-fields --docid DOCID --sheet-id SHEET
```

Via JSON:

```bash
wecom doc:smartsheet-get-fields --json '{"docid":"DOCID","sheet_id":"SHEET"}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "fields": [
        {"field_id": "fld_1", "title": "Name", "type": 1},
        {"field_id": "fld_2", "title": "Status", "type": 1}
    ]
}
```

## Important

- Use the returned `field_id` values when building record `field_values`.
