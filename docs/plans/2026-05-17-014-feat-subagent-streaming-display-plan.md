---
title: Subagent Streaming Display
type: feat
status: active
date: 2026-05-17
origin: docs/brainstorms/2026-05-17-subagent-streaming-display-requirements.md
---

# Subagent Streaming Display

## Summary

Add real-time subagent visibility to the GUI. Subagent messages (SDK messages carrying `parent_tool_use_id`) are currently dropped by the SSE emitter. This plan extends the SSE protocol with `subagent_start`, `subagent_delta`, and `subagent_done` events; adds client-side state tracking for subagent conversations; and introduces two new UI surfaces: a compact `SubagentBriefStatus` rendered inline for Agent `tool_use` blocks in the main message stream, and a bottom `SubagentDrawer` that displays the full subagent conversation on demand.

---

## Problem Frame

The Claude Code SDK emits subagent messages during streaming with `parent_tool_use_id` set, but `src/server/services/sse-emitter.ts:71-74` silently drops them. Users have no visibility into subagent activity — the GUI appears idle while subagents perform work. Meanwhile, rendering full subagent streaming inline would clutter the main message area; subagent conversations can be lengthy (dozens of messages with tool uses, thinking blocks, and text). A brief status in the main stream plus a dedicated detail drawer provides the right balance of awareness and cleanliness.

---

## Requirements

**Subagent detection and streaming**

- R1. The SSE emitter must stop dropping messages that carry `parent_tool_use_id` and must emit them as typed subagent events.
- R2. The SSE protocol must support subagent lifecycle events: `subagent_start`, `subagent_delta`, and `subagent_done`.
- R3. The client chat-store must handle subagent SSE events and maintain subagent conversation state separately from main message parts.

**Brief status in main message**

- R4. Agent tool invocations (`tool_use` with `name: "Agent"`) must render a brief status component within the main message stream.
- R5. The brief status must display: the subagent description, execution state (running / completed / error), elapsed duration, a progress hint (most recent tool name + input), and the number of tools the subagent has used so far.
- R6. The brief status must update in real-time as subagent events arrive; it must remain visible and accurate after the subagent completes.

**Detailed streaming in drawer**

- R7. A bottom drawer component must display the full subagent conversation.
- R8. The drawer must open when the user clicks the brief status.
- R9. The drawer must render subagent messages (text, thinking, tool_use, tool_result) in a mini chat interface with its own scrolling.
- R10. The drawer must continue receiving and displaying streaming updates while open.
- R11. The drawer must be dismissible without affecting subagent execution; streaming continues in the background while closed.
- R12. When multiple subagents run concurrently, each must have an independent brief status and independently openable drawer.

**Completion and history**

- R13. When a subagent finishes, its brief status must transition from "running" to "completed" (or "error") and must remain visible in the message history.
- R14. For loaded historical sessions, if the SDK exposes historical subagent data inline, the brief status must remain clickable and the drawer must replay the subagent conversation.

**Origin acceptance examples:** AE1 (covers R4, R5, R6), AE2 (covers R7, R8, R9, R10), AE3 (covers R11, R12), AE4 (covers R13, R14)

---

## Scope Boundaries

- Subagent resuming / `SendMessage` continuation workflow is out of scope for v1. This feature is display-only.
- Modifying how the main assistant message incorporates or summarizes subagent results is out of scope.
- Inline expandable subagent detail within the main message stream is out of scope; the drawer is the exclusive detail surface.
- Interacting with the subagent from the drawer (e.g., sending messages, approving tools) is out of scope; the drawer is read-only for v1.
- Changes to the SDK's subagent storage format or persistence behavior are out of scope.
- Historical subagent replay (R14) is best-effort; if `getSessionMessages` does not return subagent data inline, the brief status renders as non-clickable for historical sessions.

### Deferred to Follow-Up Work

- Virtualized scrolling for very long subagent conversations (100+ messages)
- Subagent conversation search / filtering inside the drawer
- Copy-to-clipboard or export of subagent conversation

---

## Context & Research

### Relevant Code and Patterns

- `src/server/services/sse-emitter.ts` — `SseEmitter.handle()` drops `parent_tool_use_id` messages at lines 71-74. The class tracks `blockStates`, `seenStreamPartIndexes`, `finalizedMessageIds`, and `currentMessageId` for dedup and lifecycle management.
- `src/server/types/message.ts` and `src/client/types/message.ts` — `SseEvent` discriminated union and `MessagePart` types. **Must remain byte-identical.**
- `src/client/stores/chat-store.ts` — Zustand store with `handleSseEvent` switch statement, `updateAssistantPart`, `mutateToolUsePart`, `addSystemMessage` helpers.
- `src/client/components/MessageList.tsx` — renders `ChatMessage[]` via vendored AI Elements. `tool_use` parts render as `<Tool>` components. `toToolState` derives lifecycle from co-located `tool_result` parts.
- `src/client/components/ai-elements/tool.tsx` — `Tool`, `ToolHeader`, `ToolContent`, `ToolInput`, `ToolOutput` components. `ToolState` enum: `'input-streaming'`, `'input-available'`, `'output-available'`, `'output-error'`.
- `src/client/components/ai-elements/reasoning.tsx` — `Reasoning` component with `isStreaming`, `duration`, auto-open/close behavior. Uses `useControllableState` from Radix.
- `src/client/components/FileDrawer.tsx` — existing drawer overlay pattern: fixed overlay (`z-40`) + aside (`z-50`). Model for drawer positioning.
- `src/client/components/ChatPanel.tsx` — chat layout with header, message list, approval banner, prompt input.
- `src/server/services/message-normalizer.ts` — `normalizeSessionMessage` converts SDK `SessionMessage` to `ChatMessage`. Does not currently filter by `parent_tool_use_id`.

### Institutional Learnings

- No test framework exists in the project. Verification is manual via dev server.
- The `SseEvent` union is duplicated in client and server types files due to `tsconfig.server.json` `rootDir` constraint. Any change must be applied to both files identically.
- The SSE emitter uses a ring buffer (cap 500) for reconnection replay. Subagent events participate in this buffer automatically via `onEvent` callback.

---

## Key Technical Decisions

- **Three-event subagent protocol (`subagent_start`, `subagent_delta`, `subagent_done`).** Rationale: covers the full lifecycle with minimal event vocabulary. `subagent_delta` uses a tagged union (`kind: 'text' | 'thinking' | 'tool_use' | 'tool_result'`) so the client can build conversation state incrementally without parsing raw SDK shapes.
- **Nested `SubagentEmitter` helper inside `SseEmitter`.** Rationale: subagent messages have the same `stream_event`/`assistant`/`user`/`result` structure as main messages but must be emitted with `parentToolUseId` tagging. A dedicated helper keeps the main emitter's state machine clean while reusing the stream-event parsing logic.
- **Client subagent state is keyed by `parentToolUseId` and stored parallel to messages.** Rationale: subagent conversations are self-contained and secondary to the main transcript. A separate `Record<string, SubagentState[]>` (keyed by sessionId) keeps the main message normalization path unchanged.
- **Brief status replaces the regular `<Tool>` card only for `toolName === 'Agent'`.** Rationale: non-Agent tool uses still benefit from the existing collapsible `<Tool>` UI. The Agent tool_use is semantically different (it represents a subagent invocation) and warrants its own compact presentation.
- **Bottom drawer over inline expandable or modal.** Rationale: the user explicitly wants the main message kept clean, and a drawer provides dedicated vertical space for long subagent conversations without blocking the main chat. (see origin: docs/brainstorms/2026-05-17-subagent-streaming-display-requirements.md)
- **Progress hint = most recent tool name + truncated input summary.** Rationale: gives concrete sense of what the subagent is doing right now. Input is truncated to ~60 chars to keep the status line compact.
- **Historical replay is best-effort.** Rationale: the CLI stores subagent history in separate `subagents/agent-<id>.jsonl` files, not inline. We assume inline historical data for planning; if the SDK's `getSessionMessages` does not return subagent messages inline, R14 degrades gracefully to a non-clickable completed status.

---

## Open Questions

### Resolved During Planning

- **Progress hint derivation:** Use the most recent subagent tool name and its input, truncated to ~60 characters.
- **Historical data assumption:** Assume inline historical data from `getSessionMessages` for R14. If the SDK does not provide this, the brief status renders without drawer support for historical sessions.
- **Drawer positioning:** Bottom sheet anchored to the bottom of the chat area, overlaying the message list but not the prompt input. Follows the FileDrawer fixed-overlay pattern.

### Deferred to Implementation

- **Exact SDK subagent message timing:** Whether subagent `stream_event` messages can arrive before the parent Agent `tool_use_done` (input still streaming). The server implementation buffers description until available or uses a placeholder.
- **Virtualization for very long subagent conversations:** If a subagent emits 100+ messages, the drawer may need virtualized scrolling. Deferred as follow-up work.

---

## Implementation Units

### U1. Server — SSE protocol extension and subagent emission

**Goal:** Stop dropping `parent_tool_use_id` messages; extend `SseEvent` with subagent lifecycle events; emit subagent deltas via a nested helper.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `src/server/types/message.ts`
- Modify: `src/client/types/message.ts` (must be byte-identical to server version)
- Modify: `src/server/services/sse-emitter.ts`

**Approach:**

1. **Extend `SseEvent` union in both types files.** Add:
   ```typescript
   | { type: 'subagent_start'; parentToolUseId: string; description?: string }
   | {
       type: 'subagent_delta'
       parentToolUseId: string
       delta:
         | { kind: 'text'; text: string }
         | { kind: 'thinking'; text: string }
         | { kind: 'tool_use'; toolUseId: string; toolName: string; input?: unknown }
         | { kind: 'tool_result'; toolUseId: string; output: string; isError: boolean }
     }
   | { type: 'subagent_done'; parentToolUseId: string; state: 'completed' | 'error' }
   ```

2. **Add `SubagentEmitter` helper class inside `sse-emitter.ts`.** This class:
   - Is instantiated when `SseEmitter` sees a `tool_use_start` with `toolName === 'Agent'`.
   - Tracks its own `blockStates` (index → type + toolUseId + inputBuffer) for parsing subagent `stream_event` frames.
   - Processes subagent `stream_event`, `assistant`, `user`, and `result` messages, emitting `subagent_delta` events.
   - Provides `done(state)` to emit `subagent_done`.

3. **Modify `SseEmitter.handle()`.**
   - Remove the early return that drops `parent_tool_use_id` messages.
   - If `msg.parent_tool_use_id` is present and matches an active `SubagentEmitter`, route to that emitter.
   - If `msg.type === 'stream_event'` / `assistant` / `user` / `result` with `parent_tool_use_id`, handle via the subagent emitter.
   - When the parent Agent `tool_use_done` fires, call `done('completed')` on the subagent emitter and remove it from the active map.
   - If a `result` message with `is_error` fires for the subagent, call `done('error')`.

4. **Subagent stream_event handling (simplified).**
   - `message_start` / `message_stop` → tracked but no SSE event emitted (the client doesn't need message-level boundaries for v1).
   - `content_block_start` with `type: 'text'` → emit nothing until deltas arrive.
   - `content_block_start` with `type: 'thinking'` → emit nothing until deltas arrive.
   - `content_block_start` with `type: 'tool_use'` → emit `subagent_delta` with `kind: 'tool_use'` (input may be incomplete; a follow-up delta with parsed input can be emitted at `content_block_stop` or `assistant` finalization).
   - `content_block_delta` with `text_delta` → emit `subagent_delta` with `kind: 'text'`.
   - `content_block_delta` with `thinking_delta` → emit `subagent_delta` with `kind: 'thinking'`.
   - `content_block_stop` with `type: 'tool_use'` → if input was buffered, emit updated `subagent_delta` with `kind: 'tool_use'` including parsed input.
   - `assistant` whole-turn message → emit any missing deltas (dedup recovery, similar to `emitDedupRecovery`).
   - `user` message with `tool_result` blocks → emit `subagent_delta` with `kind: 'tool_result'` for each block.

**Patterns to follow:**
- Existing `SseEmitter` stream_event handling (`handleStreamEvent`, `emitDedupRecovery`, `closeStreamedBlock`).
- Ring buffer participation is automatic via the existing `onEvent` callback passed to `SseEmitter` constructor.

**Test scenarios:**
- Happy path: Agent tool_use starts → `subagent_start` emitted. Subagent emits text → `subagent_delta` {kind: 'text'} emitted. Subagent completes → `subagent_done` emitted.
- Happy path: Subagent invokes a tool → `subagent_delta` {kind: 'tool_use'} emitted. Tool result returns → `subagent_delta` {kind: 'tool_result'} emitted.
- Edge case: Multiple concurrent subagents → each gets its own `SubagentEmitter`; deltas carry correct `parentToolUseId`.
- Edge case: Subagent message arrives before Agent `tool_use_done` → buffered or routed correctly once the parent toolUseId is known.
- Edge case: Subagent errors → `subagent_done` with `state: 'error'` emitted.
- Invariant: Both types files remain byte-identical after changes.

**Verification:**
- Manual test: trigger a subagent (e.g., `ce-research`) in a session. Observe subagent events in browser DevTools Network → EventStream tab.
- Confirm non-Agent tool uses still work normally.

---

### U2. Client — chat-store subagent state

**Goal:** Handle `subagent_start`, `subagent_delta`, and `subagent_done` events; maintain per-session subagent state with conversation history, tool count, and progress hint.

**Requirements:** R3, R13 (partial), R14 (partial)

**Dependencies:** U1

**Files:**
- Modify: `src/client/stores/chat-store.ts`

**Approach:**

1. **Add subagent types and state shape.**
   ```typescript
   type SubagentPart =
     | { type: 'text'; text: string }
     | { type: 'thinking'; text: string }
     | { type: 'tool_use'; toolUseId: string; toolName: string; input: unknown }
     | { type: 'tool_result'; toolUseId: string; output: string; isError: boolean }

   interface SubagentMessage {
     id: string
     role: 'assistant' | 'user'
     parts: SubagentPart[]
   }

   interface SubagentState {
     parentToolUseId: string
     description: string
     state: 'running' | 'completed' | 'error'
     startTime: number
     endTime?: number
     toolCount: number
     progressHint: string
     messages: SubagentMessage[]
   }
   ```

2. **Add `subagents` to `ChatState`.**
   ```typescript
   subagents: Record<string, SubagentState[]>
   ```

3. **Add `handleSseEvent` cases.**
   - `subagent_start`: Create `SubagentState` with `state: 'running'`, `startTime: Date.now()`, `toolCount: 0`, `progressHint: ''`. Description sourced from the existing Agent `tool_use` part's input if available (the main stream already received `tool_use_done` for this toolUseId), otherwise fallback to `'Agent'`. Append to `subagents[sessionId]`.
   - `subagent_delta`: Find the matching `SubagentState` by `parentToolUseId`. Update based on `delta.kind`:
     - `text`: Append to last assistant message's text part, or create new assistant message with text part.
     - `thinking`: Append to last assistant message's thinking part, or create new assistant message with thinking part.
     - `tool_use`: Append tool_use part to last assistant message. Increment `toolCount`. Update `progressHint` to `${toolName}: ${truncatedInput}` (input JSON stringified and truncated to ~60 chars).
     - `tool_result`: Create new user message with tool_result part.
   - `subagent_done`: Find matching `SubagentState`, set `state` to `'completed'` or `'error'`, set `endTime: Date.now()`.

4. **Update `deleteSession` cleanup.** Remove subagent state for the deleted sessionId.

**Patterns to follow:**
- Existing `updateAssistantPart`, `mutateToolUsePart` patterns for immutable updates.
- Existing `addSystemMessage` pattern for appending new messages.

**Test scenarios:**
- Happy path: `subagent_start` creates state. Multiple `subagent_delta` {kind: 'text'} append to the same assistant message. `subagent_done` transitions state to completed.
- Happy path: `subagent_delta` {kind: 'tool_use'} increments toolCount and updates progressHint.
- Edge case: `subagent_delta` {kind: 'tool_result'} creates a new user message.
- Edge case: Interleaved text and thinking deltas → both appended to the same assistant message in arrival order.
- Edge case: Concurrent subagents → state for each is independent.
- Edge case: `subagent_start` arrives before main-stream `tool_use_done` for the Agent tool → description falls back to `'Agent'` and is updated later when `tool_use_done` provides input.

**Verification:**
- Dev console: inspect `useChatStore.getState().subagents[sessionId]` during a subagent run. Confirm state transitions, toolCount increments, and progressHint updates.

---

### U3. Subagent brief status component

**Goal:** Render a compact, real-time status line for Agent `tool_use` blocks in the main message stream. Clicking it opens the drawer.

**Requirements:** R4, R5, R6

**Dependencies:** U2

**Files:**
- Create: `src/client/components/SubagentBriefStatus.tsx`

**Approach:**

1. **Component props:**
   ```typescript
   interface SubagentBriefStatusProps {
     parentToolUseId: string
     sessionId: string
     onOpenDrawer: (parentToolUseId: string) => void
   }
   ```

2. **Read subagent state from chat-store.** Use `useChatStore` to read the `SubagentState` matching `parentToolUseId` for the session.

3. **Derive display values:**
   - **Description:** `subagent.description` or `'Agent'`.
   - **Status badge:** Derived from `subagent.state`:
     - `'running'` → pulsing clock icon + "Running" (amber/secondary badge)
     - `'completed'` → check icon + "Completed" (green badge)
     - `'error'` → x icon + "Error" (red badge)
   - **Duration:** If `endTime` exists, show `formatDuration(endTime - startTime)`. If running, show elapsed since `startTime` (updates via `requestAnimationFrame` or 1s interval while running).
   - **Tool count:** `${toolCount} tools` (or `0 tools`).
   - **Progress hint:** If non-empty, show truncated hint after a separator.

4. **Layout:** Compact horizontal row inside a rounded card with subtle border:
   ```
   [icon] [description] [badge] • [duration] • [N tools] [progress hint truncated]
   ```
   - Full row is clickable (`cursor-pointer`, hover highlight).
   - Chevron or "View" indicator on the right to indicate clickability.
   - While running, a subtle left-border pulse or badge pulse indicates activity.

5. **Styling:** Reuse Tailwind tokens. Keep height compact (~40px). Use `text-sm` or `text-xs`. Follow the existing `Tool` card's border style but more compact.

**Patterns to follow:**
- `src/client/components/ai-elements/tool.tsx` — `ToolHeader` status badge pattern (icon + label + color).
- `src/client/components/ai-elements/reasoning.tsx` — `isStreaming` duration update pattern.

**Test scenarios:**
- Happy path (AE1): Subagent starts → status shows "Running `ce-research` • 0s • 0 tools" with pulsing indicator. After 10s and 3 tool uses → "Running `ce-research` • 10s • 3 tools • web_search: {query: '...'}".
- Happy path: Subagent completes → status transitions to "Completed ..." with check icon, final duration, and total tool count.
- Edge case: Clicking the status calls `onOpenDrawer(parentToolUseId)`.
- Edge case: No subagent state found (rare race) → render minimal "Agent" placeholder.
- Edge case: Very long description or progress hint → truncate gracefully with CSS `truncate` or max-width.

**Verification:**
- Visual check during live subagent run: status updates smoothly, duration increments, tool count increments on each tool_use.
- Click check: clicking opens the drawer.

---

### U4. Subagent drawer component

**Goal:** Build a bottom drawer that renders the full subagent conversation as a mini chat interface with independent scrolling.

**Requirements:** R7, R8, R9, R10, R11, R12

**Dependencies:** U2, U3

**Files:**
- Create: `src/client/components/SubagentDrawer.tsx`
- Create: `src/client/components/SubagentConversation.tsx`

**Approach:**

1. **`SubagentDrawer` component.** Props:
   ```typescript
   interface SubagentDrawerProps {
     parentToolUseId: string | null
     sessionId: string
     onClose: () => void
   }
   ```
   - If `parentToolUseId` is null, render nothing.
   - Read `SubagentState` from chat-store.
   - **Positioning:** Fixed overlay at the bottom of the chat area. Use a bottom-sheet pattern:
     - Overlay: `fixed inset-x-0 bottom-0 bg-black/40 z-40` covering the message list area (not the prompt input).
     - Drawer panel: `fixed bottom-0 inset-x-0 bg-surface border-t border-border z-50` with `height: 50vh` (or `max-h-[50vh]`).
     - On smaller screens, allow the drawer to take up to 70vh.
   - **Header:** Subagent description, status badge, duration, tool count, and a close (`X`) button.
   - **Scroll container:** `flex-1 overflow-y-auto` containing `SubagentConversation`.
   - **Dismiss:** Click overlay, click X button, or press Escape.

2. **`SubagentConversation` component.** Props:
   ```typescript
   interface SubagentConversationProps {
     messages: SubagentMessage[]
     isRunning: boolean
   }
   ```
   - Maps over `messages` and renders each message's parts.
   - **Assistant message parts:**
     - `text` → `<Response>` (reuse vendored component) or simple styled text block.
     - `thinking` → `<Reasoning>` with trigger and content.
     - `tool_use` → Compact tool card showing tool name and truncated input (no full `<Tool>` collapsible; keep it compact since this is a mini chat).
   - **User message parts:**
     - `tool_result` → Compact result block (output or error indicator).
   - Messages are grouped by role: consecutive assistant parts in the same message object render together; a user message (tool_result) renders as its own block.
   - Auto-scroll to bottom when `isRunning` and new messages arrive.

3. **Styling for mini chat:**
   - Assistant messages: left-aligned, subtle background (`bg-surface-hover/30`).
   - User/tool_result messages: right-aligned or distinct background to distinguish from assistant.
   - Tool_use cards: compact inline card with wrench icon, tool name, and JSON snippet.
   - Tool_result cards: compact inline card with output preview.
   - Keep font size small (`text-sm` / `text-xs`) to fit more content.

**Patterns to follow:**
- `src/client/components/FileDrawer.tsx` — fixed overlay + panel pattern.
- `src/client/components/ai-elements/conversation.tsx` — scroll container pattern.
- `src/client/components/ai-elements/reasoning.tsx` — collapsible thinking block.
- `src/client/components/MessageList.tsx` — message part rendering pattern.

**Test scenarios:**
- Happy path (AE2): Drawer opens when clicking brief status. Shows subagent conversation so far. New deltas appear at the bottom in real time.
- Happy path (AE3): Two concurrent subagents. Open drawer for subagent A. Open drawer for subagent B (A closes or stays open depending on design — recommend only one drawer open at a time for simplicity, but brief status for both updates). Closing drawer A does not affect subagent B streaming.
- Edge case: Drawer open, subagent completes → status badge in drawer header updates to "Completed".
- Edge case: Very long subagent conversation → drawer scrolls independently; auto-scroll keeps bottom in view while running.
- Edge case: Empty subagent conversation (no deltas yet) → drawer shows a "Subagent started..." placeholder.

**Verification:**
- Visual check: drawer slides up smoothly, content renders correctly.
- Streaming check: open drawer during subagent run; new text/thinking/tool cards appear in real time.
- Scroll check: scroll up manually while streaming; auto-scroll respects user scroll position (optional v1: always auto-scroll).

---

### U5. Integration — MessageList and ChatPanel

**Goal:** Wire brief status into the main message stream; wire drawer into the chat layout; ensure multiple concurrent subagents are supported.

**Requirements:** R4, R8, R11, R12, R13, R14

**Dependencies:** U3, U4

**Files:**
- Modify: `src/client/components/MessageList.tsx`
- Modify: `src/client/components/ChatPanel.tsx`

**Approach:**

1. **MessageList modifications.**
   - In `renderMessage`, when rendering a `tool_use` part, check `part.toolName === 'Agent'`.
   - If Agent: render `<SubagentBriefStatus>` instead of `<Tool>`.
   - Pass `parentToolUseId={part.toolUseId}`, `sessionId`, and `onOpenDrawer` callback.
   - Non-Agent tool_use: preserve existing `<Tool>` rendering.

2. **ChatPanel modifications.**
   - Add state: `openDrawerToolUseId: string | null`.
   - Pass `onOpenDrawer={(id) => setOpenDrawerToolUseId(id)}` to `MessageList`.
   - Render `<SubagentDrawer>` at the bottom of the layout (inside the flex container, after PromptInput or as a portal).
   - The drawer should overlay the message list but not cover the prompt input. Position it above the prompt input area.

3. **Historical session support (R14).**
   - When `loadMessages` populates the store, if historical messages contain Agent `tool_use` parts, the `SubagentBriefStatus` will render for them.
   - If the store has no `SubagentState` for a historical Agent tool_use (because historical subagent data was not loaded), the brief status shows a fallback state: description from tool_use input, status "Completed" (assuming historical = done), but the drawer opens to an empty conversation.
   - **Decision:** For v1, historical subagent replay is best-effort. If `getSessionMessages` returns subagent messages inline, U2's state builder will populate `subagents` during message loading. If not, the brief status renders as non-interactive or with an empty drawer.

**Patterns to follow:**
- Existing `MessageList` part rendering switch statement.
- Existing `ChatPanel` layout and state management.

**Test scenarios:**
- Happy path: Normal (non-Agent) tool_use → renders existing `<Tool>` unchanged.
- Happy path: Agent tool_use → renders `<SubagentBriefStatus>` instead.
- Happy path: Clicking brief status opens drawer for that specific subagent.
- Happy path (AE3): Two Agent tool_uses in the same session → both render brief statuses; clicking each opens its own drawer (or closes the previous and opens the new one).
- Edge case: Session switch → drawer closes (`useEffect` on `activeSessionId` change).
- Edge case: Historical session with Agent tool_use but no subagent data → brief status shows "Completed" with tool count 0; drawer opens empty.

**Verification:**
- Full manual walkthrough of AE1–AE4 scenarios.
- Confirm non-Agent tools still render correctly.
- Confirm drawer closes on Escape, overlay click, and X button.

---

## System-Wide Impact

- **SSE event vocabulary:** Three new event types (`subagent_start`, `subagent_delta`, `subagent_done`) are emitted by the server and consumed by the client. Any future SSE consumers (e.g., mobile clients, tests) must handle or ignore these events.
- **Chat-store state shape:** New `subagents` field added to `ChatState`. Downstream selectors or devtools that inspect the store will see this new field.
- **MessageList rendering:** Agent `tool_use` parts now render a different component. The existing `Tool` / `ToolHeader` / `ToolContent` rendering path is bypassed only for `toolName === 'Agent'`.
- **Ring buffer:** Subagent events participate in the `SessionRuntime` ring buffer automatically. Reconnecting clients will replay subagent events in order.
- **Error propagation:** Subagent emission errors are localized to the `SubagentEmitter`. A malformed subagent message does not crash the main stream.
- **Unchanged invariants:** Non-subagent tool rendering, approval banners, prompt input, session management, and message normalization paths are untouched.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| SDK subagent message format differs from assumptions | The server implementation treats subagent messages as generic SDK messages. If the format is different, only the subagent display breaks; main stream continues. |
| Subagent events arrive before Agent `tool_use_done` | Server buffers or routes correctly once `toolUseId` is known. Client falls back to `'Agent'` description and updates later. |
| Bottom drawer conflicts with existing overlays (FileDrawer, ApprovalBanner) | Drawer uses a distinct `z-index` layer. Only one overlay should be open at a time; subagent drawer closes when FileDrawer opens (or vice versa) via natural click-away behavior. |
| Performance with multiple long-running subagents | Subagent state is a plain array of messages; no virtualization in v1. If memory becomes an issue, cap message count per subagent or add virtualization as follow-up. |
| Historical subagent data not inline (R14) | Documented as best-effort. Brief status degrades to non-clickable or empty drawer. |

---

## Documentation / Operational Notes

- No documentation updates required beyond the requirements and plan docs.
- No rollout or monitoring concerns — this is a pure client+server feature with no external dependencies.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-17-subagent-streaming-display-requirements.md](../brainstorms/2026-05-17-subagent-streaming-display-requirements.md)
- **Related code:** `src/server/services/sse-emitter.ts`, `src/client/stores/chat-store.ts`, `src/client/components/MessageList.tsx`, `src/client/components/ai-elements/tool.tsx`, `src/client/components/FileDrawer.tsx`, `src/client/components/ChatPanel.tsx`, `src/server/services/message-normalizer.ts`
- **SDK documentation:** https://code.claude.com/docs/en/agent-sdk/subagents#detecting-subagent-invocation
