---
title: 'fix: Session message list cannot scroll'
type: fix
status: active
date: 2026-05-16
---

# fix: Session message list cannot scroll

## Summary

Restore vertical scrolling in the session message list by correcting the vendored AI Elements `Conversation` container, which currently sets `overflow-y-hidden` on the outer `StickToBottom` element — clipping older messages and breaking both manual scrolling and the auto-stick-to-bottom behavior the library is meant to provide.

## Requirements

- R1. When a session has more rendered message height than the available viewport, the user can scroll up to see earlier messages and scroll back down to the latest, using mouse wheel, trackpad, and keyboard.
- R2. The existing floating "scroll to bottom" affordance (`ConversationScrollButton` in `MessageList.tsx`) appears when the user is not at the bottom and returns the view to the latest message when clicked.
- R3. Streaming auto-follow continues to work: while a new assistant message is streaming and the user is already at the bottom, the view stays pinned to the bottom; if the user has scrolled up, the view does not jump.
- R4. The fix does not alter the visual identity of the conversation surface (dark + orange tokens, spacing) or the behavior of any scroll container outside the message list.

## Scope Boundaries

- Refactoring `MessageList.tsx` or `ChatPanel.tsx` beyond what is required to verify the fix.
- Restyling the scrollbar (it is already styled globally in `src/client/index.css`).
- Adding scroll-position persistence across session switches or page reloads.
- Adding keyboard shortcuts for scroll navigation (`PageUp`/`PageDown`, `Home`/`End`).
- Adding virtualization or windowing for long sessions.
- Touching the prompt input area, sidebar, file panel, workspace switcher, or any non-message-list scroll container.
- Migrating `use-stick-to-bottom` to a newer major version, or replacing the library.
- Standing up a client-side component test harness — verification for this fix is manual in the dev server.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/ai-elements/conversation.tsx` — vendored `Conversation` / `ConversationContent` / `ConversationScrollButton` wrappers around `use-stick-to-bottom`'s `StickToBottom`. The `Conversation` element's className currently includes `overflow-y-hidden`. This is the root cause: the `use-stick-to-bottom` library walks the DOM looking for the nearest ancestor whose computed `overflow` is `scroll` or `auto`, and only auto-corrects when the value is the literal `visible`. `hidden` is silently passed over, so the chat region has no native scrollbar and the library may bind sticky behavior to the wrong ancestor.
- `src/client/components/MessageList.tsx` — sole consumer of `Conversation`. Already renders `<ConversationScrollButton />` inside `<Conversation>` and handles the empty-state path. No structural change required.
- `src/client/components/ChatPanel.tsx` — wraps `<MessageList />` in a `flex-1 overflow-hidden` parent. This is the correct outer pattern (parent constrains height; inner container scrolls) and does not need to change.
- `src/client/index.css` — global `scrollbar-width: thin` and `scrollbar-color: #333 transparent` styling applies to any element that becomes a scroll container, so no additional styling is needed for the restored scrollbar.

### Institutional Learnings

- None — this repo does not yet have a `docs/solutions/` directory.

### External References

- Library scroll-ancestor contract: `node_modules/use-stick-to-bottom/dist/useStickToBottom.js` walks ancestors until it finds an element whose computed `overflow` is `scroll` or `auto`; `dist/StickToBottom.js` rewrites `visible` to `auto` but leaves `hidden` untouched.
- Upstream reference: AI Elements' published `conversation.tsx` (the source the vendored copy was adapted from) uses `overflow-y-auto` for the same wrapper.

## Key Technical Decisions

- **Use `overflow-y-auto`, not `overflow-y-scroll`, on the outer `Conversation` element.** `auto` shows the scrollbar only when content overflows, matching AI Elements upstream and avoiding a persistent empty scrollbar gutter on short sessions. The library's `StickToBottom` implementation also normalizes `overflow: visible` to `overflow: auto` internally, confirming `auto` is the intended contract.
- **Fix at the vendored container, not at consumers.** The bug is one className token in the shared wrapper. Adding overflow at `MessageList` or `ChatPanel` would mask the root cause and force every future consumer of `Conversation` to repeat the workaround.
- **Do not introduce automated test coverage for this fix.** Scrolling is a visual / interaction concern in a tiny vendored UI primitive, and the repo has no client-side component test harness today. Standing one up for a one-line className change is disproportionate. Verification is manual in the dev server, per the test scenarios in U1.

## Implementation Units

### U1. Restore overflow on the Conversation container

**Goal:** Replace `overflow-y-hidden` with `overflow-y-auto` on the outer `StickToBottom` element in the vendored `Conversation` wrapper so the message list becomes a proper scroll container and `use-stick-to-bottom` binds its sticky behavior to it.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None.

**Files:**
- Modify: `src/client/components/ai-elements/conversation.tsx`

**Approach:**
- In the `Conversation` component definition, swap the `overflow-y-hidden` Tailwind utility for `overflow-y-auto` in the `StickToBottom` className. Leave every other class (`relative`, `flex-1`) in place.
- Leave the file's adaptation header comment, the rest of `Conversation`'s props, `ConversationContent`, `ConversationEmptyState`, and `ConversationScrollButton` unchanged.

**Patterns to follow:**
- The same scroll-container pattern AI Elements upstream uses for the `Conversation` wrapper — the vendored copy is the outlier and should be aligned with the upstream contract.

**Test scenarios:**
<!-- Verification for this fix is manual: scroll is a visual / interaction behavior in a vendored UI primitive, and the repo does not yet have a client-side component test harness. Each scenario names the input, action, and expected outcome so the implementer does not have to invent coverage. -->
- Happy path (manual scroll up and down): open a session whose rendered messages exceed the chat panel height (any long session from `WorkspaceTabs` will do) → the user can scroll up with mouse wheel, trackpad two-finger swipe, and keyboard, and scroll back down to the latest message; the native scrollbar appears, styled with the global thin / `#333` thumb.
- Happy path (sticky bottom during streaming): with the view at the bottom of a non-trivial session, send a new prompt → streaming assistant tokens append at the bottom and the view auto-follows them (`StickToBottom` behavior); no manual scroll is needed.
- Edge case (user-scrolled-up override): scroll up mid-stream → the view stops auto-following new tokens, and the floating "scroll to bottom" arrow appears centered near the bottom. Clicking it smoothly returns to the latest message and restores the sticky-bottom behavior for subsequent tokens.
- Edge case (short session): open a session whose total message height is smaller than the viewport → no scrollbar appears (because `overflow-y-auto`, not `overflow-y-scroll`); the empty-state path still renders correctly when the session has zero messages.
- Edge case (session switch): switch between a long session and a short session via the session list → each renders with the correct scroll affordance independently; switching back to the long session returns to a sensible position (bottom by default, matching the library's `initial="smooth"`).
- Visual regression: the surrounding layout (header toolbar, input area, sidebar, file panel, workspace tabs) is unaffected — no double scrollbars on the chat region, no unexpected width shift from the new scrollbar gutter on platforms with non-overlay scrollbars.

**Verification:**
- All six test scenarios pass in a manual dev-server run on the current development browser.
- No console errors or warnings appear during scroll, session switch, or streaming.
- Project lint passes with no new violations.
- Project type-check / build pass with no new errors.

## Sources & References

- Related plan: `docs/plans/2026-05-16-006-feat-ai-elements-message-rendering-plan.md` — delivered the vendored `Conversation` component this plan corrects.
- Library: `use-stick-to-bottom` v1 (declared in `package.json`).
- Upstream reference: AI Elements `conversation.tsx` (`github.com/vercel/ai-elements`).
