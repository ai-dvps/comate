# smartpage-export-task / smartpage-get-export-result API

Export a smartpage's content asynchronously. First call `smartpage-export-task` to get a `task_id`, then poll `smartpage-get-export-result` until the task completes.

## Step 1: smartpage-export-task — start export

### CLI usage

```bash
wecom doc:smartpage-export-task [flags]
```

### Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | No | Smartpage document ID |
| `--sheet-id` | string | No | Smartsheet sheet ID (for smartsheet export) |
| `--format` | string | No | Export format. Default `pdf` |
| `--json` | string | No | Raw JSON request body; overrides other flags |

### Examples

```bash
wecom doc:smartpage-export-task --docid DOCID --format pdf
```

Via JSON:

```bash
wecom doc:smartpage-export-task --json '{"docid":"DOCID","content_type":1}'
```

### Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "task_id": "TASK_ID"
}
```

## Step 2: smartpage-get-export-result — poll for result

### CLI usage

```bash
wecom doc:smartpage-get-export-result [flags]
```

### Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--task-id` | string | No | Export task ID |
| `--json` | string | No | Raw JSON request body; overrides other flags |

### Examples

```bash
wecom doc:smartpage-get-export-result --task-id TASK_ID
```

Via JSON:

```bash
wecom doc:smartpage-get-export-result --json '{"task_id":"TASK_ID"}'
```

### Response examples

Task not done:

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "task_done": false
}
```

Task done:

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "task_done": true,
    "content": "# Weekly Report\n\n## Progress\n\n1. User module completed\n2. 3 production bugs fixed"
}
```

## Async polling

1. **Call smartpage-export-task**: get `task_id`.
2. **First poll**: call `smartpage-get-export-result` with `task_id`.
3. **Check response**: if `task_done` is `false`, poll again.
4. **Get content**: when `task_done` is `true`, the `content` field holds the full Markdown.

## Important

- `smartpage-export-task` only returns a `task_id`; the content is not available yet.
- Provide either `docid` or `url`, not both.
- When the task completes, the `content` field contains the full document content directly.
- Increase polling intervals if multiple polls are needed.
