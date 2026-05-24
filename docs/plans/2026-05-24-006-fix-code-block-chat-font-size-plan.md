---
title: 'fix: Make code blocks respect chat font size setting'
type: fix
status: completed
date: 2026-05-24
origin: docs/brainstorms/2026-05-24-configurable-chat-font-size-requirements.md
depth: lightweight
---

# fix: Make code blocks respect chat font size setting

## Summary

The configurable chat font size feature (Small/Medium/Large) was applied to message text, reasoning blocks, and tool headers, but code blocks were missed. Both markdown-rendered code blocks (Streamdown) and tool JSON code blocks (local CodeBlock component) still render at a fixed `text-sm` with `p-4` padding regardless of the user's chat font size preference. This plan fixes both paths.

## Problem Frame

When the chat font size preference was implemented, the focus was on removing hardcoded `text-sm` classes from message, reasoning, and conversation components so they inherit the container's font size. Code blocks were overlooked:

- The local `CodeBlock` component (`code-block.tsx`) hardcodes `text-sm` on its `<pre>` and `<code>` elements, `text-xs` on its header, and `p-4` on its body.
- Streamdown's internal markdown code block renderer also hardcodes `text-sm` and `p-4`, which cannot be modified directly since it lives inside the `streamdown` npm package.

As a result, switching the chat font size to Small or Large leaves code blocks stuck at 14px with generous padding, breaking visual consistency.

## Requirements

- R1. Local `CodeBlock` components (tool input/output JSON) respect the chat font size.
- R2. Streamdown markdown code blocks (assistant message fenced code) respect the chat font size.
- R3. Code block body padding is reduced to 0.
- R4. No regression in FileDrawer or FilePanel code block appearance.

## Scope Boundaries

- Inline code spans (backtick `code`) inside markdown — out of scope unless the container-level fix naturally covers them.
- FileDrawer/FilePanel code blocks — may inherit UI font size and 0 padding; no explicit change required.
- Syntax highlighting colors or themes.
- Code block border radius or layout.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/ai-elements/code-block.tsx` — Local `CodeBlock`, `CodeBlockBody`, `CodeBlockHeader`, `CodeBlockContent`, `CodeBlockContainer`. `CodeBlockBody` hardcodes `text-sm` on `<pre>` and `<code>`. `CodeBlockHeader` hardcodes `text-xs`.
- `src/client/components/ai-elements/response.tsx` — Wraps `Streamdown` for assistant message rendering.
- `src/client/components/MessageList.tsx` — Applies `fontSizeClass(chatFontSize)` to `ConversationContent`.
- `src/client/components/VirtualizedMessageList.tsx` — Applies `fontSizeClass(chatFontSize)` to its inner content container.
- Streamdown internals — fenced code blocks are rendered by a lazy-loaded internal `CodeBlock` component with `text-sm` hardcoded and `data-streamdown="code-block-body"` on the `<pre>`. Inline code has `data-streamdown="inline-code"`.

### Institutional Learnings

- `docs/plans/2026-05-24-004-feat-configurable-font-size-plan.md` implemented the broader font size feature but did not touch `code-block.tsx` or address Streamdown's internal code block styling.

## Key Technical Decisions

- **Remove hardcoded sizes and padding from local CodeBlock.** Deleting `text-sm` and `p-4` from `CodeBlockBody` and `text-xs` from `CodeBlockHeader` lets them inherit from the parent container. This is consistent with how `message.tsx`, `reasoning.tsx`, and `conversation.tsx` were already updated.
- **Container-level override for Streamdown code blocks.** Since Streamdown is an external package, we cannot modify its internal component. Instead, add Tailwind arbitrary variants on the message list container that target `[data-streamdown="code-block-body"]` and set `font-size: inherit` and `padding: 0`. This overrides Streamdown's hardcoded styles via higher selector specificity without touching the package internals.

## Implementation Units

### U1. Remove hardcoded font sizes and padding from local CodeBlock

**Goal:** Make the local `CodeBlock` component inherit font size from its parent and remove body padding.

**Requirements:** R1, R3, R4

**Dependencies:** None

**Files:**
- Modify: `src/client/components/ai-elements/code-block.tsx`

**Approach:**
1. In `CodeBlockBody`, remove `text-sm` and `p-4` from the `<pre>` className, and remove `text-sm` from the `<code>` className.
2. In `CodeBlockHeader`, remove `text-xs` from the className.

**Patterns to follow:**
- The existing font size removal pattern in `message.tsx`, `reasoning.tsx`, and `tool.tsx` (from the prior font size plan).

**Test scenarios:**
- Happy path: Open a chat with tool use → tool input/output JSON code block renders at the chat font size (12px/14px/16px).
- FileDrawer/FilePanel: Open a file → code block still renders legibly (inherits UI root font size).

**Verification:**
- `npx tsc --noEmit` passes.
- Manual: trigger a tool that shows JSON input/output; verify the code block text scales with the chat font size setting.

### U2. Override Streamdown markdown code block font size and padding

**Goal:** Make Streamdown-rendered markdown code blocks respect the chat font size and remove their body padding.

**Requirements:** R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/client/components/MessageList.tsx`
- Modify: `src/client/components/VirtualizedMessageList.tsx`

**Approach:**
1. In `MessageList.tsx`, extend the `ConversationContent` className to include Tailwind arbitrary variants that target Streamdown code blocks:
   - `[&_[data-streamdown="code-block-body"]]:[font-size:inherit]` for font size inheritance.
   - `[&_[data-streamdown="code-block-body"]]:[padding:0]` for padding removal.
2. In `VirtualizedMessageList.tsx`, add the same targeting variants to the inner content container div that already carries `fontSizeClass(chatFontSize)`.
3. Optionally also target inline code with `[&_[data-streamdown="inline-code"]]:[font-size:inherit]` on both containers.

**Patterns to follow:**
- Existing `fontSizeClass(chatFontSize)` application in both files.

**Test scenarios:**
- Happy path: Assistant message with a fenced code block (```) → code block text scales with chat font size.
- Edge case: Multiple code blocks in one message → all scale consistently.
- Edge case: Inline code inside a message → also scales if the inline-code variant is included.

**Verification:**
- `npx tsc --noEmit` passes.
- Manual: send a message that produces a code block response; verify the code block text scales with the chat font size setting.

## System-Wide Impact

- **Interaction graph:** `MessageList` and `VirtualizedMessageList` gain new className utilities. `code-block.tsx` loses explicit text-size classes. No other components are affected.
- **Error propagation:** None — this is a pure styling change.
- **State lifecycle risks:** None.
- **Unchanged invariants:** Syntax highlighting, copy buttons, and line numbers are untouched. Code block body padding is intentionally changed (reduced to 0).

## Risks & Dependencies

| Risk | Mitigation |
|------|-----------|
| Streamdown updates its `data-streamdown` attribute names | The targeting variant would silently stop working. This is a low risk (Streamdown is stable) and the fallback is benign (code blocks revert to fixed 14px). |
| Removing `text-sm` from local CodeBlock affects non-chat usages | FileDrawer/FilePanel will inherit the UI root font size, which is acceptable. If issues arise, explicit text classes can be re-added to those specific call sites. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-24-configurable-chat-font-size-requirements.md](docs/brainstorms/2026-05-24-configurable-chat-font-size-requirements.md)
- Related plan: `docs/plans/2026-05-24-004-feat-configurable-font-size-plan.md`
- Related code: `src/client/components/ai-elements/code-block.tsx`, `src/client/components/MessageList.tsx`, `src/client/components/VirtualizedMessageList.tsx`
