---
date: 2026-06-10
sequence: 002
type: feat
status: completed
---

# Wire Sender Session to WeCom Proactive Message Queue Enqueue Endpoint

## Summary

Add the missing caller path from the sender's session (user A) into the WeCom proactive message enqueue endpoint. The queue and worker are already built, but when A asks the bot to send a message to B, the agent still uses the old direct-send CLI command. This plan adds a new `wecom queue enqueue` CLI command, includes `workspaceId` in the WeCom context file, and updates the `send-wecom-message` skill so the agent knows when to enqueue (proactive send to another user) versus when to send directly (reply in the current conversation).

---

## Problem Frame

The proactive message queue (built in `2026-06-09-001-feat-wecom-proactive-message-queue-plan.md`) provides:
- An enqueue endpoint at `POST /api/workspaces/:id/wecom-queue`
- A background worker that dispatches queued messages to the recipient's session
- A skill section `<proactive_send>` that teaches the recipient's agent (B) how to execute the send

However, the **sender's session (A)** has no mechanism to reach the enqueue endpoint. The existing `wecom msg send` CLI command (`packages/wecom-cli/src/index.ts`) calls the old direct-send endpoint (`POST /api/wecom/send`). The `send-wecom-message` skill only instructs the agent to use `wecom msg send`. As a result, proactive send requests from A never enter the queue — they bypass it entirely and send directly via the WeCom SDK, which means the outgoing message still does not appear in B's session history.

---

## Key Technical Decisions

- **New CLI command over extending the old one:** Adding `wecom queue enqueue` as a separate subcommand keeps the tool semantics explicit (`send` = direct, `enqueue` = queued). This makes agent reasoning clearer and preserves backward compatibility for direct-send workflows.
- **`workspaceId` in the context file:** The enqueue endpoint is workspace-scoped (`/api/workspaces/:id/wecom-queue`). The CLI needs `workspaceId` to construct the URL. Adding it to `.claude/wecom-context.json` is the minimal change; the file is already workspace-scoped and written at bot-connect time.
- **Skill heuristic for enqueue vs. direct send:** The agent distinguishes proactive sends by intent phrasing (e.g. "send to ZhangSan", "notify LiSi") versus current-conversation replies (e.g. "send a message saying hello" with no named recipient). This is a pragmatic heuristic rather than a hard recipient check, because the skill markdown is static and does not have access to the current user's WeCom ID at skill-read time.

---

## High-Level Technical Design

### Sender-Side Flow

```text
User A: "send to ZhangSan: please upload the file"
   │
   ▼
Agent in A's session reads skill <proactive_send_initiate>
   │
   ▼
Agent runs: wecom queue enqueue --to-user ZhangSan --message "please upload the file"
   │
   ▼
CLI reads .claude/wecom-context.json → { workspaceId, botId, serverUrl }
   │
   ▼
CLI POSTs to /api/workspaces/${workspaceId}/wecom-queue
   │
   ▼
Queue entry created (pending)
   │
   ▼
Worker polls, dispatches to B's session when idle
   │
   ▼
Agent in B's session reads skill <proactive_send_execute>
   │
   ▼
Agent runs: wecom msg send --to-user ZhangSan --message "please upload the file"
   │
   ▼
Message sent via WeCom SDK, recorded in B's session history
```

---

## Implementation Units

### U1. Include `workspaceId` in WeCom context file

**Goal:** Make `workspaceId` available to the CLI so it can construct workspace-scoped enqueue URLs.

**Requirements:** (see origin: `docs/brainstorms/2026-06-09-wecom-proactive-message-session-switching-requirements.md` — R1)

**Dependencies:** None

**Files:**
- `src/server/services/wecom-bot-service.ts` (modify `writeContextFile`)

**Approach:**
Update `writeContextFile` to write `{ workspaceId, botId, serverUrl }` instead of `{ botId, serverUrl }`. The method already receives `workspace` as an argument, so `workspace.id` is available. Existing `.claude/wecom-context.json` files in the field will be missing `workspaceId` until the bot reconnects; the new CLI command should fail gracefully with a clear error when `workspaceId` is absent.

**Patterns to follow:** Existing `writeContextFile` implementation in `wecomBotService`.

**Test scenarios:**
- Happy path: `writeContextFile` writes `workspaceId` alongside `botId` and `serverUrl`
- Edge case: context file JSON is valid and parseable by the CLI

**Verification:** Context file contains `workspaceId`; CLI can read it.

---

### U2. Add `wecom queue enqueue` CLI command

**Goal:** Provide a CLI command that calls the enqueue endpoint from the sender's session.

**Requirements:** (see origin: R1)

**Dependencies:** U1

**Files:**
- `packages/wecom-cli/src/index.ts` (add command + update usage)
- `packages/wecom-cli/package.json` (version bump optional)

**Approach:**
Restructure the CLI to support subcommands:
- `wecom msg send --to-user <id> --message <text> [--msg-type text|markdown]` (existing behavior, unchanged)
- `wecom queue enqueue --to-user <id> --message <text>` (new)

The `queue enqueue` command:
1. Reads `.claude/wecom-context.json` (same `findContextFile` logic)
2. Validates that `workspaceId` exists in the context file
3. Calls `POST ${serverUrl}/api/workspaces/${workspaceId}/wecom-queue` with `{ toUser, message }`
4. On HTTP 202, parses the response for `{ id, status }` and prints a confirmation line
5. On HTTP 400, parses the error code (`recipient_not_resolved`, `recipient_no_session`) and prints a human-readable message
6. Returns exit code 0 on success, 1 on argument/context errors, 3 on HTTP failure

**Patterns to follow:** Existing `postJson` helper and argument-parsing loop in `packages/wecom-cli/src/index.ts`.

**Test scenarios:**
- Happy path: enqueue with valid recipient → HTTP 202, prints queue entry ID, exits 0
- Error path: missing `--to-user` or `--message` → prints usage, exits 1
- Error path: context file missing `workspaceId` → clear error, exits 1
- Error path: recipient not resolved (HTTP 400 `recipient_not_resolved`) → prints readable error, exits 3
- Error path: recipient has no session (HTTP 400 `recipient_no_session`) → prints readable error, exits 3
- Error path: server returns 500 → prints generic error, exits 3

**Verification:** CLI builds successfully; manual test with `node dist/index.js queue enqueue ...` returns 202.

---

### U3. Update `send-wecom-message` skill for proactive-send initiation

**Goal:** Teach the agent in the sender's session when to enqueue versus when to send directly.

**Requirements:** (see origin: R1, R6)

**Dependencies:** U2

**Files:**
- `src/server/assets/send-wecom-message.md` (add `<proactive_send_initiate>` section)
- `src/server/assets/wecom-skill.ts` (regenerate via `npm run generate:skills`)

**Approach:**
Add a new `<proactive_send_initiate>` section before `<proactive_send>` (which handles the recipient-side execution). The section instructs the agent:

1. **Determine recipient type:**
   - If the user names a recipient **other than themselves** (e.g. "send to ZhangSan", "notify LiSi", "tell WangWu to check the logs"), this is a **proactive send** → use `wecom queue enqueue`.
   - If the user does not name a recipient, or names themselves, this is a **current-conversation send** → use `wecom msg send`.
2. **For proactive sends:**
   - Extract the recipient user ID and message content.
   - Run: `wecom queue enqueue --to-user RECIPIENT --message "MESSAGE"`
   - Report the queue entry ID returned by the CLI.
3. **For current-conversation sends:**
   - Use the existing `wecom msg send` flow unchanged.

Add an example under `<examples>` showing a proactive enqueue:
```markdown
<example number="4">
<input>Send a message to ZhangSan saying the deployment is complete</input>
<output>
Queueing proactive message:

```bash
wecom queue enqueue --to-user ZhangSan --message "The deployment is complete"
```
</output>
</example>
```

After editing the markdown, regenerate `wecom-skill.ts` with `npm run generate:skills`.

**Patterns to follow:** Existing skill section structure (`<objective>`, `<workflow>`, `<examples>`, `<anti_patterns>`, `<proactive_send>`).

**Test scenarios:**
- Happy path: skill file is written to workspace on bot connect
- Integration: manual test — agent in A's session receives "send to B: hello", runs `wecom queue enqueue`, queue entry is created

**Verification:** `wecom-skill.ts` is regenerated; manual end-to-end test from sender request through queue creation succeeds.

---

## Scope Boundaries

- Does not modify the queue worker, storage, or UI (those are already built and remain unchanged).
- Does not modify the old `POST /api/wecom/send` endpoint behavior.
- Does not add auto-detection of "current user" to the skill (heuristic-based intent detection only).
- Does not add scheduled sends, rate limiting, or authorization rules.

### Deferred to Follow-Up Work

- Graceful migration of existing `.claude/wecom-context.json` files that lack `workspaceId` (fixed on next bot reconnect).
- Badge count / desktop notification when queued messages fail.

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Old context files missing `workspaceId` break the new CLI command | Medium | Medium | CLI returns clear error telling user to reconnect the bot. |
| Agent misclassifies proactive send vs. direct send intent | Medium | Low | Heuristic is conservative; ambiguous cases fall back to direct send, which is the old behavior. |
| Skill update not propagated to existing workspaces | Medium | Low | `writeSkillFiles` runs on every bot reconnect; operators can reconnect bots if needed. |

---

## Dependencies / Assumptions

- `wecomBotService.writeSkillFiles` writes the updated skill to each workspace's `.claude/skills/send-wecom-message/SKILL.md` on bot connect.
- `wecomBotService.writeContextFile` writes the context file to each workspace's `.claude/wecom-context.json` on bot connect.
- The agent SDK respects updated skill files after the bot reconnects.

---

## Test Strategy Summary

- **Unit tests:** CLI argument parsing and error handling (manual verification via CLI invocation).
- **Integration tests:** Full sender-session flow from skill instruction → CLI invocation → enqueue endpoint → queue entry creation.
- **Characterization tests:** None required; this is new functionality.
