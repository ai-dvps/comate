---
title: Subagent Streaming Display — Panel and Renderer Parity
type: feat
status: active
date: 2026-05-29
origin: docs/brainstorms/2026-05-17-subagent-streaming-display-requirements.md
---

# Subagent Streaming Display — Panel and Renderer Parity

## Summary

Refactor the subagent detail surface from a bottom drawer to a right-side panel, narrow the open trigger to a dedicated button in the brief status header, and extract a shared message renderer so the subagent conversation uses the same `ai-elements` components as the main chat.

---

## Problem Frame

The existing subagent streaming display uses a bottom drawer with hand-rolled message rendering. This creates three problems: (1) the drawer competes for vertical space with the main chat and approval surface; (2) the custom conversation renderer looks and behaves differently from the main chat (plain text instead of markdown, simple thinking blocks instead of collapsible `Reasoning`, lightweight tool cards instead of structured `Tool`); (3) clicking anywhere on the brief status card opens the drawer, which is error-prone when users want to interact with the collapsible body content. (see origin: docs/brainstorms/2026-05-17-subagent-streaming-display-requirements.md)

---

## Requirements

- R7. A right-side panel must display the full subagent conversation.
- R8. The panel must open only when the user clicks a dedicated button in the brief status header.
- R9. The panel must render subagent messages through the same shared message renderer as the main chat, using the `ai-elements` design system.
- R10. The panel must continue receiving and displaying streaming updates while open.
- R11. The panel must be dismissible without affecting subagent execution; streaming continues in the background while closed.
- R12. When multiple subagents run concurrently, each must have an independent brief status and independently openable panel.
- R13. A shared message renderer must be extracted from the main chat's message rendering logic and consumed by both the main chat and the subagent panel.
- R14. The shared renderer must produce visual parity between surfaces: assistant messages flush-left with no bubble, user messages right-aligned with `bg-msg-user`, text rendered as markdown, thinking blocks collapsible via `Reasoning`, and tool_use/tool_result displayed via `Tool`.

**Origin acceptance examples:** AE2 (covers R7, R8, R9, R10), AE3 (covers R11, R12), AE5 (covers R13, R14)

---

## Scope Boundaries

- Subagent resuming / `SendMessage` continuation workflow is out of scope for v1. This feature is display-only.
- Modifying how the main assistant message incorporates or summarizes subagent results is out of scope.
- Inline expandable subagent detail within the main message stream is out of scope; the panel is the exclusive detail surface.
- Interacting with the subagent from the panel (e.g., sending messages, approving tools) is out of scope; the panel is read-only for v1.
- Changes to the brief status body content or layout beyond the click target are out of scope.
- Changes to the SDK's subagent storage format or persistence behavior are out of scope.
- Server SSE protocol extension (R1-R2) and chat-store subagent state (R3) are treated as already implemented by the prior plan.

### Deferred to Follow-Up Work

- Virtualized scrolling for very long subagent conversations (100+ messages)
- Subagent conversation search / filtering inside the panel
- Copy-to-clipboard or export of subagent conversation
- Message actions (copy, delete) in the subagent panel

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/MessageList.tsx` — `renderMessage` function (line ~193) maps `ChatMessage.parts` to ai-elements: `Message`/`MessageContent` for layout, `CompactableText` for text, `Reasoning` for thinking, `Tool` for tool_use. Builds `resultMap` to pair `tool_use` with `tool_result` across messages.
- `src/client/components/ai-elements/message.tsx` — `Message` takes `from: MessageRole`; `MessageContent` applies `bg-msg-user` bubble for user, flush-left for assistant.
- `src/client/components/ai-elements/reasoning.tsx` — `Reasoning` takes `isStreaming`, `defaultOpen`, `disableAutoBehavior`; auto-opens while streaming and auto-closes 1s after completion.
- `src/client/components/ai-elements/tool.tsx` — `ToolHeader` with status badge, `ToolContent` with `CompactableContainer`, `ToolInput`/`ToolOutput` for structured display.
- `src/client/components/SubagentBriefStatus.tsx` — entire header `<button>` is clickable to call `onOpenDrawer`. Collapsible body uses `CompactableContainer` for prompt/result.
- `src/client/components/SubagentDrawer.tsx` — bottom sheet (`fixed inset-x-0 bottom-0`, `h-[50vh]`). Renders `SubagentConversation`.
- `src/client/components/SubagentConversation.tsx` — custom ad-hoc renderer with inline bubbles. Does NOT use ai-elements.
- `src/client/components/FilePanel.tsx` and `src/client/components/Sidebar.tsx` — right-side panel pattern: `<aside>` with explicit width, `flex-shrink-0`, `border-r`, resize handle via mouse events.
- `src/client/components/ChatPanel.tsx` — manages `openDrawerToolUseId` state, renders `SubagentDrawer` at bottom.
- `src/client/stores/chat-store.ts` — `SubagentPart`, `SubagentMessage`, `SubagentState` types. `subagents: Record<string, SubagentState[]>`.

### Institutional Learnings

- SSE streams can close cleanly and drop pending events. The client retry pattern in `chat-store.ts` should be reused for any new stream consumer. (`docs/solutions/integration-issues/sse-clean-close-retry-2026-05-22.md`)
- No test framework exists in the project. Verification is manual via dev server.

---

## Key Technical Decisions

- **Extract shared renderer as a normalized message component rather than duplicating ai-elements imports.** Rationale: a single `MessageRenderer` component that accepts a normalized message format ensures the main chat and subagent panel stay in sync automatically. Duplicating the ai-elements wiring in `SubagentConversation` would achieve visual parity today but drift tomorrow.
- **Right-side panel follows the existing `FilePanel` / `Sidebar` pattern.** Rationale: the repo already has resizable side panels with `<aside>`, width prop, and resize handles. Reusing this pattern is consistent and requires no new UI primitives.
- **Button-only trigger over full-card click.** Rationale: the brief status body contains collapsible content (prompt, result, meta row) that users may want to interact with. A dedicated button makes the open action explicit and prevents accidental triggers.
- **Adapter layer for subagent part types rather than changing `SubagentPart` shape.** Rationale: `SubagentPart` lacks `state` fields present in `MessagePart` (e.g., thinking state, tool_use inputJsonStream). Rather than modifying the SSE protocol or chat-store to add these fields, the shared renderer accepts a normalized format and an adapter converts `SubagentPart` → normalized part on render.

---

## Open Questions

### Resolved During Planning

- **Panel width:** Start with a fixed width of `400px` (similar to Sidebar minimum), allow resize between `300px` and `600px`. Follows existing panel conventions.
- **Multiple concurrent panels:** Only one panel open at a time. Clicking a different subagent's open button closes the current panel and opens the new one. This matches the current `openDrawerToolUseId` single-value state and keeps layout simple.
- **Historical replay:** Best-effort. If `getSessionMessages` does not return subagent data inline, the brief status renders as non-clickable or with an empty panel.

### Deferred to Implementation

- **Exact adapter shape for subagent thinking state:** Whether to pass `isStreaming` to `Reasoning` based on subagent state (`subagent.state === 'running'`) or per-message heuristics. Implementation-time decision once the adapter is being written.
- **Tool result pairing in subagent context:** Main chat pairs `tool_use` with `tool_result` via `resultMap` across messages. Subagent messages may have tool results in the same message or adjacent messages. The adapter must handle either pattern.

---

## Implementation Units

### U1. Extract shared message renderer

**Goal:** Extract the message-to-UI mapping from `MessageList.tsx` into a shared `MessageRenderer` component that can render both main-chat and subagent conversations.

**Requirements:** R13, R14

**Dependencies:** None

**Files:**
- Create: `src/client/components/ChatMessageRenderer.tsx`
- Modify: `src/client/components/MessageList.tsx`

**Approach:**

1. **Define a normalized message format** inside `ChatMessageRenderer.tsx`:
   - `RenderableMessage`: `{ id, role, parts: RenderablePart[] }`
   - `RenderablePart`: text | thinking | tool_use | tool_result, with a unified shape that covers both `MessagePart` and `SubagentPart`.

2. **Extract rendering logic** from `MessageList.tsx`'s `renderMessage` function into `ChatMessageRenderer`:
   - `Message` / `MessageContent` wrapper based on `role`
   - `CompactableText` for text parts
   - `Reasoning` for thinking parts (accepts `isStreaming`, `duration`, `children`)
   - `Tool` / `ToolHeader` / `ToolContent` / `ToolInput` / `ToolOutput` for tool_use/tool_result pairs
   - `resultMap` building and tool state derivation (`toToolState`)

3. **Create adapter functions**:
   - `adaptChatMessage(msg: ChatMessage): RenderableMessage` — preserves existing behavior
   - `adaptSubagentMessage(msg: SubagentMessage, isRunning: boolean): RenderableMessage` — maps `SubagentPart` to `RenderablePart`, deriving `isStreaming` from the subagent's running state

4. **Update `MessageList.tsx`** to use `ChatMessageRenderer` instead of inline `renderMessage`. Preserve existing behavior exactly — this is a pure extraction.

**Patterns to follow:**
- Existing `MessageList.tsx` rendering logic for part-type mapping
- `src/client/components/ai-elements/tool.tsx` for `ToolState` derivation and result pairing

**Test scenarios:**
- Happy path: Main chat messages render identically after extraction — assistant text, user bubbles, thinking collapsibles, tool cards all unchanged.
- Edge case: Subagent message with text + thinking + tool_use in a single message renders all parts in order.
- Edge case: Subagent tool_use without a matching tool_result renders as "input-available" state.
- Integration: Changing `ChatMessageRenderer` styling affects both main chat and subagent panel.

**Verification:**
- Visual comparison: main chat looks pixel-identical before and after extraction.
- Subagent panel renders using the new component with correct layout.

---

### U2. Update brief status click behavior

**Goal:** Change `SubagentBriefStatus` so only a dedicated button in the header opens the panel, not the entire card.

**Requirements:** R8

**Dependencies:** None

**Files:**
- Modify: `src/client/components/SubagentBriefStatus.tsx`

**Approach:**

1. **Split the header button into two regions:**
   - Left region: non-clickable info (bot icon, subagent type label, status badge)
   - Right region: dedicated "Open" button with an expand icon or "View" label

2. **Remove the `onClick` handler** from the header wrapper. Add it only to the dedicated button.

3. **Preserve existing body behavior:** The collapsible body (description, prompt, result, meta row) remains interactable without opening the panel.

4. **Styling:** The dedicated button should be visually distinct — use a subtle border or background hover, and an expand icon (`PanelRightOpen` or similar from lucide-react).

**Patterns to follow:**
- Existing `SubagentBriefStatus.tsx` header layout and status badge styling
- `src/client/components/ai-elements/tool.tsx` for compact header patterns

**Test scenarios:**
- Happy path: Clicking the dedicated open button calls `onOpenDrawer(parentToolUseId)`.
- Happy path: Clicking the collapsible body (prompt, result) does NOT open the panel.
- Edge case: Brief status for a completed subagent — open button still works.
- Edge case: Very long subagent type or description — open button remains accessible.

**Verification:**
- Click the open button → panel opens.
- Click the body/prompt/result → panel does not open, body toggles as before.

---

### U3. Convert subagent drawer to right-side panel

**Goal:** Replace the bottom sheet with a right-side resizable panel following the existing `FilePanel` / `Sidebar` pattern.

**Requirements:** R7, R10, R11, R12

**Dependencies:** None

**Files:**
- Modify: `src/client/components/SubagentDrawer.tsx`
- Modify: `src/client/components/ChatPanel.tsx`

**Approach:**

1. **Rename conceptually** (optional): The component is still `SubagentDrawer` in filename but behaves as a panel. Keeping the filename avoids unnecessary rename churn; the prop/variable names can stay as-is.

2. **Replace bottom-sheet positioning with right-side `<aside>`:**
   - `className="relative bg-surface border-l border-border flex flex-col flex-shrink-0 h-full"`
   - Width: start at `400px`, allow resize between `300px` and `600px`
   - Resize handle on the left edge (`absolute left-0 top-0 bottom-0 w-1 cursor-col-resize`)
   - Remove the bottom overlay (`bg-overlay/40`)

3. **Move panel rendering in `ChatPanel.tsx`:**
   - Instead of rendering `SubagentDrawer` as an overlay at the bottom, render it as a sibling to the main chat area inside the flex row.
   - `ChatPanel` layout becomes: `flex flex-row h-full` with `[Sidebar?] [ChatArea] [SubagentPanel?]`
   - The panel takes space from the chat area; the chat area shrinks when the panel is open.

4. **Preserve panel behavior:**
   - Continue receiving streaming updates while open (already handled by chat-store subscriptions)
   - Dismissible via close button or Escape (already implemented)
   - Only one panel open at a time (already enforced by `openDrawerToolUseId` single-value state)

**Patterns to follow:**
- `src/client/components/FilePanel.tsx` — `<aside>` with width prop, resize handle, `flex-col`
- `src/client/components/Sidebar.tsx` — resize mouse event handling (`handleMouseDown`, `mousemove`, `mouseup`)

**Test scenarios:**
- Happy path: Panel opens on the right side, chat area shrinks to accommodate.
- Happy path: Panel is resizable by dragging the left edge.
- Happy path: Panel closes via X button or Escape; chat area returns to full width.
- Edge case: Panel open during streaming; new messages appear in real time.
- Edge case: Multiple subagents; opening a second subagent closes the first panel and opens the second.
- Edge case: Session switch → panel closes.

**Verification:**
- Visual check: panel sits on the right, chat area adjusts.
- Resize check: dragging the edge changes panel width within bounds.
- Close check: panel closes and chat area expands back.

---

### U4. Wire shared renderer into subagent panel

**Goal:** Replace `SubagentConversation`'s custom renderers with the shared `ChatMessageRenderer`.

**Requirements:** R9, R14

**Dependencies:** U1, U3

**Files:**
- Modify: `src/client/components/SubagentConversation.tsx`

**Approach:**

1. **Replace custom `MessageBlock` and `PartRenderer`** with `ChatMessageRenderer`.

2. **Import the subagent adapter** from `ChatMessageRenderer`:
   - Convert `SubagentMessage[]` to the normalized format using `adaptSubagentMessage`
   - Pass `isRunning` from `SubagentDrawer` so the adapter can derive `isStreaming` for thinking blocks

3. **Preserve auto-scroll behavior:**
   - Keep the existing `useEffect` that scrolls to bottom when `isRunning` and messages change
   - The scroll container remains inside `SubagentConversation`

4. **Preserve empty state:**
   - Keep the "Subagent started... waiting for output" placeholder when `messages.length === 0`

**Patterns to follow:**
- `src/client/components/MessageList.tsx` — how `ChatMessageRenderer` will be invoked
- Existing `SubagentConversation.tsx` auto-scroll and empty state behavior

**Test scenarios:**
- Happy path: Subagent text renders as markdown via `CompactableText`.
- Happy path: Subagent thinking renders as collapsible `Reasoning` with shimmer while running.
- Happy path: Subagent tool_use renders as structured `Tool` card with header, input, and output.
- Happy path: Subagent user messages (tool results) render right-aligned with `bg-msg-user` bubble.
- Edge case: Empty conversation → placeholder shown.
- Edge case: Very long subagent conversation → scrolls independently, auto-scroll while running.

**Verification:**
- Visual comparison: subagent panel conversation looks identical to main chat rendering.
- Thinking blocks: collapsible, auto-open while running.
- Tool cards: structured input/output, status badges.

---

### U5. Integration and layout adjustments

**Goal:** Wire the updated brief status, right-side panel, and shared renderer together; ensure normal tool_use rendering is unaffected.

**Requirements:** R4, R5, R6, R15, R16

**Dependencies:** U2, U3, U4

**Files:**
- Modify: `src/client/components/MessageList.tsx`
- Modify: `src/client/components/ChatPanel.tsx`

**Approach:**

1. **MessageList verification:**
   - Confirm `SubagentBriefStatus` is still rendered for `toolName === 'Agent'`
   - Confirm non-Agent `tool_use` still renders the existing `<Tool>` component
   - Confirm `onOpenDrawer` is passed correctly to `SubagentBriefStatus`

2. **ChatPanel layout verification:**
   - Confirm `SubagentDrawer` is rendered as a right-side sibling, not a bottom overlay
   - Confirm `openDrawerToolUseId` state management still works
   - Confirm drawer closes on session switch

3. **Historical session support:**
   - Brief status for historical Agent tool_use renders correctly
   - If no subagent state exists, the brief status shows fallback state and the open button may show an empty panel

**Patterns to follow:**
- Existing `MessageList.tsx` part rendering switch statement
- Existing `ChatPanel.tsx` layout and state management

**Test scenarios:**
- Happy path: Normal (non-Agent) tool_use → renders existing `<Tool>` unchanged.
- Happy path: Agent tool_use → renders `<SubagentBriefStatus>` with new button-only open behavior.
- Happy path: Two Agent tool_uses in the same session → both render brief statuses; clicking each opens its panel.
- Edge case: Session switch → panel closes.
- Edge case: Historical session with Agent tool_use but no subagent data → brief status shows fallback.

**Verification:**
- Full manual walkthrough of AE2–AE5 scenarios.
- Confirm non-Agent tools still render correctly.
- Confirm panel closes on Escape, close button, and session switch.

---

## System-Wide Impact

- **Message rendering parity:** The shared renderer is a new shared dependency. Any future change to message rendering (new part type, styling update) affects both surfaces automatically.
- **ChatPanel layout:** Changes from pure flex-col to flex-row (or nested flex) to accommodate the right-side panel. The approval banner, prompt input, and token usage bar must remain below the chat area, not shifted by the panel.
- **SubagentBriefStatus interaction:** The click target change is a UX breaking change — users who were used to clicking anywhere on the card must now click the button.
- **Unchanged invariants:** Non-subagent tool rendering, approval banners, prompt input, session management, message normalization, and SSE protocol paths are untouched.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Shared renderer extraction breaks main chat rendering | Extract incrementally: verify main chat is pixel-identical before wiring into subagent panel. |
| Right-side panel conflicts with existing sidebar (left) or FilePanel | Panel is on the right; sidebar and FilePanel are on the left. No z-index or layout conflict. |
| Subagent part type adapter misses edge cases (e.g., streaming thinking state) | Adapter derives `isStreaming` from subagent running state as a safe default. Can refine per-message later. |
| Panel resize handle interferes with chat scroll or other interactions | Resize handle is a narrow 4px strip. Follows existing Sidebar/FilePanel patterns that do not interfere. |
| Historical subagent data not inline (R16) | Documented as best-effort. Brief status degrades gracefully. |

---

## Documentation / Operational Notes

- No documentation updates required beyond the requirements and plan docs.
- No rollout or monitoring concerns — this is a pure client-side UI refactor with no external dependencies.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-17-subagent-streaming-display-requirements.md](../brainstorms/2026-05-17-subagent-streaming-display-requirements.md)
- **Prior plan:** [docs/plans/2026-05-17-014-feat-subagent-streaming-display-plan.md](2026-05-17-014-feat-subagent-streaming-display-plan.md)
- **Related code:** `src/client/components/MessageList.tsx`, `src/client/components/ai-elements/message.tsx`, `src/client/components/ai-elements/reasoning.tsx`, `src/client/components/ai-elements/tool.tsx`, `src/client/components/SubagentBriefStatus.tsx`, `src/client/components/SubagentDrawer.tsx`, `src/client/components/SubagentConversation.tsx`, `src/client/components/FilePanel.tsx`, `src/client/components/Sidebar.tsx`, `src/client/components/ChatPanel.tsx`, `src/client/stores/chat-store.ts`
