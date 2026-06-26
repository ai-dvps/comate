---
title: WeCom updateTemplateCard must reply within 5s of the card event
date: 2026-06-26
category: docs/solutions/integration-issues
module: wecom-bot-service
problem_type: integration_issue
component: service_object
symptoms:
  - Interactive template card stays live after a successful submit; user can re-submit it
  - Server-side state already changed, so a re-submit acts on it again
root_cause: async_timing
resolution_type: code_fix
severity: medium
tags: [wecom, template-card, update-template-card, async-timing, 5s-window]
---

# WeCom updateTemplateCard must reply within 5s of the card event

## Problem
When a WeCom bot handles a `template_card_event` (e.g. a `/resume` session-switch submit) and updates the card to a terminal state afterward, the card can silently stay interactive if the update is sent too late — letting the user re-submit it. The server-side action (e.g. switching the active session) has already succeeded, so a re-submit acts on it again.

## Symptoms
- After a successful card submit, the card does not become a non-interactive `text_notice`; the options/buttons remain clickable.
- Re-submitting the same card performs the action again (e.g. switches to a different session) and succeeds.

## What Didn't Work
- Treating `conn.client.updateTemplateCard(frame, card)` as a free proactive update that can be called any time after the event. It is a *response* correlated to the event, with a tight deadline — see Why This Works.

## Solution
Send the terminal/card-update response **first**, before any slow I/O in the event handler. In `handleResumeSubmit` (`src/server/services/wecom-bot-service.ts`), call `updateCardToTerminal(...)` immediately after the fast state mutation (`setActiveWecomSession`), then do the slower confirmation work (`chatService.getSession`, `sendMessage`) afterward.

Before (update too late):

```ts
workspaceStore.setActiveWecomSession(...);          // fast
const session = await chatService.getSession(...);  // slow (may sync via SDK)
await conn.client.sendMessage(...);                 // slow (awaits WeCom ack)
await this.updateCardToTerminal(..., '已恢复会话');  // >5s after the event → dropped
```

After (update within the window):

```ts
workspaceStore.setActiveWecomSession(...);          // fast
await this.updateCardToTerminal(..., '已恢复会话');  // within ~5s → applied
const session = await chatService.getSession(...);  // slow, after the card is updated
await conn.client.sendMessage(...);                 // slow, best-effort
```

Also scope the error-card update to the action that can actually fail (the switch), so a failed confirmation send does not flip an already-successful card to an error state.

## Why This Works
The WeCom bot SDK's `WSClient.updateTemplateCard(frame, templateCard)` (`@wecom/aibot-node-sdk`) is a **response** to the inbound `template_card_event`, correlated by the event frame's `req_id` (internally `this.reply(frame, body, WsCmd.RESPONSE_UPDATE)`) — not a free proactive send. The SDK's own docstring states it must be sent within ~5 seconds of receiving the callback: *"收到事件回调后需在 5 秒内发送回复，超时将无法更新卡片"*. `sendMessage` awaits WeCom's ack (a network round-trip) and `chatService.getSession` may sync via the Claude SDK; doing either before the update can push the response past the 5s window, so WeCom ignores it and the card stays interactive. The approval/question card flow avoids this because it updates the card right after a fast in-memory `resolveApproval`. Card type (`vote_interaction` vs `button_interaction`) is irrelevant — the constraint is timing, not card shape.

## Prevention
- **Rule of thumb:** in any `template_card_event` handler, send the terminal/card-update response first; do confirmation messages and other slow I/O afterward.
- **Test the ordering invariant:** assert `updateTemplateCard` is called before `sendMessage` in the handler (see `src/server/services/wecom-bot-service.test.ts`, "updates the card to terminal BEFORE sending the confirmation"). Unit-test mocks make the live 5s window invisible, so the ordering assertion is what catches regressions.

## Related Issues
- PR #71 — the fix; PR #70 — the `/resume` feature that introduced `handleResumeSubmit`.
