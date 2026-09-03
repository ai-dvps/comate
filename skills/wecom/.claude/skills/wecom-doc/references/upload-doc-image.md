# upload-doc-image API

Upload an image to a WeCom document. The returned media information can be referenced when editing document content.

## CLI usage

```bash
wecom doc:upload-doc-image [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID |
| `--file-path` | string | Yes | Path to the image file, relative to the workspace root |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:upload-doc-image --docid DOCID --file-path "images/chart.png"
```

Via JSON:

```bash
wecom doc:upload-doc-image --json '{"docid":"DOCID","file_path":"images/chart.png"}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "url": "https://...",
    "media_id": "MEDIA_ID"
}
```

## Important

- Supported image formats and size limits follow the WeCom API rules.
- Save the returned `url` or `media_id` to embed the image in document content.
