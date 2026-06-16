# upload-doc-file API

Upload a file to a WeCom document. The returned file information can be referenced when editing document content.

## CLI usage

```bash
wecom doc:upload-doc-file [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Yes | Document ID |
| `--file-path` | string | Yes | Path to the file, relative to the workspace root |
| `--file-name` | string | No | Display name for the file |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:upload-doc-file --docid DOCID --file-path "docs/spec.pdf" --file-name "Specification.pdf"
```

Via JSON:

```bash
wecom doc:upload-doc-file --json '{"docid":"DOCID","file_path":"docs/spec.pdf","file_name":"Specification.pdf"}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "file_id": "FILE_ID"
}
```

## Important

- File size and type limits follow the WeCom API rules.
- Save the returned `file_id` to link the file in document content.
