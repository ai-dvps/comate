# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.5] - 2026-06-14

### Added

- **WeCom permissions** — workspace-level permissions sub-tab for WeCom bots, including policy-aware gating for tool usage and reply flows, a dedicated prompt hook, and grandfathering/freeze UX banners.

[0.0.5]: https://github.com/ai-dvps/comate/releases/tag/v0.0.5

## [0.0.4] - 2026-06-14

### Added

- **Analytics dashboards** — global and workspace-level analytics views with chart components, top-3 rank medals, and an analytics modal accessible from the header.
- **Toast system** — reusable toast container with severity styling, enter animation, and lifecycle management; surfaces failures (e.g., session list fetch errors) to the user.
- **Session list refresh** — refresh button in the session list wired to the toast system.

### Changed

- **Session list ordering** — sessions now sort by activity recency (tracked via `lastActivityAt`), with the active session pinned to a dedicated header.
- **Session list search** — title-based filtering with a client-side helper and unit tests.
- **TaskPanel styling** — accent-tinted background with opaque layering for better readability against the chat column.

### Fixed

- **Session title persistence** — clearing the draft flag on the first message so renames persist correctly.
- **Session rename input** — allow spaces in the active session rename input.

### Internal

- Added planning artifacts for analytics, session list, and toast features.

[0.0.4]: https://github.com/ai-dvps/comate/releases/tag/v0.0.4

## [0.0.3] - 2026-06-13

### Added

- **Skills page** — browse, install, and manage Claude Code skills from inside the app, with Vercel-labs/skills integration.
- **Plugin manager** — built-in marketplace, three-scope installation, and update progress indicators.
- **LLM provider management** — add, edit, and switch providers from settings; credentials propagate into session runtime.
- **Workspace todos** — persistent workspace-scoped task list.
- **WeCom enhancements** — file/image/voice/video message handling, proactive message queue, configurable file prompt template, and bot session auto-rename.
- **File experience** — resizable sidebar and file panel, file explorer context menu, markdown preview, and workspace-wide file search.
- **Chat polish** — session DOM caching for instant switching, inline session title editing, WIP toggle, configurable submit shortcut, and tool-content collapse by default.
- **System** — shell environment capture at startup, unified log folder with automatic cleanup, and graceful cleanup of Claude Code processes on quit.
- **Diagnostics** — WeCom resolver diagnostic logging and compact status display in subagent streams.

### Changed

- WeCom skill unified under a single send skill and distributed as a built-in Claude Code plugin.
- WeCom CLI migrated to oclif v4 and published as `@webank/wecom`.
- Settings converted to a large modal with workspace-centric tabs.
- Session persistence moved from JSON files to SQLite.

### Fixed

- WeCom multi-turn streaming and error surfacing.
- Session runtime resource leak and idle subscription handling.
- Provider banner layout, status chooser anchoring, and todo status popup positioning.
- Tool input summary for `AskUserQuestion` and git branch refresh in the status bar.
- macOS dock badge count and Cmd+Q/dock-quit sidecar cleanup.

### Internal

- Added planning artifacts for the above features and vendored `vercel-labs/skills` via git subtree.

[0.0.3]: https://github.com/ai-dvps/claude-code-gui/releases/tag/v0.0.3
