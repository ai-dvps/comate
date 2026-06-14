---
title: "feat: Configurable Tool Permissions for WeCom Bot"
type: feat
date: 2026-06-14
topic: wecom-bot-tool-permissions
---

## Summary

Add a configurable two-tier permission system for WeCom bot sessions, exposed as a new sub-tab in the existing WeCom bot settings. Each workspace picks category-level defaults plus per-tool overrides. New workspaces start on a safe preset; existing bot-enabled deployments are grandfathered to today's allow-all behavior with a one-time prompt to switch.

## Problem Frame

Today, every tool call from a WeCom bot session is unconditionally allowed by the hardcoded `canUseTool` branch in `src/server/services/chat-service.ts:789–794`. There is no per-tool logic, no allowlist, no denylist. The tool name is literally ignored.

This becomes a problem when an external party — a customer, prospect, or auditor — asks what the bot can and cannot do. The honest answer today is "everything the Claude Agent SDK exposes, with no policy gate." That answer is itself an audit finding for organizations that need least-privilege guarantees on automated agents handling inbound messages.

The work proposed here replaces the hardcoded allow-all with an explicit, reviewable policy surface. The current behavior is preserved as one of several selectable postures, so existing deployments do not break on upgrade.

## Key Decisions

- **Two-tier model: categories + overrides.** A flat per-tool list is too long once MCP and dynamic tools are counted; pure preset modes are too coarse for audit. Categories give the auditor a small, recognizable surface; overrides handle the "everything in this category except this one tool" case that real policies need.

- **Safe preset default for new workspaces.** New bot-enabled workspaces start with read-only tools and the WeCom reply capability allowed; write, shell, and network tools denied. Existing deployments are grandfathered to allow-all on upgrade and receive a one-time prompt to switch — chosen over deny-by-default (which would break every current bot on upgrade) and allow-all-by-default (which would ship a weak audit posture for new deployments).

- **Built-in Claude SDK tools only.** Permission checks cover the SDK's known tools (`Bash`, `Edit`, `Write`, `Read`, `WebFetch`, `WebSearch`, and the rest of the built-in set). MCP tools and Skills continue to use today's behavior. This is a real audit gap and is called out explicitly in Scope Boundaries — it is the smallest scope that still delivers meaningful audit value.

- **Per-workspace, not global.** Each workspace configures its own permission policy. This matches the existing WeCom settings pattern (each workspace typically maps to one customer or deployment) and preserves the multi-tenant shape auditors expect.

- **"Reply" is a named category member, not a Claude SDK tool.** The WeCom send-message path is not a Claude tool, but it is the most fundamental capability a bot needs. The safe preset enables it explicitly so the bot can always respond, even when every other action is denied.

- **GUI sessions are unaffected.** This permission system applies only to `isBotSession === true` sessions. GUI sessions keep their existing per-call permission flow.

## Requirements

### Permission model

- R1. Each workspace carries a tool-permission policy used only by WeCom bot sessions; GUI sessions are unaffected.
- R2. The policy uses a two-tier model: a category-level default (allow or deny) per category, plus optional per-tool overrides that invert the category default for named tools.
- R3. The set of categories is fixed and named, with the following membership:

  | Category | Built-in tools | Safe preset default |
  |---|---|---|
  | File Read | `Read`, `Glob`, `Grep` | allow |
  | File Write | `Edit`, `Write`, `NotebookEdit` | deny |
  | Shell | `Bash` | deny |
  | Network | `WebFetch`, `WebSearch` | deny |
  | Sub-agents | `Agent`, `TaskOutput`, `TaskStop`, `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList` | deny |
  | Reply | WeCom send-message path (named exception, not an SDK tool) | allow |

  The category list is fixed by this requirement; tools added to the SDK in future versions map to the closest existing category, with a fallback to "uncategorized → deny" if no clear fit exists.
- R4. The permission decision for any Claude SDK built-in tool is determined by: override (if present for that tool) → category default → deny.

### Defaults and migration

- R5. A workspace with no policy configured behaves as today: every tool call from a bot session is allowed. This is the "allow-all" posture.
- R6. When a workspace newly enables the WeCom bot, the safe preset is applied automatically: read-only categories and the Reply capability allowed; write, shell, and network categories denied.
- R7. Workspaces that had the WeCom bot enabled before this feature ships are grandfathered to allow-all on upgrade; the bot continues to function without interruption.
- R8. Grandfathered workspaces receive a one-time prompt in the WeCom settings offering to switch to the safe preset. The prompt does not block bot operation and can be dismissed.

### Permission check behavior

- R9. When a bot session invokes a Claude SDK built-in tool that the policy denies, the call is denied and the bot replies to the user with a short explanation naming the denied capability.
- R10. When a bot session invokes a tool outside the built-in set (MCP tool, Skill), the call follows today's behavior — the permission policy does not gate it.
- R11. The Reply capability (WeCom send-message path) defaults to allowed in the safe preset and can be denied like any other category. Denying every category including Reply silences the bot; the UI warns about this at save time.

### Configuration UI

- R12. A new sub-tab "Permissions" is added to the WeCom bot settings, alongside Connection, Users, and Prompts.
- R13. The Permissions tab shows each category with its default toggle, the list of tools in that category, and per-tool override controls.
- R14. A posture selector exposes named presets (e.g., "Allow all", "Safe", "Custom") as a shorthand for setting category defaults; selecting a preset rewrites the category defaults and preserves existing overrides.
- R15. The currently effective policy is visible in read-only form to any workspace viewer, so an auditor can review it without write access.

### Persistence

- R16. The policy is stored as part of `WorkspaceSettings` (alongside `wecomBotId`, `wecomFilePromptTemplate`, etc.) and travels through the existing PUT `/api/workspaces/:id` save path.
- R17. The storage shape is forward-compatible with adding MCP and Skills coverage later — category membership can grow without breaking stored policies.

## Key Flows

- F1. First-time bot enablement on a new workspace
  - **Trigger:** Admin toggles "Enable WeCom bot" and saves valid credentials.
  - **Actors:** Workspace admin, settings UI, wecom-bot-service, chat-service.
  - **Steps:** Save persists credentials and the safe preset as the workspace's tool-permission policy; bot connects; on the first inbound message the policy is already in effect.
  - **Covered by:** R1, R6, R16.

- F2. Existing bot-enabled workspace upgrades
  - **Trigger:** App version with this feature starts for the first time on a workspace that already has a bot enabled.
  - **Actors:** Migration logic, settings UI, workspace admin.
  - **Steps:** Workspace is detected as pre-feature; policy defaults to allow-all; the WeCom settings show a one-time banner offering the safe preset; admin can accept, dismiss, or hand-edit.
  - **Covered by:** R5, R7, R8.

- F3. Bot session invokes a denied tool
  - **Trigger:** A WeCom user sends a message that causes the Claude session to attempt a tool the policy denies.
  - **Actors:** WeCom user, chat-service, Claude session, WeCom reply path.
  - **Steps:** `canUseTool` evaluates the policy; the call is denied; the bot replies to the user with the denial explanation; the session continues.
  - **Covered by:** R4, R9, R11.

- F4. Admin customizes a preset
  - **Trigger:** Admin opens the Permissions tab and selects a preset, then adjusts a single tool's override.
  - **Actors:** Workspace admin, settings UI.
  - **Steps:** Preset selection rewrites category defaults; the admin flips one tool's override; on save the policy is persisted and takes effect for subsequent bot sessions.
  - **Covered by:** R2, R12, R13, R14, R16.

## Acceptance Examples

- AE1. **Covers R1, R4, R9.** A workspace policy denies the Shell category with no overrides. A WeCom user asks the bot to "list files in the current directory." The bot attempts `Bash`, the call is denied, and the bot replies explaining that shell commands are not allowed.
- AE2. **Covers R2, R4.** A workspace policy allows the File Write category by default, with an override denying `Edit`. The bot's attempt to call `Write` succeeds; its attempt to call `Edit` is denied.
- AE3. **Covers R6.** A fresh workspace enables the WeCom bot for the first time. Without any admin interaction with the Permissions tab, the safe preset is in effect — `Read` succeeds, `Bash` is denied.
- AE4. **Covers R7, R8.** An existing deployment upgrades. The bot continues to work unchanged (allow-all). The WeCom settings show a one-time banner offering the safe preset. The admin dismisses it; the bot continues to operate under allow-all.
- AE5. **Covers R10.** A workspace has an MCP tool registered. The policy denies every category. The bot invokes the MCP tool; the call follows today's behavior and is not gated by the permission policy.
- AE6. **Covers R11.** An admin denies every category including Reply and clicks Save. The UI warns that the bot will be unable to respond to messages. The admin confirms; on the next inbound message, the bot processes the message but cannot reply.
- AE7. **Covers R15.** A workspace viewer without edit rights opens the WeCom settings. The Permissions tab renders the current policy in read-only form; no toggle is interactive.

## Success Criteria

- An external reviewer can answer "what can this bot do?" by reading a single screen in the WeCom settings, without reading source code.
- The default for new deployments is no wider than the safe preset, so a freshly enabled bot cannot run shell or write files until an admin explicitly widens the policy.
- Every existing deployment continues to function on upgrade with zero configuration changes required.
- The four primary flows (first-enable, upgrade, denied-call, customize) work end to end and are covered by tests.

## Scope Boundaries

### In scope

- Two-tier permission model with category defaults and per-tool overrides.
- Safe preset default for new workspaces; grandfathering with one-time prompt for existing ones.
- New Permissions sub-tab in the WeCom settings.
- Persistence on `WorkspaceSettings` via the existing save path.
- Permission gating for Claude SDK built-in tools on bot sessions only.
- Named presets as shorthand for setting category defaults.
- Read-only policy view for non-admin viewers.

### Deferred for later

- Permission gating for MCP tools. The `canUseTool` callback fires for them, but categorizing dynamic tool inventories requires its own design. This is a real audit gap and should be the next iteration.
- Permission gating for Skills. Same rationale as MCP.
- Audit log of permission changes (who changed what, when). Compliance-adjacent but a separate feature with its own storage and UI surface.
- Per-user or per-role permission policies within a workspace.
- Tool-level command filtering inside a category (e.g., allow `ls` but deny `rm` inside Shell).
- Permission change notifications to admin channels.

### Outside scope

- Changes to the GUI session permission flow.
- Changes to the WeCom connection logic, file handling, or prompt templates.
- Changes to how the Claude Agent SDK is initialized beyond the `canUseTool` branch.

## Dependencies / Assumptions

- The Claude Agent SDK's `canUseTool` callback is the correct and stable hook for permission decisions; the SDK will continue to call it for every tool invocation.
- The set of built-in SDK tools is small and stable enough to fit into a fixed category list without frequent churn.
- The existing per-workspace settings storage and REST path can carry an additional structured field without schema migration beyond adding the field.
- Grandfathering detection can be done reliably — either by a stored "policy version" field or by absence-of-policy combined with bot-enabled-before-cutover. The exact mechanism is settled during planning.

## Outstanding Questions

### Resolve before planning

_None._

### Deferred to planning

- Q2. Exact wording and i18n keys for the denial reply the bot sends when a tool is denied.
- Q3. Whether the grandfathering one-time prompt is a banner inside the Permissions tab, a modal on first visit to the WeCom settings, or a toast with deep-link — UX choice.
- Q4. Whether the read-only policy view for non-admin viewers is a separate route or just disabled controls on the same UI.
- Q5. Whether the posture selector includes only "Allow all / Safe / Custom" or adds named additional presets (e.g., "Read-only", "Reply-only").

## Sources

- Hardcoded permission branch: `src/server/services/chat-service.ts:789–794`.
- `isBotSession` plumbing: `pushMessage` at `src/server/services/chat-service.ts:487`; call site at `src/server/services/wecom-bot-service.ts:190,225,261`.
- Existing WeCom settings UI (template for the new sub-tab): `WeComBotSection` in `src/client/components/SettingsPanel.tsx:1006–1262`, especially the Prompts sub-tab at lines 1241–1259.
- Workspace settings schema to extend: `src/server/models/workspace.ts:1–9`.
- Workspace save path: `handleSave` in `src/client/components/SettingsPanel.tsx:182–236`; server route at `src/server/routes/workspaces.ts:54–77`; SQLite update at `src/server/storage/sqlite-store.ts:494–504`.
- Precedent for adding a configurable bot-specific setting: `docs/brainstorms/2026-06-12-wecom-file-prompt-template-requirements.md`.
