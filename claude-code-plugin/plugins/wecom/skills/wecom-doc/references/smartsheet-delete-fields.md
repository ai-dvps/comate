# smartsheet-delete-fields API

Delete fields (columns) from a smartsheet.

## CLI usage

```bash
wecom doc:smartsheet-delete-fields [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--sheet-id` | string | Yes | Sheet ID |
| `--field-ids` | string | Yes | Comma-separated field IDs to delete |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-delete-fields --docid DOCID --sheet-id SHEET --field-ids fld_1,fld_2
```

Via JSON:

```bash
wecom doc:smartsheet-delete-fields --json '{"docid":"DOCID","sheet_id":"SHEET","field_ids":["fld_1","fld_2"]}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```

## Important

- Deleting fields also removes corresponding record values. Confirm with the user before deleting.
