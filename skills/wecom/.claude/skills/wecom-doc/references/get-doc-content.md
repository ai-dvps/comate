# get-doc-content API

Get the full content of a WeCom document or sheet, returned as Markdown. This endpoint is asynchronous: the first call returns a `task_id`; if `task_done` is false, call again with the `task_id` until `task_done` is true.

## CLI usage

```bash
wecom doc:get-doc-content [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--docid` | string | Either `--docid` or `--url` | Document ID |
| `--url` | string | Either `--docid` or `--url` | Document URL |
| `--type` | integer | No | Content format. Default `2` (Markdown) |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Async polling

1. **First call**: pass `docid`/`url` and `type: 2`, no `task_id`.
2. **Check response**: if `task_done` is `false`, save the returned `task_id`.
3. **Poll**: call again with `task_id` until `task_done` is `true`.
4. **Get content**: when `task_done` is `true`, the `content` field holds the full Markdown.

## Examples

```bash
# First call
wecom doc:get-doc-content --docid DOCID --type 2

# Poll
wecom doc:get-doc-content --json '{"docid":"DOCID","type":2,"task_id":"xxx"}'

# Via URL
wecom doc:get-doc-content --url "https://doc.weixin.qq.com/doc/xxx" --type 2
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "content": "# Document title\n\nDocument body...",
    "task_id": "xxxxx",
    "task_done": true
}
```

## URL routing

- `/doc/*` → document → use this tool
- `/sheet/*` → sheet → use this tool
- `/smartsheet/*` → smartsheet → **do not use this tool**; use the smartsheet skill
- `/smartpage/*` → smartpage → **do not use this tool**; use `doc:smartpage-export-task`
