---
date: 2026-05-17
topic: subagent-streaming-display
---

# Subagent Streaming Display

## Summary

Add real-time subagent visibility to the GUI: a brief, rich status line in the main message area for each running subagent, with full streaming detail available on demand in a dedicated bottom drawer.

---

## Problem Frame

The Claude Code SDK emits subagent messages during streaming with `parent_tool_use_id` set, but the current SSE emitter silently drops them (`sse-emitter.ts:71-74`). Users have no visibility into subagent activity — the GUI appears idle while subagents perform work in the background. This is particularly problematic when multiple review agents run concurrently (e.g., coherence, feasibility, security reviewers), as the user cannot tell what is happening or when it will complete.

Meanwhile, rendering full subagent streaming inline would clutter the main message area. Subagent conversations can be lengthy (dozens of messages with tool uses, thinking blocks, and text), and their detail is secondary to the main assistant's response.

---

## Requirements

**Subagent detection and streaming**

- R1. The SSE emitter must stop dropping messages that carry `parent_tool_use_id` and must emit them as typed subagent events.
- R2. The SSE protocol must support subagent lifecycle events: at minimum `subagent_start`, `subagent_delta`, and `subagent_done`.
- R3. The client chat-store must handle subagent SSE events and maintain subagent conversation state separately from main message parts.

**Brief status in main message**

- R4. Agent tool invocations (`tool_use` with `name: "Agent"`) must render a brief status component within the main message stream.
- R5. The brief status must display: the subagent type or description, execution state (running / completed / error), elapsed duration, a progress hint, and the number of tools the subagent has used so far.
- R6. The brief status must update in real-time as subagent events arrive; it must remain visible and accurate after the subagent completes.

**Detailed streaming in drawer**

- R7. A bottom drawer component must display the full subagent conversation.
- R8. The drawer must open when the user clicks or taps the brief status.
- R9. The drawer must render subagent messages (text, thinking, tool_use, tool_result) in a mini chat interface with its own scrolling.
- R10. The drawer must continue receiving and displaying streaming updates while open.
- R11. The drawer must be dismissible without affecting subagent execution; streaming continues in the background while closed.
- R12. When multiple subagents run concurrently, each must have an independent brief status and independently openable drawer.

**Completion and history**

- R13. When a subagent finishes, its brief status must transition from "running" to "completed" (or "error" if it failed) and must remain visible in the message history.
- R14. For loaded historical sessions, if the SDK exposes historical subagent data, the brief status must remain clickable and the drawer must replay the subagent conversation.

---

## Acceptance Examples

- AE1. **Covers R4, R5, R6.** Given an active session where the main assistant invokes `ce-research`, when the subagent starts, the main message area shows a status line reading "Running `ce-research` • 0s • 0 tools" with a pulsing indicator. After 10 seconds and 3 tool uses, it updates to "Running `ce-research` • 10s • 3 tools".

- AE2. **Covers R7, R8, R9, R10.** Given a running subagent with visible brief status, when the user clicks the status, a bottom drawer opens showing the subagent's conversation so far — user prompt, assistant text, tool_use cards, and tool_result blocks. If the subagent emits new messages while the drawer is open, they appear at the bottom in real time.

- AE3. **Covers R11, R12.** Given two concurrent subagents (`ce-research` and `ce-security-review`) with open drawers, when the user dismisses the `ce-research` drawer, the `ce-security-review` drawer remains open and both subagents continue streaming. The brief status for `ce-research` continues updating in the main message area.

- AE4. **Covers R13, R14.** Given a completed session loaded from history containing a subagent invocation, when the user views the message history, the brief status shows "Completed `ce-research` • 45s • 12 tools". Clicking it opens the drawer and replays the full subagent conversation.

---

## Success Criteria

- A user can tell at a glance which subagents are running, for how long, and how much work they've done, without scrolling through detailed output.
- A user can open any subagent's drawer to inspect its detailed work, dismiss it, and return to the main conversation without losing context.
- The main message area remains readable and uncluttered even when multiple lengthy subagents run concurrently.
- A downstream implementer can tell the handoff was clean: all behavioral requirements have R-IDs, the SSE event vocabulary is defined, and component boundaries (brief status vs. drawer) are explicit.

---

## Scope Boundaries

- Subagent resuming / `SendMessage` continuation workflow is out of scope for v1. This feature is display-only.
- Modifying how the main assistant message incorporates or summarizes subagent results is out of scope.
- Inline expandable subagent detail within the main message stream is out of scope; the drawer is the exclusive detail surface.
- Interacting with the subagent from the drawer (e.g., sending messages, approving tools) is out of scope; the drawer is read-only for v1.
- Changes to the SDK's subagent storage format or persistence behavior are out of scope.

---

## Key Decisions

- **Bottom drawer over inline expandable or modal.** Rationale: the user explicitly wants the main message kept clean, and a drawer provides dedicated vertical space for long subagent conversations without blocking the main chat.
- **Main message stays independent.** Rationale: subagent output is self-contained; merging it into the main assistant message would create confusion about authorship and make the main message unpredictably long.
- **Brief status is anchored to the Agent `tool_use` invocation.** Rationale: the SDK invokes subagents via `name: "Agent"` tool_use blocks; attaching status to this existing UI element creates a natural association.
- **Rich status includes duration, progress hint, and tool-use count.** Rationale: these three dimensions give the user a concrete sense of progress without requiring full detail.

---

## Dependencies / Assumptions

- The SDK emits subagent messages with `parent_tool_use_id` during the live streaming pass.
- The SDK's `getSessionMessages` (or a companion API) exposes historical subagent messages for replay.
- Subagent invocation is represented as a `tool_use` block with `name: "Agent"`.
- The client already supports collapsible UI primitives (Radix Collapsible) and can extend them to a drawer/sheet pattern.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Technical] What is the exact SSE event shape for subagent messages? The SDK's `parent_tool_use_id` structure must be mapped to the `SseEvent` union.
- [Needs research] Does the SDK's `getSessionMessages` include subagent messages, or is a separate API call required to fetch historical subagent conversations?
- [Needs research] How should the "progress hint" be derived? Options: echo the most recent subagent tool name, parse the subagent's latest thinking block, or use a static description from the Agent tool input.
