---
title: "feat: Render AskUserQuestion content as markdown"
type: feat
status: completed
date: 2026-05-28
---

# feat: Render AskUserQuestion content as markdown

## Summary

Replace plain-text rendering in the `AskUserQuestion` tool renderer with `Streamdown` so that question text and option descriptions support markdown formatting (lists, code spans, emphasis, links, etc.), matching the rendering quality of assistant message content.

## Requirements

- R1. Question text (`question.question`) renders as markdown instead of plain text.
- R2. Option descriptions (`option.description`) render as markdown instead of plain text.
- R3. Styling remains consistent with the tool-renderers surface (text size, color, spacing).
- R4. No markdown rendering in headers or option labels, which remain plain text.

## Scope Boundaries

- Out of scope: Adding markdown rendering to other tool renderers.
- Out of scope: Changing the `Streamdown` component or adding new remark/rehype plugins.
- Out of scope: Markdown rendering for `StructuredFallback` fallback behavior.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/tool-renderers/renderers/AskUserQuestionRenderer.tsx` — current plain-text renderer; target file for modification.
- `src/client/components/ai-elements/message.tsx` — `MessageResponse` uses `<Streamdown>` with Tailwind list-reset overrides (`[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5`).
- `src/client/components/ai-elements/response.tsx` — thin `Response` wrapper around `<Streamdown>` with margin-reset classes (`[&>*:first-child]:mt-0 [&>*:last-child]:mb-0`).
- `src/client/components/ai-elements/reasoning.tsx` — `ReasoningContent` uses `<Streamdown>` inside a collapsible with the same list-reset overrides.

### External References

- `streamdown` v1.0.0 (installed dependency) — React markdown renderer with Shiki syntax highlighting and Mermaid diagram support.

## Key Technical Decisions

- Use `<Streamdown>` directly (not the `Response` wrapper) because the tool renderer context needs tighter control over font size and color. The `Response` wrapper assumes full message-width styling.
- Apply `text-sm` and `text-text-secondary` via a wrapper `div` or `className` on `Streamdown`, keeping `Streamdown` itself unopinionated about color so it inherits correctly.
- Apply margin-reset overrides (`[&>*:first-child]:mt-0 [&>*:last-child]:mb-0`) to prevent extra vertical spacing inside the compact tool-input surface.
- Apply list-reset overrides (`[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5`) to match message rendering behavior.

## Implementation Units

### U1. Markdown-enable AskUserQuestionRenderer

**Goal:** Render question text and option descriptions as markdown using `Streamdown`.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `src/client/components/tool-renderers/renderers/AskUserQuestionRenderer.tsx`

**Approach:**
- Import `Streamdown` from `'streamdown'`.
- Replace the plain `<p>` element for `text` with `<Streamdown>` wrapped in a `div` that carries `text-sm text-text-secondary` and margin-reset classes.
- Replace the plain `<span>` element for option `description` with `<Streamdown>` wrapped similarly.
- Keep `header`, `label`, and the "Multi-select" badge as plain text.

**Patterns to follow:**
- `src/client/components/ai-elements/response.tsx` — margin-reset class pattern.
- `src/client/components/ai-elements/message.tsx` — list-reset class pattern.

**Test scenarios:**
- Happy path: Question text containing `**bold**`, `` `code` ``, and `- list` renders with correct formatting.
- Happy path: Option description containing markdown links renders as clickable links.
- Edge case: Empty question text or description renders nothing (guard clause already handles null).
- Edge case: Plain text without markdown special characters renders unchanged.

**Verification:**
- AskUserQuestion tool calls in the UI display formatted markdown in question bodies and option descriptions.
- No visual regression in headers, labels, or layout spacing.

## System-Wide Impact

- **Unchanged invariants:** Other tool renderers continue to render plain text. The `Streamdown` package is already a project dependency, so no new bundle weight is introduced.
- **API surface parity:** N/A — this is a purely presentational change within a single tool renderer.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `Streamdown` default margins or heading sizes blow out compact tool-card layout | Apply margin-reset overrides and wrap in `text-sm` container; verify visually. |

## Sources & References

- Related code: `src/client/components/tool-renderers/renderers/AskUserQuestionRenderer.tsx`
- Related code: `src/client/components/ai-elements/response.tsx`
- Related code: `src/client/components/ai-elements/message.tsx`
