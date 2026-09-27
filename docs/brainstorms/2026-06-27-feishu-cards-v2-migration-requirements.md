---
date: 2026-06-27
topic: feishu-cards-v2-migration
---

## Summary

Migrate the four legacy Feishu interactive cards to Feishu Cards v2. The session-switcher card becomes a form-container with a `select_static` dropdown and a submit button; after a successful switch the same card is re-rendered inactive. The workspace-list, approval, and question cards keep their existing behavior but move to v2 structures and callbacks.

## Problem Frame

The current session-switcher card lists every available session with its own "选择" button. As users accumulate sessions the card becomes long and hard to scan. A dropdown plus a confirmation button would make the card compact while preserving explicit intent. Feishu Cards v2's form container lets the dropdown hold its value locally and submit once, which matches the desired flow without intermediate server round-trips.

## Key Decisions

- **K1. Use Feishu Cards v2 form container for the session switcher.** This gives the dropdown-then-confirm interaction without a two-step server round-trip.
- **K2. Remove the "新建会话" button from the session card.** Session creation remains available through `/new`, `/clear`, and the bot menu; keeping a creation button on the switcher card would introduce a competing path.
- **K3. Migrate all four legacy cards in one change.** Doing workspace-list, session-switcher, approval, and question cards together avoids maintaining two card builders and two callback parsers in parallel.
- **K4. Preserve existing user-visible behavior for the other cards.** Only the card format and callback shape change for workspace-list, approval, and question cards.

## Requirements

**Session switcher card**

- R1. Render the session switcher as a Feishu Cards v2 form container.
- R2. Use a `select_static` element populated with all sessions owned by the user, ordered by `createdAt ASC`.
- R3. The current active session is the default selected option, labeled with "（当前）".
- R4. Provide a submit button labeled "确认切换".
- R5. On submit, the server switches the user's active session to the selected `sessionId`, validates ownership, and returns a success toast.
- R6. After a successful switch, update the original card to an inactive state where the dropdown and submit button are no longer interactive.
- R7. When the user has no sessions, show "你还没有会话，发送 /new 创建新会话" and omit the dropdown and submit button.

**Other legacy cards**

- R8. Migrate the workspace-list card to v2 while keeping one-select-button-per-workspace behavior.
- R9. Migrate the approval card to v2 while keeping "允许" / "拒绝" behavior.
- R10. Migrate the question card to v2 while keeping single-select immediate resolution, multi-select toggle plus submit, and the free-form fallback prompt.
- R11. Each migrated card must use v2 action callback shapes and continue to identify the action via a stable `action` field in the callback value.

**Callback handling**

- R12. The Feishu card action handler must parse v2 payloads, including `form_value` keyed by component name, and route to the existing action handlers.
- R13. For non-form v2 actions (workspace, approval, question options), continue to derive `workspaceId`, `sessionId`, and action intent from the callback value.
- R14. Rate limiting per user remains in place for all card interactions.

**Testing and compatibility**

- R15. Update card-builder tests to assert v2 JSON structure and component tags.
- R16. Update action-handler tests to use v2 callback payloads.
- R17. The streaming answer card, already v2, remains unchanged.

## Key Flows

- F1. **Session switch**
  - **Trigger:** User opens the session card via `/resume` or the bot menu.
  - **Steps:**
    1. Card renders a dropdown with the current session selected.
    2. User selects a different session.
    3. User clicks "确认切换".
    4. Server receives `form_value` with the selected `sessionId`, validates ownership, sets the active session, returns a success toast, and re-renders the card inactive.
  - **Outcome:** The user's active session changes and the card becomes non-interactive.

- F2. **Workspace select**
  - **Trigger:** User opens the workspace-list card.
  - **Steps:** Card lists workspaces with a select button each; user clicks one; server validates admin permission and sets the active workspace.
  - **Outcome:** Feishu bot workspace binding is updated.

- F3. **Tool approval**
  - **Trigger:** A tool call needs user approval.
  - **Steps:** Card shows tool info and "允许" / "拒绝" buttons; user clicks one; server resolves the approval in the runtime.
  - **Outcome:** The runtime continues or stops based on the decision.

- F4. **Question answer**
  - **Trigger:** The assistant asks the user one or more questions.
  - **Steps:** Single-select options resolve immediately; multi-select options toggle and require "提交"; free-form questions prompt the user to reply in chat.
  - **Outcome:** The question is resolved with the collected answers.

## Acceptance Examples

- AE1. **Successful session switch**
  - **Covers:** R1, R3, R5, R6.
  - **Given** the user owns sessions A (current) and B. **When** the card renders, the dropdown defaults to "A（当前）". The user selects B and clicks "确认切换". **Then** the server sets the active session to B, returns "会话已切换。", and the card is re-rendered inactive.

- AE2. **Empty session state**
  - **Covers:** R7.
  - **Given** the user has no Feishu sessions. **When** the card renders. **Then** it shows "你还没有会话，发送 /new 创建新会话" with no dropdown or confirm button.

- AE3. **Ownership check on switch**
  - **Covers:** R5.
  - **Given** the user selects a session they do not own. **When** the submit reaches the server. **Then** it returns "你无法操作该会话。" and leaves the active session unchanged.

## Scope Boundaries

- The streaming answer card stays as-is; it is already v2.
- The workspace-list card keeps one-button-per-workspace; it is not converted to a dropdown.
- No new Feishu text commands or bot menu items are added.
- No backend changes to session ownership, workspace admin logic, or the active-session store.

## Dependencies / Assumptions

- Feishu Cards v2 form container supports a `select_static` element plus a submit button that returns aggregated `form_value` without intermediate selection callbacks.
- The Feishu card action callback can return a replacement card to update the original message.
- The existing `chat` adapter and bot service can send v2 card JSON via `msg_type: interactive`; the streaming answer card already does this.
- Stable component `name` values in v2 forms are used to parse `form_value`.

## Sources / Research

- `src/server/services/feishu-card-builder.ts` — current card builders for workspace-list, session-list, approval, question, and streaming answer cards.
- `src/server/services/feishu-card-action-handler.ts` — current action routing and rate limiting.
- `src/server/services/feishu-bot-service.ts` — card sending, callback entry point, and action response handling.
- `src/server/services/feishu-session-helpers.ts` — shared session creation path used by text commands, bot menu, and the current card button.
- `src/server/storage/sqlite-store.ts` — session list ordering and active-session storage.
- Feishu Cards v2 form container documentation: https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container
