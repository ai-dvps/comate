# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bot list name filter** — the Bot Management page now has a search box at the top of the left bot list. Press Enter to filter bots by name with fuzzy, order-preserving matching; a clear button and match count appear while a filter is active. If the selected bot is filtered out, the selection moves to the first visible match. When the selected bot has unsaved changes, a Save/Discard dialog appears (no Keep Editing option, since the bot is no longer visible in the list). English and Simplified Chinese i18n keys added.

- **Dead-loop detection** — server-side detection and silent intervention for two common runaway patterns. Main-agent `Read` loops on unchanged files are blocked after a configurable threshold and return the cached file content as the tool result, with a warning injected before the block. Subagent tight tool-call loops are detected by polling subagent transcripts; when a loop is found, guidance is injected into the main session prompting the model to stop the subagent, and the query is interrupted if the loop persists past the configured timeout. Thresholds, poll intervals, and timeouts are configurable per workspace via `WorkspaceSettings.deadLoopDetection` with global defaults; detection is enabled by default and emits no user-facing notifications.

### Changed

- **Deferred runtime rebuild on config changes** — changes to bot role policy, persona, role personas, or member list; workspace-level legacy bot permissions (`wecomToolPermissions`, `wecomBotIsolation`, `sensitiveFileDenylist`); and provider settings (`providerId`, `baseUrl`, `authToken`, `model`, default/subagent models, `effortLevel`, `customEnvVars`) now automatically rebuild affected cached runtimes. If a runtime is actively processing a turn or waiting on a pending approval/question, the rebuild waits until the turn ends, then closes the old runtime and pre-creates a replacement so the next user prompt picks up the new configuration without manual intervention. Multiple rapid changes to the same runtime are coalesced into a single rebuild.

- **Picker popovers follow the input-card width** — the skill, file, and history pickers in the normal-session `PromptInput` now open at the same width as the input-card container and resize with it. The popovers are left-aligned to the input card; when `contentWidth` is not provided (e.g., outside `PromptInput`) they keep the previous fixed `360px` width.

- **Bot channel ownership model** — the bot "Provider" concept has been renamed to "Channel" across TypeScript models, the Express API, SQLite storage, and the React UI. Bot ownership is now scoped per channel: each enabled WeCom/Feishu channel has exactly one owner, channel owners can manage members of their own channel and switch the bot's active workspace, but they cannot update/delete the bot or manage other channels. The GUI bypasses ownership checks via the system actor. Existing databases are migrated automatically; promoting owners in already-migrated databases is left to the GUI. English and Simplified Chinese i18n keys added.

## [0.0.20] - 2026-06-30

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
