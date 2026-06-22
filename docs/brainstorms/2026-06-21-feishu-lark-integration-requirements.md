---
date: 2026-06-21
topic: feishu-lark-integration
---

# Feishu/Lark Bot Integration Requirements

## Summary

Add a Feishu (Lark) bot channel to Comate using the official `@larksuite/vercel-chat-adapter` as a transport shim. A configurable list of Feishu admin users can switch the bot's active workspace via a `/workspace` card. Employees then chat in that workspace, list/switch/create their own sessions via a `/session` card, and resolve tool permission requests, `AskUserQuestion`, and interrupts inside Feishu. Comate's existing session runtime remains the brain that executes turns and surfaces approvals.

---

## Problem Frame

The organization mandates Feishu as the primary collaboration platform. Employees currently cannot interact with Comate from Feishu, which forces them to switch to the desktop app for approvals, questions, or interrupts. A Feishu bot channel would let employees stay in their mandated chat tool while still using Comate's workspace sessions and agent runtime.

---

## Actors

- A1. **Feishu admin** — a Feishu user listed in the bot's admin configuration who can switch which workspace the bot is bound to.
- A2. **Feishu employee** — a regular Feishu user who chats with the bot in the currently bound workspace and owns their own sessions.
- A3. **Comate server** — hosts the bot adapter, manages workspace/session state, and proxies chat turns into the existing session runtime.
- A4. **Feishu adapter** — the `@larksuite/vercel-chat-adapter` channel that normalizes incoming direct messages and sends outgoing card/markdown replies.

---

## Key Decisions

- **Use the official Vercel Chat SDK + Lark adapter as transport.** This matches the Feishu documented integration path and provides message normalization, WebSocket connection, and outgoing card/markdown streaming without building a Feishu protocol handler from scratch.
- **Keep Comate's existing session runtime as the brain.** The adapter only handles the channel; message execution, tool approvals, `AskUserQuestion`, and interrupts still flow through Comate's runtime, reusing the same patterns as the React client and WeCom bot.
- **Workspace binding is global and admin-controlled.** A single Feishu bot is bound to one Comate workspace at a time. Only configured admin Feishu user IDs can change the binding via a `/workspace` command. This preserves the existing 1:1 bot-to-workspace model while allowing reconfiguration from Feishu.
- **Sessions are per Feishu user within the active workspace.** Each employee sees, selects, and creates only their own sessions. The bot does not auto-create a single session per user; the user explicitly chooses or starts one.
- **Direct messages only for v1.** Group `@mention` support is deferred to avoid group visibility, thread ownership, and permission complexities in the first release.

---

## Requirements

### Workspace binding

- R1. The bot settings store a configurable list of Feishu user IDs that are allowed to switch the bot's active workspace.
- R2. An admin sending `/workspace` in a direct message receives an interactive card listing the Comate workspaces available for binding.
- R3. The workspace card shows enough information for the admin to identify each workspace, such as name and folder path.
- R4. Selecting a workspace from the card updates the bot's active workspace binding and confirms the switch to the admin.
- R5. After a switch, new employee messages are routed into the newly bound workspace; previously active sessions in the old workspace are left as-is.

### Session management

- R6. A user sending `/session` in a direct message receives an interactive card listing their existing sessions in the active workspace.
- R7. The session list card includes a control to create a new session.
- R8. Selecting a session sets it as the user's active session for subsequent messages in that workspace.
- R9. Creating a new session makes it the user's active session and returns a confirmation to the user.
- R10. Sessions are owned per Feishu user; one user cannot see another user's session list.

### Messaging

- R11. Text messages sent to the bot in a direct message are pushed into the user's active session in the active workspace.
- R12. The bot streams assistant output back to the Feishu user as markdown or card messages.
- R13. Tool-use progress and subagent progress may be rendered as lightweight status updates, but the primary output is the assistant's final response stream.

### Tool permissions and AskUserQuestion

- R14. When the agent requests tool permission, the bot surfaces an interactive card showing the tool name, title, and description, with allow and deny actions.
- R15. When the agent calls `AskUserQuestion`, the bot surfaces an interactive card showing each question, options, and multi-select state, with a submit action.
- R16. Resolving an approval or answering a question from Feishu feeds the result back into the active Comate session runtime and resumes the turn.
- R17. If a permission request or question times out, the bot notifies the user that the request expired.

### Interrupt

- R18. A user can interrupt an ongoing assistant turn from Feishu, for example via a `/stop` command or an interrupt button on the active message card.
- R19. Interrupting cancels the current turn and the bot confirms the interruption to the user.

### Bot lifecycle

- R20. The bot's Feishu credentials are stored in the workspace/bot settings and are not logged.
- R21. The server attempts to connect the Feishu bot on startup if credentials are configured.
- R22. The server reports whether the Feishu bot is connected, disconnected, or not configured.

---

## Key Flows

### F1. Admin switches active workspace

- **Trigger:** A1 sends `/workspace` to the bot.
- **Actors:** A1, A3, A4.
- **Steps:**
  1. Bot verifies that the sender's Feishu user ID is in the configured admin list.
  2. Bot fetches the list of Comate workspaces.
  3. Bot sends a card message listing the workspaces.
  4. A1 selects a workspace.
  5. Server updates the bot's active workspace binding.
  6. Server confirms the new binding to A1.
- **Outcome:** New employee messages route into the selected workspace.

### F2. User lists or switches sessions

- **Trigger:** A2 sends `/session` to the bot.
- **Actors:** A2, A3, A4.
- **Steps:**
  1. Bot identifies A2 and the active workspace.
  2. Bot fetches A2's sessions in that workspace.
  3. Bot sends a card message listing sessions and a "New session" option.
  4. A2 selects an existing session or creates a new one.
  5. Server records A2's active session for that workspace.
  6. Bot confirms the active session to A2.
- **Outcome:** A2's subsequent messages go to the selected session.

### F3. User sends a chat message

- **Trigger:** A2 sends a text message to the bot.
- **Actors:** A2, A3, A4.
- **Steps:**
  1. Bot maps the message to A2's active session in the active workspace.
  2. Server pushes the message into the session runtime.
  3. Runtime executes the turn and emits SSE events.
  4. Adapter converts assistant output into Feishu markdown/card updates.
- **Outcome:** A2 sees a streaming reply in Feishu.

### F4. Resolve a tool permission request

- **Trigger:** The agent requests permission for a tool during a turn.
- **Actors:** A2, A3, A4.
- **Steps:**
  1. Runtime pauses the turn and emits a pending approval event.
  2. Bot sends A2 a card with tool details and allow/deny actions.
  3. A2 selects allow or deny.
  4. Server resolves the approval in the runtime.
  5. Runtime resumes the turn.
- **Outcome:** The tool is allowed or denied based on A2's choice.

### F5. Answer an AskUserQuestion

- **Trigger:** The agent calls `AskUserQuestion` during a turn.
- **Actors:** A2, A3, A4.
- **Steps:**
  1. Runtime pauses the turn and emits a pending question event.
  2. Bot sends A2 a card with the questions and options.
  3. A2 submits answers.
  4. Server resolves the question in the runtime.
  5. Runtime resumes the turn.
- **Outcome:** The agent receives A2's answers.

### F6. Interrupt an ongoing turn

- **Trigger:** A2 sends `/stop` or taps an interrupt button while the bot is streaming.
- **Actors:** A2, A3.
- **Steps:**
  1. Server calls interrupt on the active session runtime.
  2. Runtime stops the turn and emits an interrupted event.
  3. Bot confirms the interruption to A2.
- **Outcome:** The current assistant turn ends early.

---

## Acceptance Examples

### AE1. Admin workspace switch

- **Given:** A1 is in the admin list and the bot is currently bound to workspace W1.
- **When:** A1 runs `/workspace`, selects W2 from the card, and the switch succeeds.
- **Then:** A1 receives a confirmation that the active workspace is W2, and the next employee message is handled in W2.

### AE2. Non-admin workspace switch

- **Given:** A2 is not in the admin list.
- **When:** A2 runs `/workspace`.
- **Then:** The bot replies that the user is not authorized to switch workspaces.

### AE3. Session list and selection

- **Given:** A2 has two existing sessions S1 and S2 in the active workspace.
- **When:** A2 runs `/session` and selects S1.
- **Then:** A2 receives a confirmation that S1 is active, and the next message continues S1.

### AE4. Tool permission denial

- **Given:** The agent requests permission for a Bash tool during A2's session.
- **When:** A2 taps "Deny" on the permission card.
- **Then:** The tool is denied, the turn resumes with a denial result, and the agent explains it cannot run the command.

### AE5. AskUserQuestion with options

- **Given:** The agent asks A2 to choose between two approaches via `AskUserQuestion`.
- **When:** A2 selects one option and submits.
- **Then:** The runtime receives the answer and continues the turn using the selected approach.

### AE6. Interrupt while streaming

- **Given:** The bot is streaming a long reply to A2.
- **When:** A2 sends `/stop`.
- **Then:** The stream stops, the runtime interrupts the turn, and A2 sees a brief confirmation.

---

## Scope Boundaries

### Deferred for later

- Group-chat `@mention` support and multi-user group sessions.
- Feishu media, file, and voice message handling.
- Rendering rich tool output or task panels inside Feishu cards.
- Two-way sync of the full session history to Feishu; history is read on demand when the user opens `/session`.

### Outside this product's identity

- Replacing the Comate desktop client or React UI with Feishu.
- Using Feishu as the primary workspace/session management surface for all users.

---

## Dependencies / Assumptions

- The `@larksuite/vercel-chat-adapter` and its peer dependencies are compatible with the project's Node.js runtime and can be initialized alongside the existing Express server.
- Feishu bot credentials are available and the bot app is granted permissions for direct messaging and interactive cards.
- The existing `SessionRuntime`, approval resolution, and interrupt paths can be invoked from a Feishu event handler without a browser client connected.
- Feishu user IDs are stable and can be used as the external identity key for session ownership and admin checks.

---

## Success Criteria

- An admin can switch the bot's workspace entirely from Feishu without opening the desktop app.
- An employee can list, select, and create sessions, send messages, and receive streamed replies entirely from Feishu.
- Tool permission requests and `AskUserQuestion` prompts are actionable from Feishu and resume the turn correctly.
- An employee can interrupt an ongoing turn from Feishu.
- The Feishu channel does not weaken existing workspace tool-permission or bot-isolation policies.

---

## Sources / Research

- Feishu official integration guide: [Vercel Chat SDK + Lark message publish](https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/vercel-chat-sdk-lark-message-publish)
