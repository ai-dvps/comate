---
title: Tool Content Collapse by Default
type: feat
status: completed
date: 2026-05-28
origin: docs/brainstorms/tool-content-collapse-requirements.md
---

# Tool Content Collapse by Default

## Summary

Extend `CompactableContainer` with two optional props — `compactHeight` and `alwaysShowToggle` — so `ToolContent` can start fully collapsed with a persistent toggle, while existing non-tool consumers retain their current behavior unchanged. Both message list paths (`MessageList` and `VirtualizedMessageList`) are covered by the single `ToolContent` change.

---

## Problem Frame

Every tool call currently renders its full input and output inline by default. This creates vertical noise in chat, especially when multiple tools run in a single assistant turn. The original AI Elements vendoring plan specified tool blocks should default to collapsed, but that behavior was not fully wired in `CompactableContainer` / `ToolContent`.

(see origin: `docs/brainstorms/tool-content-collapse-requirements.md`)

---

## Requirements

- R1. All tool renders must start with their content area hidden, displaying only the tool header.
- R2. Tool content must be hidden regardless of content length — even tools with very short output start collapsed.
- R3. A "Show more" control must appear below the tool header when the tool is collapsed.
- R4. When expanded, the control must read "Show less" and allow the user to collapse the content back.
- R5. The toggle must reuse the existing "Show more / Show less" interaction pattern and terminology.
- R6. The collapsed-by-default behavior must apply only to tool renders, and must not alter the behavior of shared UI primitives in non-tool contexts.

**Origin acceptance examples:** AE1 (covers R1–R5), AE2 (covers R6)

---

## Scope Boundaries

- No persistence of expand/collapse state across messages, chat sessions, or reloads.
- No bulk expand/collapse control for all tools in a message.
- No changes to the tool header design beyond ensuring the toggle is visible below it.
- No removal of the existing inner content truncation for long output — it may coexist with the new tool-level collapse.
- No animation or transition effects added to the expand/collapse behavior.
- No new test framework or component tests — the repo has no UI component test infrastructure.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/ai-elements/compactable-container.tsx` — The shared collapse primitive. Currently truncates at `192px` and shows the toggle only when content overflows that threshold. Uses `ResizeObserver` for height measurement. Must remain backward-compatible for `SubagentBriefStatus`.
- `src/client/components/ai-elements/tool.tsx` — `ToolContent` wraps children in `CompactableContainer` with `space-y-2 p-2` styling. The original vendoring comment notes that `Collapsible` was replaced with `CompactableContainer` and the header is intentionally static.
- `src/client/components/MessageList.tsx` and `src/client/components/VirtualizedMessageList.tsx` — Both render tools identically via `ToolHeader` + `ToolContent`. A change in `ToolContent` covers both paths automatically.
- `src/client/components/SubagentBriefStatus.tsx` — The only other consumer of `CompactableContainer`. Uses it for prompt and result blocks with default styling.

### Institutional Learnings

- The prior extraction of `CompactableContainer` from `ToolContent` into a standalone component was explicitly done to avoid styling leakage to non-tool consumers. This plan follows the same pattern: extend the shared primitive with configuration props rather than coupling tool-specific behavior into the shared component or vice versa.
- The original AI Elements vendoring plan (`docs/plans/2026-05-16-006-feat-ai-elements-message-rendering-plan.md`) already specified that tool blocks should default to collapsed on both streaming and completion.

---

## Key Technical Decisions

- **Extend `CompactableContainer` with props rather than create a wrapper:** The component is already extracted and shared. Adding `compactHeight` and `alwaysShowToggle` as optional props is the minimal change that preserves the existing API for `SubagentBriefStatus` while enabling the new behavior for `ToolContent`. A wrapper would introduce an extra component layer for no additional benefit.
- **Use `compactHeight` for both the collapsed max-height and the overflow threshold:** More correct than a hardcoded `192px` threshold when the collapsed height is configurable. When `compactHeight` is `0`, any non-empty content will measure as overflowing, which naturally aligns with the `alwaysShowToggle` intent.
- **No `defaultExpanded` prop needed:** The existing `expanded` state starts at `false`, which already means "show the compact view." The distinction between "compact at 192px" and "compact at 0px" is captured entirely by `compactHeight`.

---

## Implementation Units

### U1. Extend CompactableContainer with configurable collapse behavior

**Goal:** Allow consumers to specify a custom compact height and force the toggle to always render, while preserving existing default behavior.

**Requirements:** R5, R6

**Dependencies:** None

**Files:**
- Modify: `src/client/components/ai-elements/compactable-container.tsx`

**Approach:**
- Add `compactHeight?: number` prop with default `COMPACTABLE_MAX_HEIGHT_PX`.
- Add `alwaysShowToggle?: boolean` prop with default `false`.
- Use `compactHeight` for the `maxHeight` style when `expanded` is `false`.
- Use `compactHeight` for the `overflows` threshold (`scrollHeight > compactHeight`) instead of the hardcoded constant.
- Render the toggle when `overflows || alwaysShowToggle`.
- Keep the existing `ResizeObserver` measurement pattern and toggle styling unchanged.

**Patterns to follow:**
- Existing `CompactableContainer` structure: `useState`, `useRef`, `useEffect` + `ResizeObserver`.
- Repo convention for optional props on functional components.

**Test scenarios:**
- **Happy path:** Consumer passes `compactHeight={0}` and `alwaysShowToggle={true}` → component renders with 0px max-height and the toggle is visible even for empty content.
- **Edge case:** Consumer passes no props → component behaves exactly as before (192px compact height, toggle visible only on overflow).
- **Edge case:** Content is exactly `compactHeight` tall → `overflows` is `false`; if `alwaysShowToggle` is `true`, toggle still renders.

**Verification:**
- `SubagentBriefStatus.tsx` compiles and renders unchanged without prop modifications.
- The toggle styling, icons (ChevronDown / ChevronUp), and aria-expanded attribute remain identical.

---

### U2. Wire ToolContent to start collapsed with always-visible toggle

**Goal:** Tool renders start fully hidden below the header, with the existing toggle visible and functional.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/ai-elements/tool.tsx`

**Approach:**
- In `ToolContent`, pass `compactHeight={0}` and `alwaysShowToggle={true}` to `CompactableContainer`.
- No other changes to `ToolContent` styling or structure.

**Patterns to follow:**
- `ToolContent` already delegates to `CompactableContainer` — the change is prop-only.

**Test scenarios:**
- **Happy path:** Message with a completed tool → only the tool header (icon, name, status badge) is visible initially. Clicking "Show more" expands to reveal `ToolInput` and `ToolOutput`. Clicking "Show less" collapses back to header-only.
- **Happy path:** Message with a running tool (`input-available` state) → tool starts collapsed while the header shows the pulsing "Running" badge. User can expand to watch streaming input arrive.
- **Edge case:** Tool with very short output (e.g., a single string) → still starts collapsed with "Show more" visible, matching the always-collapsed requirement.
- **Integration:** Both `MessageList` and `VirtualizedMessageList` render tools in the collapsed state without individual changes.

**Verification:**
- In the chat UI, a message containing one or more tool calls renders with only headers visible.
- Expanding and collapsing each tool works independently.
- No visual regressions in `SubagentBriefStatus` cards.

---

## System-Wide Impact

- **Interaction graph:** `ToolContent` is the only component that changes behavior. Both `MessageList` and `VirtualizedMessageList` consume `ToolContent`, so both paths are updated automatically.
- **Unchanged invariants:** `SubagentBriefStatus` continues to use `CompactableContainer` with default props, so its prompt and result blocks retain the 192px truncation-with-overflow-toggle behavior. The `CompactableContainer` API surface is additive only.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `SubagentBriefStatus` accidentally affected by default-behavior change in `CompactableContainer` | The change is strictly additive (new optional props). Existing call sites pass no new props, so behavior is unchanged. Verify during U2 verification. |
| Toggle is invisible or mispositioned when `compactHeight={0}` because it sits at the bottom of a 0px content area | The toggle is a sibling of the content wrapper, not a child, so it renders immediately below the collapsed content area. This matches the user's requested placement "right below the header." |
| Virtualized message list remounts components and loses toggle state | Accepted — toggle state is ephemeral by design (requirement). Remounts resetting state are consistent with the no-persistence boundary. |

---

## Sources & References

- **Origin document:** [docs/brainstorms/tool-content-collapse-requirements.md](docs/brainstorms/tool-content-collapse-requirements.md)
- **Related plan:** [docs/plans/2026-05-16-006-feat-ai-elements-message-rendering-plan.md](docs/plans/2026-05-16-006-feat-ai-elements-message-rendering-plan.md) — original vendoring plan that specified tool blocks should default collapsed
- Related code: `src/client/components/ai-elements/compactable-container.tsx`, `src/client/components/ai-elements/tool.tsx`, `src/client/components/SubagentBriefStatus.tsx`
