# smartpage-create API

Create a smartpage (formerly "智能主页"). Supports a single local Markdown file via flags, or multiple pages via `--json`.

## CLI usage

```bash
wecom doc:smartpage-create [flags]
```

## Flags

| Flag | Type | Required | Description |
|---|---|---|---|
| `--title` | string | No | Smartpage title |
| `--page-filepath` | string | No | Path to a local Markdown file, relative to the workspace root |
| `--json` | string | No | Raw JSON request body; overrides other flags |

## Examples

```bash
wecom doc:smartpage-create --title "Overview" --page-filepath "docs/requirements.md"
```

Create a multi-page smartpage via JSON:

```bash
wecom doc:smartpage-create --json '{
  "title": "Overview",
  "pages": [
    {"page_title": "Requirements", "content_type": 1, "page_filepath": "docs/requirements.md"},
    {"page_title": "Design", "content_type": 1, "page_filepath": "docs/design.md"}
  ]
}'
```

## Response example

```json
{
    "errcode": 0,
    "errmsg": "ok",
    "docid": "DOCID",
    "url": "https://doc.weixin.qq.com/smartpage/a1_xxxxxx"
}
```

## Important

- `docid` is only returned at creation time. Save it immediately.
- `content_type` should be `1` (Markdown) for `.md` files or any content with Markdown syntax. Use `0` (plain text) only for files with no Markdown at all.
- Each sub-page Markdown file must be under **10 MB**; split large files into multiple pages.
- The legacy Rust CLI required `+smartpage_create`; the new CLI uses `wecom doc:smartpage-create` without the `+` prefix.
