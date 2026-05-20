---
title: Agent tool_use compactable prompt and result rendering
type: feat
status: active
date: 2026-05-20
---

# Agent tool_use compactable prompt and result rendering

## Summary

Extract the compactable show-more/less container from `ToolContent` into a reusable component, then use it inside `SubagentBriefStatus` to render both the Agent tool prompt and its matching tool_result with the same overflow behavior as other tools.

---

## Requirements

- R1. The Agent tool_use prompt must render inside a compactable container that shows "Show more / Show less" when content exceeds `192px`.
- R2. The Agent tool_use matching `tool_result` (looked up by `toolUseId`) must render inside the same compactable container.
- R3. Existing non-Agent tool rendering must remain unchanged.

---

## Scope Boundaries

- Does not change subagent drawer behavior or SSE event handling.
- Does not affect how non-Agent tools render.
- Does not modify the chat-store or message-normalizer.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/ai-elements/tool.tsx` — `ToolContent` already implements the compactable behavior (`COMPACTABLE_MAX_HEIGHT_PX = 192`, `ResizeObserver`, expand/collapse toggle). This is the pattern to extract and reuse.
- `src/client/components/MessageList.tsx` — builds `resultMap: Map<string, ToolResultPart>` from all messages; the Agent tool_use special-case currently does not pass the result into `SubagentBriefStatus`.
- `src/client/components/SubagentBriefStatus.tsx` — current Agent brief-status card; has a simple manual collapsible prompt toggle that should be replaced by the reusable compactable container.

---

## Key Technical Decisions

- **Extract a standalone `CompactableContainer` component** rather than importing `ToolContent` directly into `SubagentBriefStatus`. `ToolContent` wraps children in `p-3 text-text-primary` styling that does not match the subagent card's layout. A thin wrapper component keeps both consumers clean.
- **Pass the full `ToolResultPart` into `SubagentBriefStatus`** from `MessageList` rather than looking it up again inside the component. `resultMap` is already built at the list level; passing it down avoids duplicating the lookup logic.

---

## Implementation Units

### U1. Extract `CompactableContainer` from `ToolContent`

**Goal:** Create a reusable compactable wrapper that any component can use for show-more/less overflow behavior.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Create: `src/client/components/ai-elements/compactable-container.tsx`
- Modify: `src/client/components/ai-elements/tool.tsx`

**Approach:**
- Move the `COMPACTABLE_MAX_HEIGHT_PX` constant, the `ResizeObserver` measurement logic, and the expand/collapse toggle into a new `CompactableContainer` component that accepts `children` and an optional `className`.
- Update `ToolContent` to delegate its body to `CompactableContainer`, preserving existing styling (`space-y-2 p-3 text-text-primary`).

**Patterns to follow:**
- `ToolContent` in `src/client/components/ai-elements/tool.tsx` for the overflow measurement and toggle UI.

**Test scenarios:**
- Happy path: Content taller than `192px` renders with "Show more" toggle; clicking expands to full height and label changes to "Show less".
- Edge case: Content shorter than `192px` renders without any toggle.

**Verification:**
- `ToolContent` continues to work identically for non-Agent tools.
- New component compiles and is importable from `SubagentBriefStatus`.

---

### U2. Render Agent prompt and result with `CompactableContainer`

**Goal:** Replace the manual prompt toggle in `SubagentBriefStatus` with `CompactableContainer` for both prompt and result.

**Requirements:** R1, R2

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/SubagentBriefStatus.tsx`
- Modify: `src/client/components/MessageList.tsx`

**Approach:**
- Add `result?: ToolResultPart` prop to `SubagentBriefStatus`.
- In `MessageList.tsx`, look up `resultMap.get(part.toolUseId)` and pass it into `<SubagentBriefStatus>`.
- In `SubagentBriefStatus`, replace the manual `showPrompt` state and toggle with two `CompactableContainer` blocks:
  - One for the prompt (labeled "Prompt").
  - One for the result output (labeled "Result", only when result exists).
- Remove the old collapsible prompt toggle code.

**Patterns to follow:**
- `ToolInput`/`ToolOutput` in `src/client/components/ai-elements/tool.tsx` for the labeled-section pattern.

**Test scenarios:**
- Happy path: Agent tool_use renders with prompt in compactable container; when result arrives, a second compactable container appears for the result.
- Edge case: Agent tool_use without a prompt key renders without prompt section.
- Edge case: Agent tool_use whose result has `isError: true` renders the error text in the result container.

**Verification:**
- Agent brief status renders prompt and result with show-more/less toggles when content is long.
- No visual regressions in the status badge, elapsed time, or tool-count meta row.

---

## System-Wide Impact

- **Unchanged invariants:** Non-Agent tool rendering via `ToolContent` is unchanged. The `resultMap` lookup already exists; we only plumb the result one level deeper.
