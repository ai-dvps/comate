---
title: "Fix compact status indicator in virtualized message list"
type: fix
status: active
date: 2026-05-29
---

# Fix compact status indicator in virtualized message list

## Problem Frame

When conversation compaction is triggered (via `/compact` or auto-compact), the
"Compacting conversation…" transient indicator is not visible in the chat panel
for long conversations. Only the "Conversation compacted" boundary appears after
compaction completes.

The root cause is a layout bug in `VirtualizedMessageList.tsx`. The compacting
indicator is rendered inside the virtualized content container alongside
absolutely-positioned virtual items. Because all message items use
`position: absolute` with `transform: translateY(...)`, they are removed from
normal document flow. The compacting indicator — the only normal-flow child —
gets placed at the **top** of the relative container, overlapping the first
message, rather than at the **bottom** after all messages.

Short conversations (< 50 messages) use `MessageList.tsx`, which renders
messages in normal flow and places the indicator correctly. The bug only
affects the virtualized path.

## Scope Boundaries

### In scope
- Fix DOM placement of the `isCompacting` indicator in
  `VirtualizedMessageList.tsx` so it renders after all virtualized messages.
- Preserve existing styling, animation, and text.

### Out of scope
- Changing the indicator from a spinner to a true progress bar. The SDK only
  provides a binary on/off signal (`compact_status` with `active: boolean`);
  there is no granular progress data available.
- Modifying server-side SSE emission, chat-store state handling, or the
  non-virtualized `MessageList.tsx` rendering — these are already working.

### Deferred to Follow-Up Work
- Add automated component tests for `VirtualizedMessageList.tsx` (no test suite
  currently exists for this component).

---

## Key Technical Decisions

- **Move the indicator outside the height-constrained virtualized container**
  rather than making it absolutely positioned. This keeps the indicator in
  normal flow after the virtual content, matching the behavior of the
  non-virtualized list and avoiding the need to manually sync its position with
  `virtualizer.getTotalSize()`.

---

## Implementation Units

### U1. Fix compacting indicator placement in VirtualizedMessageList

**Goal:** Ensure the "Compacting conversation…" spinner renders at the bottom
of the message list in the virtualized view.

**Files:**
- `src/client/components/VirtualizedMessageList.tsx`

**Approach:**
Move the `{isCompacting && (...)}` JSX block from inside the
`style={{ height: virtualizer.getTotalSize() }}` div to after that div, still
inside the scrollable `parentRef` container. Wrap the moved indicator in a
div with the same horizontal layout constraints (`max-w-3xl mx-auto w-full`)
and appropriate padding so it aligns visually with the message content above.

Specifically:
1. Remove the `isCompacting` block from inside the virtualized content div.
2. Place it after the virtualized content div, inside the `overflow-y-auto`
   scroll container.
3. Use `px-3 pb-3` (or `p-3`) on the wrapper to match the content div's
   horizontal padding and provide bottom spacing.

**Patterns to follow:**
- The `isLoadingOlder` indicator in the same file already uses
  `p-3 max-w-3xl mx-auto w-full` for alignment within the scroll container.

**Test scenarios:**
- **Happy path:** With > 50 messages and `isCompacting === true`, the spinner
  appears below the last message, fully visible when scrolled to bottom.
- **Edge case:** With `isCompacting === false`, no indicator is rendered and
  scroll height matches virtual content only.
- **Integration:** Indicator coexists correctly with the scroll-to-bottom
  button and `isLoadingOlder` indicator without overlapping.

**Verification:**
- Manual test: Load a session with > 50 messages, trigger `/compact`, and
  verify the "Compacting conversation…" spinner appears at the bottom of the
  message list.
- Manual test: Verify the indicator disappears when compaction completes and
  the "Conversation compacted" boundary appears.

---

## System-Wide Impact

- **End users:** Will now see the compaction-in-progress indicator in long
  conversations (the common case for compaction).
- **Developers:** No API or state changes; purely a layout fix.

---

## Risks

| Risk | Mitigation |
|---|---|
| Indicator flickers or causes scroll jump when `isCompacting` toggles | Indicator is small (~20px height) and placed at bottom; minimal scroll impact. Same behavior already exists in non-virtualized list. |
| Padding mismatch makes indicator look misaligned | Re-use the same `max-w-3xl mx-auto w-full` container class and `px-3` horizontal padding used by the virtualized content. |
