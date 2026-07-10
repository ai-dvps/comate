# Feature Screenshots

This folder holds screenshots used by the Features page cards.

## How to replace placeholders

1. Capture a screenshot for the feature listed below.
2. Save it as a `.png` (preferred) or `.webp` file with the matching filename.
3. Update the corresponding feature MDX file in `website/src/content/features/` to point at the new file extension if you change from `.svg` to `.png`/`.webp`.

## Screenshot checklist

| Filename | Feature | Suggestion |
|---|---|---|
| `workspaces` | Workspaces & Projects | Workspace tabs, session list, Git branch in status bar |
| `chat` | Chat & Sessions | A streaming chat with Markdown, code block, tool card |
| `ai-collaboration` | AI Collaboration | Approval banner or AskUserQuestion stepper |
| `files` | Files & Context | File tree, search, file panel with a preview |
| `prompt-input` | Prompt Input & Discovery | Prompt input with `/` or `@` picker open |
| `bot-integrations` | Bot Integrations | Bot Management page or WeCom session viewer |
| `skills-mcp` | Skills, MCP & Plugins | Plugin Manager or Skills page |
| `task-tracking` | Task & Workflow Tracking | TaskPanel or Workflow floating panel |
| `desktop-experience` | Desktop Experience | Settings panel, theme toggle, or system tray |
| `security` | Security & Control | Bot role permissions or audit log |

## Placeholder files

The `.svg` files in this directory are temporary placeholders. They will be served by the site until real screenshots are added. Replace them rather than keeping both formats to avoid confusion.

## Image guidelines

- Preferred format: WebP or PNG
- Recommended width: 1200 px or smaller (cards display ~400 px wide)
- Use the same aspect ratio for all feature screenshots so the grid stays aligned
- Keep file sizes reasonable; use lazy loading is already enabled in `FeatureCard.astro`
- Add localized `alt` text in the feature MDX frontmatter (`imageAlt`)
