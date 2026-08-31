# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.5] - 2026-08-31

### Added

- **Git history stays inside Comate** — Git Workspaces can open a read-only Git Graph to inspect branch and tag topology, commit details, changed files, and historical file diffs in independent context tabs.
- **Prompt references now support folders** — The file picker and `@` search can attach a directory as a first-class prompt reference while preserving file-reference behavior.
- **Comate can launch automatically when you sign in** — General settings can enable or disable the operating system login startup entry on macOS, Windows, and Linux.
- **Release downloads are mirrored to Gitee** — Published source, installers, updater manifests, and blockmaps are synchronized from GitHub for faster access in China.

### Changed

- **Desktop updates choose the fastest reachable release source** — Packaged builds probe GitHub and Gitee, keep GitHub canonical when versions differ, and retry through the alternate source without installing a different version.
- **Deleting a session preserves its underlying transcript** — Every session can be removed from the sidebar without deleting the Agent-owned conversation history on disk.
- **README and changed-file typography are easier to scan** — The repository overview now explains Comate's end-to-end task workflow, while changed-file paths use a higher-quality monospace font stack.

### Fixed

- **Bot workspace switching keeps the correct channel** — Feishu switches retain Feishu routing, WeCom switches no longer inherit stale Feishu routing, and long WeCom workspace lists paginate across cards.
- **Update release notes render as formatted content** — The restart dialog displays sanitized lists and emphasis instead of exposing raw HTML tags.

## [0.4.4] - 2026-08-28

### Added

- **Collapsed sidebar keeps New Chat within reach** — The titlebar now shows a New Chat shortcut beside the command-center expand button while the left sidebar is collapsed.

### Changed

- **Titlebar icons now use a quieter visual weight** — Panel toggles, New Chat, context tabs, add, and close controls use softer semantic colors and a consistent thinner stroke while retaining clear hover and focus feedback.

### Fixed

- **The conversation status bar now remains readable in narrow layouts** — Workspace, account usage, Session tokens, and Context usage switch from long labels to semantic icons and compact values as the conversation column shrinks, instead of clipping their text.
- **The right context panel no longer crowds out conversations in narrow windows** — Its expanded width is capped at two thirds of the current window, saved widths are constrained again after the window becomes smaller, and the workspace/Session title hides when the expanded panel leaves too little titlebar space for its collapse control.

## [0.4.3] - 2026-08-27

### Added

- **File tree syncs with the active editor tab** — Switching back to an open file tab now exits file search, expands the file's parent folders, highlights the file in the navigator, and scrolls it into view.

### Changed

- **Agent selectors use recognizable brand icons** — Settings and the prompt toolbar now show the Claude, OpenCode, and OpenAI marks; locked conversations keep the selected agent mark and add a small lock overlay.
- **Comate's main window supports a narrower compact layout** — The main window can now resize down to 480px while retaining its 1280px initial width and the detached browser's 640px minimum width.
- **File tree expand/collapse uses a short animation** — Folder chevrons rotate and children open/close over ~150ms with a light fade; selection highlight eases in.
- **File tree scroll-to-active-tab is smooth** — Switching editor tabs scrolls the navigator to the file with `behavior: 'smooth'` instead of jumping instantly.

### Fixed

- **Permission mode matches the compact prompt toolbar** — At narrow window widths, the permission selector now hides its text label like the other prompt controls instead of crowding the toolbar.

## [0.4.2] - 2026-08-27

### Fixed

- **Codex Skills appear and run from the slash-command picker** — New chats and existing Codex sessions now load the native Codex Skill catalog, and selected Skills are submitted through Codex's structured Skill input instead of an empty or text-only `/` flow.
- **Packaged Codex turns tolerate normal startup time** — The release acceptance gate now allows healthy Codex Provider turns up to 60 seconds to start while preserving its route, authorization, payload, and credential-leak checks.
- **Switching a draft conversation to Codex starts a fresh thread** — Changing from Claude Code or OpenCode now clears the incompatible backend session reference, while reselecting the same backend keeps its resumable session.
- **OpenCode Skills appear in every slash-command picker** — New chats discover project and global Skills before a runtime exists, while active sessions merge the OpenCode runtime's command and Skill catalogs instead of falling back to Claude SDK initialization.
- **OpenCode reloads workspace Skills after they change** — Opening the slash-command picker now detects added, edited, or removed project Skills and safely rebuilds an idle OpenCode runtime; active turns finish before the refresh occurs.
- **Codex conversations recover when a saved thread has no rollout** — Comate replaces only the missing thread, persists the replacement ID, and continues the pending first turn without hiding unrelated resume failures.
- **Codex tool calls preserve live input parameters** — Streaming tool-use events now carry their JSON arguments through the shared SSE layer instead of exposing an empty input object.

## [0.4.1] - 2026-08-26

### Added

- **Analytics now includes OpenCode and Codex sessions** — OpenCode contributes per-message tokens, cost, models, tools, activity, and duration; Codex contributes exact thread totals and activity while clearly degrading only the unavailable per-day token breakdown.

### Fixed

- **OpenCode thinking indicators stop when sessions finish** — Terminal session events now complete active reasoning blocks instead of leaving the interface stuck in a thinking state.
- **OpenCode tool calls show their parameters while streaming** — Tool input now crosses the live SSE boundary after OpenCode finishes assembling it, including the normal pending-to-running lifecycle.
- **OpenCode auto-compaction recovers instead of ending the turn** — Recoverable context-overflow events now show compaction progress while OpenCode compacts and retries; failed recovery still surfaces the original error, including when the event stream disconnects mid-compaction.

## [0.4.0] - 2026-08-25

### Added

- **Provider model capabilities can be configured per Agent and model** — Advanced Provider settings now expose separate Claude Code, Codex, and OpenCode panels for context limits, reasoning behavior, tool and modality support, and protocol-aware OpenCode variants; BigModel's Coding Plan preset uses its documented OpenAI Responses `/api/v1` endpoint and `glm-5.3` model.
- **New sessions follow a global permission-mode default** — General settings now choose whether new sessions start in Auto, Read only, or Ask before actions mode; the app defaults to Auto while preserving per-session overrides.

### Changed

- **OpenCode upgraded to 1.18.23** — The SDK and every bundled platform binary move together from 1.18.4 to 1.18.23 as one pinned compatibility unit.

### Fixed

- **Saved Provider Auth Tokens can be inspected again** — Provider editors now show a masked saved-token state and reveal the credential only after an explicit eye-button action through the desktop-authenticated, non-cacheable API path.

## [0.3.1] - 2026-08-22

### Added

- **Feishu Bots support private deployments** — Each Bot can set an optional HTTPS server origin for both OpenAPI and event WebSocket traffic; leaving it blank keeps the official Feishu service.
- **Experimental Codex CLI agent backend** — Settings can select Codex as the default Agent for new GUI, Bot, and scheduled sessions while each session remains locked to its original Agent. A signed-in Codex Account appears as a native Provider with selectable model, reasoning effort, and speed; compatible third-party Providers use the OpenAI Responses protocol without exposing stored tokens. Codex keeps ownership of its login, threads, and transcripts. Production selection remains behind `COMATE_ENABLE_EXPERIMENTAL_CODEX=1` until the documented Claude Code parity gaps are closed.
- **Codex Account usage in Agent settings** — Signed-in Codex accounts now show their native rate-limit windows and reset times, available credits, recent token totals, and lifetime usage without moving account or session ownership into Comate.
- **Comate's website now explains complete Agent workflows** — The bilingual product site now walks through a controlled finance-report task, presents current desktop product evidence, offers platform-specific downloads, and measures visits and download actions only after consent.

### Changed

- **Codex shows every configured third-party Provider** — When Codex is selected, OpenAI Responses-compatible Providers remain selectable, while incompatible Providers stay visible but disabled with an explanation.
- **Agent settings are clearer and more compact** — Claude Code options now live in a polished collapsible group with responsive spacing, while Output style is an app-global preference that applies consistently across sessions.
- **Desktop and website colors now follow the Comate brand** — Primary actions, activity, attention states, work surfaces, and supporting website visuals use a shared logo-derived color system with improved light and dark mode balance.

### Fixed

- **OpenCode streaming recovers after an interrupted turn** — When stopping a turn forces its runtime to close, the chat now notifies connected clients to rebind before the next message instead of leaving the replacement runtime working invisibly in the background.
- **The left sidebar collapses on the first click** — The shell no longer requires a second interaction before responding to the collapse control.
- **Website release and analytics checks are more robust** — Download trust decisions, consent handling, release metadata, and shared bilingual content now have stricter automated coverage.

## [0.3.0] - 2026-08-20

### Added

- **Claude Code output style setting** — Output style is now an app-global Claude Code preference under Settings → Agent; changing it applies to every Claude Code session and rebuilds cached runtimes before their next turn.
- **Structured context-usage card** — Clicking the Context percentage in the status bar opens a breakdown card with a per-category segmented bar, auto-compact threshold marker, over-limit warning, and top token consumers across MCP tools, memory files, agents, and skills (CLI 2.1.237 data surface, replacing markdown-table parsing).
- **Status bar now shows the session's reasoning effort** — When the CLI reports an effort level on session init (CLI 2.1.237+), it appears as a chip next to the context usage.
- **Renderers for the new ProposeGoal and ReadNotifications tools** — The CLI 2.1.237 `/goal` proposal and notification-drain tool calls render as compact dedicated rows instead of raw JSON.
- **The Developer menu now shows provider usage at a glance** — Opening the user account menu lists every Kimi and BigModel coding-plan provider under a read-only Usage section (above Analytics) with a quota progress bar, remaining percentage, and compact quota reset time, refreshed live each time the menu opens; providers without usage support are omitted.
- **Prompt messages now accept screenshots and images** — Paste, drop, or choose ordered PNG, JPEG, WebP, and GIF images alongside text (or send images alone) to supported Claude Code and OpenCode models. Static images are proportionally normalized to the active model limits, failed admission restores the complete draft, and accepted images are rendered later from the backend-owned transcript rather than a separate Comate archive.
- **File Explorer now plays workspace video files** — Opening a supported video displays native playback controls with streamed seeking instead of the generic binary-file placeholder.
- **File Explorer now plays workspace audio files** — Opening a supported audio file (WAV, MP3, M4A, AAC, FLAC, Ogg Audio, Opus, WebM audio) displays an audio card with native playback controls and streamed seeking instead of the generic binary-file placeholder; audio files also get a dedicated icon in the file tree.
- **Sidebar workspace rows now have a right-click context menu** — Right-clicking a workspace offers Edit Workspace (opens Settings scoped to that workspace), Open Folder (reveals the workspace folder in the OS file manager), and Reload Sessions (refreshes that workspace's session list); expanded workspaces also refresh their session lists when the window regains focus.

### Changed

- **Claude Code settings are grouped with their Agent** — Agent choices now use a compact grouped-list layout with clearer selection and focus states, while Claude Code-specific options live in a default-open, smoothly animated Settings group with compact controls that match the rest of Settings.
- **Comate desktop now shares the product's brand color system** — Primary controls use the logo-derived blue, Agent activity uses cyan, user-attention states use orange, and the light and dark work surfaces use cooler neutrals while success, destructive, Provider, code-syntax, and analytics colors retain their existing meanings.
- **Comate website now presents a general-purpose Agent task workspace** — The bilingual site keeps its existing information architecture while replacing developer-first positioning with controlled everyday work, a complete finance-report workflow, current Electron product evidence, macOS/Windows/Linux download choices, an explicit bring-your-own-Provider prerequisite, and consent-gated measurement of anonymous visits and download actions.
- **Claude Agent SDK upgraded to 0.3.237 (Claude Code 2.1.237)** — Bundled CLI moves from 2.1.220 to 2.1.237. Highlights inherited from upstream: prompt caching now works for sessions behind a custom `ANTHROPIC_BASE_URL`/LLM gateway, whitespace-only messages no longer 400 in SDK sessions, print-mode MCP servers connect before the first turn, the 200-subagent spawn cap is gone, long-path session directories no longer collide, and a dozen Bash/PowerShell/sandbox permission-bypass fixes harden bot-session isolation. Task-tracking tools (TaskCreate/TaskList/…, TodoWrite) are force-enabled via `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` because CLI 2.1.233 removed them on newer models and Comate's task UI depends on them. Command discovery now also filters the CLI's terminal-only slash commands out of the GUI command list and picks up the session runtime's init capabilities for feature detection.
- **Token accounting now tracks thinking tokens** — Turn and cumulative session usage capture the reasoning-token detail (`output_tokens_details.thinking_tokens`) reported by CLI 2.1.237+.
- **Provider coding-plan usage is now fetched live on every check** — Kimi and BigModel quota summaries no longer come from a one-hour server-side cache, so opening the provider selector or pressing Refresh always reflects the provider's current usage; a short client-side throttle still avoids redundant requests within ten seconds.
- **Bot sessions now ask questions as plain chat text** — WeCom and Feishu bot sessions no longer offer the agent the structured AskUserQuestion tool, so a decision request surfaces as a plain text message the user answers by replying; the now-unreachable WeCom and Feishu question cards, card-answer routing, and free-text question interception are removed, while GUI sessions keep the structured question flow unchanged.
- **Workspaces now follow recent Session activity** — The Workspace list moves the Workspace with the newest effective Session activity to the top, including running work, unread completions, and pending user interactions, while preserving expansion and selection state.
- **Prompt references are now atomic chips** — Resolved Skills and files appear as lightweight, non-editable chips that can be deleted as a whole and reinserted with `/` or `@`; references that become invalid remain atomic and show a warning state. File chips display only the basename and reveal the full path in an instant hover tooltip, while the prompt text, copy, and cut keep the complete `@path` reference.
- **Prompt history no longer generates sentence suggestions** — The distracting local n-gram completion overlay and its Tab/Escape/arrow-key behavior are removed, while Skill and file pickers, prompt history, and Skill argument hints remain available.
- **Workspace groups now expand and collapse from the whole header** — Clicking a workspace name toggles its session list with a smooth transition instead of selecting the workspace and opening an empty “Start a conversation” view.
- **Prompt input no longer shows Skills and Files toolbar buttons** — Skills and files are still inserted with `/` and `@` triggers; the dedicated toolbar buttons are removed to reduce clutter.
- **The file-tree toggle now lives in the viewer header and animates** — With a file or diff open, the internal file tree's collapse/expand button moves into the viewer header beside Copy content instead of floating over the top-right corner (the floating button remains only for empty states), and the tree column now slides smoothly open and closed instead of snapping.
- **Preview tabs are now visually distinct** — Tabs opened by single-clicking a file (preview) show their name in italic with a hover hint explaining that double-clicking keeps the file open, matching the durable/preview distinction users expect from modern editors.

### Fixed

- **Agent settings now use consistent responsive spacing** — The Agent configuration page now aligns with the other Settings tabs, keeps comfortable gutters from compact windows through desktop widths, and presents availability and default state in clearer accessible selection cards.
- **Electron updater manifests are generated even without signing credentials** — Release builds now always emit and validate `latest-mac.yml`, `latest.yml`, `latest-linux.yml`, and their available blockmaps. Unsigned macOS and Windows packages are still uploaded, with the release notes explicitly warning that they are unsigned, alongside the metadata required by Electron auto-update.
- **Desktop update checks now report real failures** — Manual and automatic checks no longer record a failed feed request as successful, packaged builds without an updater feed show a localized recovery message, and signed release jobs verify every packaged architecture contains an exact `ai-dvps/comate` updater configuration.
- **New-session form next to a workspace now submits on Cmd/Ctrl+Enter** — The inline session-name input no longer creates a session on a plain Enter press; it now requires `Cmd+Enter` (macOS) or `Ctrl+Enter` (Windows/Linux), matching the composer shortcut and preventing accidental submissions.
- **Server test runner now works on the pinned Node 22 toolchain** — `test:server` hard-coded the `--test-isolation=process` flag, which only exists on Node 23+, so the suite could not run on the repo-pinned Node 22 at all; the runner now loads tsx via `--import` (the only loader mode that propagates into isolation child processes) and selects the matching isolation flag for the running Node version. Browser capture and direct-HTTP watchdog timers also no longer `unref()` themselves: both services only run inside the sidecar (whose HTTP server keeps the loop alive), and unref'd watchdogs stranded awaited stops on Node 22's test runner, cancelling 13 previously-skipped tests.
- **Code viewer scrollbars now stay pinned to the visible area** — The file and diff viewers previously grew the editor to the full document height, so the horizontal scrollbar sat at the very end of the file (mid-view for short files, unreachable for long ones); the editor now fills the container and scrolls internally with both scrollbars at the visible bottom edge.
- **Code viewer line numbers no longer show scrolling text behind them** — The line-number gutter in the file viewer (and other read-only code views) now has a solid background matching the panel, so horizontally scrolled code no longer bleeds through behind the line numbers.
- **Sidebar workspace and session lists no longer reshuffle while sessions work** — Streaming output, turn completion, pending approvals or questions, background poll ticks, and simply opening a session no longer move items in the Agent Command Center; those states still surface through the existing status icons and badges. Items rise only when a new turn actually starts — sending a message or a bot/scheduled run beginning — and the learned order now persists across app restarts, with newly created workspaces and sessions appearing at the top once.

## [0.2.0] - 2026-08-16

### Added

- **New Chat now starts conversations directly from a workspace** — Choose an existing workspace or create one from the integrated composer header, use the same Skills, Files, and Provider controls as an active chat, then submit the first prompt to create and open the session immediately.

### Changed

- **Embedded browsers can now open in an independent desktop window** — The same live browser view moves into a reusable OS window pinned to its originating chat, while the main panel keeps focus and restore controls; closing the window restores the browser to its panel.
- **Enterprise chat bots now explain progress without internal noise** — WeCom and Feishu show grouped, user-facing activity states instead of raw tool names, keep approval and question context in read-only result cards, accept direct chat replies for free-text questions, and cancel pending decisions safely when their cards cannot be delivered.
- **Electron development now rebuilds every main runtime before launch** — `npm run dev:electron` refreshes the server, sidecar, client, and bundled CLIs before starting the development watchers, and the sidecar prefers that freshly staged WeCom CLI over an older global installation.
- **Browser page understanding and element discovery are now explicit** — The embedded browser guides agents through `getPageState` → `findElements` → `getElementDetails` → `act`, starting with a text-only, token-bounded semantic outline and element inventory that works without vision. The old ref-only `inspectElement` operation is renamed to `getElementDetails`, while the old `snapshot` surface becomes the optional visual-only `takeScreenshot` and no longer invalidates current refs. Read-only details tolerate same-document changes only for stable backend-node refs, while actions and form refs keep strict stale-ref protection.
- **Edit tool changes now appear as one unified diff** — Replacements, additions, and deletions are shown in a single read-only diff instead of separate Before and After blocks, while file metadata and Replace all status remain visible.
- **Process Region detail drawer now opens and closes smoothly** — The side pane expands from the right when opened, supports resizing up to 800px, and finishes its exit motion before it is removed while respecting reduced-motion preferences.
- **Process Region items now expand and collapse smoothly** — Tool details and thinking blocks animate to their measured content height inside the side drawer while respecting reduced-motion preferences.
- **Process Region content now follows the chat font-size setting** — Tool and thinking details in the side drawer use the same configured size as the main conversation.
- **Process Region tool headers now match reasoning rows** — Tool controls in the side drawer use the same lightweight, transparent presentation instead of a separate card background.
- **Subagent message lists now match Process Region presentation** — Their content follows the chat font-size setting, uses lightweight tool headers, and animates tool and reasoning expansion and collapse.

### Fixed

- **Closing the embedded browser now also closes its right-side tab** — A server-side browser close (the agent's close tool, the state bar's close button, or idle reclaim) now retires the session's Browser context tab and clears its persisted pane-open flag, instead of leaving an orphaned tab showing the empty state; a later browser birth re-opens the panel as before.
- **Embedded browser panel now auto-opens when Claude starts a web task** — The first `comate-browser` MCP tool call in the active chat expands the right-side browser panel (and a crash rebuild re-opens it), matching the empty-state promise that a browser opens automatically; switching into a chat whose browser is already running keeps the panel's saved per-session open state, and takeover/handback cycles never re-open a panel the user closed.
- **Browser panel open state no longer clobbers itself across windows** — Persisting the panel's per-session open flags now merges into the latest stored map, so a detached browser window can no longer overwrite open/close choices the main window made after it launched (and vice versa).
- **Scheduled-task creation validates before writing** — The scheduled-task MCP tool now checks the schedule before persisting, so an invalid cron returns an error without leaving an orphaned Todo row, and the server test suite covers the unified Todo-backed tool surface again.
- **Bot and scheduled agent sessions no longer inherit ambient Comate credentials** — Subprocess environments are stripped of any broker token or Comate CLI variables inherited from a parent Comate process before per-session authority is minted.
- **New Chat no longer crashes the packaged backend while naming a session** — Session titles now use package-safe sentence parsing and width measurement with no `Intl.Segmenter` anywhere in the dependency chain (the `cli-truncate` → `string-width`/`slice-ansi` path also reached it, so Chinese or long prompts still crashed), and the sidecar build verifies the complete workspace-to-session creation path with English, Chinese, and truncating prompts in the packaged binary.
- **File browser now previews image files** — Opening PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, or SVG files displays the image instead of the generic binary-file placeholder.
- **Multi-question prompts now submit successfully** — Answering an `AskUserQuestion` card with multiple questions no longer fails with “Approval is no longer pending,” and the server uses the canonical pending question payload when resolving the response.
- **Embedded browser now identifies and edits ProseMirror-style rich-text editors reliably** — Page discovery ignores zero-area textarea mirrors, derives a bounded editor name from nested placeholder metadata, and consistently treats role-less contenteditable roots as textboxes during ref revalidation, so agents can target and fill the real long-form editor.
- **Night-idle todos now explain missing workspace setup** — Automatic run types require a workspace, legacy workspace-less night-idle todos remain visible for repair, and selecting a workspace reactivates affected items instead of silently consuming them.
- **New Chat composer no longer doubles its inner padding** — The prompt input card now aligns its text and toolbar with the session composer instead of stacking an extra wrapper padding inside the border, and the workspace selector tab above it is more compact.
- **Prompt send controls stay inside the composer at narrow widths** — Optional toolbar controls now yield space before the send or stop buttons can overflow the input card.
- **Electron development sidecar now loads its staged SQLite binding** — Development launches resolve `better_sqlite3.node` from the resource directory supplied by the Electron shell instead of looking for an unpackaged native module inside the sidecar snapshot.
- **Interrupted turns no longer show internal EDE diagnostics** — Manually stopping a Claude turn now hides the SDK's internal `[ede_diagnostic]` marker from the message list while preserving genuine error messages.
- **Interrupted sub-agent timers now stop in inactive sessions** — Reopening an inactive session no longer reconstructs interrupted Process Region agents as running; their terminal state and elapsed time remain fixed.
- **Windows custom title bar now has a visible top frame when restored** — The subtle top edge follows the app theme and disappears while the window is maximized or fullscreen.
- **Comate now exits duplicate desktop launches immediately** — The Electron single-instance lock is acquired before debug-port allocation or shell service startup, and launching Comate again restores the existing window instead of starting another app instance.
- **Electron release no longer opens to a blank window** — Clean CI builds now compile and package the Vite renderer alongside the Electron shell, and the release workflow rejects any app archive whose renderer entry files are missing.

## [0.1.0] - 2026-08-08

### Changed

- **macOS and Windows installers are published as direct Release assets** — GitHub Actions still retains short-lived, ZIP-wrapped workflow artifacts for maintainers, while the Release exposes each architecture-specific DMG, macOS updater ZIP, and Windows EXE separately. These macOS and Windows packages are currently unsigned because signing credentials are unavailable; no auto-update manifests are emitted for them.
- **Desktop shell migrated from Tauri to Electron** — The app now ships on an Electron shell (same React UI, same Express sidecar, same data directory). The embedded browser no longer downloads or bundles its own Chrome for Testing runtime; browser sessions run as native, per-session isolated views inside the shell itself, which makes the app roughly 267 MB lighter. Linux (AppImage, plus deb) joins macOS and Windows as a supported desktop target. Behavior notes for existing installs:
  - UI preferences kept in webview storage (panel open/closed, pane widths) reset once on first launch of the Electron build.
  - Site logins in the embedded browser do not carry over from the old browser runtime; sites saved via "Remember this site" sign back in automatically on first use, other sites need one fresh login.
  - On first launch the app deletes the legacy browser residue (old profiles, pidfiles, and the downloaded browser cache); remembered-site login data is preserved.
  - On Windows, the old Tauri installation is detected and removed by the new installer automatically (one UAC prompt; if declined, the old entry points are neutralized instead).
  - For support and enterprise-ops scenarios, the browser tools can be pointed at an operator-supplied Chromium without a client release via `COMATE_BROWSER_CDP_TARGET` (see development.md).

### Added

- Nothing yet.

### Changed

- **Default agent is now Claude** — The app-level default agent resolves to Claude from first launch instead of leaving "no default" selected. The Agent selector in settings now highlights Claude out of the box, so users no longer need to click once before chatting. An explicitly chosen agent still takes precedence.
- **Tool cards and thinking blocks are collapsed by default** — In every chat view (linear mode, the result-focus process drawer, and the subagent drill-down), tool calls and thinking blocks now render header-only and expand via a dedicated icon at the end of the header. Expanded content is capped at ~40vh with its own vertical scroll, replacing the 192px preview with a Show more/Show less toggle. Search navigation force-expands the matching card and scrolls the hit into view, and running tools show progress through the header status badge.

### Fixed

- **Handoff approval card no longer hangs when the browser closes** — Closing the embedded browser (or an idle auto-close) while a takeover/handback approval card is pending now resolves the card immediately with a "browser was closed" result instead of leaving the agent's tool call hanging until the 10-minute timeout.
- **Compacting conversation progress bar width** — The "Compacting conversation…" progress bar no longer stretches to the full conversation width; it now matches the centered message column (`max-w-3xl`) like the rest of the messages.
- **Todo "Start session" now loads the new session** — Starting a session from a todo's detail pane no longer left the workspace's session list stale. The run is created server-side, so the workspace's session list is now reloaded and the freshly started session is opened (and begins streaming) immediately after the run kicks off.

## [0.0.33] - 2026-08-05

### Changed

- **Owner/admin-approved Bash on degraded hosts (bot sandbox model, AE5)** — On a host where the execution sandbox is unavailable (notably Windows, where the probe reports `platform-unsupported`), a regular WeCom bot member's Bash command no longer fails outright with "repair sandboxing first." The permission gate now routes it directly to the channel's owner/admin approval cards — the same flow as an out-of-sandbox escape — and runs it unsandboxed once an owner or admin approves. Owner/admin members still bypass approval, non-WeCom channels (e.g. Feishu) still deny until their card flow is aligned, and the existing per-user/per-bot caps, dedupe, and always-allow persistence bound the request volume. The authorization is decided by the gate from host sandbox state, not by the model's per-call sandbox flag.
- **Todo title submission shortcut** — Creating and renaming todos now requires Ctrl/Cmd+Enter instead of plain Enter.
- **Dismissible sandbox warning** — The degraded sandbox warning banner can now be dismissed for the current app session without changing the sandbox posture.

## [0.0.32] - 2026-08-04

### Added

- **Provider usage in the status bar** — The status bar now shows provider usage information without leaving the active workspace.

### Changed

- **Numeric font-size controls** — Chat and UI font sizes can now be entered directly as bounded pixel values instead of choosing from preset sizes.

### Fixed

- **Workspace-scoped chat sessions** — Starting a chat no longer reuses a session from another workspace.
- **WeCom interactive card updates** — Approval and workspace cards now carry the required task identity and update using valid interactive-card payloads.
- **Privileged bot Bash access** — Bot owners and admins now receive their intended Bash approval bypass.

## [0.0.31] - 2026-08-04

### Added

- **Browser API discovery workbench** — Agents can inspect one selected DOM element, bracket one browser action with bounded network capture, and receive ranked credential-redacted API candidates in chat. A task-scoped authenticated-request MCP and new `comate api request` CLI replay selected APIs through Comate-held cookies or bearer credentials without exposing them; GET/HEAD calls remain fluid, mutations show an exact sanitized approval card, and explicit Remember-site consent can preserve the selected authentication for browser-closed reuse.

- **Skill search provider filters, health, and views** — Skill Search now lets users include or exclude any connected provider, remembers that choice globally, and identifies unavailable providers with safe failure reasons and per-provider Retry. Searches skip unavailable sources while preserving healthy results, clearly warn when result coverage is incomplete, and support persistent card and list result layouts.

- **WeSkillHub federated Skills provider** — WeSkillHub is now the fifth federated provider, with discovery using the generic project/global Skill installation and update lifecycle.

- **Enterprise Zone in Skills** — Skills now includes a top-level Enterprise Zone for searchable, industry-filtered enterprise discovery, per-enterprise Skill search and sorting, Skill details, and individual project/global installation through the standard Skill flow.

- **Expert Packages in Skills** — Skills now includes a top-level Expert Packages area with searchable and scene-filtered package discovery, package and included-Skill detail pages, and in-app project/global installation. Complete package installs preserve partial successes and support failed-item retry, while package orchestration remains runtime-compatible but is labeled separately from standard Skills.

- **MCP tool classification and admin boundary (bot sandbox model, U9)** — MCP tools in bot sessions are no longer silently allow-all: every `mcp__*` call is now classified at the permission gate as read / write / unknown. Server-provided annotations (`readOnlyHint` / `destructiveHint`) are honored first, a per-server override in the bot policy (`mcpClassification`, keyed by server name) wins over the annotation, and an unclassifiable tool always asks — it can never fall through to allow. Write-class and unknown-class calls enter the escalation flow as `mcp-write` requests: regular members route to the channel's owner/admin approval cards (with the same dedupe, caps, TTL, and no-approver deny-with-explanation as bash escapes), owner/admin requesters self-ask, and Feishu channels keep the previous deny until their card flow is aligned. Read-class tools continue through the existing category policy without a card. The bundled scheduled-tasks MCP server now advertises annotations (`list_scheduled_tasks` is read-only; task creation is write-class), and the admin role's target boundary is enforced at the gate itself: an admin can write the workspace and the closed capability set (`.claude/skills`, `.claude/agents`) but is now denied writes into `.claude/plugins`, hooks, settings files, and anything outside the workspace — previously only bash was constrained (by the sandbox), while the Edit/Write tools ran wide open inside `.claude` for admins. The owner's reach is unchanged.

- **Loopback API authentication (bot sandbox hardening, U12)** — the entire `/api` surface is now default-deny authenticated at the route-registration layer: every present and future route requires a Bearer credential, with exemptions declared explicitly. Bot sessions receive a per-session capability token (24h TTL, rotated on runtime rebuild, revoked on session close/demotion/boot, stored as SHA-256 hashes) that reaches only the closed set of wecom CLI routes, with identity and admin rights derived from the token-bound session — a self-asserted `sessionId` is no longer trusted. The desktop client authenticates with a per-boot GUI credential delivered via the sidecar ready message (Tauri) or a `0600` credential file (dev proxy). The wecom CLI context moved from the workspace-root `.claude/wecom-context.json` (discovered by walking up directories) to a per-session `data/<user>/.runtime/wecom-context.json` passed explicitly via `COMATE_WECOM_CONTEXT_FILE`, so a context planted in a user-writable directory can no longer redirect the CLI; the CLI also routes its loopback calls through the sandbox HTTP proxy when one is present (required for egress from sandboxed sessions).

- **Bot decision audit trail (bot sandbox hardening, U6)** — the bot audit log now records the sandbox permission model's decision points: bash denials (with the structural reason and routing class), out-of-sandbox requests and their resolutions (approved/denied/expired, with the approver as actor and the requester recorded alongside), passlist rule additions (with manual/approval provenance), admin writes into the workspace capability dirs (`.claude/skills`, `.claude/agents`), capability-token mint/revoke, and loopback authentication rejections. Long commands, rules, and domains are stored in full with a SHA-256 integrity hash instead of being redacted, while secret-shaped values (API keys, bearer tokens, the 48-hex capability tokens) are masked at any length; audit rows are retained for 90 days and then purged, and the audit surface stays unreachable for bot session tokens — only the desktop credential can read it.

- **Bot escalation approval ledger (bot sandbox hardening, U8)** — out-of-sandbox approval requests from owner/admin bot sessions are now recorded in a persistent escalation ledger (requester, recipients, rule payload, state, expiry) instead of living only in memory. Approvals are bounded by a 30-minute TTL when the tool call carries no timeout of its own: an unanswered request now settles as a fail-closed denial with an `expired` audit row and a timeout notice to the requester (previously it could wait indefinitely). A server restart no longer strands approvals either — every still-pending request is expired at boot (never auto-approved), audited, and the requester is notified once the bot's WeCom connection is back. Each pending also carries an audience marker (`self` for owner/admin requesters, `admins` otherwise — fail-safe) that the upcoming remote-approval cards will route on. Desktop approvals now resolve through the same provenance writer as card approvals with identical audit shape, the desktop approvals endpoint never spawns a session runtime just to answer an approval (404 when none is live), and the desktop session list shows its existing pending indicator on bot sessions awaiting approval.

- **Remote owner/admin approval cards for regular members (bot sandbox model, U11)** — a regular channel member's out-of-sandbox bash request no longer hits a blanket denial: it now creates an escalation that delivers an actionable approval card to the channel's owner/admin. Owner and Admin requests retain their default role bypass and run without approval. The regular-member requester receives a read-only notice card instead of a self-approvable one — self-approval was never supervision. Card clicks are authorized against a fresh role check on the ledger row's bot (a demoted admin loses approval power immediately and members of other bots are rejected), and settlement is transactional first-click-wins, so double-clicks and late/replayed clicks are harmless no-ops; the clicker's card flips terminal while everyone else — the requester on any outcome and the non-clicking approvers — receives a terminal notification card on approve, deny, or TTL expiry. "始终允许" (always allow) now persists an exact-match structural rule (the literal command, never a wildcard) into the bot's out-of-sandbox passlist with the approver's identity and `approval` provenance in the audit trail, so the same command in a future session runs without asking while a same-tool/different-arguments variant still cannot match; SDK suggestions that would widen scope (mode changes, added directories, rule replacement) are dropped and suppress the button entirely. Escalation volume is bounded: parameter-variant retries collapse into a single pending card, per-user hourly and per-bot outstanding caps fail closed with a notice, and a turn that keeps retrying after repeated denials gets an explicit stop instruction. Regular members' `allowUnsandboxedCommands` is now enabled — the escape hatch finally has a supervised path. Feishu channels keep the previous behavior until their card flow is aligned.

### Changed

- **Incomplete Expert Package installation** — package validation is now advisory. The app installs the raw package orchestration and every resolvable included Skill, reports unavailable children as per-item failures, and lets users correct the installed files afterward.

### Fixed

- **Packaged Comate CLI startup** — the bundled `comate` executable now contains exactly one shebang, so the packaged CLI starts correctly instead of failing on a duplicated interpreter line.

## [0.0.30] - 2026-07-31

### Added

- **Inline todo title editing** — a todo title in the list can now be renamed in place: single-click still opens the detail pane, double-clicking the title enters edit mode, Enter or Cmd/Ctrl+Enter saves, Escape cancels, and blur saves. Empty titles are rejected (silently reverted). The same 2000-character cap applies.

- **Embedded browser: internal HTTP and insecure-certificate sites** — the embedded browser now respects explicit `http://` URLs instead of automatically upgrading them to HTTPS, preventing upgrade/downgrade redirect loops that surfaced as `ERR_BLOCKED_BY_CLIENT`. Private-CA and hostname-mismatched sites can also load through a global Settings → General toggle, persisted server-side and applied to every spawned Chrome as `--ignore-certificate-errors`; it is on by default and can be disabled for strict certificate validation. (Replaces the earlier `COMATE_BROWSER_IGNORE_CERT_ERRORS` env var, which is now a no-op.) Applies to the embedded browser only.
- **GitHub Issues sync** — todos are now global, shareable entities that sync with GitHub Issues. Connect a GitHub account (GitHub App via Device Flow, or a fine-grained PAT), then publish a local todo to an issue or pull an issue into a local replica. Sync is origin-anchored and field-class: comments merge append-only both ways, status/labels/assignee accept the remote, and title is origin-wins with both-sides-edited conflicts surfaced for an accept-local/accept-remote choice (never auto-clobbered). Sync runs on-demand when the Todos panel opens or you click refresh; a single-flight guard collapses overlapping triggers. A remote deletion is detected and flagged, never silently destroying local comments. Tokens are encrypted at rest and never appear in any response or log.

### Changed

- **Panel background color redesign** — simplified the main layout to a minimal white-and-gray palette. App header, left sidebar, and status bar now share a single `chrome` gray surface, while the chat header, message body, right panel, and prompt input share a single `work` white surface. App header uses a subtle shadow instead of a bottom border to avoid a double divider with the chat header. Added design comparison prototypes under `docs/design/`.
- **Right sidebar browser integration** — the embedded browser is now a tab inside the right sidebar alongside Files and Git Changes. The old chat-header browser button and the separate in-chat browser pane are removed. The right sidebar now collapses completely (no 40 px rail) and animates its width when expanding or collapsing. Browser iframes stay mounted across tab switches and collapse/expand so the cast stream never reloads.

- **Todos panel top-bar layout** — the todos panel is now a top-bar task list: the left view rail is removed, smart views (Inbox / Today / Upcoming / All) live in a segmented header control with counts, search filters the active view, and the list spans the full width with information-rich rows showing due dates, labels, and origin. Group-by moved into the header, quick-add sits at the top of the list, and empty/no-results/load-failure states are split so sync errors are visible.
- **Todo detail panel** — the detail pane is now wider by default and resizable via a left-edge drag handle. It animates when a todo is selected, shows the workspace name instead of its ID, and lets you reassign the workspace and edit the status directly. Linked sessions are clickable and jump to the session. Search and group-by inputs are sized to 34 px.

### Fixed

- **Embedded browser content appearing scaled down** — live browser frames now render at their native 100% CSS-pixel size instead of being fitted to the panel height. When the page viewport is larger than the embedded browser, the viewer shows scrollbars rather than shrinking the content.
- **Claude SDK Sessions becoming idle while background agents still run** — Session activity now follows the SDK's complete background-task snapshot instead of ending with the main-agent result. Background work keeps the Session active, visible, retained, and stoppable while leaving the composer available for replies and follow-up prompts; the Session list shows a task count and the open chat shows task details. Stop now fences the whole Session immediately, drains late tasks, and closes the SDK process when cancellation cannot be proven.
- **Individual Claude background task controls** — each running background agent or command can now be stopped independently from the activity panel without interrupting the foreground turn or other background work.
- **First chat message flush against the header** — the conversation content area now has top padding, so the first message no longer sits directly on the chat header's bottom border; the 16 px gap matches the existing spacing below each message row.

## [0.0.29] - 2026-07-28

### Fixed

- WeCom plaintext user ID resolution no longer fails with "credentials not
  configured": the resolver now reads corp credentials from the bot's wecom
  channel config (their home after the unified-schema migration) instead of the
  deleted `workspace.settings.wecomCorpId`/`wecomCorpSecret` fields. Fixes both
  automatic background resolution and manual "resolve pending" resolution.

## [0.0.28] - 2026-07-28

### Added

- **Scheduled tasks** — the assistant can now run tasks unattended on a schedule. Tasks are drafted from chat or WeCom and only take effect after you confirm them in the new Scheduled Tasks panel (opened from the header), which shows the exact instruction being approved. Supports one-shot and recurring cron schedules (hourly/daily/weekdays/weekly presets or a raw expression), keeps a per-task run history whose entries open as regular sessions, and reports results through desktop notifications, an in-app title-bar badge, and optional WeCom summaries. Runs execute as fresh sessions in auto-approval mode with a goal-completion check on the Claude backend; on other backends execution degrades to a plain prompt without the completion check.

### Changed

- **Bot channel owner lifecycle** — a bot no longer requires an "Initial owner user ID" at creation time. That field asked for the encrypted WeCom/Feishu channel user ID, which is unknowable until the first inbound message, so it could never be filled with a valid value. Channels now start owner-less: the first sender on each owner-less channel is auto-promoted to owner, and an operator can reassign a channel's owner to any other member from the members UI (previously the owner was effectively immutable once set). Auto-promotion and transfers are wrapped in a store transaction and logged for auditing. Note: owner grants tool/skill/bash bypass and `/workspace` authority, so auto-promotion is a privilege grant to whoever messages first — review the members UI and transfer if the first sender was unintended.

### Fixed

- **Embedded browser failing to start with `browser_start_failed`** — the vendored Steel bundle's pruning step treated all `doc` / `docs` directories as non-runtime dead weight and deleted `yaml/dist/doc/`, which contains modules required at runtime (`directives.js`, `Document.js`, etc.). Steel crashed during startup with `MODULE_NOT_FOUND` before it could launch Chrome, so the browser pane stayed black and no chrome process appeared. The build script no longer prunes `doc` / `docs`, and the rebuilt bundle preserves these runtime modules.
- **Opencode backend echoing the first user message** — `opencode serve` emits the user message as a `message.part.updated` event before the assistant response. The event mapper was rendering every text part as assistant content, so the user's own prompt appeared as an identical reply and any empty model output left no further response. The mapper now tracks each message's role and only renders parts that belong to assistant messages.
- **Renaming an opencode session failed with "Session … not found in project directory"** — `updateSession` always called the Claude Code SDK's `renameSession`, which scans project dirs for a `.jsonl` transcript that opencode sessions never have. Opencode-backed sessions now rename via their serve's `PATCH /session/{id}` (persisting the title in opencode's own store), the new title is mirrored into the local `name`/`custom_title`, and the post-rename `getSessionInfo` re-read is skipped for opencode (it would throw the same project-dir error).

## [0.0.27] - 2026-07-25

### Fixed

- **Embedded browser failing to start with `browser_start_failed`** — the vendored Steel bundle's pruning step treated all `doc` / `docs` directories as non-runtime dead weight and deleted `yaml/dist/doc/`, which contains modules required at runtime (`directives.js`, `Document.js`, etc.). Steel crashed during startup with `MODULE_NOT_FOUND` before it could launch Chrome, so the browser pane stayed black and no chrome process appeared. The build script no longer prunes `doc` / `docs`, and the rebuilt bundle preserves these runtime modules.

## [0.0.26] - 2026-07-23

### Added

- **Embedded controlled browser** — chat sessions can now drive a real browser through natural-language prompts. A browser button in the chat panel header opens a collapsible, resizable pane to the right of the chat area showing the live page (powered by a locally hosted Steel browser engine), where you watch Claude navigate, fill forms, and extract content. You can take over at any moment — type credentials, scan a QR code, or finish a complex flow yourself — then hand control back; Claude resumes with a diff of what changed (password fields always masked). Everything you type in the pane stays out of the model context and the chat record.
- **Human handoff with timeout recovery** — when the agent hits a login wall, CAPTCHA, QR code, or ambiguous form, it explicitly hands the browser to you: the pane auto-expands, a pending card appears in chat, and a badge marks the header button. Unanswered handoffs expire after a server-fixed 10 minutes into a recoverable state instead of hanging the task, and the agent explains how to resume.
- **Submit hard gate and navigation confirmation** — form submissions, payments, and publishing actions always require per-action confirmation (even in auto approval mode), showing the target URL and field list with sensitive values redacted; approvals are re-verified against the live form before dispatch (TOCTOU protection). In auto mode, the first cross-domain navigation per session asks once before proceeding. WeCom/Feishu bot sessions cannot use the browser.
- **Remember this site** — after logging in via a takeover, you can opt to remember the site: its session state (cookies and web storage) is stored per workspace and re-injected on your next visit, so new sessions stay logged in. Stored credentials are write-only (never sent back to the client), can be revoked individually from workspace settings, and are never logged or included in model context.
- **Browser action audit** — browser actions (navigate, click, submit, takeover, handback, site remember/revoke) are recorded in a per-workspace audit table storing only action names, categories, URL origins, and field names — never field values or screenshots.
- **Sidecar remote-surface hardening** — the local API now restricts CORS to the app origins, verifies WebSocket upgrade origins, validates Origin/Sec-Fetch headers on state-changing routes, and enforces a Host-header whitelist, so web pages you visit cannot drive the app or its browser.
- **Browser resource teardown (explicit close + idle reclaim)** — the embedded browser can now be closed on demand instead of living until the chat session is deleted. Claude can request a close (you confirm via a card), and a dedicated close button in the browser state bar tears it down directly — distinct from collapsing the pane, which keeps the session alive. A per-session idle timer prompts you to close a browser that has sat unused, and auto-closes it after a further grace period if no one is around, so always-on deployments no longer accumulate idle Chromium processes. Closing auto-remembers the current site's login (if you are signed in), so the next open is still signed in; every close is audited with its trigger source.

### Changed

- **Responsive chat panel header** — the header kept its `title / model` layout at every width, with the side buttons floating over the centered title, so on a narrow panel the session name slid under the buttons and competed with the model label. The header is now a three-part flex row so the side button clusters sit in flow and the title region is exactly the space between them (it can no longer overlap the buttons); that region's width — not the whole header — decides when the separator and model name drop out, handing the full width to the title, which then ellipsizes via `truncate`.
- **Process region ghost opens only from its trailing chevron** — in result-focused mode the collapsed process-region row was an entire-width button, so any click opened the drawer and the step/tool/command text could not be selected. The row body is now plain selectable text and only the trailing chevron icon is the click target that expands the drawer (keyboard focus and the aria-label move to that single control).
- **Browser runtime distribution** — the Steel browser engine ships inside the app resources (no Docker required). The embedded browser now defaults to an isolated, pinned Chrome for Testing that is bundled as an app resource and extracted to the data directory on first use (fully offline, including intranet installs); it never drives your installed Chrome. Set `COMATE_USE_SYSTEM_CHROME=1` to opt into the system Chrome, or `COMATE_CHROMIUM_PATH` to point at a specific executable; a verified one-time download remains as an online fallback.

### Fixed

- **Embedded browser destabilizing the installed Chrome** — Chromium resolution preferred the system Chrome, so the embedded browser drove your installed Chrome binary; on macOS that shares the same `.app` identity as your daily browser, and its launch/teardown churn (idle reclaim, etc.) destabilized your open Chrome windows (windows vanishing, Chrome becoming unusable). The embedded browser now defaults to a bundled, isolated Chrome for Testing (`com.google.chrome.for.testing` — a different app identity) and only touches your installed Chrome when you explicitly opt in via `COMATE_USE_SYSTEM_CHROME=1`.
- **Result-focused message panel flicker, overlap, and missing history** — Result Focus now uses one stable native message list for short and long sessions, projects assistant turns with source-derived stable region identities, and preserves unchanged text and process ghosts while streaming updates only the affected region. Opening an existing session loads its complete history before revealing the list, eliminating upward pagination, virtualizer measurement churn, changing scrollbar extents, and prepend corrections. Live events received during loading are reconciled by message identity, and scrolling away from the streaming tail preserves the user's reading position until they return to the bottom.
- **`<task-notification>` XML leaking into the chat transcript** — when a background task settled, the CLI injected a `<task-notification>…</task-notification>` block as a synthetic user-role message meant for the model, and the historical message loader rendered it verbatim as a raw chat bubble. These synthetic messages are now dropped during normalization (detected via the `origin.kind === 'task-notification'` provenance where present, with a wrapper-text fallback), so the XML never appears in the transcript. Task status remains available in the Tasks panel, which is fed independently by the structured task-lifecycle system messages.
- **Browser panel expand/collapse state leaking across sessions** — the pane's open/closed state was a single global flag shared by every chat session, so opening it in one session and switching to another left the pane open there too, and collapsing it in one collapsed it everywhere. The open state is now tracked per session (and persisted per session), so each session remembers its own expand/collapse independently.
- **Browser panel rendering as a black rectangle** — the embedded browser viewer loads from the viewer proxy on `http://127.0.0.1:*`, but Tauri's CSP only allowed `http://localhost:*` in `frame-src`. The blocked iframe showed its black fallback background while the state bar text rendered normally. The CSP now permits `http://127.0.0.1:*` so the live page appears in the pane.
- **Browser panel black rectangle when the Steel session is unavailable** — when the embedded browser process crashed, was still starting, or failed its warm-up probe, the viewer proxy returned a 503 with `X-Frame-Options: DENY`. The browser refused to render the error inside the iframe, leaving a black screen. The proxy now returns a frameable HTML "Browser unavailable" page for valid sessions that have no reachable browser, so the user sees a clear crash state instead of black.
- **Browser panel black rectangle from missing Chrome remote-debugging port** — Steel hardcodes `--remote-debugging-port=9222` and Comate filters it out to avoid port collisions, but Steel's arg deduplication ran before the filter, dropping the replacement `--remote-debugging-port=0` as well. Chrome launched without an exposed CDP port, so external clients (browser-mcp, the viewer proxy) got `socket hang up` and `/v1/sessions/default/live-details` returned 500. The vendored Steel build and `build-steel-bundle.ts` now apply `FILTER_CHROME_ARGS` before deduplication, so Chrome exposes a real remote debugging port and the live browser renders.
- **Browser panel going black when a session's browser is re-opened** — when a Steel process was torn down without reaping its Chrome child (idle close, app nav, crash), the orphaned Chrome kept holding the session profile directory's `SingletonLock`. The next launch for that session into the same deterministic profile dir aborted ("Failed to create SingletonLock: File exists"), so Steel had no browser, `/v1/sessions/default/live-details` returned 500, the viewer proxy warm-up timed out, and the pane stayed black. Browser-service now reaps the stale lock before each spawn: it clears the lock when the holder pid is dead, and — after verifying the live holder is the Chrome bound to this exact profile (PID-reuse guard) — kills the orphan and clears the lock.
- **Browser panel stuck on `about:blank` after opening** — Steel reports `/v1/health` = 200 (its `isRunning()` is true) before Chrome's CDP endpoint accepts WebSocket upgrades (~1–2s later on a cold start), so the first CDP connect raced Chrome readiness and failed with "socket hang up". The first `navigate` failed with no retry, leaving Chrome on `about:blank`. `connectSteelPage` now retries the connect+attach across that cold-start window (bounded 10s budget), so the first browser tool call waits for Chrome instead of failing.
- **Release build failing on a browser store type mismatch** — `npm run release` aborted at the client typecheck with `TS2345: Argument of type ... is not assignable to parameter of type 'StateCreator<BrowserPaneState, [], []>'` on the `useBrowserPaneStore` `create()` call. The real cause was `snoozeIdle`: the `BrowserPaneState` interface declared it as `(sessionId) => Promise<void>` but the implementation was a synchronous function returning `void`, so the initializer's return type no longer satisfied `BrowserPaneState` and the whole `create()` call failed to typecheck. The implementation is now `async` (awaiting the snooze request with errors swallowed), matching its sibling `confirmIdleClose`.
- **Release build failing on vendored Steel resources** — `npm run release` no longer aborts with `resource path 'resources/steel/node_modules/.../.bin/...' doesn't exist`. Steel vendoring now preserves npm `.bin` symlinks as relative links when copying (`verbatimSymlinks`; `fs.cpSync`'s default rewrote them to absolute paths inside the deleted temp build dir), and a new build gate fails the vendoring step with a clear message if any dangling symlink ever slips through.
- **Windows release build failing on the Steel API compile** — `build-steel-bundle.ts` spawned `node_modules/.bin/tsc` directly via `execFileSync`, which works on POSIX (npm writes extensionless shim symlinks there) but threw `ENOENT` on Windows, where npm emits `tsc.cmd` and the extensionless path does not exist. Spawning the `.cmd` directly is not an option either — modern Node rejects `.bat`/`.cmd` without a shell (CVE-2024-27980). The Steel browser feature is new in 0.0.26, so this was the first Windows build to reach that code path. The script now spawns `tsc` through a shell on Windows (`shell: process.platform === 'win32'`), where cmd.exe resolves it via `PATHEXT`; the argument list is empty, so there is no shell-quoting surface.
- **Windows MSI build failing on a non-ASCII resource path (WiX `LGHT0311`)** — the Windows `light.exe` MSI linker defaults to database code page 1252 (Latin-1) and aborted on `@fastify/send`'s `test/fixtures/snow ☃` fixture, whose `☃` (U+2603) is outside that code page. The fixture rode along in the vendored Steel `node_modules` because whole package directories are copied, and Tauri swallows `light.exe`'s stderr, so it surfaced only as a cryptic `failed to run light.exe`. The Steel vendoring now prunes non-runtime directories (test/docs/example trees — dead weight that also inflates the bundle) and any non-ASCII-named directory, and a new build-time `assertNoNonAsciiPaths` gate fails the build locally with the offending path instead of as a remote WiX error.

## [0.0.25] - 2026-07-18

### Added

- **Ctrl/Cmd+click to open URLs in chat messages** — holding Ctrl (Windows/Linux) or Cmd (macOS) and clicking an `http://` or `https://` URL in user messages, assistant markdown links, or tool error text now opens the link in the system default browser. Plain clicks keep the existing behavior (text selection, copy, and default link navigation), and URLs retain their current visual appearance.
- **Collapsible prompt input while streaming** — the prompt-input text area now collapses with a height animation during active generation, leaving only the bottom toolbar controls visible. It expands again smoothly once the stream ends.
- **Responsive prompt-input toolbar** — as the prompt-input card narrows, toolbar controls now hide progressively from left to right (Skills → Files → History → Provider → Fast mode → Approval mode → Clear) so the input never overflows. The left-side picker triggers stay mounted but hidden so the `/`, `@`, and `Alt+H` keyboard shortcuts keep working, and the Send/Stop button always remains visible.
- **Collapsible AskUserQuestion cards** — `AskUserQuestion` tool cards in the message panel now start expanded and can be folded down to a thin header line by clicking the header. The collapsed state is local to the card and resets on reload, and cards containing multiple questions collapse and expand together.
- **Collapsible main sidebar** — the session/todo/file sidebar can now be collapsed into a narrow icon rail to free up horizontal space on small screens. Clicking a tab icon switches tabs without expanding. The toggle is now a single icon button in the chat panel header instead of a fixed button at the bottom of the sidebar, saving vertical space in the rail. The collapsed state and width persist across app restarts, and `Cmd/Ctrl+B` toggles collapse from anywhere except text inputs.
- **Session fast-mode toggle** — each chat session now has a fast-mode switch in the prompt-input toolbar. The preference is persisted per session and passed to the Claude Agent SDK via `Options.fastMode`. It is disabled while the session is streaming or restarting, and the toolbar shows a tooltip when the active provider/model does not support fast mode.
- **Result-focused chat display mode** — a second chat display mode (the default for new sessions) collapses each assistant turn's consecutive thinking + tool-use runs into a minimal one-line "process" indicator that live-updates the latest step and expands into a side drawer showing that region's steps in time order. Text results stay visible inline, and a failed tool surfaces an error marker on the indicator. A header toggle switches back to the linear view; the preference is global and persisted. Scoped to the primary (non-bot) chat panel.
- **Process region duration in result-focused mode** — collapsed process-region ghosts now show the cumulative elapsed time between the step count and the latest step name. The duration refreshes every second while the region is streaming and freezes on completion, using source message timestamps so multi-message turns are measured correctly; it falls back to an em dash when timestamp data is unavailable.
- **Right-side Files & Git Changes panel** — a new collapsible right sidebar hosts the active workspace's Files explorer and Git Changes list. Changed and untracked files are shown in clearly separated sections with icon headers and file counts, and support tree and flat views. Double-clicking a changed or untracked file opens it in a tabbed CodeMirror viewer next to the list. Panel widths and collapsed state persist across app restarts.
- **Unified detail drawer** — process regions, subagents, nested agents, and workflows now share a single right-hand drawer with a navigation stack. Drilling into a subagent or nested agent pushes a new view with a back button to return to the parent, instead of dead-ending or opening conflicting sibling panels. Includes focus management across view swaps, accessible back/close buttons, and an aria-live announcement on navigation.

### Changed

- **Files and Git Changes unified on the right** — the Files explorer has moved from the left sidebar into a shared right-side panel with Git Changes. Files and diffs now open as tabs in a single CodeMirror 6 content area (unified and side-by-side diff modes, Markdown preview, binary/deleted file handling), replacing the previous left `FilePanel` and the intermediate `GitDiffPanel`. The list sidebar and content panel are coupled to the same collapse state, and both the outer panel and the list sidebar are resizable.
- **User prompt messages are more prominent** — user message bubbles in the chat message list now use an accent-tinted background (`bg-accent/10` light, `bg-accent/15` dark) with a subtle accent border instead of the near-background neutral gray, making it much easier to spot your own prompts when scanning a long conversation full of tool cards.
- **Process region drawer now stays in sync and starts collapsed** — opening a process region in result-focused mode previously showed tool cards fully expanded and could lag behind streaming updates. The drawer now subscribes to live message updates as the turn streams, and each tool card inside the drawer starts collapsed (header + "Show details" toggle) so the overall flow is easier to scan. Thinking cards remain collapsed as before, and the normal linear chat view still expands tool cards by default.
- **Prompt-input controls unified** — the provider selector, approval-mode toggle, and fast-mode toggle in the prompt-input toolbar are now borderless and background-less, with state indicated only by text color and a shared hover surface. This gives the right-hand control group a consistent, flatter visual style.
- **Send/stop button styling** — the prompt-input send and stop buttons are now smaller (`p-1.5`, `w-4 h-4` icon) and share the same rounded shape. The send button uses a soft accent style (`bg-accent/15`, `border-accent/20`, `text-accent`) instead of the previous plain icon, while the stop button keeps its destructive style at the reduced size.
- **App settings are now reactive** — `useAppSettings` was converted from per-component state to a shared reactive store, so changing a preference (display mode, font size, etc.) now updates every open view immediately instead of requiring a reload.
- **Tooltip styling** — tooltips now use a neutral surface background with a subtle border and shadow instead of the primary accent color, and the rotated-square arrow has been removed for a cleaner look. This improves the appearance of tooltips on the collapsed sidebar icon rail and across the app.
- **Session-list approval-mode badge removed** — the colored auto/readonly badge no longer appears on each session-list row; the current session's approval mode is still shown and controllable via the prompt-input toggle.

### Fixed

- **Result-focused mode no longer re-renders the whole message list on each streaming update** — `mergeAssistantTurns` rebuilt every merged assistant turn as a brand-new object on every render, which defeated the adapter's `WeakMap` cache and `ChatMessageRenderer`'s `React.memo`. Each streaming delta (text/thinking/tool) therefore re-rendered the entire list of merged turns instead of just the one turn that was actively streaming, causing visible flicker and, under the re-render storm, occasional user messages appearing to drop out. Merged turns are now reused whenever their source messages are referentially unchanged (a `WeakMap` keyed by the turn's first source message, so it is reclaimed on prune/session switch), so only the streaming turn re-renders.
- **Virtualized message list stays pinned to bottom during streaming in result mode** — `VirtualizedMessageList` only auto-scrolled when `messages.length` increased, so streaming text/thinking deltas that grew the merged last turn in place (common in result-focused display mode) left the panel lagging behind the new bottom. A new layout effect now detects scroll-height growth while the user is at the bottom and pins the view to the latest content, while ignoring prepend (older-message fetch) cases so the anchored position is preserved.
- **Interrupted turns now show a notice in the message list** — the `interrupted` event only cleared the streaming state and appended no message, so a stopped turn was invisible in the message list. This was especially pronounced in result-focused display mode, where the partial assistant content collapses into a compact process ghost with no final-result block, leaving no sign the turn was cut off. The handler now appends an "Interrupted by user" system message (with a timestamp via the existing Interrupt rendering path) while preserving the background-task streaming gate.

### Security

- **Dependency vulnerability remediation** — bumped `adm-zip` to `^0.6.0` (CVE-2026-39244: crafted ZIP triggering a 4GB memory allocation) and `serde_with` to `3.21.0` (KeyValueMap serialization panic on empty sequences), and removed an orphaned `esbuild` entry from the wecom-cli lockfile (Windows dev-server arbitrary file read). `npm audit` now reports 0 vulnerabilities for both the root and `packages/wecom-cli`. A remaining `glib` 0.18.x advisory (unsound `VariantStrIter` impl) is constrained by the pinned Tauri/GTK stack and is deferred to a Tauri upgrade.

## [0.0.24] - 2026-07-14

### Fixed

- **Bot channel secret fields reset while editing** — the WeCom/Feishu channel cards on the Bot Channels settings page were defined as components inside `BotChannelsSection`, so every parent re-render remounted the whole card subtree: revealed secrets flipped back to masked within one 5-second status-poll tick, and every input in the card lost focus on each keystroke. Clearing a secret field also visually restored the previous value, because `SecretInput` fell back to the auto-fetched original credential whenever the draft was empty. The cards are now module-level components, `fetchStatus` skips the store write (and the resulting full-page re-render) when the polled status is unchanged, and `SecretInput` shows the draft value verbatim once the user has edited the field.

- **TaskPanel progress stuck below 100% when tasks fail** — failed and killed tasks are terminal but were excluded from the progress counter, so a fully-finished run with one failure showed 14/15 with an incomplete progress bar. All terminal statuses now count toward progress, and a destructive failed-count badge keeps failures visible.

### Changed

- **Claude Agent SDK upgraded to 0.3.207** — bumped `@anthropic-ai/claude-agent-sdk` from the previous pinned version to 0.3.207.

## [0.0.23] - 2026-07-13

### Fixed

- **Windows: analytics/statistics always empty** — the project-directory encoding used to locate Claude Code transcripts only replaced path separators and the drive-letter colon, while Claude Code replaces EVERY non-alphanumeric character with `-` and encodes the realpath-resolved path. On Windows, where user profiles and repo paths routinely contain dots, spaces, underscores, or CJK characters, the resolved transcript directory never existed, so every session was silently skipped and the global/workspace summaries returned all zeros. The encoding now mirrors the SDK exactly (all non-alphanumerics → `-`, realpath canonicalization, 200-char truncation with a base36 hash suffix), and the projects root honors `CLAUDE_CONFIG_DIR` with the SDK's NFC normalization (an empty value is treated as unset). This completes an earlier fix that added only the drive-letter colon to the encoding.

- **Windows: all Tauri IPC blocked by Content Security Policy** — added `http://ipc.localhost` to the `connect-src` directive in `src-tauri/tauri.conf.json`. On Windows, WebView2 cannot register truly custom protocol schemes, so Tauri v2 aliases the `ipc://localhost` scheme used for `invoke()` calls to `http://ipc.localhost`. The CSP only allowed the macOS/Linux form (`ipc://localhost`), so every Tauri command (starting with `get_api_port`, which the client needs to learn the sidecar API port) failed with a CSP violation, leaving the app unable to reach the backend on Windows.

## [0.0.22] - 2026-07-13

### Added

- **Marketing website** — added a bilingual (Chinese/English) static marketing site under `website/` built with Astro 7 and Tailwind CSS 4. It includes Home, Features, Usage, Download, About, and FAQ pages, light/dark theme support, and a GitHub Pages deployment workflow at `.github/workflows/deploy-website.yml`.

### Fixed

- **Session stays active while background tasks run** — a session no longer drops its active state the moment the foreground turn's `result` arrives while an async sub-agent or background Bash command it launched is still running. The server now tracks confirmed background tasks (confirmed via `async_launched` tool results, Bash `backgroundTaskId`, or `is_backgrounded` patches — never a bare `task_started`, and never `skip_transcript` housekeeping tasks) and folds them into the processing state that drives the session-list spinner, the open chat's generating state, the status poll, and the idle reaper, so a runtime is no longer reclaimed — killing its still-running tasks — while background work continues. A new `session_processing` event carries the server's verdict to the client, which keeps the generating state until the last task settles; visuals are unchanged.

- **Stop button is a one-click clear-all** — clicking stop now interrupts the in-flight turn and stops every running background task via the SDK stop API in one action; stopped tasks clear the active state through the normal terminal path. The confirmation popover names the background tasks it will stop ("Stop generating and N background tasks?"), and clicking a stale stop no longer spawns a fresh Claude process. WeCom/Feishu bot `/stop` stays turn-scoped and now truthfully replies 当前没有正在进行的对话。 on background-only sessions instead of reporting a turn interrupted while tasks keep running.

- **WeCom bots deliver every result from a single run** — when one WeCom-triggered run produces more than one main-agent result, the first result finishes the streaming reply bubble as before and each later result now arrives as a proactive follow-up message containing only its new content. Previously, results after the first were silently dropped once the bubble finished, so sub-agent follow-ups and retried turns never reached the user. Approval/question cards raised in later turns are now delivered too, and the 9-minute "still working" notice is unchanged.

- **Bot role lookup matches either channel id** — `BotService.getMemberRole` now resolves a member by either their encrypted channel user id or their resolved plaintext user id. Previously, querying by plaintext id against a member stored under the encrypted channel id returned `null`, so Owner/Admin users were treated as Normal and denied workspace writes with `outside-user-dir-write`.

- **Bot role changes now apply immediately to file-path checks** — when a WeCom/Feishu user's bot role is promoted to Owner or Admin, file Write/Edit/Read/Glob/Grep calls in an already-running session are now evaluated against the current role instead of the role snapshot taken when the runtime started. This fixes `outside-user-dir-write` denials for users who had already been granted Owner/Admin rights.

- **Message panel double scrollbar** — the `Conversation` wrapper no longer sets `overflow-y-auto`; only the inner `StickToBottom.Content` scroll container is used. This removes the duplicate scrollbar that appeared in the message panel when the non-virtualized message list was active.

- **WeCom card answers no longer read backward** — when a WeCom bot asks a question or requests tool permission via a template card, the resolved answer/outcome is now folded into the same streaming reply bubble (above the agent's continuation) the moment the card is tapped, and the card flips to a compact terminal receipt. Previously the agent's continuation kept streaming above the card, so the answer appeared above the question it answered — and past the 9-minute safeguard it arrived as a separate later message. Question folds show the question and chosen label(s); permission folds show only the tool name and outcome (`已允许` / `已拒绝` / `已始终允许`), never the command, file path, or diff.

## [0.0.21] - 2026-07-09

### Added

- **Message timestamps** — chat messages now display a timestamp below the message content: `HH:mm` for messages sent today and `YYYY-MM-DD HH:mm` for older messages. Timestamps appear for user messages, assistant final-text replies, stdout/stderr meta messages, and Interrupt system messages. They remain hidden on thinking, tool_use, subagent, api_retry, system-reminder, and generic system messages to reduce whitespace between messages. Timestamps are revealed on hover and use the existing `ChatMessage.timestamp` field.

- **Bot member plaintext management** — bot member rows now show the channel user ID alongside its resolved plaintext user ID (and Feishu display name when available). Members with an unresolved plaintext ID are marked as "Pending" and can be resolved in bulk via a "Resolve pending" button, or manually by typing a fallback plaintext ID inline. A dedicated "Refresh" button reloads only the member list. WeCom and Feishu message handlers now automatically add first-time messengers as `normal` bot members, while preserving existing `owner`/`admin` roles. English and Simplified Chinese i18n keys added.

- **WebSocket sidecar spike (GUI traffic)** — added a WebSocket server on `/ws` alongside the existing Express HTTP sidecar. GUI sessions now subscribe to runtime events, poll `/status`, send messages, and load messages over a single multiplexed WebSocket connection instead of multiple HTTP/1.1 fetches/SSE streams, avoiding the browser ~6-connection-per-domain limit. HTTP routes for static files, WeCom/Feishu webhooks, health checks, and the old chat endpoints remain in place as a fallback. Set `localStorage.setItem('comate-force-http', '1')` to force the GUI back to HTTP without a code change. Server-side bot delivery and HTTP push remain unchanged.

- **Bot list name filter** — the Bot Management page now has a search box at the top of the left bot list. Press Enter to filter bots by name with fuzzy, order-preserving matching; a clear button and match count appear while a filter is active. If the selected bot is filtered out, the selection moves to the first visible match. When the selected bot has unsaved changes, a Save/Discard dialog appears (no Keep Editing option, since the bot is no longer visible in the list). English and Simplified Chinese i18n keys added.

- **Bot channel connection status** — the Bot Management Channels section now shows per-channel status for WeCom and Feishu (`connected`, `connecting`, `disconnected`, `error`, or `not_configured`) with a colored dot, localized label, and sanitized error message. Status is polled every 5 seconds while the section is open. The Save button is the single action for credential/toggle-driven connect, reconnect, and disconnect. A dedicated Reconnect button appears only when a channel is `disconnected`, enabled, and its saved credentials are unchanged. The server exposes `GET /api/bots/:id/status` and `POST /api/bots/:id/channels/:channelKey/reconnect` (30-second rate limit per bot/channel), and reconciles connections automatically when channel settings or active workspace change. Connection teardown is guarded by `connectionId` so stale disconnect handlers cannot wipe newer connections. English and Simplified Chinese i18n keys added.

- **Workflow display** — `Workflow` tool invocations now show a clickable status card in the main chat stream, a floating panel that stays visible while scrolling, and a detail view that exposes workflow phases, running/completed subagent counts, and per-subagent conversations via the existing subagent drawer. Workflow subagents are loaded from the SDK transcript directory and keyed with synthetic `workflow:<runId>:<agentId>` identifiers. Server-side support includes `workflow_start`/`workflow_update`/`workflow_done` SSE events and REST endpoints to list/read workflow state. English and Simplified Chinese i18n keys added. (v1 is display-only; cancel/retry/resume/re-invoke are out of scope.)

- **Async subagent message display** — Agent tool invocations that run as async/background subagents now render a clean inline lifecycle card (async-launched → running-in-background → completed/error) instead of dumping raw launch metadata such as "Async agent launched successfully". Completed and error cards intentionally omit inline result/error previews; the full transcript remains available via the existing subagent drawer. The backend no longer emits subagent_done on async-launch metadata, and the chat store can replace an async-placeholder tool_result with the final collected result. New aria-live region and improved Open panel button accessibility. English and Simplified Chinese i18n keys added.

### Fixed

- **TaskPanel internal task filtering** — `TaskCreate` tool calls that include `metadata: { _internal: true }` are now excluded from the TaskPanel task list, matching Claude Code's own `TaskListTool`/`useTasksV2` convention. This prevents subagent internal tracking tasks (for example, "Reading ...", "Running ...", or "... doc review") from appearing as user-visible tasks while still leaving them in the message transcript.

- **Workflow history hydration** — reopening a session now restores completed and still-running workflows from disk into the chat-store workflow slice. `loadMessages`/`loadMessagesAfter` return `workflows` alongside messages/tasks/subagents, workflow subagent IDs are filtered out of the top-level subagent list to avoid "Could not map subagent ... to a parent toolUseId" warnings, and non-terminal workflows resume polling after history load so the floating panel appears for workflows that ran while the session was closed.

- **Workflow floating panel position** — the workflow floating panel now anchors to the top-right of the chat area so it no longer overlaps the prompt input box.

- **TaskPanel and workflow floating panel width decoupling** — when both panels are visible in the top-right of the chat area, expanding the task panel no longer forces the workflow floating panel to stretch to the same width. Each panel now sizes independently based on its own content while sharing the same max-width cap.

- **Workflow detail subagent drawer** — clicking a subagent inside the workflow detail modal now opens its drawer inside the modal rather than in the main message list, and the modal has a fixed height so the drawer conversation can scroll when content is long.

- **Workflow display hardening** — workflow REST endpoints now validate `sessionId`/`runId` and verify session ownership before reading disk, preventing path traversal. Workflow polling on the client uses a single recursive loop per run with fetch timeouts, aborts in-flight requests on restart/switch, stops at terminal states, and ignores stale `workflow_update` events. The current phase title is now derived from progress instead of the last configured phase. Shared `workflowStatusConfig` replaces duplicated status badge config across workflow components, and `pendingWorkflows` entries are cleaned up when the tool result arrives even if the workflow did not launch. Escape-key handling in the workflow detail panel no longer races with the subagent drawer.

### Changed

- **Kimi repeated-tool-call guard** — replaced the model-agnostic dead-loop detection feature with a Kimi/Moonshot-specific guard in the main agent. The new detector tracks identical tool calls across all tools within a user turn and denies repeats with guidance when the provider is detected as Kimi/Moonshot (by model prefix or base URL). This removes workspace-level dead-loop settings, the Read-only cache, and the subagent loop poller.

- **Bot member management** — removed the manual "Add member" form from the Bot Management members tab. Members are now added only through bot creation (initial channel owner) or automatic WeCom/Feishu first-message enrollment. Role editing, member removal, resolve-pending, plaintext fallback, and refresh remain available. Removed the now-unused `onAddMember` prop and related `en`/`zh-CN` i18n keys.

- **Deferred runtime rebuild on config changes** — changes to bot role policy, persona, role personas, or member list; workspace-level legacy bot permissions (`wecomToolPermissions`, `wecomBotIsolation`, `sensitiveFileDenylist`); and provider settings (`providerId`, `baseUrl`, `authToken`, `model`, default/subagent models, `effortLevel`, `customEnvVars`) now automatically rebuild affected cached runtimes. If a runtime is actively processing a turn or waiting on a pending approval/question, the rebuild waits until the turn ends, then closes the old runtime and pre-creates a replacement so the next user prompt picks up the new configuration without manual intervention. Multiple rapid changes to the same runtime are coalesced into a single rebuild.

- **Picker popovers follow the input-card width** — the skill, file, and history pickers in the normal-session `PromptInput` now open at the same width as the input-card container and resize with it. The popovers are left-aligned to the input card; when `contentWidth` is not provided (e.g., outside `PromptInput`) they keep the previous fixed `360px` width.

- **Settings footer refactor** — removed the global Save/Cancel footer from the Settings panel. The General, Workspace, and Bot Management tabs now show their own local, always-visible Save/Cancel footers fixed at the bottom; the buttons are disabled when there are no unsaved changes. In Bot Management, the page-level footer now commits or discards Basic config, Role permissions, and Persona together, and the inline Save/Cancel controls have been removed from the Roles and Persona sections. Appearance remains auto-save; Provider keeps its existing per-section controls. The close-guard unsaved-changes dialog is now a shared `UnsavedChangesDialog` component, and switching workspaces or bots inside the respective tabs is also guarded when there are unsaved changes.

- **Bot channel ownership model** — the bot "Provider" concept has been renamed to "Channel" across TypeScript models, the Express API, SQLite storage, and the React UI. Bot ownership is now scoped per channel: each enabled WeCom/Feishu channel has exactly one owner, channel owners can manage members of their own channel and switch the bot's active workspace, but they cannot update/delete the bot or manage other channels. The GUI bypasses ownership checks via the system actor. Existing databases are migrated automatically; promoting owners in already-migrated databases is left to the GUI. English and Simplified Chinese i18n keys added.

### Refactored

- **TaskPanel floating refactor** — `TaskPanel` now anchors as a floating card in the top-right of the chat message area, stacked vertically with the `WorkflowFloatingPanel` so the two panels no longer overlap the prompt input. `TodoWrite` items are filtered out of the session task list and continue to render as normal tool cards in the message stream; only `TaskCreate`/`TaskUpdate` tool events populate the panel. Task rows support long-title wrapping and the expanded list scrolls internally. English and Simplified Chinese i18n keys added.

- **Unified bot/workspace/session/member/role schema** — replaced legacy WeCom- and Feishu-specific tables (`wecom_user_sessions`, `feishu_user_sessions`, `wecom_user_id_mappings`, `wecom_workspace_users`, `feishu_workspace_users`, `feishu_active_sessions`, `feishu_bot_binding`, `bot_members`) with unified `bot_channels`, `bot_roles`, `bot_users`, and `user_sessions` tables. Bot channel settings, role policies, and role personas now live on their respective rows; the `Bot` model carries only default persona and active workspace. TypeScript types were renamed (`BotChannel` → `BotChannelKey`, `BotRole` → `BotRoleKey`, `BotMember` → `BotUser`) and API/client payloads now use `channelKey`/`roleKey`. Existing databases are migrated automatically on first start. Historical `bot_audit_logs` rows prior to the migration are discarded and are not backfilled or normalized; only audit logs written after the migration use the new event terminology. The app now shows a one-time notice on first launch after the migration when historical audit logs were cleared.

### Fixed

- **GUI session resume after server-side idle runtime close** — when a GUI session's runtime was closed by the server idle timeout while the WebSocket stayed connected (e.g. overnight), the client now receives a `runtime_closed` event, tears down the stale subscription, and clears the per-session server nonce. The next `sendMessage` then re-subscribes to a fresh runtime instead of posting to a runtime with no WebSocket handler. Previously the UI showed only the user prompt and a spinner because SSE events were emitted but not forwarded to the GUI.

- **Multi-workspace session re-subscribe** — switching back to a workspace whose session had been in the background now re-creates the WebSocket subscription. A deduplication guard was keeping the active session id but never checking whether the subscription itself was still alive, so after switching workspaces the previous session stayed unsubscribed and its messages appeared stale.

- **WebSocket reconnect replay** — GUI sessions now record the last processed SSE event id and request replay from that point when the WebSocket reconnects. Previously the `lastEventId` cursor was read once at subscription time but never updated as events arrived, so a disconnect during an active turn caused missed SSE events. The UI stayed in the streaming state but showed no new messages until the app was restarted and persisted messages were loaded.

- **Bot member plaintext editing** — the plaintext user ID input no longer appears by default for every pending member. Instead, members without a plaintext ID show a clickable placeholder, and members with a plaintext ID show the resolved value; clicking either opens an inline editor that saves on Enter or blur and cancels on Escape or an empty blur. The pending/resolved status badge continues to reflect the actual resolution state.

- **GUI session subscribe timeout** — increased the WebSocket `subscribe` timeout from 5s to 30s (`DEFAULT_TIMEOUT`) so that cold-start runtime creation (which includes `getSessionInfo`, building SDK options, and testing the Claude binary) no longer causes the GUI to show `Connection error: WebSocket request timeout: subscribe`. Bot sessions were unaffected because they do not use the GUI's WebSocket subscribe path. Added server-side diagnostic logs around `getOrCreateRuntime` and the WebSocket subscribe handler so future slow-start issues can be traced stage-by-stage.

- **Session subscribe hangs and duplicate subscriptions** — `setActiveSession` now short-circuits when the target session is already active, preventing the App-level effect from re-subscribing twice for the same click. The server-side `getSessionInfo` verification step in `getOrCreateRuntime` now has a 10s timeout and returns a clear `SESSION_VERIFY_FAILED` error instead of leaving the WebSocket `subscribe` request hanging forever. Additional runtime-creation logs (`[ChatService] calling SessionRuntime.open`, `[Runtime] SessionRuntime.open called`) make it obvious whether runtime creation started.

- **GUI sessions missing assistant output after WebSocket disconnect** — the client now clears the per-session subscription nonce when the WebSocket disconnects and whenever a new subscribe request starts. Previously a stale `serverNonce` let `sendMessage` post to a runtime that had no WebSocket handler registered, so the server produced SSE events but the GUI only showed the user prompt and a spinner. A race in `subscribeToSession` that could spawn duplicate subscriptions was also closed by recording the subscription before the async request begins. On the server, fresh WebSocket subscriptions without a `lastEventId` now replay the in-flight `assistant_start` event inclusively so the client creates the assistant message instead of silently dropping deltas.

- **Release build WebSocket CSP** — added `ws://localhost:*`, `wss://localhost:*`, and `ipc://localhost` to the Tauri `connect-src` Content Security Policy. In release builds the webview previously blocked connections to the sidecar WebSocket (`ws://localhost:<port>/ws`) and the Tauri IPC fallback (`ipc://localhost/get_api_port`), so GUI sessions could not subscribe or start a runtime even though the binary was present. Dev mode worked because the development CSP/webview defaults allowed localhost WebSocket traffic.

## [0.0.20] - 2026-07-04

### Added

- **Per-role Bot personas** — bots now have a Default persona plus optional Owner, Admin, and Normal role personas, each with its own append/replace mode. When a role-specific persona is unset, the Bot falls back to the Default persona; users without a member record are treated as Normal. Personas are stored on the Bot record (`persona_json` for Default and `role_personas_json` for role overrides), edited through a redesigned **Persona** tab in Bot Management with role sub-tabs and a single page-level Save, and translated into the SDK `Options.systemPrompt` field at runtime. Active Bot runtimes are closed when persona, member role, or role-permission policy changes, so the next user turn recreates the runtime with the updated persona. English and Simplified Chinese i18n keys added.

### Changed

- **Bot Persona editor** — the persona editor now has Default, Owner, Admin, and Normal sub-tabs, a shared Save/Cancel bar, per-tab descriptions and fallback hints, and over-budget indicators in the tab list. The save button is enabled only when any tab differs from the last saved state.

### Fixed

- **WeCom `/stop` feedback reliability** — the WeCom bot now sends a proactive `已中断` confirmation after successfully interrupting an in-flight turn, even when an active stream reply exists. Previously, the command relied solely on the stream reply's final frame; if that frame was bound to a stale connection or silently dropped by WeCom, users saw the turn stop but received no feedback message.

- **Auto-install wecom plugin for WeCom-enabled workspaces** — creating or updating a bot with WeCom enabled, switching a bot's active workspace, or running the workspace-to-bot migration now automatically installs the built-in `wecom` Claude Code plugin in the workspace's project scope if it is not already installed in user, project, or local scope. This restores the previous behavior where WeCom workspaces received the necessary skill automatically.
## [0.0.19] - 2026-06-29

### Added

- **Bot `/status` command for Feishu and WeCom** — users can now send `/status` in a Feishu DM or WeCom chat to see the current Comate workspace name and their own active session name. The reply is a single plain-text message in Chinese. If no workspace is bound or no active session exists, the bot replies with a plain-language message instead of empty values or internal IDs. The command requires no special permissions and is implemented independently in `src/server/services/feishu-bot-service.ts` and `src/server/services/wecom-bot-service.ts` with matching response shapes.

- **Bot audit logging and security hardening** — bot security events are now written to a dedicated `bot_audit_logs` table via `src/server/services/bot-audit-logger.ts`. Audited events include provider credential changes, provider enable/disable, active-workspace switches, member additions/removals, member role changes, and file-access denials. Details are sanitized before persistence so long values (likely secrets or ciphertext) are replaced with `<redacted>`. Decryption failures in `src/server/utils/credential-crypto.ts` log only the ciphertext length and error message, never the ciphertext itself.

- **Bot integration test coverage** — expanded server tests verify end-to-end bot/workspace behavior: migration dry-run and rollback, active-workspace switching through the WeCom/Feishu chat apps and the REST API, dynamic role changes during in-flight sessions, workspace denylist enforcement, and audit-log emission for security events.

- **GUI Bot Management page** — Settings now has a **Bots** tab with a dedicated bot-management surface. It lists bots, shows active workspace and provider status, lets admins create/edit bots with WeCom/Feishu credentials, switch a bot's active workspace, manage per-bot members and roles, and run the workspace-to-bot migration. New components: `src/client/components/BotManagementPage.tsx`, `BotForm.tsx`, `BotMemberList.tsx`; state is managed by `src/client/stores/bot-store.ts`. i18n keys added for English and Simplified Chinese.

- **Bot role permission editor** — bot role permissions now live on a dedicated **Roles** view reachable from each bot in Bot Management, instead of inside the bot credential form. The view has tabs for `Owner`, `Admin`, and `Normal`: Owner/Admin are shown as unrestricted, and the Normal tab reuses `PermissionsSubTab` for tool policy plus textarea editors for Skill and Bash allowlists. New component: `src/client/components/BotRolePermissions.tsx`; `BotForm.tsx` no longer collects role policy. i18n keys added for English and Simplified Chinese.

- **Bot management REST API** — new `src/server/routes/bots.ts` exposes `GET /api/bots`, `POST /api/bots`, `GET/PUT/DELETE /api/bots/:id`, `POST /api/bots/:id/active-workspace`, member routes, `GET /api/bots/:id/status`, and `POST /api/bots/migrate`. Provider credentials are redacted in responses (sensitive fields appear as `true` when set). Workspace-bound bots can be retrieved via `GET /api/workspaces/:id/bot`.

### Changed

- **Workspace settings no longer drive bot connections** — `PUT /api/workspaces/:id` no longer connects or disconnects WeCom/Feishu bots based on workspace settings, and the safe tool-permission preset auto-apply has been removed. Bot lifecycle is now managed entirely through the bot management API.

- **Unified Select component for bot configuration dropdowns** — the bot management surface (`BotManagementPage`, `BotForm`, and `BotMemberList`) now uses a shared `src/client/components/ui/select.tsx` primitive built on `@radix-ui/react-select`. All workspace-switcher, provider, and role dropdowns render with consistent trigger and menu styling instead of native `<select>` elements.

### Fixed

- **Bot management page padding matches other settings tabs** — `BotManagementPage` now wraps its list, form, and member views in `p-6 max-w-xl` so the content inset matches `GeneralTab` and `AppearanceTab` instead of touching the panel edges.

- **Workspace tabs and switcher show bot status again** — after the bot-workspace decoupling migration removed `wecomBotEnabled`/`feishuBotEnabled` from workspace settings, the `useBotStatuses` hook stopped polling status endpoints and the bot connection icons disappeared from `WorkspaceTabs` and `WorkspaceSwitcher`. The hook now polls every candidate workspace and omits `not_configured` statuses, so icons appear only for workspaces with a bound bot.

### Security

- **Dependency security upgrade** — upgraded npm dependencies flagged by `npm audit` and added `overrides` to patch transitive vulnerabilities. Direct upgrades: `dompurify` ^3.4.11, `uuid` ^11.1.1, `ws` ^8.21.0, `esbuild` ^0.28.1, `playwright` ^1.55.1, `vite` ^6.4.3, `@vitejs/plugin-react` ^5.0.4, and `@vitest/browser-playwright` ^4.1.9. Transitive overrides: `@babel/core` ^7.29.6, `axios` ^1.18.1, `form-data` ^4.0.6, `hono` ^4.12.25, `js-yaml` ^4.1.2, `qs` ^6.15.3, `shell-quote` ^1.8.4, `tar` ^7.5.16, and `uuid` ^11.1.1. Vitest workspace configuration was migrated to the Vitest 4 `test.projects` format (`vitest.jsdom.config.ts` and `vitest.browser.config.ts`). `npm audit` now reports zero vulnerabilities. Test mocks were updated for Vitest 4 / browser-mode compatibility.

### Residual risk

`@larksuiteoapi/node-sdk` declares `axios: ~1.13.3`; the `axios` override forces it to 1.18.1 to satisfy `npm audit`. This is outside the package's declared semver range. Automated tests, the production build, and the full Tauri release build all pass, but runtime behavior of the Lark/Feishu SDK should be monitored in staging.

## [0.0.18] - 2026-06-27

### Added

- **Feishu bot `/stop` command** — Feishu bot users can now interrupt an in-flight AI turn by sending `/stop` as a text command or by configuring a bot menu with the `/stop` event key. The command cancels any pending tool approval or `AskUserQuestion` for that turn, resolves them as denied, and appends `已中断` to the ongoing streaming card reply when one is active. If no stream reply is active but a turn is still running, it sends `已中断` as a standalone message. It only affects the sender's own active Feishu session and never creates a new session. Errors during interrupt handling are caught and replied to with a fallback message.

### Changed

- **Feishu interactive cards migrated to Cards v2** — all legacy Feishu interactive cards (workspace list, session switcher, tool approval, and question cards) now use Feishu Cards v2. The session-switcher card is now a compact form with a dropdown and a "确认切换" button; the previous per-session button list and the "新建会话" button have been removed. Session creation remains available via `/new`, `/clear`, and the bot menu. After a successful session switch, the original card is updated to a read-only confirmation. The streaming answer card is unchanged.

### Fixed

- **Feishu session-switcher disabled state now persists** — after confirming a session switch, the original session-list form is replaced via CardKit `cardkit.v1.cardElement.update` with a disabled version of the same form instead of using `im.message.patch` or patching child controls independently. The dropdown's `initial_index` now uses Feishu's 1-based indexing, so the active session remains selected while the controls stay non-interactive.

## [0.0.17] - 2026-06-27

### Added

- **WeCom bot `/stop` command** — WeCom bot users can now interrupt an in-flight AI turn by sending `/stop`. The command cancels any pending tool approval or `AskUserQuestion` for that turn, resolves them as denied, and appends `已中断` to the ongoing stream reply while it is still within WeCom's passive-reply window. If the 9-minute safeguard has already closed the passive stream, it sends `已中断` as a standalone message instead. It only affects the sender's own active WeCom session and never creates a new session. Errors during interrupt handling are logged and do not crash the bot connection.

- **Notification sounds for pending requests and task completion** — Comate now plays a short sound when Claude needs your response (a tool approval or `AskUserQuestion`) and when Claude finishes a turn and goes idle, so you don't miss these moments after switching away from the app. Two audibly distinct royalty-free clips are bundled: a "needs attention" alert and a gentler "completion" chime. A single **Notification sounds** toggle in Settings → General controls all sounds and is enabled by default. The completion sound only fires for turns longer than ~3 seconds, and rapid successive events coalesce into one sound, so ordinary back-and-forth stays quiet. Playback unlocks on the app's first click to satisfy webview autoplay rules; the dock badge continues to flag requests that were already pending at launch.

### Removed

- **Feishu HTTP callback route** — `POST /api/feishu/card` and the `src/server/routes/feishu-card.ts` handler have been removed. The built-in chat adapter uses WebSocket-only transport, and menu/card-action events are now fully handled on the long-connection path. Feishu bot setups must use long-connection event subscription.

### Fixed

- **Feishu bot menu `/resume`, `/new`, and `/clear` keys** — Feishu bot menu events configured with a leading slash (e.g. `/resume`, `/new`, `/clear`) are now normalized and handled. `/clear` and `/new` both create a new session; `/resume` sends the session-list card. Previously, a menu key of `/resume` was treated as unknown and either silently failed or replied with "未知的菜单操作". Additionally, menu events are now handled on the WebSocket/long-connection path used by the chat adapter, so they work when the Feishu app is configured to use long-connection event subscription. Text commands `/new <title>` and `/clear <title>` are now aliases. Diagnostic logging now records request arrival, the raw menu payload, normalized key, chosen branch, and handling result to make future menu configuration issues easier to trace.

- **Feishu new-session default title** — sessions created from the bot menu (`/new`/`/clear`), the text commands (`/new`/`/clear`), the session-list card's "新建会话" button, and the auto-create-on-first-message path now use the same default title (the user's Feishu open_id). Previously the card button created sessions named "Feishu Session" while the other paths used the user id, so the same user saw inconsistent session names depending on how the session was started. The creation logic is now shared via `createFeishuSessionForUser` to keep the paths identical.

- **WeCom bot `/stop` stream-reply tracking** — the active stream reply is now registered only after the bot event handler is attached to the runtime. Previously, when a session already had a handler from an earlier turn, `getOrCreateRuntime` cleared the old handler before adding the new one, and the old handler's cleanup deleted the new stream-reply entry before it was fully registered. That caused `/stop` to miss the active stream, send a standalone `已中断`, and leave the turn's result without a stream to finalize into. `已中断` is now correctly appended to the current stream reply whenever the passive window is still open.

## [0.0.16] - 2026-06-26

### Added

- **WeCom bot admin permissions** — users listed in `wecomBotIsolation.adminUserIds` now bypass the workspace tool-permission policy, per-user file isolation, the workspace denylist, and skill allowlists inside WeCom bot sessions. Admins can also send files from any workspace folder via the proactive send-file API. The workspace boundary and symlink resolution remain enforced for admins; GUI and Feishu bot sessions are unchanged.

### Changed

- **Active bot session icon is now visually distinct** — when a workspace has several WeCom/Feishu bot sessions, the currently selected session's bot icon stays full-color while inactive bot icons are desaturated and dimmed, so the active bot session pops by contrast. The active session row also exposes `aria-current` for assistive tech.
- **WeCom/Feishu bot acknowledgment now rotates** — the fixed "收到，正在处理中" / "收到，正在处理..." placeholder shown right after a bot message is replaced with a small built-in pool of friendlier Chinese acknowledgments. A message is chosen at random for each incoming message, and the same pool is shared across WeCom and Feishu.
- **WeCom bot Bash whitelist removed** — the Bash command whitelist in the Isolation tab has been removed. `Bash` calls from bot sessions are now gated only by the tool-permission policy (Permissions tab) and the canonical WeCom user identity check. The whitelist will be redesigned in a later iteration.

### Fixed

- **WeCom bot `/clear` & `/new` session commands** — WeCom users can now start a fresh conversation with `/clear <optional title>` or `/new <optional title>` (aliases). Each creates a new session, marks it the user's current session via an explicit per-user active marker (a new `isActive` column on `wecom_user_sessions`, replacing the old "most-recent by creation time" inference), preserves prior sessions in the history viewer, and replies `新的会话已创建：【<title>】，可继续对话`. A user-supplied title is stored as a protected `customTitle` so the auto-renamer won't overwrite it. The proactive-message path resolves the recipient's current session through the same active marker for consistency. On first launch after this update, the latest existing WeCom session for each user is automatically backfilled as the active session so restarts continue from the existing conversation.

- **WeCom bot "ask" permission and template-card approvals** — workspace admins can set any built-in tool category or override to `ask`, pausing the tool call until the WeCom user approves it. Approvals and `AskUserQuestion` prompts are delivered as native WeChat Work template-card messages with `allow`, `always allow`, and `deny` buttons. `always allow` delegates persistence to the Claude SDK via `updatedPermissions`; Comate does not maintain a separate grant store. Expired or already-resolved cards update to a terminal state when clicked.
- **GUI pending indicator for bot-session approvals** — when a WeCom (or Feishu) bot session is waiting for a user decision, the chat panel shows a non-interactive "Waiting for the bot user to respond in chat..." banner instead of the interactive approval controls.

- **Provider display and switching on bot sessions** — WeCom and Feishu bot sessions now show their active LLM provider in the session header (beside the refresh button) and let the operator switch it in place to recover from a failing provider (quota, rate-limit, or endpoint errors). It reuses the existing per-session provider switch: the change persists and the runtime restarts, so the next inbound bot message runs on the newly selected provider. The provider name collapses to an avatar at narrow widths to keep the header tidy; the approval-mode toggle is intentionally not surfaced for bot sessions.

- **Settings panel now supports the full update flow inline** — after clicking "Check for Updates", the General tab shows the new version, a Download button, download progress, and Install & Restart / Later actions. The main window notification stays in sync as a parallel surface, so users can close Settings and finish installing from the main window.

### Fixed

- **WeCom template-card event parsing for AskUserQuestion submissions** — the SDK emits `template_card_event` nested under `event.template_card_event` with `selected_items.selected_item` / `option_ids.option_id` wrappers. The parser now normalizes that shape, so card submits correctly resolve pending questions and the GUI no longer stays stuck in a running `AskUserQuestion` state.
- **WeCom multi-select AskUserQuestion card type** — single-question multi-select prompts now render as a `vote_interaction` card with `checkbox.mode: 1`, matching WeChat Work's expected multi-select format, instead of the unsupported `multiple_interaction` layout.
- **WeCom bot AskUserQuestion answer shape** — when a user selects options on a template card, the bot now returns `answers` as a `Record<string, string>` keyed by the question text, matching the Anthropic SDK's `AskUserQuestionOutput` shape. Previously it returned a `string[]`, which caused the model to report that the user had not answered the questions.

## [0.0.15] - 2026-06-24

### Added

- **WeCom CLI `doc:smartsheet-export-excel`** — exports every smartsheet in a WeCom document to a single `.xlsx` workbook (one worksheet per smartsheet). Since the smart-document MCP has no native export, the server composes the existing `smartsheet_get_sheet`/`get_fields`/`get_records` APIs (paginating all records), builds the workbook with `exceljs`, and returns the binary bytes via `POST /api/workspaces/:workspaceId/wecom/smartsheet-export`. The CLI writes the bytes to `--output`, prompts before overwriting an existing file (or requires `--force` when non-interactive), and cleans up any partial file it created if the export fails.

### Fixed

- **WeCom smartsheet Excel export hung on large sheets** — exporting a document whose sheets exceed 1000 rows would spin for many minutes and never produce a file. The record pagination incremented an integer `offset`, but the `smartsheet_get_records` API ignores `offset` and paginates by an opaque `cursor` (seeded from each response's `next_cursor`). A full first page kept returning `has_more: true`, so the loop re-fetched page 1 up to its 1000-page cap (~minutes per sheet) and the workbook — written only after every sheet finishes — was never produced. Pagination now uses the cursor and stops as soon as `has_more` is false or no cursor is returned.
- **WeCom smartsheet Excel export produced empty data cells** — exported `.xlsx` files had correct column headers but every data row was blank. The `smartsheet_get_records` API ignores the requested `CELL_VALUE_KEY_TYPE_FIELD_ID` and returns each record's `values` map keyed by **field title**, while the workbook builder looked up cells by field id (`record[field.fieldId]`) — so every lookup missed and every cell rendered empty. The builder now resolves cells by field id first, then falls back to field title.
- **Feishu bot menu produced no feedback** — the menu-event guard rejected events with HTTP 400 when the workspace had no `feishuEncryptKey` configured, a common (token-only) setup where card actions already worked via the SDK's empty-key verification bypass. The guard now requires only `feishuAppId`/`feishuAppSecret` (needed to build the reply DM client), matching the rest of the endpoint. Diagnostic logging was also added across the menu flow: event type on receipt, guard pass/reject, handler dispatch, and the service-side decision and DM-send result.

## [0.0.14] - 2026-06-24

### Added

- **Manual WeCom user ID mapping** — admins can now manually enter a plaintext enterprise `userId` for an existing WeCom user directly from the workspace settings, instead of waiting for the automatic resolver. The user list displays each user's encrypted `openuserid` alongside the plaintext ID, supports inline editing with explicit Save/Cancel, and includes Reload and "Resolve pending now" buttons to refresh the list or trigger an immediate batch resolution for the workspace. Duplicate plaintext IDs are rejected within the same workspace, and auto-resolution may still overwrite manual entries later.

- **Feishu bot menu commands** — the Feishu callback route now handles `application.bot.menu_v6` events. Clicking a bot menu with `event_key` `session` sends the same session-list card as `/session`, and `new` creates a new session and notifies the user, exactly like typing the command. Menu events are signature-verified through the existing callback, reject workspaces missing Feishu app credentials, and build a per-callback `lark.Client` so the correct workspace's credentials are used regardless of the service's singleton connection.

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

[0.0.20]: https://github.com/ai-dvps/comate/releases/tag/v0.0.20
[0.0.19]: https://github.com/ai-dvps/comate/releases/tag/v0.0.19
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
