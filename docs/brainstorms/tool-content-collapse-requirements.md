---
date: 2026-05-28
topic: tool-content-collapse
---

# Tool Content Collapse by Default

## Summary

Every tool render starts with its content hidden, showing only the tool header. A "Show more / Show less" toggle below the header expands or collapses the tool's input and output on demand. Toggle state is ephemeral — it resets when the user navigates away or reloads.

---

## Problem Frame

Currently, every tool call renders its full input and output inline by default. When an assistant message includes multiple tool calls, or when tool output is verbose, this creates significant vertical noise and pushes subsequent messages far down the viewport. Users who only care about the final result must scroll past all intermediate tool detail.

---

## Requirements

**Default visibility**
- R1. All tool renders must start with their content area hidden, displaying only the tool header.
- R2. Tool content must be hidden regardless of content length — even tools with very short output start collapsed.

**Toggle behavior**
- R3. A "Show more" control must appear below the tool header when the tool is collapsed, allowing the user to expand the content.
- R4. When expanded, the control must read "Show less" and allow the user to collapse the content back to the hidden state.
- R5. The toggle must reuse the existing "Show more / Show less" interaction pattern and terminology already present in the codebase.

**Scope isolation**
- R6. The collapsed-by-default behavior must apply only to tool renders, and must not alter the behavior of shared UI primitives in non-tool contexts.

---

## Success Criteria

- Users can scan a message with multiple tool calls without scrolling through full tool content.
- A user can expand any individual tool to inspect its input and output with a single click.
- Downstream implementers can identify whether the change is localized to tool rendering or affects shared UI primitives.

---

## Scope Boundaries

- No persistence of expand/collapse state across messages, chat sessions, or reloads.
- No bulk expand/collapse control for all tools in a message.
- No changes to the tool header design beyond ensuring the toggle is visible below it.
- No removal of the existing inner content truncation for long output — it may coexist with the new tool-level collapse.

---

## Key Decisions

- **Reuse existing toggle rather than add a header-level control:** Keeps the interaction pattern consistent with the existing "Show more / Show less" behavior and avoids introducing a new UI element in the header.
- **Always collapsed including short tools:** Prioritizes consistent behavior over minimizing clicks for trivial output.

---

## Dependencies / Assumptions

- The existing collapse/expand container component can be extended or configured to support an initial collapsed state and forced toggle visibility without affecting other consumers.
