---
title: Fix tool parameter/result scroll background coverage
type: fix
status: active
date: 2026-05-23
---

# Fix tool parameter/result scroll background coverage

## Summary

When tool parameter or result content overflows horizontally and a scrollbar appears, the background color does not extend to cover the scrolled-out text. Fix the `ToolInput`/`ToolOutput` container structure and the `CodeBlockBody` `<pre>` width behavior so backgrounds cover the full scrollable width.

## Requirements

- R1. Horizontally scrolled text in tool parameters maintains full background coverage.
- R2. Horizontally scrolled text in tool results maintains full background coverage.
- R3. No visual regressions in non-scrolled code blocks or tool displays.

## Scope Boundaries

- Non-goals: Changing scrollbar styling, changing color values, modifying `CompactableContainer` behavior.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/ai-elements/tool.tsx` — `ToolInput` uses `overflow-hidden` on its outer wrapper and nests rendered content in a `bg-surface-hover/50` div with no `overflow-x-auto`. `ToolOutput` uses `overflow-x-auto` directly on its background-colored div, but the background only paints the visible viewport.
- `src/client/components/ai-elements/code-block.tsx` — `CodeBlockContent` renders a `<pre>` via `CodeBlockBody`. The `<pre>` has `width: auto` (fills container), so its `backgroundColor` (from Shiki tokenization) only covers the visible box, not overflowed content.

## Key Technical Decisions

- **Separate scroll container from background container**: Move `overflow-x-auto` to an outer wrapper and apply `min-w-fit` to the inner content wrapper that carries the background. This ensures the background-colored element expands to the full content width while the parent handles scrolling.
- **Expand `<pre>` to fit content**: Add `min-w-fit` to `CodeBlockBody`'s `<pre>` element (via `CodeBlockContent`'s className prop) so its Shiki-provided `backgroundColor` covers the full scrollable width.

## Implementation Units

### U1. Fix CodeBlock scroll background

**Goal:** Ensure code block backgrounds cover horizontally scrolled content.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/client/components/ai-elements/code-block.tsx`

**Approach:**
- In `CodeBlockContent`, pass `min-w-fit` to `CodeBlockBody`'s `className` prop (composed with any incoming `className`). This causes the `<pre>` element to expand to at least the width of its content, ensuring the `backgroundColor` inline style covers the full scrollable area.

**Test scenarios:**
- Happy path: A tool with a Bash command containing a very long single line — scrolling horizontally shows the background color behind all visible text.
- Happy path: A Write tool with code content wider than the viewport — the syntax-highlighted background covers scrolled text.
- Edge case: Short code content with no overflow — `min-w-fit` does not cause layout issues; the `<pre>` still fills the container normally (since `width: auto` + `min-w-fit` on short content = container width).

**Verification:**
- Render a tool with wide code content and scroll horizontally — no transparent gaps behind scrolled text.

### U2. Fix ToolInput and ToolOutput container structure

**Goal:** Restructure tool parameter and result containers so background covers full scrollable width.

**Requirements:** R1, R2, R3

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/ai-elements/tool.tsx`

**Approach:**
- `ToolInput` custom-renderer path: Wrap the `bg-surface-hover/50` div in an `overflow-x-auto` container, and add `min-w-fit` to the background div so it expands with content.
- `ToolInput` JSON-fallback path: Same treatment — wrap `CodeBlock` in `overflow-x-auto` with a `min-w-fit` background wrapper.
- `ToolOutput`: Move `overflow-x-auto` to an outer wrapper, keep `bg-surface-hover/50` (or `bg-destructive/20`) on an inner `min-w-fit` div so the background expands with content.

**Test scenarios:**
- Happy path: A tool result containing a wide JSON object — scrolling horizontally shows `bg-surface-hover/50` behind all text.
- Happy path: A tool result with a wide table — scrolling horizontally shows background behind all table cells.
- Edge case: Error output with long error text — `bg-destructive/20` covers the full scrolled width.

**Verification:**
- Render tools with wide parameter and result content; horizontal scroll reveals consistent background color across the full content width.

## System-Wide Impact

- **Unchanged invariants:** `CodeBlock` component behavior outside of tool contexts is unaffected (the `min-w-fit` change improves all code blocks). `CompactableContainer` height capping and expand toggle are untouched. All tool registry renderers continue to work without modification.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `min-w-fit` causes unexpected layout shifts in narrow containers | Test with both wide and narrow content; `min-w-fit` only affects minimum width, not maximum. |

## Sources & References

- Related code: `src/client/components/ai-elements/tool.tsx`, `src/client/components/ai-elements/code-block.tsx`
