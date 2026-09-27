---
title: "fix: Hide empty tool-result user messages in subagent conversation"
description: Filter out tool_result-only user messages from SubagentConversation rendering to prevent empty message boxes.
type: fix
created: 2026-05-30
status: completed
---

## Problem Frame

In the subagent conversation panel, user messages that contain only `tool_result` parts render as empty message boxes. These messages are created when a subagent's tool calls receive results — the result is appended as a new `role: 'user'` message containing a single `tool_result` part.

`ChatMessageRenderer` does not have a rendering branch for `part.type === 'tool_result'` inside its `message.parts.map()`; it only renders `text`, `thinking`, and `tool_use` parts. When a message contains only `tool_result` parts, every part maps to `null`, leaving the `<Message>` wrapper with empty `<MessageContent>`. This produces a visible but empty user-aligned message bubble.

The main chat surfaces (`MessageList.tsx` and `VirtualizedMessageList.tsx`) already solve this by filtering out messages that contain only `tool_result` parts via `isToolResultOnly`. The subagent conversation never applied the same filter.

## Summary

Add the same `tool_result`-only filtering logic to `SubagentConversation.tsx` so that subagent tool results are consumed exclusively through the `resultMap` (for pairing with their parent `tool_use` in `ChatMessageRenderer`) and never rendered as standalone empty user messages.

## Key Technical Decisions

- **Reuse existing filter pattern:** Match the `isToolResultOnly` predicate and `messages.filter((m) => !isToolResultOnly(m))` pattern already present in both `MessageList.tsx` and `VirtualizedMessageList.tsx`. This keeps behavior consistent across all conversation surfaces.
- **Keep resultMap intact:** Filtering the rendered list does not remove messages from the `messages` array passed to `buildResultMap`, so `tool_use` cards in the subagent conversation still receive their paired results.

## Scope Boundaries

### In Scope
- Filter `tool_result`-only user messages from `SubagentConversation` rendering

### Out of Scope
- Changes to how `tool_result` parts are stored in subagent state
- Changes to `ChatMessageRenderer` part rendering
- Changes to main-chat message filtering

## Implementation Units

### U1. Filter tool_result-only messages in SubagentConversation

**Goal:** Prevent empty user message boxes in the subagent conversation panel.

**Files:**
- Modify: `src/client/components/SubagentConversation.tsx`

**Approach:**

1. Add an `isToolResultOnly` helper function (identical to the one in `MessageList.tsx` and `VirtualizedMessageList.tsx`) that returns `true` when a `SubagentMessage` has `role === 'user'`, `parts.length > 0`, and every part is `type === 'tool_result'`.
2. Before mapping over `messages` in the JSX, filter them with `messages.filter((m) => !isToolResultOnly(m))`.
3. The `resultMap` must continue to be built from the original unfiltered `messages` array so that `tool_use` parts in the rendered messages can still look up their paired `tool_result`.

**Patterns to follow:**
- Copy the exact predicate shape from `MessageList.tsx` lines 42–48.

**Test scenarios:**

- **Happy path — subagent with tool use:** Given a subagent conversation containing `tool_use` followed by `tool_result`, the `tool_use` renders as a Tool card with its output visible, and no empty user message bubble appears for the `tool_result`.
- **Edge case — multiple tool results:** Given a subagent that uses three tools sequentially, three Tool cards render with their respective outputs, and no empty user messages appear between them.
- **Edge case — user text + tool result:** Given a subagent user message containing both `text` and `tool_result` parts (if this ever occurs), the message is not filtered and renders its text content normally. (The filter requires *every* part to be `tool_result`.)
- **Edge case — no messages:** Given an empty subagent conversation, the existing "Subagent started... waiting for output" placeholder continues to render.

**Verification:**
- Open a subagent panel for a session that triggers tool use (e.g., `ce-research` or `ce-plan`).
- Confirm that tool cards show their output.
- Confirm that no empty user-aligned message bubbles appear after tool cards.
