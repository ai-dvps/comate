# smartsheet-update-fields API

Update fields (columns) of a smartsheet.

## CLI usage

```bash
wecom doc:smartsheet-update-fields [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--sheet-id` | string | Yes | Sheet ID |
| `--fields` | string | Yes | JSON array of field objects to update |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-update-fields --docid DOCID --sheet-id SHEET --fields '[{"field_id":"fld_1","title":"Full Name"}]'
```

Via JSON:

```bash
wecom doc:smartsheet-update-fields --json '{"docid":"DOCID","sheet_id":"SHEET","fields":[{"field_id":"fld_1","title":"Full Name"}]}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```

## Important

- Each field object must include its `field_id`.
- Wrap the JSON array in single quotes.
