# edit-doc-content API

Overwrite the content of a WeCom document.

## CLI usage

```bash
wecom doc:edit-doc-content [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID |
| `--content` | string | No | New document content |
| `--content-type` | integer | No | Content format. Default `1` (Markdown) |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:edit-doc-content --docid DOCID --content "# Title\n\nBody" --content-type 1
```

Via JSON:

```bash
wecom doc:edit-doc-content --json '{"docid":"DOCID","content":"# Title\n\nBody","content_type":1}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok"
}
```

## Important

- `--content-type` defaults to `1` (Markdown).
- This operation **overwrites** the entire document.
- Consider calling `doc:get-doc-content` first to understand the current content.
