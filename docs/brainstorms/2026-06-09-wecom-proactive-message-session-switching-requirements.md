---
date: 2026-06-09
topic: wecom-proactive-message-session-switching
---

# WeCom Proactive Message Session Switching

## Summary

A queue-based session handoff for WeCom proactive messages. When user A asks the bot to message user B, the request is queued and a background worker dispatches it to B's session once B is idle and their user ID is decrypted — ensuring the outgoing message appears in B's conversation history. A queue management UI lets users view, retry, and clean up queued messages; messages auto-timeout after 12 hours.

---

## Problem Frame

Currently, when user A asks the bot to send a WeCom message to user B, the message is sent directly via the WeCom SDK without entering B's session history. When B replies, their session has no context about the proactive message, causing confusion: the bot sees B's reply as out-of-context or misattributes it to an older conversation. The session history is managed by the Claude Code agent SDK, so the only reliable way to include a proactive message in B's history is to have the agent in B's session actually construct and send it.

---

## Actors

- A1. **Sender (User A):** A user who asks the bot to send a proactive message to another user.
- A2. **Recipient (User B):** The user who receives the proactive message and may reply.
- A3. **Queue Worker:** A background process that polls the queue and dispatches messages when conditions are met.
- A4. **Bot Operator:** A human who monitors the queue UI and handles failed or stuck messages.

---

## Key Flows

- F1. **Successful proactive message delivery**
  - **Trigger:** User A asks the bot to send a message to User B.
  - **Actors:** A1, A2, A3
  - **Steps:**
    1. The bot queues the proactive message request.
    2. The worker polls the queue and checks if B is idle and B's user ID is decrypted.
    3. Once conditions are met, the worker hands off to B's session.
    4. The agent in B's session constructs the message and sends it via the WeCom SDK.
    5. The queue entry is marked as delivered.
  - **Outcome:** B receives the message, and the outgoing message is part of B's session transcript.
  - **Covered by:** R1, R2, R3, R4, R5, R6

- F2. **Failed message with manual retry**
  - **Trigger:** A queued message fails delivery (e.g., B's agent errors, or 12-hour timeout reached).
  - **Actors:** A3, A4
  - **Steps:**
    1. The worker marks the queue entry as failed with an error reason.
    2. The bot operator views the failed message in the queue UI.
    3. The operator clicks retry, or cleans up the message.
    4. If retried, the entry is reset to pending and the worker attempts delivery again.
  - **Outcome:** Failed messages are observable and actionable.
  - **Covered by:** R7, R8, R9, R10

- F3. **Blocked message waiting for conditions**
  - **Trigger:** A proactive message is queued, but B is actively chatting or B's user ID is not yet decrypted.
  - **Actors:** A2, A3
  - **Steps:**
    1. The worker checks the queue entry and finds B is busy or B's ID is encrypted.
    2. The worker skips this entry and will retry on the next poll cycle.
    3. Once B becomes idle and the ID is decrypted, the worker dispatches the message.
    4. If 12 hours pass before conditions are met, the entry auto-fails.
  - **Outcome:** Messages wait patiently for the right moment without interrupting B.
  - **Covered by:** R3, R4, R5, R11

---

## Requirements

**Queue and dispatch**

- R1. When a user asks the bot to send a proactive WeCom message to another user, the system must enqueue the request rather than sending immediately.
- R2. The queue must persist across server restarts.
- R3. The worker must dispatch a queued message only when the recipient's session runtime is idle (not actively processing a turn).
- R4. The worker must dispatch a queued message only when the recipient's WeCom user ID has been successfully decrypted by the user resolver.
- R5. If the recipient has no session or their user ID is encrypted, the message must remain queued until both conditions are satisfied.
- R6. The agent in the recipient's session must construct and send the message so that the outgoing message appears in the recipient's session history.

**Failure handling and lifecycle**

- R7. Messages that fail delivery must be marked as failed with a human-readable error reason.
- R8. Failed messages must be retryable by a bot operator through the queue UI.
- R9. Messages must be manually deletable from the queue UI by a bot operator.
- R10. Retrying a message must reset its state to pending and re-evaluate dispatch conditions.
- R11. Messages that remain undelivered for 12 hours must automatically transition to a failed state with a timeout reason.

**Queue UI**

- R12. The queue UI must display all queued messages with their status (pending, delivered, failed), sender, recipient, message preview, and creation time.
- R13. The queue UI must allow filtering by status.
- R14. The queue UI must provide retry and delete actions for failed or pending messages.

---

## Acceptance Examples

- AE1. **Covers R1, R3, R4, R6.** Given B has an active session and decrypted user ID and is currently idle, when A asks the bot to send "please upload the correct file" to B, then B receives the message and B's session transcript includes the outgoing message.
- AE2. **Covers R3, R5.** Given B is actively chatting with the bot (runtime processing a turn), when A asks to send a message to B, then the message is queued and remains pending until B's turn completes.
- AE3. **Covers R4, R5.** Given B has never messaged the bot before, when A asks to send a message to B, then the message is queued and remains pending until B initiates a conversation and their user ID is decrypted.
- AE4. **Covers R7, R8, R9.** Given a queued message failed because B's agent encountered an error during send, when the bot operator views the queue UI, then they see the failed message with an error reason and can click retry or delete.
- AE5. **Covers R11.** Given a message was queued at 09:00 and B never becomes idle or decrypted, when 21:00 arrives (12 hours later), then the message automatically transitions to failed with a timeout reason.

---

## Success Criteria

- When B replies to a proactive message, the bot in B's session has full context of the outgoing message and can respond coherently.
- No proactive message is lost due to server restarts — queued messages survive and resume processing.
- Bot operators can observe and recover from failed proactive sends without restarting the system.
- Messages never interrupt B's active conversation turn.

---

## Scope Boundaries

- Authorization rules on who can message whom through the bot.
- Rate limiting or spam protection for proactive sends.
- Group chat support (1:1 only in this scope).
- Scheduled messages (future addition via a scheduled-at timestamp).
- Automatic retry with backoff (manual retry only in this scope).
- Delivery receipts or read receipts from WeCom.

---

## Key Decisions

- **Queue + worker over inline HTTP handler:** Required to wait for B to be idle and for ID decryption, which may take an indeterminate amount of time.
- **Two dedicated CLI/HTTP paths over single endpoint with flags:** Cleaner separation between the initial enqueue from A's session and the final SDK send from B's session.
- **Manual retry over automatic retry:** Gives operators control over failure recovery; automatic retry can be added later.
- **12-hour timeout over indefinite queueing:** Prevents the queue from filling with undeliverable messages.

---

## Dependencies / Assumptions

- The WeCom user resolver eventually decrypts user IDs after B's first message. Until then, the encrypted ID cannot be used for session lookup.
- The recipient must have initiated at least one conversation with the bot before proactive sends are possible.
- The session runtime exposes a way to check whether it is actively processing a turn.

---

## Outstanding Questions

### Resolved During Brainstorm

- [Affects R12-R14][User decision] The queue UI will be a standalone panel accessible from the main navigation.

### Deferred to Planning

- [Affects R3][Technical] How exactly does the worker check if a session runtime is idle? Does the runtime expose a busy-state indicator, or should the worker track turn completion via events?
- [Affects R4][Technical] How does the worker know when the user resolver has decrypted a user ID? Does it poll the resolver state, or should the resolver emit events?
- [Affects R2][Needs research] Should the queue table live in the existing project store or a separate mechanism?
