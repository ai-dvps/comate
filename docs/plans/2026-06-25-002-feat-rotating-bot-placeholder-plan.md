---
date: 2026-06-25
topic: wecom-feishu-rotating-placeholder
origin: docs/brainstorms/2026-06-25-wecom-feishu-rotating-placeholder-requirements.md
---

# feat: Rotating acknowledgment placeholder pool for WeCom and Feishu

## Summary

Add a small shared utility that returns a random Chinese acknowledgment message from a built-in pool. Wire it into the WeCom and Feishu streaming reply services so the first placeholder users see after sending a message varies instead of always showing the fixed "收到，正在处理中" text.

## Problem Frame

The current placeholder reads as stiff and robotic. Because it is the first thing users see after every message, it sets a mechanical tone for the whole interaction. A small rotation of warmer, more natural acknowledgments makes the bot feel responsive without changing behavior (see origin).

## Requirements

- R1. When a WeCom or Feishu text message callback arrives, the bot immediately sends the initial stream placeholder using a message randomly selected from a built-in pool.
- R2. The pool contains at least 3 and at most 8 short Chinese acknowledgments that all fit the same "we got it, working on it" intent.
- R3. The same pool is used for both WeCom and Feishu; per-channel differences are not required.
- R4. The random selection is per incoming message; repeated messages in the same session may show different acknowledgments.
- R5. Existing tool-use, subagent, and thinking placeholders remain unchanged.

## Key Technical Decisions

- **Shared utility.** Both channels express the same intent at the same moment, so a single module keeps the bot voice consistent and avoids duplication.
- **Built-in pool, not configurable.** The brainstorm explicitly chose defaults-only to avoid adding workspace settings UI for a polish item.
- **Random selection per message.** A simple uniform random pick satisfies the request; no weighting or user-session stickiness is required.
- **Preserve explicit Feishu `initialHint`.** Feishu already supports an explicit `initialHint` for new-session greetings; that override stays in place and the rotating pool only supplies the default.
- **WeCom `thinking_start` placeholder stays fixed.** The brainstorm scoped rotation to the initial acknowledgment only; the WeCom thinking placeholder keeps its existing text.

## Implementation Units

### U1. Create shared acknowledgment placeholder utility

- **Goal:** Define a small pool of rotating Chinese acknowledgment messages and a function that returns one at random.
- **Requirements:** R2, R3
- **Dependencies:** None
- **Files:** `src/server/utils/bot-placeholder.ts` (new), `src/server/utils/bot-placeholder.test.ts` (new)
- **Approach:** Keep the module stateless. Export the pool array and a `getRandomAcknowledgment()` function. Design the selector so tests can either mock the random source or verify that repeated calls return pool members.
- **Patterns to follow:** Existing server utils are small, focused modules with co-located `node:test` tests (e.g., `src/server/utils/resolve-shell-env.test.ts`).
- **Test scenarios:**
  - Returns a string that is one of the configured pool messages.
  - Repeated calls can return different messages from the pool.
  - Pool contains between 3 and 8 messages, all non-empty.
- **Verification:** New tests pass and the pool is importable from both WeCom and Feishu services.

### U2. Update WeCom stream reply to use rotating placeholder

- **Goal:** Replace the fixed initial placeholder in `createStreamReply` with a random selection from the shared pool.
- **Requirements:** R1, R4, R5
- **Dependencies:** U1
- **Files:** `src/server/services/wecom-stream-reply.ts`, `src/server/services/wecom-stream-reply.test.ts`
- **Approach:** Select a placeholder message when the stream reply is created and use it for the initial `replyStream` call and the cycling animation frames. Keep the `thinking_start` placeholder text unchanged.
- **Patterns to follow:** The existing code already centralizes placeholder strings inside `wecom-stream-reply.ts`; replace only the initial-acknowledgment occurrences.
- **Test scenarios:**
  - The initial `replyStream` call sends a message from the shared pool, not the fixed "收到，正在处理中" text.
  - The animation frames use the same selected base message with trailing dots.
  - The `thinking_start` placeholder still uses the existing fixed text.
- **Verification:** `npm run test:server` passes for `wecom-stream-reply.test.ts`.

### U3. Update Feishu stream reply to use rotating placeholder

- **Goal:** Replace the default Feishu initial hint with a random selection from the shared pool when no explicit `initialHint` is provided.
- **Requirements:** R1, R3, R4
- **Dependencies:** U1
- **Files:** `src/server/services/feishu-stream-reply.ts`, `src/server/services/feishu-stream-reply.test.ts`
- **Approach:** In `FeishuStreamReply.start()`, use the shared selector as the fallback when `this.initialHint` is absent. Explicit `initialHint` values (e.g., the new-session greeting in `feishu-bot-service.ts`) continue to take precedence.
- **Patterns to follow:** Feishu already supports `initialHint` override; the change is limited to the default value.
- **Test scenarios:**
  - When `initialHint` is not provided, the streaming card starts with a message from the shared pool, not the fixed "收到，正在处理..." text.
  - When `initialHint` is provided, it still overrides the pool selection.
  - Different reply instances can start with different pool messages.
- **Verification:** `npm run test:server` passes for `feishu-stream-reply.test.ts`.

## Scope Boundaries

- No per-workspace or per-bot customization.
- No localization beyond the current Chinese UI.
- No changes to placeholder animation timing, stream mechanics, or fallback error messages.
- No changes to WeCom or Feishu bot service logic beyond supplying/using the placeholder.

## Acceptance Examples

- AE1. **Covers R1–R2.** Given a connected WeCom bot, when a user sends "hello", they see one of the rotating messages (e.g., "好嘞，我先想想…") within ~200ms.
- AE2. **Covers R3.** Given a connected Feishu bot, when a user sends "hello", they see a message from the same pool used by the WeCom bot.
- AE3. **Covers R4.** Given a user who sends two messages in a row, the two acknowledgments may differ.

## Sources / Research

- Origin requirements: `docs/brainstorms/2026-06-25-wecom-feishu-rotating-placeholder-requirements.md`
- Existing WeCom placeholder implementation: `src/server/services/wecom-stream-reply.ts`
- Existing Feishu placeholder implementation: `src/server/services/feishu-stream-reply.ts`
- Prior placeholder decision (superseded for text): `docs/brainstorms/2026-05-22-wecom-processing-status-requirements.md`
