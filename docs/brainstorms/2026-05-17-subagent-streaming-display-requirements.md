---
date: 2026-05-17
topic: subagent-streaming-display
---

# Subagent Streaming Display

## Summary

Add real-time subagent visibility to the GUI: a brief, rich status line in the main message area for each running subagent, with full streaming detail available on demand in a dedicated right-side panel. The panel's conversation rendering uses the same shared message renderer and `ai-elements` design system as the main chat panel for visual parity.

---

## Problem Frame

The Claude Code SDK emits subagent messages during streaming with `parent_tool_use_id` set, but the current SSE emitter silently drops them (`sse-emitter.ts:71-74`). Users have no visibility into subagent activity — the GUI appears idle while subagents perform work in the background. This is particularly problematic when multiple review agents run concurrently (e.g., coherence, feasibility, security reviewers), as the user cannot tell what is happening or when it will complete.

Meanwhile, the subagent detail surface that does exist uses custom renderers that look and behave differently from the main chat. Text is plain rather than markdown, thinking blocks lack collapsible UI, and tool cards use lightweight styling instead of the structured `Tool` component. This inconsistency makes the subagent conversation feel like a second-class view, even though it contains the same kinds of content (text, reasoning, tool calls) as the main chat.

The original bottom-drawer design also competes for vertical space with the main chat and approval surface. A right-side panel provides more horizontal room for reading code and tool output, and a dedicated open button prevents accidental drawer opens when interacting with the brief status body.

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

**Subagent detail panel**

- R7. A right-side panel must display the full subagent conversation.
- R8. The panel must open only when the user clicks a dedicated button in the brief status header.
- R9. The panel must render subagent messages through the same shared message renderer as the main chat, using the `ai-elements` design system.
- R10. The panel must continue receiving and displaying streaming updates while open.
- R11. The panel must be dismissible without affecting subagent execution; streaming continues in the background while closed.
- R12. When multiple subagents run concurrently, each must have an independent brief status and independently openable panel.

**Conversation rendering parity**

- R13. A shared message renderer must be extracted from the main chat's message rendering logic and consumed by both the main chat and the subagent panel.
- R14. The shared renderer must produce visual parity between surfaces: assistant messages flush-left with no bubble, user messages right-aligned with `bg-msg-user`, text rendered as markdown, thinking blocks collapsible via `Reasoning`, and tool_use/tool_result displayed via `Tool`.

**Completion and history**

- R15. When a subagent finishes, its brief status must transition from "running" to "completed" (or "error" if it failed) and must remain visible in the message history.
- R16. For loaded historical sessions, if the SDK exposes historical subagent data, the brief status must remain clickable and the panel must replay the subagent conversation.

---

## Acceptance Examples

- AE1. **Covers R4, R5, R6.** Given an active session where the main assistant invokes `ce-research`, when the subagent starts, the main message area shows a status line reading "Running `ce-research` • 0s • 0 tools" with a pulsing indicator. After 10 seconds and 3 tool uses, it updates to "Running `ce-research` • 10s • 3 tools".

- AE2. **Covers R7, R8, R9, R10.** Given a running subagent with visible brief status, when the user clicks the dedicated open button in the header, a right-side panel slides in showing the subagent's conversation so far — user prompt, assistant text, tool_use cards, and tool_result blocks. If the subagent emits new messages while the panel is open, they appear at the bottom in real time.

- AE3. **Covers R11, R12.** Given two concurrent subagents (`ce-research` and `ce-security-review`) with open panels, when the user dismisses the `ce-research` panel, the `ce-security-review` panel remains open and both subagents continue streaming. The brief status for `ce-research` continues updating in the main message area.

- AE4. **Covers R15, R16.** Given a completed session loaded from history containing a subagent invocation, when the user views the message history, the brief status shows "Completed `ce-research` • 45s • 12 tools". Clicking the open button shows the panel and replays the full subagent conversation.

- AE5. **Covers R13, R14.** Given the same subagent conversation rendered in both the main chat (if inlined) and the right-side panel, both surfaces use identical styling for assistant text, user bubbles, thinking collapsibles, and tool cards. Changing the shared renderer's styling affects both surfaces.

---

## Success Criteria

- A user can tell at a glance which subagents are running, for how long, and how much work they've done, without scrolling through detailed output.
- A user can open any subagent's panel to inspect its detailed work, dismiss it, and return to the main conversation without losing context.
- The subagent panel's conversation looks and behaves like the main chat panel — a user cannot tell they are different rendering systems.
- The main message area remains readable and uncluttered even when multiple lengthy subagents run concurrently.
- A downstream implementer can tell the handoff was clean: all behavioral requirements have R-IDs, the SSE event vocabulary is defined, component boundaries (brief status vs. panel vs. shared renderer) are explicit, and the shared renderer is a single source of truth.

---

## Scope Boundaries

- Subagent resuming / `SendMessage` continuation workflow is out of scope for v1. This feature is display-only.
- Modifying how the main assistant message incorporates or summarizes subagent results is out of scope.
- Inline expandable subagent detail within the main message stream is out of scope; the panel is the exclusive detail surface.
- Interacting with the subagent from the panel (e.g., sending messages, approving tools) is out of scope; the panel is read-only for v1.
- Changes to the brief status body content or layout beyond the click target are out of scope.
- Changes to the SDK's subagent storage format or persistence behavior are out of scope.

---

## Key Decisions

- **Shared message renderer over direct component swap.** Rationale: eliminates future drift between the main chat and subagent panel. Any design-system change (new part type, styling update) propagates to both surfaces automatically.
- **Right-side panel over bottom drawer.** Rationale: more horizontal space for reading code and tool output; does not compete with the main chat and approval surface for vertical space.
- **Button-only trigger over full-card click.** Rationale: the brief status body contains collapsible content (prompt, result) that users may want to interact with without opening the panel. A dedicated button makes the action explicit and prevents accidental opens.
- **Exact layout parity over compact bubble style.** Rationale: the subagent conversation is a first-class chat view. Using the same layout as the main chat (no assistant bubble, user bubble on right) makes it immediately familiar.

---

## Dependencies / Assumptions

- The SDK emits subagent messages with `parent_tool_use_id` during the live streaming pass.
- The SDK's `getSessionMessages` (or a companion API) exposes historical subagent messages for replay.
- Subagent invocation is represented as a `tool_use` block with `name: "Agent"`.
- The client already supports collapsible UI primitives (Radix Collapsible) and can extend them to a panel/sheet pattern.
- Subagent message types (`SubagentMessage`, `SubagentPart`) can be adapted to the shared renderer's interface without loss of information.
- The `ai-elements` components (`Message`, `MessageContent`, `CompactableText`, `Reasoning`, `Tool`) function correctly in the panel context without modification.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Technical] What is the exact SSE event shape for subagent messages? The SDK's `parent_tool_use_id` structure must be mapped to the `SseEvent` union.
- [Needs research] Does the SDK's `getSessionMessages` include subagent messages, or is a separate API call required to fetch historical subagent conversations?
- [Needs research] How should the "progress hint" be derived? Options: echo the most recent subagent tool name, parse the subagent's latest thinking block, or use a static description from the Agent tool input.
- [Technical] How should subagent `thinking` parts signal streaming state to the `Reasoning` component? Subagent parts may lack the `state` field present in main-chat thinking parts.
- [Technical] How should subagent `tool_use`/`tool_result` pairing work in the shared renderer? Main chat pairs across messages via `resultMap`; subagent messages may structure these differently.
