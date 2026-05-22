---
date: 2026-05-22
topic: wecom-processing-status
---

# WeCom Processing Status Indicator

## Summary

When a WeCom user sends a message to the bot, immediately display a "thinking" placeholder in their chat before the first AI response chunk arrives. The placeholder is then overwritten in-place by the real streaming response.

## Problem Frame

Currently, after a user sends a message, there is a silent delay while the session initializes and the AI begins generating. The user sees nothing until the first `text_delta` event triggers the first `replyStreamNonBlocking` call. For slow-starting models or complex prompts, this creates uncertainty about whether the message was received.

## Actors

- A1. WeCom user: sends a message and expects immediate feedback.

## Key Flows

- F1. User sends message, sees immediate processing indicator
  - **Trigger:** A text message callback arrives from WeCom.
  - **Steps:** Bot receives the message. Bot immediately sends a stream reply with `finish=false` and placeholder content. As AI tokens arrive, the placeholder is overwritten. When the response completes, `finish=true` is sent.
  - **Outcome:** The user never sees an empty chat after sending a message.
  - **Covered by:** R1–R3

## Requirements

- R1. Upon receiving any text message from a WeCom user, the bot sends an initial `replyStream` with placeholder content (e.g. "思考中...") and `finish=false` before starting AI processing.
- R2. The initial placeholder uses the same `stream.id` that subsequent AI token updates will use, so the placeholder is overwritten in-place.
- R3. If the AI produces no content (empty response), the placeholder is still closed with `finish=true` so the user sees a completed (albeit empty) message rather than a stuck indicator.

## Acceptance Examples

- AE1. **Covers R1–R2.** Given a connected WeCom bot, when a user sends "hello", then within ~200ms they see "思考中..." in their chat, which is then replaced by the AI's actual response as it streams in.
- AE2. **Covers R3.** Given a connected bot, when a user sends a message that results in an empty AI response, then the "思考中..." placeholder disappears or completes rather than remaining indefinitely.

## Success Criteria

- Users never experience a silent gap between sending a message and seeing the first visible reaction from the bot.
- The placeholder and final response share the same `stream.id` so there is no duplicate message.

## Scope Boundaries

- No custom placeholder text per workspace or user — single hardcoded or simple default.
- No typing indicator API (WeCom does not expose one); stream placeholder is the mechanism.
- No changes to the HTTP bridge or CLI.

## Key Decisions

- **Placeholder text:** "思考中..." (brief, universal, implies ongoing work).
- **Same stream.id:** Reuse the existing `sessionId-${Date.now()}` pattern already used for the final stream, generated immediately on message receipt rather than at `assistant_start`.
- **Non-blocking initial send:** Use `replyStream` (not `replyStreamNonBlocking`) for the first frame to guarantee delivery, then switch to `replyStreamNonBlocking` for delta updates.

## Dependencies / Assumptions

- The WeCom AI Bot SDK's `replyStream` behavior matches the documented first-call-creates-message semantics.
- The existing debounced flush logic continues to work when an initial non-empty `responseText` is already present.
