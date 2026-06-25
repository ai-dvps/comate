---
date: 2026-06-25
topic: wecom-feishu-rotating-placeholder
---

# Rotating WeCom / Feishu Acknowledgment Placeholder

## Summary

Replace the fixed "收到，正在处理中" / "收到，正在处理..." acknowledgment shown after a bot message is received with a small built-in pool of friendlier messages. The pool is shared between WeCom and Feishu, and one message is chosen at random for each incoming message.

## Problem Frame

The current placeholder reads as stiff and robotic. Because it is the first thing users see after every message, it sets a mechanical tone for the whole interaction. A small rotation of warmer, more natural acknowledgments makes the bot feel responsive without changing behavior.

## Requirements

- R1. When a WeCom or Feishu text message callback arrives, the bot immediately sends the initial stream placeholder using a message randomly selected from a built-in pool.
- R2. The pool contains at least 3 and at most 8 short Chinese acknowledgments that all fit the same "we got it, working on it" intent.
- R3. The same pool is used for both WeCom and Feishu; per-channel differences are not required.
- R4. The random selection is per incoming message; repeated messages in the same session may show different acknowledgments.
- R5. Existing tool-use, subagent, and thinking placeholders remain unchanged.

## Key Decisions

- **Built-in pool over user-configurable pool.** Keeps the change small and avoids adding workspace settings UI for a polish item.
- **Shared across WeCom and Feishu.** Both channels express the same intent at the same moment, so a single pool keeps the bot voice consistent.
- **Initial placeholder only.** Tool, subagent, and "thinking" placeholders are more specific states and stay as they are.

## Scope Boundaries

- No per-workspace or per-bot customization.
- No localization beyond the current Chinese UI.
- No changes to placeholder animation timing, stream mechanics, or fallback error messages.

## Acceptance Examples

- AE1. **Covers R1–R2.** Given a connected WeCom bot, when a user sends "hello", they see one of the rotating messages (e.g., "好嘞，我先想想…") within ~200ms.
- AE2. **Covers R3.** Given a connected Feishu bot, when a user sends "hello", they see a message from the same pool used by the WeCom bot.
- AE3. **Covers R4.** Given a user who sends two messages in a row, the two acknowledgments may differ.

## Sources / Research

- Existing placeholder implementation lives in `src/server/services/wecom-stream-reply.ts` and `src/server/services/feishu-stream-reply.ts`.
- Prior placeholder decision documented in `docs/brainstorms/2026-05-22-wecom-processing-status-requirements.md` (superseded for placeholder text by this doc).
