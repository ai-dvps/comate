# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Feishu bot menu commands** — the Feishu callback route now handles `application.bot.menu_v6` events. Clicking a bot menu with `event_key` `session` sends the same session-list card as `/session`, and `new` creates a new session and notifies the user, exactly like typing the command. Menu events are signature-verified through the existing callback, reject workspaces missing Feishu credentials or encryption key, and build a per-callback `lark.Client` so the correct workspace's credentials are used regardless of the service's singleton connection.

### Changed

- **WeCom `send-wecom-file` recipient resolution** — the skill now resolves "send <file> to me" by calling `wecom current-user --session-id ${CLAUDE_SESSION_ID}` instead of trusting the `WECOM_USER_ID` environment variable. The server no longer injects `WECOM_USER_ID` into bot sessions.
- **WeCom bot upload directory** — files uploaded by WeCom bot users are now saved under `<workspace>/data/<user-folder>` instead of `<workspace>/<user-folder>`. The bot tool-permission boundary is aligned to the same `data/<user-folder>` path, so received files remain inside the bot's writable zone. Existing files at the old path are left in place.

### Fixed

- **Prompt ghost text alignment with empty lines** — auto-completion suggestions now stay on the same line as the caret when the prompt contains empty lines, by preserving empty lines in `contentEditable` text extraction and rendering the ghost overlay line-by-line.

## [0.0.13] - 2026-06-23

### Added

- **Feishu bot session GUI parity** — Feishu-bound sessions are now treated as bot sessions in the GUI, suppressing the chat input, blocking local sends, skipping SSE subscriptions, and surfacing a Feishu-branded bot bar with the configured bot name, bound user info, and refresh control.
- **Feishu user info route** — `GET /api/workspaces/:id/sessions/:sessionId/feishu-user` returns the cached Feishu user name and last-seen time for a Feishu-bound session.
- **`feishuBotName` workspace setting** — configure a friendly display name for the Feishu bot shown in the chat panel bot bar.
- **`send-wecom-file` skill** — new built-in skill that lets WeCom bot users send workspace files to themselves or another user with confirmation.
- **`WECOM_USER_ID` env injection for WeCom bot sessions** — the spawned Claude Code process now receives `WECOM_USER_ID` set to the plaintext WeCom user ID, so the `send-wecom-file` skill can resolve "send <file> to me" without prompting.
- **`@webank/wecom` CLI 1.0.1** — bumped the bundled WeCom CLI to 1.0.1; existing `wecom-doc` and `send-wecom-msg` skills require 1.0.1 or higher.

### Changed

- **Feishu streaming replies** — replaced the patch-per-chunk `im.v1.message.patch` approach with CardKit native streaming (`cardkit.v1.card.create`, `cardkit.v1.cardElement.content`, `cardkit.v1.card.settings`). The card updates in place with a typewriter effect, transient thinking/tool/sub-agent placeholders are removed before the final answer, and the finished card contains only the final answer, matching WeCom behavior.

### Fixed

- **`wecom --version` reads from package.json** — the WeCom CLI now reports the version declared in `packages/wecom-cli/package.json` instead of a hardcoded value.

- **Feishu streaming card stuck on "收到，正在处理…"** — the CardKit content-update call returned `99992402` ("field validation failed: content min len is 1"). Empty/whitespace-only updates (e.g. clearing a placeholder before any answer text arrived) are now skipped entirely, and content is checked for a *visible* character rather than with `String.trim()` — which does not strip the Unicode zero-width family (U+200B et al.) that Feishu normalizes away server-side.
- **Feishu streaming card "cardid is invalid"** — the CardKit 2.0 streaming card spec incorrectly included `config.wide_screen_mode`, a field that belongs to the schema-1.0 interactive-card format. Feishu created card instances whose `card_id` was rejected by later CardKit operations (e.g. when rendering a `🔧 Bash...` placeholder or sending an approval card), producing error `230099`/`11310`. The field has been removed from the streaming card builder so the returned `card_id` is valid.
- **Feishu streaming card stuck on "收到，正在处理…" after tool failure** — when a Claude Code tool failed mid-turn and the model produced no answer text, the Feishu card was left on the initial processing hint because the final content patch was empty. `FeishuStreamReply` now substitutes a generic failure message (`⚠️ 处理失败，请稍后重试。`) whenever the final answer has no visible characters, so the user always receives a final message.

## [0.0.12] - 2026-06-22

### Added

- **WeCom proactive file send** — server API `POST /api/workspaces/:workspaceId/wecom/send-file` and `wecom send-file` CLI subcommand for sending workspace files to WeCom users.
- **WeCom media cache** — cache uploaded WeCom temporary media by workspace, relative path, and MD5 with a 71-hour TTL to avoid re-uploading unchanged files.
- **Workspace file isolation for proactive sends** — files under `data/<user-folder>` can only be sent to the matching WeCom user; unauthorized access sends a permission-denied message.

## [0.0.11] - 2026-06-21

### Added

- **Friendly empty states** — onboarding empty state for new users and the ability to select an existing workspace from it.
- **Session title prompt** — ask for an optional session title before creating a new chat.
- **Subagent brief status** — surface elapsed time and tool count in `SubagentBriefStatus`.
- **Workspace recency** — track `lastOpenedAt` and cap the empty-state recent workspace list.

### Changed

- **Context usage streaming** — stream context usage via SSE and unify the indicator in `SessionTokenUsage`.
- **Relative path display** — consistent relative paths in the file panel and tool headers.
- **Tool path display** — improved file path display in tool usage parameters.
- **Status bar context usage** — simplified to a single percentage label.

### Fixed

- **Subagent elapsed time** — freeze elapsed duration at `endTime` when a subagent completes; derive approximate historical timestamps from the parent transcript when the SDK omits them.
- **CI updater artifact path** — fixed verification path for updater artifacts.

### Internal

- Added `CLAUDE.md` and solution guides for testing and the Tauri updater.

## [0.0.10] - 2026-06-20

### Fixed

- **macOS updater target** — enable the macOS updater target in the Tauri bundle.

## [0.0.9] - 2026-06-20

### Fixed

- **Updater signing keypair** — rotate the Tauri updater Ed25519 signing keypair.

## [0.0.8] - 2026-06-19

### Fixed

- **Updater endpoint** — point the Tauri updater endpoint to the current repository (#51).

## [0.0.7] - 2026-06-20

### Added

- **Chat message search** — search bar, live highlights, scroll-to-match, and integration tests for finding messages in a session.
- **Historical subagent transcripts** — load and display historical subagent transcripts from the SDK.
- **SDK upgrade** — upgraded `@anthropic-ai/claude-agent-sdk` to 0.3.183 and adopted P0/P1 features.

### Changed

- **Session list polish** — refined context menu and New Session button styling/behavior.

### Fixed

- **Subagent elapsed time** — `SubagentBriefStatus` now freezes elapsed duration at `endTime` when a subagent completes, keeping the brief header consistent with `SubagentDrawer`.
- **Historical subagent timestamps** — when loading historical subagents, approximate `startTime`/`endTime` are now derived from the parent transcript position when the SDK omits per-message timestamps, so durations are no longer reported as `0s`.

- Restored SDK 0.2.x `tool_use`-based task compatibility layer (reverted its removal).

### Internal

- Added planning artifacts for chat message search.

[0.0.13]: https://github.com/ai-dvps/comate/releases/tag/v0.0.13
[0.0.12]: https://github.com/ai-dvps/comate/releases/tag/v0.0.12
[0.0.11]: https://github.com/ai-dvps/comate/releases/tag/v0.0.11
[0.0.10]: https://github.com/ai-dvps/comate/releases/tag/v0.0.10
[0.0.9]: https://github.com/ai-dvps/comate/releases/tag/v0.0.9
[0.0.8]: https://github.com/ai-dvps/comate/releases/tag/v0.0.8
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
