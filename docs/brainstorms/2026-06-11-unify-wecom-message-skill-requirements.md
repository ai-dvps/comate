---
date: 2026-06-11
topic: unify-wecom-message-skill
---

# Unify WeCom Message Skill into Send-WeCom-Msg

## Summary

Replace the split `send-wecom-message` and `enqueue-wecom-proactive-message` skills with a single `send-wecom-msg` skill backed by a unified `wecom send` CLI command and smart HTTP endpoint. The endpoint routes same-user messages directly through the WeCom SDK and cross-user or unmapped messages into the existing queue for worker delivery.

---

## Problem Frame

The recent skill split created two separate skills to disambiguate normal sends from proactive queueing, but it added surface area and forced the user (and agent) to choose the right skill up front. In practice, the intent is the same — "send a message to a user" — and the decision of whether to send immediately or enqueue should be automatic based on who the caller is and who the recipient is. Carrying two skills, two CLI commands, and two HTTP routes creates unnecessary complexity and still relies on the agent to pick the right tool.

---

## Actors

- A1. **Sender agent**: Claude session where the user asks to send a message
- A2. **Unified endpoint**: HTTP route that decides direct vs queued delivery
- A3. **Queue worker**: Background process that polls and delivers queued messages
- A4. **Recipient agent**: Claude session that receives and acts on a queued delivery prompt

---

## Key Flows

- F1. **Direct send (same user)**
  - **Trigger:** User asks to send a message to the same WeCom user tied to their current session
  - **Actors:** A1, A2
  - **Steps:**
    1. Sender skill collects `${CLAUDE_SESSION_ID}`, to_user, message
    2. `wecom send` CLI posts to unified endpoint
    3. Endpoint resolves session_id to caller user_id
    4. Endpoint sees caller user_id == to_user
    5. Endpoint calls WeCom SDK directly
    6. HTTP response returns success
  - **Outcome:** Message sent immediately; no queue entry created
  - **Covered by:** R1, R2, R3, R4, R5, R6, R12

- F2. **Queued send (different or unmapped user)**
  - **Trigger:** User asks to send a message to a different WeCom user, or their session has no WeCom mapping yet
  - **Actors:** A1, A2, A3, A4
  - **Steps:**
    1. Sender skill collects `${CLAUDE_SESSION_ID}`, to_user, message
    2. `wecom send` CLI posts to unified endpoint
    3. Endpoint resolves session_id to caller user_id
    4. Endpoint sees caller user_id != to_user (or no mapping)
    5. Endpoint enqueues the message
    6. Worker polls, claims pending entry
    7. Worker resolves recipient session and constructs prompt
    8. Worker pushes prompt into recipient's session
    9. Recipient agent sees natural-language send request and invokes `send-wecom-msg` skill
    10. Recipient agent runs `wecom send` to complete delivery
  - **Outcome:** Message delivered through recipient's own session context
  - **Covered by:** R1, R2, R3, R4, R5, R6, R13, R15, R16

---

## Requirements

**Skill**
- R1. Create a single `send-wecom-msg` skill that replaces both old skills
- R2. Skill description should focus on "send a message to a user" without distinguishing between direct and queued sends
- R3. Skill collects three inputs: current session ID via `${CLAUDE_SESSION_ID}`, recipient user ID, and message content
- R4. Skill includes markdown auto-detection and drafting guidance
- R5. Skill does not contain a `<proactive_send>` directive

**CLI**
- R6. Create a new `wecom send` CLI command accepting `--to-user`, `--message`, and automatically including the session ID
- R7. `wecom send` passes session_id, to_user, and message to the unified HTTP endpoint
- R8. CLI returns structured exit codes (0 success, 1 invalid args, 2 no context, 3 HTTP failed) with a detailed error message on failure

**HTTP Endpoint**
- R9. Create a unified `POST` endpoint that replaces the old `/api/wecom/send` and `/api/workspaces/:id/wecom-queue` POST routes
- R10. Endpoint receives session_id, to_user, message
- R11. Endpoint looks up the WeCom user ID associated with the provided session_id
- R12. When the caller's user ID matches to_user, send the message directly via the WeCom SDK
- R13. When the caller's user ID differs from to_user, or the session has no WeCom user mapping, enqueue the message for the worker
- R14. Return appropriate HTTP status and response body indicating direct-send vs queued

**Worker**
- R15. Worker continues polling the queue for pending messages
- R16. When claiming a pending message, worker resolves the recipient's session and constructs a natural-language prompt that triggers the recipient's `send-wecom-msg` skill
- R17. Worker executes the prompt in the recipient's session

**Cleanup**
- R18. Remove old skill markdown sources and generated TypeScript assets
- R19. Remove old generation scripts that produced the split skills
- R20. Remove old CLI commands `wecom msg send` and `wecom queue enqueue`
- R21. Remove old HTTP routes `/api/wecom/send` and `/api/workspaces/:id/wecom-queue` (POST only)
- R22. Update `wecomBotService` to write only the new single skill on bot connect

---

## Acceptance Examples

- AE1. **Covers R12.** Given a session mapped to WeCom user `Alice`, when the user asks to send "hello" to `Alice`, the endpoint calls the WeCom SDK directly and returns a success response with no queue entry created.
- AE2. **Covers R13.** Given a session mapped to WeCom user `Alice`, when the user asks to send "hello" to `Bob`, the endpoint enqueues the message and returns a queued response.
- AE3. **Covers R13.** Given a session with no WeCom user mapping, when the user asks to send "hello" to `Bob`, the endpoint enqueues the message rather than returning an error.

---

## Success Criteria

- Users can send messages to any WeCom user from a single skill without choosing between "send" and "enqueue"
- Same-user sends complete in one HTTP round-trip without queue latency
- Cross-user sends reliably reach the recipient through their own session context
- No old skill files, CLI commands, or routes remain in the codebase
- The queue monitoring UI continues to function for queued messages

---

## Scope Boundaries

- **In scope:** Single skill, unified CLI, unified endpoint, direct-send logic, worker prompt integration, cleanup of old split artifacts
- **Out of scope:** Queue monitoring list/retry/delete endpoints (staying separate), worker polling interval and retry logic, session-specific skill loading, new automated tests for skill generation, WeCom SDK version changes

---

## Key Decisions

- **Single skill over split skills:** The user intent is always "send a message"; routing should be automatic, not a skill-choice problem.
- **Endpoint owns the user-id comparison:** The CLI stays thin and only transports inputs; the server owns session-to-user resolution and routing logic.
- **Direct send bypasses queue:** Same-user messages are sent immediately via SDK for speed, even though this means they won't appear in queue history.
- **Worker uses natural-language prompt:** Removing `<proactive_send>` means the worker pushes a send request into the recipient's session that the unified skill handles naturally, rather than a structured directive.

---

## Dependencies / Assumptions

- Claude Code injects `${CLAUDE_SESSION_ID}` at skill runtime
- The existing queue worker infrastructure can be adapted to construct and push natural-language prompts
- `wecomBotService` can be updated to write a single skill without breaking existing workspace connections
- The WeCom SDK direct-send path is available in the unified endpoint handler