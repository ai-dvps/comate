---
date: 2026-05-16
topic: prompt-input-and-streaming-input-mode
---

# Rich Prompt Input + Streaming Input Mode with Approvals

## Summary

Replace the single-line textarea + Send icon in the chat panel with a rich prompt input (auto-grow with a height ceiling, no horizontal scroll ever, Send-flips-to-Stop-with-confirm, and a Clear button), and move the server from single-prompt SDK calls to one long-lived Streaming Input Mode `query()` per session that keeps running in the background, with tool-permission requests and `AskUserQuestion` clarifying questions surfaced as a pinned banner above the input.

---

## Problem Frame

Today the chat panel renders a one-row `<textarea>` whose height is capped by Tailwind's `max-h-32` and whose horizontal overflow behavior is left to the browser. Long pasted prompts squish into a thin strip, the cursor can land outside the visible area, and there is no way to interrupt Claude once a message is sent — the only signal a user has is the chat going quiet. There is also no Clear affordance; users delete by hand when they want to revise a draft.

The server speaks to the Claude Agent SDK in **single-prompt mode** (`query({ prompt: '<string>' })`). That mode is incompatible with `canUseTool`: when Claude wants to run a tool that isn't auto-approved, or when it invokes `AskUserQuestion` to clarify the user's intent, the SDK has no callback to pause on, so today the app effectively runs with all tools auto-allowed and `AskUserQuestion` results are unobservable. The mismatch between the SDK's interactive surface and the app's one-shot HTTP shape is the structural reason these features are missing — fixing the input UX without addressing the input mode would leave the chat feeling polished but still mute when Claude tries to talk back.

---

## Actors

- A1. **Developer**: the human using the GUI to drive a Claude Code session. Sends prompts, watches output stream in, sometimes wants to interrupt, occasionally needs to approve or steer a tool call.
- A2. **Claude Code CLI / other SDK consumers**: any process other than this app that runs against the same workspace directory. Reads and writes the same session JSONL files and `.claude/settings.local.json` permission rules.

---

## Key Flows

- F1. **Send a message in an existing session**
  - **Trigger:** A1 types in the prompt input and clicks Send (or presses Enter).
  - **Actors:** A1
  - **Steps:** Input is committed; Send transitions to Stop with a loading state; the user's message appears in the conversation; assistant output streams in incrementally.
  - **Outcome:** The turn resolves; the button returns to Send; the session's long-lived `query()` remains open and ready for the next message.
  - **Covered by:** R3, R4, R5, R10, R20

- F2. **Stop a running turn**
  - **Trigger:** A1 clicks the Stop button while a turn is streaming.
  - **Actors:** A1
  - **Steps:** An anchored popover opens with Cancel / Confirm. Cancel returns to the running Stop state. Confirm interrupts the current turn at the SDK level. Streaming halts; partial output already on screen is retained; the button returns to Send.
  - **Outcome:** The session's `query()` is still open; a follow-up message can be sent immediately.
  - **Covered by:** R6, R7, R8, R21

- F3. **Approve, deny, or always-allow a tool call**
  - **Trigger:** Claude attempts a tool whose permissions aren't auto-approved.
  - **Actors:** A1, A2 (the rule, once persisted, is shared with A2)
  - **Steps:** A banner pinned above the input shows the tool name, a summary of its input, and Allow / Allow always / Deny buttons. Allow lets the tool execute as Claude requested. Allow always additionally writes a matching rule to the workspace's `.claude/settings.local.json` via the SDK's permission-update mechanism. Deny returns a denial to Claude, which may adjust its approach. Streaming output continues underneath.
  - **Outcome:** The agent proceeds with the user's decision; future identical requests are silent if Allow always was used.
  - **Covered by:** R11, R12, R13, R14, R17

- F4. **Answer an `AskUserQuestion` clarifying request**
  - **Trigger:** Claude calls the SDK's `AskUserQuestion` tool with one or more multiple-choice questions.
  - **Actors:** A1
  - **Steps:** The same banner surface presents the question(s) and option list (including any `preview` content when present). The user selects an option per question; selections are returned to Claude.
  - **Outcome:** Claude continues the turn with the user's answers in context.
  - **Covered by:** R11, R15, R16

- F5. **Background work and reconnection**
  - **Trigger:** A1 switches to a different session, closes the workspace tab, or closes the browser while a turn is running.
  - **Actors:** A1
  - **Steps:** The server keeps the session's `query()` alive. Returning to the session resubscribes to the running stream and catches up on any output emitted while disconnected.
  - **Outcome:** Work the agent did while the user was away is visible when the user returns; the session continues from wherever the agent reached.
  - **Covered by:** R18, R19, R22

---

## Requirements

**Prompt input behavior**
- R1. The prompt input is a multi-line text area that grows in height as the user types or pastes, up to a configured maximum height. Past the maximum, the area shows a vertical scrollbar; height does not increase further.
- R2. The prompt input never shows a horizontal scrollbar. Long lines wrap. Pasted content with embedded newlines preserves its line breaks.
- R3. The prompt input shows placeholder text when empty and visually distinguishes the focused state.
- R4. Enter sends the message. Shift+Enter inserts a newline. The current keyboard contract is preserved.
- R5. A Send button is visible on the right side of the input. While the textarea is empty or while no session is active, Send is disabled. When the textarea has content and a session is active, Send is enabled.

**Send / Stop / Clear**
- R6. When a turn is streaming, the Send button is replaced by a Stop button with a visible loading indicator.
- R7. Clicking Stop opens an anchored confirmation popover with Cancel and Confirm. Cancel dismisses the popover and leaves the turn running. Confirm interrupts the current turn at the SDK level.
- R8. Once a turn is fully interrupted or completes (success, error, or interrupted), the button reverts to Send.
- R9. A Clear button is visible next to the Send button when the textarea contains content. Clicking Clear empties the textarea draft only. It does not affect chat history, the live stream, the session, or any pending approval banner.

**Session continuity**
- R10. New sessions are sent to the SDK with no resume ID. The SDK-assigned session ID is captured from the response stream and used for all subsequent turns. Existing sessions are resumed via the SDK's `resume` mechanism.
- R11. The app uses Streaming Input Mode. Each session has at most one long-lived `query()` open on the server, fed by an input channel that the server pushes new user messages into.

**Approvals and clarifying questions**
- R12. When the SDK requests permission for a tool call that isn't auto-approved, a banner appears pinned above the prompt input showing the tool name, a summary of the tool input, and Allow / Allow always / Deny buttons. The chat history continues to scroll underneath.
- R13. Allow permits the tool to execute with the original input. Deny blocks the tool and returns a denial message to Claude. Allow always permits the tool *and* persists a matching rule by echoing the SDK's `localSettings` permission-update suggestion, which writes to `.claude/settings.local.json` under the workspace's directory.
- R14. While an approval is pending, the agent's turn is paused at the SDK level. Streaming output that has already arrived stays visible. The user can scroll the conversation, type into the input, and click Send — but Send is queued until the pending approval is resolved (it does not interrupt the turn or skip ahead of the approval).
- R15. When Claude calls `AskUserQuestion`, the same banner surface presents the question text, header, and option list. Multi-select questions allow multiple selections; single-select allows one. If the SDK provides option previews (because the app enables `previewFormat`), the banner renders them alongside the option label.
- R16. The banner shows one request at a time. If a second request arrives while one is pending, it queues FIFO. The banner cannot be dismissed except by Allow / Allow always / Deny (or by selecting answers for `AskUserQuestion`). Closing the tab or refreshing the page does not silently deny the request — on reconnect, the same banner is shown.
- R17. Approval rules persisted via R13 are read by the Claude Code CLI and any other SDK consumer running in the same workspace directory. The app does not maintain its own parallel rule store.

**Background sessions and reconnection**
- R18. The server keeps each session's `query()` alive in the background even when the user switches sessions, closes the workspace tab, or closes the browser. The query is closed only when the session is deleted or the server shuts down.
- R19. When the user returns to a session whose `query()` is running, the client resubscribes to the live stream and catches up on any output emitted while disconnected. Output that arrived before reconnect is visible without re-running the turn.
- R20. The existing streaming-output rendering (partial messages, tool blocks, thinking blocks) continues to work unchanged. The new approval banner is an additional event channel; it does not replace or alter the existing message stream.

**Failure surfaces**
- R21. If the SDK interrupt fails or times out, the user sees an in-conversation system note explaining the failure and the button remains in the Stop state until the SDK resolves (success or error).
- R22. If the server restarts while a session's `query()` is open, the next user message in that session reopens the query with `resume:` against the SDK-stored session ID, and the affected sessions display a system note indicating that background work was lost on restart.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given the input is empty, when the user pastes a 200-word paragraph with embedded newlines, the textarea expands vertically to fit the content up to the maximum height, then begins to show a vertical scrollbar; no horizontal scrollbar ever appears, regardless of paragraph length.
- AE2. **Covers R6, R7, R8.** Given a turn is streaming, when the user clicks Stop and then clicks Confirm in the popover, the SDK interrupt fires, streaming halts within a few hundred milliseconds, partial output already rendered is retained, and the button returns to Send.
- AE3. **Covers R7.** Given the Stop popover is open, when the user clicks Cancel (or presses Escape), the popover closes and the turn continues streaming without interruption.
- AE4. **Covers R9.** Given the user has typed a multi-line prompt and a turn is *also* streaming, when the user clicks Clear, the textarea is emptied but the streaming output and Stop button are unaffected.
- AE5. **Covers R12, R13.** Given the agent attempts to write a file in a path that isn't auto-approved, when the user clicks Allow always, the tool executes and the same tool-call shape made in any subsequent session (including via the Claude Code CLI) skips the banner.
- AE6. **Covers R14.** Given the agent's turn is paused on a pending approval banner, when the user types a new message and clicks Send, the message is queued client-side and does not transmit until the user resolves the banner; clicking Stop is *not* the way to discard the pending approval.
- AE7. **Covers R15.** Given the agent invokes `AskUserQuestion` with two questions (one single-select, one multi-select), when the user selects one option for the first and two options for the second and confirms, the agent receives both answers and continues the turn.
- AE8. **Covers R10, R11.** Given a fresh draft session, when the user sends the first message, the SDK-assigned session ID is captured and the long-lived `query()` opens; subsequent sends in the same session push to the same `query()`'s input channel without re-resuming.
- AE9. **Covers R18, R19.** Given a session is mid-stream when the user navigates to a different session and waits 30 seconds, when the user returns, the previously-running session shows all output that arrived during the absence, and the turn continues (or has completed, in which case the result is fully visible).
- AE10. **Covers R22.** Given a session's `query()` is open when the server restarts, when the user sends the next message in that session, a system note appears in the conversation explaining the restart, and the agent resumes context via the SDK's session storage.

---

## Success Criteria

- A user can compose, send, interrupt, and approve tool calls inside a single chat panel without leaving the input area. The input grows naturally with content, never overflows horizontally, and provides clear stop and clear affordances.
- Tool-permission rules set via "Allow always" are observably honored by the Claude Code CLI when run from the same workspace directory.
- `AskUserQuestion` is no longer silent: when the agent calls it, the user sees the question(s), answers, and the conversation continues.
- A downstream implementer can take this doc and `ce-plan` it without needing to invent product behavior, the lifecycle of a streaming-input session, what counts as "Stop," how "Allow always" persists, or how the banner relates to the conversation thread.
- Background work survives session switches and tab closes (within the same server process); a session opened, sent, and then walked away from continues to do work and shows that work on return.

---

## Scope Boundaries

- Approve-with-changes (modifying tool input before allowing). Deny + retype is the v1 workaround.
- A settings UI for editing or revoking `.claude/settings.local.json` rules. Users edit the file by hand or via the CLI.
- Multi-machine / cross-host session resume via a `SessionStore` adapter.
- Image, file, or other non-text attachments in the prompt input. File mentions, slash commands, voice input.
- Light-mode theming for the new input, banner, and popover surfaces.
- Tool approvals for tool calls made by subagents (the SDK does not currently surface `AskUserQuestion` from subagents).
- A permission-mode toggle (plan / acceptEdits / bypassPermissions). The default mode is used; switching modes is a separate feature.
- Inline-message-card and modal approval surfaces. Rejected during dialogue in favor of the banner.
- Soft-interrupt that lets in-progress tool calls finish before stopping. Stop hits the SDK's turn-level interrupt; the doc does not promise tool-level granularity.
- Persistent draft sync across devices. Draft persistence is client-only and per-session.
- Exposing or editing the per-session background-query cap as a user-visible setting.

---

## Key Decisions

- **Long-lived `query()` per session, kept alive in the background.** Alternatives considered: one-`query()`-per-Send (closest to today's per-turn HTTP shape, simplest server state) and single-active-stream-only (close all but the focused session). The chosen shape makes background work observable on return and is the natural fit for Streaming Input Mode, at the cost of holding open Claude processes per active session. The cost is acceptable because the use is local-developer-driven; planning will bound it.
- **Banner above input for approvals and `AskUserQuestion`.** Alternatives considered: inline message card (more conversational but mixes user-decision UI with assistant content), modal (most explicit but most disruptive), side-panel queue (least disruptive but hides urgency). Banner pins the request, lets the user keep reading context underneath, and matches both surface types (permission and clarifying-question) without inventing two UIs.
- **"Allow always" persists via SDK `localSettings` (cwd-scoped).** Alternatives considered: app-owned per-workspace store (cleaner isolation, no CLI interop), both / write-through (doubled storage, harder to keep consistent), per-session memory only (no persistence). Honoring the SDK's mechanism gives free interop with the CLI and any other SDK consumer in the same directory and keeps the app from owning a parallel permission store.
- **Stop = SDK interrupt of the current turn, not session teardown.** Alternatives considered: terminate the entire long-lived query (heavy, loses background state), soft-interrupt that drains in-progress tool calls (no SDK affordance for this). Interrupt-then-keep-alive matches what users mean by "stop" in a chat UX.
- **Anchored confirm popover for Stop.** Alternatives considered: inline transform with auto-revert (lighter but easier to misclick during high-stress moments), press-and-hold (novel, less discoverable), modal (most disruptive). A popover anchored to the button is explicit, low-friction, and dismissable with Escape.

---

## Dependencies / Assumptions

- The Claude Agent SDK version in use supports `canUseTool` with `updatedPermissions` carrying `localSettings`-destination suggestions (the "Approve and remember" pattern in the SDK docs). The currently-installed `^0.2.141` is assumed sufficient; verify during planning.
- The SDK's Streaming Input Mode can be driven by an indefinitely-open async iterable of `{ type: 'user', message }` frames, with the iterator pulled by the SDK as it processes turns. This is the documented pattern.
- `query.interrupt()` is safe to call mid-tool-call and reliably returns control without corrupting the long-lived session.
- The existing per-message SSE protocol can be extended with new event types (pending-approval, approval-resolved, `AskUserQuestion` events, queue-state events) without breaking the v1 renderer beyond additive changes.
- Writing to `.claude/settings.local.json` from within the SDK does not require the app to do file IO itself; the SDK handles persistence when the suggestion is echoed back.
- Server process can hold at least dozens of open Claude CLI subprocesses without resource issues on a developer machine; planning will pick a concrete cap and surface a queue when exceeded.
- The currently-shipped AI Elements rendering surface (markdown, code blocks, tool, reasoning) is unchanged by this work; the approval banner is a new component that styles consistently with that surface.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R1][Design] What is the exact maximum height of the prompt input (a fixed pixel value, a viewport percentage, a number of visible lines)? Suggested starting point: ~40% of the chat-panel viewport, but pin a concrete value during planning.
- [Affects R11, R18][Technical] How does the long-lived query's input channel get implemented — a pushable async iterator (e.g., a queue with a deferred reader), an in-memory event bus, or a different pattern? What happens when the SDK drains the iterator faster than the user types (back-pressure, idle waits)?
- [Affects R12, R14, R15][Technical] How does the server bridge a pending `canUseTool` callback to a banner click in the browser? Candidates: SSE event for the request + a separate REST POST for the response, a per-session WebSocket, or a long-poll. The chosen mechanism interacts with R19 (reconnection / replay).
- [Affects R15][Technical] Should `toolConfig.askUserQuestion.previewFormat` be set to `"markdown"` (consistent with the existing markdown rendering) or `"html"` (richer visual previews but requires sanitization handling)? Default suggestion: `"markdown"`.
- [Affects R18, R19][Technical] How are missed events stored for replay on reconnect — an in-memory ring buffer per session, persisted alongside the session JSONL, or derived from the SDK's session-on-disk content? What is the replay window?
- [Affects R18][Technical] What is the bound on concurrent background-alive `query()` instances per server process, and what is the behavior when the bound is hit (queue, evict oldest, refuse new session)?
- [Affects R22][Technical] On server restart, how does the client detect that background sessions were lost — a session-version header on reconnect, an explicit "server-restarted" SSE event, or via the lack of an active query? The system-note copy depends on the detection mechanism.
- [Affects R14][Needs research] What does the SDK do when `canUseTool` stays pending for a very long time (minutes / hours)? The docs say it can stay pending indefinitely until cancelled, but practical limits on TCP keep-alive and Claude binary subprocess health should be confirmed.
- [Affects R16][Design] Approval banner visual treatment when queued: does the banner show "1 of 3" or surface them strictly one-by-one without a count? What is the close-vs-resolve affordance when the banner is *not* dismissible?
- [Affects R12, R13][Design] Tool-input summary inside the banner: how much of the input is shown by default (the full JSON, a one-line summary, the first N keys), and is there an expand affordance? Some inputs are large (Write content, Bash with long commands).
- [Affects R5, R9][Design] When the input area is disabled (no active session), does the Clear button render at all? What about the Send button — disabled state styling vs. hidden?
