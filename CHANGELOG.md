# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.7] - 2026-06-20

### Added

- **Chat message search** — search bar, live highlights, scroll-to-match, and integration tests for finding messages in a session.
- **Historical subagent transcripts** — load and display historical subagent transcripts from the SDK.
- **SDK upgrade** — upgraded `@anthropic-ai/claude-agent-sdk` to 0.3.183 and adopted P0/P1 features.

### Changed

- **Session list polish** — refined context menu and New Session button styling/behavior.

### Fixed

- Restored SDK 0.2.x `tool_use`-based task compatibility layer (reverted its removal).

### Internal

- Added planning artifacts for chat message search.

[0.0.7]: https://github.com/ai-dvps/comate/releases/tag/v0.0.7

## [0.0.6] - 2026-06-19

### Added

- **Auto-updater** — Tauri updater plugin, in-app update check/preference UI, restart cleanup, and CI-signed updater artifacts.
- **Pending request timeout** — timeout-aware auto-denial for pending approvals and `AskUserQuestion`.
- **Workspace deletion** — settings affordance with type-name confirmation and cascade session cleanup.
- **WeCom doc commands** — 22 `wecom doc` subcommands and a generic server proxy route.
- **WeCom bot isolation** — workspace isolation settings, path/Bash/skill policy engines, and policy-aware UI banners.
- **Prompt input overhaul** — contentEditable input with IME support, inline markdown source highlighting, local n-gram completion ghost text, history popup with search, and file picker path insertion.
- **Session archive** — archive/unarchive sessions and a redesigned status filter popover.
- **Sent-prompt history** — per-workspace prompt history with recall and history popup.

### Changed

- **Skills button** — renamed the input-box "Commands" button to "Skills".
- **WeCom Queue** — moved the queue panel into WeCom Bot settings.

### Fixed

- **Reconnect warning** — suppress the missed-output warning when the ring buffer is empty, removing false-positive `error_note` events.
- **Task compatibility** — removed SDK 0.2.x `tool_use`-based task compatibility logic.
- **Prompt input IME** — recover stuck composition states, preserve cursor position, and custom undo/redo for contentEditable.
- **Task status normalization** — preserve `in_progress` status when normalizing task statuses.
- **Plugin uninstall** — remove CLI-installed plugins from `installed_plugins.json`.

### Internal

- Added planning artifacts for updater, workspace delete, prompt input, WeCom doc, session archive, and reconnect warning fixes.
- Bumped `@webank/wecom` CLI to 0.2.0.

[0.0.6]: https://github.com/ai-dvps/comate/releases/tag/v0.0.6

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
