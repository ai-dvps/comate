---
title: "feat: WeCom Bot 'ask' Permission via Template Card Messages"
type: feat
date: 2026-06-24
topic: wecom-bot-ask-permission
---

## Summary

Add a third permission value `ask` to the WeCom bot tool-permission model, alongside `allow` and `deny`. When a bot session hits an `ask` tool, Comate sends an interactive WeChat Work template-card message with `allow`, `always allow`, and `deny` options. The same template-card mechanism is reused for `AskUserQuestion`, so both tool approvals and user questions have a native decision surface inside WeCom. Decisions happen only in the chat app; the GUI shows pending status but does not approve or deny.

---

## Problem Frame

Today's WeCom bot permission model only supports `allow` and `deny`. That forces admins into a binary choice: either a sensitive tool runs unsupervised, or it is blocked entirely. Many real policies need a middle ground where the end user in the chat app decides whether a specific action is acceptable.

At the same time, `AskUserQuestion` has no natural surface in a WeCom conversation. The question is emitted as an SSE event and resolved through the GUI approvals API, so a WeCom-only user has no way to answer. WeChat Work template-card messages are the native, low-friction way to present these decisions directly in chat.

---

## Key Decisions

- **Template cards for both tool approvals and user questions.** A single interactive message pattern covers the new `ask` permission and the existing `AskUserQuestion` path, keeping the WeCom UX consistent.
- **Reuse the SDK's approval mechanism.** The card exposes three options: `allow` (once), `always allow`, and `deny`. `always allow` is delegated to the Claude Agent SDK's own permission handling, which updates `settings.local.json`; Comate does not duplicate that state.
- **Pending approvals live in runtime memory.** They are modeled as `SessionRuntime` pending approvals, aligned with how `AskUserQuestion` already works. This avoids a separate persistent queue but means in-flight asks are lost on server restart.
- **Decisions are WeCom-only.** GUI sessions display a pending indicator so admins can see why a bot session is stalled, but approve/deny actions are not exposed in the GUI.
- **Card events arrive through the existing websocket.** The `@wecom/aibot-node-sdk` connection already receives inbound messages and events; template-card click events are parsed and routed through the same pipeline.
- **Expired or invalid clicks update the card.** When a user clicks a card whose approval no longer exists, the original message is updated to show a terminal state such as "已过期" instead of leaving an active-looking button.

---

## Requirements

### Permission model

R1. `ToolPermissionPolicy` accepts `ask` as a valid value for `categoryDefaults` and for per-tool `overrides`, in addition to `allow` and `deny`.

R2. The permission evaluator returns a decision of `ask` when the resolved category default or override is `ask`.

R3. The permission evaluator continues to return `unknown` for tools outside the built-in SDK set (MCP tools, Skills, future uncategorized tools); those tools follow today's behavior and are not gated by `ask`.

R4. When a bot session invokes a built-in SDK tool and the effective decision is `ask`, the system pauses the tool call and sends a WeCom template-card message requesting approval.

R5. The tool-approval card shows at minimum: the tool category, a brief description of the requested action, and three buttons labeled `allow`, `always allow`, and `deny`.

### Decision handling

R6. Selecting `allow` on a tool-approval card resolves the pending approval with a one-time grant; the current tool call is allowed and the session continues.

R7. Selecting `always allow` delegates to the Claude Agent SDK's permission mechanism, which updates `settings.local.json`; Comate does not maintain a separate persistent grant list.

R8. Selecting `deny` resolves the pending approval with a denial and the bot replies to the user with a generic message that does not name the denied tool or capability.

R9. If the user does not respond before the SDK's approval timeout, the pending approval is denied with the same generic message, and the card is updated to show an expired state.

### AskUserQuestion handling

R10. When a bot session emits a `pending_question` event, the system sends a WeCom template-card message containing the question text and available response options.

R11. For single-choice or boolean `AskUserQuestion`, the card presents selectable options. For free-text questions, the card either provides a text input field or instructs the user to reply directly in the chat; the chosen approach is settled during planning.

R12. The user's response via the card is fed back into the SDK as the `AskUserQuestion` answer, allowing the session to continue.

### Card event routing

R13. Template-card click events are received through the existing WeCom websocket connection used by `@wecom/aibot-node-sdk`.

R14. The event payload is parsed to extract the original `requestId` and the selected action, the matching pending approval is located, and the approval is resolved.

R15. Multiple concurrent pending approvals per session are supported; each card carries a unique `requestId` so clicks resolve the correct approval.

R16. If the matching pending approval no longer exists (expired, session ended, or already resolved), the original card is updated to a terminal state and no session action is taken.

### GUI visibility

R17. For bot sessions with one or more pending approvals, the GUI session view shows a non-interactive indicator that the session is waiting for the WeCom user's decision.

R18. GUI users cannot approve or deny pending WeCom approvals from the GUI.

### Compatibility

R19. Workspaces with an existing `ToolPermissionPolicy` that contains only `allow`/`deny` values continue to behave exactly as before; the storage shape is forward-compatible.

R20. The safe preset and allow-all preset continue to use only `allow`/`deny` defaults; `ask` is opt-in through the workspace settings.

---

## Key Flows

F1. **Tool configured as `ask` is invoked**
- **Trigger:** A WeCom bot session invokes a built-in SDK tool whose policy resolves to `ask`.
- **Actors:** WeCom user, bot session, WeCom bot service, template-card event handler.
- **Steps:** `canUseTool` creates a pending approval and emits an event; a template card is sent to the WeCom user; the user clicks `allow`, `always allow`, or `deny`; the click event resolves the approval; the session continues or replies with a denial.
- **Covered by:** R4–R9, R13–R16.

F2. **User receives `AskUserQuestion`**
- **Trigger:** The bot session emits a `pending_question` event.
- **Actors:** WeCom user, bot session, WeCom bot service.
- **Steps:** The pending question is converted to a template card; the user selects an option or submits text; the response is fed back as the question answer; the session continues.
- **Covered by:** R10–R12.

F3. **User clicks an expired card**
- **Trigger:** A user clicks a template card whose approval has already timed out or been resolved.
- **Actors:** WeCom user, card event handler.
- **Steps:** The handler finds no matching pending approval; the original card is updated to show an expired/terminal state; no session action is taken.
- **Covered by:** R9, R16.

F4. **Admin views a bot session with a pending ask**
- **Trigger:** A GUI user opens a bot session that is waiting for a WeCom user decision.
- **Actors:** GUI user, session runtime.
- **Steps:** The session view renders a pending indicator; the GUI user sees why the session is stalled but cannot approve or deny.
- **Covered by:** R17, R18.

---

## Acceptance Examples

AE1. **Covers R4, R5, R6.** A workspace policy sets the Shell category to `ask`. A WeCom user asks the bot to list files; the bot sends a template card; the user clicks `allow`; the `Bash` call executes and the result is streamed back.

AE2. **Covers R7.** The same Shell `ask` scenario: the user clicks `always allow`; the Claude Agent SDK records the grant in `settings.local.json`; subsequent `Bash` calls in the same session are no longer blocked by the card.

AE3. **Covers R8.** The same Shell `ask` scenario: the user clicks `deny`; the tool call is denied and the bot replies with a generic message without naming the tool.

AE4. **Covers R9.** The same Shell `ask` scenario: the user does not click within the SDK approval timeout; the call is denied, the bot replies with a generic message, and the card updates to show "已过期".

AE5. **Covers R10, R11, R12.** The bot asks the user a single-choice question; a template card with the options is sent; the user selects an option; the bot receives the answer and continues the conversation.

AE6. **Covers R16.** A user clicks a card after the approval has already resolved; the card updates to show "已处理" and the session is unaffected.

AE7. **Covers R17, R18.** A GUI user opens the bot session while a card is pending; the session header shows "等待企微用户确认" and no approve/deny controls are visible.

---

## Success Criteria

- A workspace admin can configure a tool category or specific tool to `ask`, and the WeCom user receives a decision card on the next invocation.
- `AskUserQuestion` in a WeCom bot session surfaces as a native template card instead of hanging for a GUI-only response.
- `allow`, `always allow`, and `deny` all produce the expected session behavior, with `always allow` handled by the SDK's own mechanism.
- Expired or invalid card clicks do not crash the session and leave the card in a terminal state.
- GUI users can see when a bot session is waiting for a WeCom decision, but cannot act on it.

---

## Scope Boundaries

### In scope

- Adding `ask` as a third value in the WeCom bot tool-permission model.
- Template-card messages for tool approvals and `AskUserQuestion`.
- Parsing template-card click events from the existing WeCom websocket.
- Resolving pending approvals in `SessionRuntime` from card events.
- Updating cards to terminal states for expired/invalid clicks.
- GUI pending-status indicator for bot sessions with active asks.

### Deferred for later

- Persistent approval queue or audit log of approval decisions.
- GUI controls that let admins approve or deny on behalf of the WeCom user.
- `ask` support for MCP tools or Skills (the existing permission model already defers these categories).
- Per-user or per-role `ask` policies beyond the workspace-level policy.
- Group-chat-specific card behaviors beyond what the standard bot API provides.

### Outside scope

- Changes to the GUI session permission flow.
- Changes to Feishu bot card handling (it already has its own mechanism).
- New WeCom connection or authentication mechanisms.

---

## Dependencies / Assumptions

- WeChat Work template-card message APIs support the card layouts and button actions required for tool approvals and questions.
- The `@wecom/aibot-node-sdk` websocket client exposes template-card click events, or the raw event payload can be parsed.
- The Claude Agent SDK's `canUseTool` callback supports async pending-approval behavior that returns a Promise resolved later.
- The Claude Agent SDK's `always allow` path writes to `settings.local.json` that the Comate server-side bot sessions read.
- Bot sessions run in the same runtime environment as the Comate process so that `settings.local.json` updates are visible to subsequent tool calls.

---

## Outstanding Questions

### Resolve before planning

- None.

### Deferred to planning

- Q1. Exact WeCom template-card layout, copy, and i18n keys for tool-approval and question cards.
- Q2. How to handle free-text `AskUserQuestion` if the card format does not provide a clean text input field.
- Q3. Whether multiple concurrent template cards in a single WeCom chat create UX confusion, and whether they should be serialized.
- Q4. The precise generic denial message text for denied or timed-out tool calls.
- Q5. Whether the SDK's `always allow` grant is scoped per-workspace, per-session, or per-machine, and how that interacts with multi-workspace bot deployments.
