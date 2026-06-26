---
title: WeCom template-card updates - reply within 5s AND use replace_text to disable
date: 2026-06-26
last_updated: 2026-06-26
category: docs/solutions/integration-issues
module: wecom-bot-service
problem_type: integration_issue
component: service_object
symptoms:
  - Interactive template card stays live after a successful submit; user can re-submit it
  - Server-side state already changed, so a re-submit acts on it again
root_cause: wrong_api
resolution_type: code_fix
severity: medium
tags: [wecom, template-card, update-template-card, replace-text, vote-interaction, async-timing]
---

# WeCom template-card updates: reply within 5s AND use replace_text to disable

## Problem
When a WeCom bot updates a template card to a terminal/non-interactive state after handling a `template_card_event` (e.g. a `/resume` session-switch submit), the card can silently stay interactive — letting the user re-submit it. The server-side action has already succeeded, so a re-submit acts on it again.

There are TWO independent causes; BOTH must be fixed.

## Symptoms
- After a successful card submit, the card does not become non-interactive; the options/buttons remain clickable.
- Re-submitting the same card performs the action again and succeeds.

## What Didn't Work
1. **Replacing a `vote_interaction` card with a `text_notice`** via `updateTemplateCard`. This does NOT reliably disable a `vote_interaction` card's interactive elements — the options and submit button stay clickable even though the update was sent and applied.
2. **Sending the update after slow I/O** (`sendMessage` round-trip, `getSession`). The update is a *response* with a 5s deadline; if it arrives late, WeCom drops it silently.

## Solution
Two fixes, both required:

### 1. Use `replace_text` + `checkbox.disable` for vote_interaction cards (the real cause)
Per WeCom doc [/94888](https://developer.work.weixin.qq.com/document/path/94888) (投票选择型), to disable a `vote_interaction` card, keep `card_type: vote_interaction` and set:
- **`replace_text`** — *"按钮替换文案，填写本字段后会展现灰色不可点击按钮"* (greyed-out, non-clickable button).
- **`checkbox.disable: true`** — prevents re-selecting options.

`buildTerminalCard` (`src/server/services/wecom-template-card.ts`) is now card-type-aware: `vote_interaction` produces a vote_interaction card with `replace_text` + `disable`; other types keep the existing `text_notice` (which works for `button_interaction`).

### 2. Send the update within 5 seconds (contributing factor)
`WSClient.updateTemplateCard(frame, card)` is a response to the event (correlated by `req_id`), not a free proactive update. Send it **first**, before slow I/O (`sendMessage`, `getSession`). See `handleResumeSubmit` (`src/server/services/wecom-bot-service.ts`).

## Why This Works
- **Format:** WeCom renders `replace_text` as a greyed-out button that cannot be clicked, and `checkbox.disable` prevents option selection. A `text_notice` replacement changes the card type but doesn't carry these disable signals, so the original interactive elements persist for `vote_interaction`.
- **Timing:** the update response must arrive within ~5s of the event (SDK doc: *"收到事件回调后需在 5 秒内发送回复，超时将无法更新卡片"*).

The approval/question flow (`button_interaction`) was unaffected — `text_notice` replacement works for that type, and its handler calls `updateCardToTerminal` right after a fast `resolveApproval`.

## Prevention
- **Rule of thumb:** when disabling a template card after an event, use the card-type-specific disable mechanism (`replace_text` + `disable` for `vote_interaction`/`multiple_interaction`), not a blanket `text_notice` replacement.
- **Test the structure:** assert `buildTerminalCard('vote_interaction', …)` produces `replace_text` + `checkbox.disable: true` (see `src/server/services/wecom-template-card.test.ts`). Unit-test mocks make the live WeCom rendering invisible, so the structural assertion is what catches regressions.
- **Test the ordering:** assert `updateTemplateCard` is called before `sendMessage` in the handler (`src/server/services/wecom-bot-service.test.ts`).
- **Consult the docs:** [doc /94888](https://developer.work.weixin.qq.com/document/path/94888) (更新模板卡片 — card-type-specific update formats) and [doc /101463](https://developer.work.weixin.qq.com/document/path/101463) (智能机器人长连接 — the 5s response window for long-connection bots).

## Related Issues
- PR #72 — the `replace_text` + `disable` fix (the real root cause).
- PR #71 — the 5s-timing fix (contributing factor).
- PR #70 — the `/resume` feature that introduced `handleResumeSubmit`.
