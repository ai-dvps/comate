# smartsheet-add-fields API

Add fields (columns) to a smartsheet.

## CLI usage

```bash
wecom doc:smartsheet-add-fields [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID of the smartsheet |
| `--sheet-id` | string | Yes | Sheet ID |
| `--fields` | string | Yes | JSON array of field objects to add |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartsheet-add-fields --docid DOCID --sheet-id SHEET --fields '[{"title":"Name","type":1},{"title":"Status","type":1}]'
```

Via JSON:

```bash
wecom doc:smartsheet-add-fields --json '{"docid":"DOCID","sheet_id":"SHEET","fields":[{"title":"Name","type":1},{"title":"Status","type":1}]}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "field_ids": ["fld_1", "fld_2"]
}
```

## Important

- Wrap the JSON array in single quotes to prevent shell expansion.
- Field type values follow the WeCom API schema.
