---
date: 2026-05-22
topic: wecom-http-bridge
---

# WeCom HTTP Bridge and CLI

## Summary

An HTTP endpoint on the existing GUI server that lets running Claude Code sessions send proactive WeCom messages to arbitrary users, plus a CLI that skills invoke to call the endpoint. When a workspace's WeCom bot connects, a context file is written to the workspace so the CLI can discover the bot identity and server address without hardcoding either.

---

## Problem Frame

The existing WeCom bot integration is purely request-response: a user sends a message, the server ACKs implicitly by opening a session, Claude processes it, and the final response goes back to the sender. There is no path for a skill running inside that session to send proactive messages — to the original user with progress updates, or to other people with intermediate results or alerts. Skills that want to notify someone via WeCom today would need to import the WeCom SDK directly, which couples them to credentials they should not handle and to a dependency they should not need.

---

## Actors

- A1. Skill developer: Writes skills that include WeCom notification steps.
- A2. Running skill / agent: Executes inside a Claude Code session and invokes the CLI to send a message.
- A3. WeCom recipient: Receives the proactive message; may be the original sender or a different user.

---

## Key Flows

- F1. Workspace file is written on bot connect
  - **Trigger:** A workspace's WeCom bot successfully connects.
  - **Actors:** (server-side)
  - **Steps:** Server verifies bot credentials. Connection is established. Server writes a small context file into the workspace directory containing the bot ID and server URL.
  - **Outcome:** The workspace now carries a discoverable marker that a bot is active.
  - **Covered by:** R1–R3

- F2. Skill sends a WeCom message during task processing
  - **Trigger:** A running skill decides it needs to notify someone.
  - **Actors:** A2, A3
  - **Steps:** Skill invokes the CLI with recipient ID and message. CLI searches upward for the workspace context file. CLI reads bot ID and server URL from the file. CLI POSTs to the server's send-message endpoint. Server looks up credentials by bot ID and sends the message via the WeCom SDK.
  - **Outcome:** The recipient receives the message in WeCom.
  - **Covered by:** R4–R11

- F3. Workspace file is cleaned up on bot disconnect
  - **Trigger:** The WeCom bot is disabled, credentials are removed, or the connection drops and is not restored.
  - **Actors:** (server-side)
  - **Steps:** Server detects disconnect or config change. Server removes or updates the workspace context file.
  - **Outcome:** Subsequent CLI invocations fail with a clear "no active bot" error instead of calling a stale endpoint.
  - **Covered by:** R2, R12

---

## Requirements

**Workspace bot context file**

- R1. When a workspace's WeCom bot connects successfully, the server writes a small file to the workspace directory containing the bot ID and server URL.
- R2. When the bot disconnects or its configuration changes to disabled, the file is removed or updated to reflect the new state.
- R3. The file is located at a predictable path within the workspace so the CLI can discover it by walking upward from the current directory.

**HTTP endpoint**

- R4. The server exposes an authenticated HTTP endpoint for sending WeCom messages.
- R5. The endpoint accepts a bot ID, recipient user ID, message text, and an optional message type (text or markdown).
- R6. The endpoint looks up the workspace and bot credentials using the bot ID, then sends the message via the existing WeCom SDK.
- R7. The endpoint returns a clear success or failure response to the caller.

**CLI**

- R8. The CLI command is `wecom msg send --to-user <id> --message "..."`.
- R9. The CLI discovers the active bot by searching upward from the current working directory for the workspace context file.
- R10. The CLI calls the HTTP endpoint using the bot ID and server URL from the context file, passing the recipient and message provided by the user.
- R11. The CLI supports sending markdown messages.
- R12. When no context file is found, the CLI exits with a clear error indicating that no WeCom bot is configured for the workspace.
- R13. When the HTTP endpoint returns an error, the CLI surfaces that error to the user with a non-zero exit code.

---

## Acceptance Examples

- AE1. **Covers R1, R4, R8, R9, R10.** Given a workspace with WeCom bot enabled and connected, when a skill runs `wecom msg send --to-user U123 --message "Deployment complete"`, then WeCom user U123 receives the message.
- AE2. **Covers R2, R12.** Given a workspace where the WeCom bot was previously enabled but is now disabled, when a skill runs the CLI from that workspace, then the CLI exits with a clear error and no HTTP call is made.
- AE3. **Covers R11.** Given a connected bot, when a skill sends a message containing markdown formatting, then the recipient receives the message rendered as markdown.

---

## Success Criteria

- A skill author can send a WeCom message from within a running Claude Code session without importing the WeCom SDK or handling credentials.
- The CLI works from any subdirectory within the workspace tree.
- Disabling a bot or removing credentials prevents future CLI sends without leaving stale state.

---

## Scope Boundaries

- Group chat support — 1:1 direct messages only.
- Non-text messages (images, files, voice) — text and markdown only.
- Delivery receipts, read receipts, or message status tracking.
- Message queue, retry logic, or offline buffering beyond basic error handling.
- Authentication tokens or API keys on the HTTP endpoint — relies on localhost / same-host trust.
- Distributing the CLI as a separate npm package or global binary — lives in the repo for now.

---

## Key Decisions

- **File-based discovery over environment variables:** A visible file in the workspace survives session restarts and makes bot availability explicit. Environment variables would be simpler but disappear when the spawning process exits.
- **Bot-scoped endpoint over workspace-scoped:** The CLI passes a bot ID rather than a workspace ID. This keeps the CLI decoupled from workspace internals and lets the server resolve credentials.
- **Markdown support in v1:** The WeCom SDK already supports markdown; exposing it in the CLI costs little and covers formatting needs that plain text cannot.
- **Reuse existing server and credentials:** No separate service or credential store. The bridge extends what already works.

---

## Dependencies / Assumptions

- The workspace has a functioning WeCom bot connection before the CLI is invoked.
- The CLI runs on the same host as the GUI server, or at least can reach the server URL written to the context file.
- The existing WeCom SDK supports sending proactive messages to arbitrary user IDs using the same bot credentials.

---

## Outstanding Questions

### Resolve Before Planning

- None

### Deferred to Planning

- [Affects R3][Technical] Exact file path and JSON schema for the workspace context file.
- [Affects R4][Technical] Exact endpoint path and request/response shape.
- [Affects R5][Technical] Whether the CLI should expose a `--msg-type` flag or infer markdown from content.
