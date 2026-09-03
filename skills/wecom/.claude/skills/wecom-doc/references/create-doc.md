# create-doc API

Create a WeCom document, sheet, or smartsheet. On success, returns the document URL and docid.

## CLI usage

```bash
wecom doc:create-doc [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--doc-type` | integer | No | Document type: `3`=document, `4`=smartpage, `10`=smartsheet |
| `--doc-name` | string | No | Document name, max 255 characters |
| `--admin-users` | string | No | Admin user IDs, comma-separated |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Notes

- For smartpages, prefer `doc:smartpage-create` per this skill's workflow.
- For smartsheets, use the smartsheet skill.
- This skill focuses on `doc_type=3` document creation.

## Examples

```bash
# Create a document
wecom doc:create-doc --doc-type 3 --doc-name "Weekly Report"

# Via JSON
wecom doc:create-doc --json '{"doc_type":3,"doc_name":"Weekly Report"}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "url": "https://doc.weixin.qq.com/doc/xxx",
    "docid": "DOCID"
}
```

## Important

- `docid` is only returned at creation time. Save it immediately.
