---
title: "AskUserQuestion Collapse - Plan"
type: feat
date: "2026-07-16"
topic: "ask-user-question-collapse"
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# AskUserQuestion Collapse - Plan

## Goal Capsule

- **Objective:** Let users temporarily fold the AskUserQuestion tool card in the message panel so it stops taking up vertical space while they read nearby messages.
- **Product authority:** User-controlled, ephemeral UI state; no workflow rules or persistence.
- **Open blockers:** None.

---

## Product Contract

Product Contract unchanged from the requirements-only version.

### Summary

Add a collapse toggle to the AskUserQuestion tool renderer in the message panel. The card starts expanded so the question is visible and answerable; clicking a thin header folds it to just that header line. Collapse state is local and temporary, resetting when the view reloads.

### Problem Frame

AskUserQuestion cards can become tall, especially when the question text or option descriptions are long. They currently stay fully expanded once rendered, pushing earlier and later messages apart and forcing extra scrolling when the user is mainly reading the conversation rather than interacting with the question. Users want a quick way to hide the card without dismissing it.

### Requirements

- R1. The AskUserQuestion tool card in the message panel renders with a collapse toggle in its header.
- R2. The card starts expanded when first rendered.
- R3. Clicking the toggle collapses the card to a thin header line that shows the tool identity and an expand affordance; all question text and options are hidden.
- R4. Clicking the collapsed header expands the card again and restores the full question text and options.
- R5. Collapse state is temporary and resets when the component re-renders from scratch or the user navigates away and back.
- R6. If one AskUserQuestion call contains multiple questions, they collapse and expand together as a single card.
- R7. Existing markdown rendering of question text and option descriptions is preserved when the card is expanded.

### Key Decisions

- **Full card collapse, not compact preview.** The user rejected height-based "Show more / less" previews and wants the entire card folded down to a header line for maximum space savings.
- **Manual toggle only, not tied to answer state.** Collapse is a reading aid controlled by the user; it does not auto-collapse after an answer is selected.
- **Ephemeral state over persistence.** The state lives in the component instance and resets on reload, keeping the behavior predictable and avoiding storage concerns.

### Scope Boundaries

- Out of scope: Auto-collapsing AskUserQuestion after the user answers.
- Out of scope: Height-based compact preview mode ("Show more / Show less") for long question text.
- Out of scope: Collapsing other tool renderers in the message panel.
- Out of scope: Persisting collapse state across sessions or storing it in the backend.

---

## Planning Contract

### Key Technical Decisions

- **Local `useState` inside the renderer.** The collapse state is a per-instance UI affordance, not shared data. Keeping it inside `AskUserQuestionRenderer` satisfies the ephemeral-state requirement and avoids the message store's server-fetched state overwriting it.
- **Use the existing `Collapsible` primitive.** `src/client/components/ui/collapsible.tsx` wraps `@radix-ui/react-collapsible` and is already used by `Reasoning` and `MutedSystemNote`. Reusing it gives accessible expand/collapse behavior and animation hooks without adding dependencies.
- **Header-driven toggle.** The entire header row becomes the toggle, following the `ReasoningTrigger` pattern. The header remains visible when collapsed so users can re-expand; the chevron rotates to indicate state.

### Assumptions

- The renderer can be converted from a pure function to a component with local state without breaking the tool-renderer registry contract.
- No parent component needs to control the collapsed state; future controllability can be added later if product requirements change.

### Sequencing

1. Implement the collapse toggle in `AskUserQuestionRenderer.tsx`.
2. Add co-located component tests.
3. Run lint and jsdom tests.
4. Verify visually in the message panel.

---

## Implementation Units

### U1. Make AskUserQuestionRenderer stateful with collapse toggle

**Goal:** Add a collapse toggle to the AskUserQuestion renderer that starts expanded and folds to a thin header line.

**Requirements:** R1, R2, R3, R4, R6, R7

**Dependencies:** None

**Files:**
- Modify: `src/client/components/tool-renderers/renderers/AskUserQuestionRenderer.tsx`

**Approach:**
- Convert the renderer from a pure function to a component with `const [isOpen, setIsOpen] = useState(true)`.
- Import `Collapsible`, `CollapsibleTrigger`, and `CollapsibleContent` from `src/client/components/ui/collapsible.tsx`.
- Import `ChevronDown` from `lucide-react` for the expand/collapse affordance.
- Wrap the card in `Collapsible open={isOpen} onOpenChange={setIsOpen}`.
- Move the existing header row (`HelpCircle`, header text, multi-select badge) into `CollapsibleTrigger`.
- Move the question text and options into `CollapsibleContent`.
- Keep the collapsed view as a thin header line showing the tool identity and a chevron.
- Preserve existing `Streamdown` markdown rendering when expanded.

**Patterns to follow:**
- `src/client/components/ai-elements/reasoning.tsx` for header toggle, chevron rotation, and `aria-expanded`.
- `src/client/components/ui/collapsible.tsx` for the collapsible primitive.

**Test scenarios:**
- Happy path: renders expanded by default and shows question text and options.
- Happy path: clicking the header collapses the card, hiding question text and options while keeping the header visible.
- Happy path: clicking the collapsed header expands the card and restores the full content.
- Edge case: an AskUserQuestion call with multiple questions collapses and expands as a single card.
- Edge case: invalid or missing input still returns `null`.

**Verification:**
- The card renders in the message panel with a toggle in the header.
- Toggle expands and collapses the card.
- Existing markdown formatting remains intact when expanded.

---

### U2. Add component tests for AskUserQuestionRenderer collapse

**Goal:** Verify expand/collapse behavior with automated jsdom tests.

**Requirements:** R1, R2, R3, R4, R6

**Dependencies:** U1

**Files:**
- Create: `src/client/components/tool-renderers/renderers/AskUserQuestionRenderer.test.tsx`

**Approach:**
- Import the renderer via the registry and render it inside `ToolRendererProvider`, following existing renderer tests.
- Query the toggle with `screen.getByRole('button', { name: /.../ })` or a test id.
- Use `userEvent.click` to toggle state.
- Assert on `aria-expanded` and content visibility.

**Patterns to follow:**
- `src/client/components/tool-renderers/renderers/ReadRenderer.test.tsx` for provider setup and registry import.
- `src/client/components/ai-elements/structured-report.test.tsx` for collapse assertions.

**Test scenarios:**
- Happy path: toggle button has `aria-expanded="true"` initially and content is visible.
- Happy path: after one click, `aria-expanded="false"` and question text/options are hidden.
- Happy path: after a second click, `aria-expanded="true"` and content is visible again.
- Edge case: multiple questions inside one call collapse and expand together.
- Edge case: malformed input still renders nothing.

**Verification:**
- `npm run test:client` passes for the new test file.

---

## Verification Contract

- Run `npm run test:client` and confirm `AskUserQuestionRenderer.test.tsx` passes.
- Run `npm run lint` and confirm no new errors in modified files.
- Manually trigger an `AskUserQuestion` in the app and verify:
  - The card starts expanded.
  - Clicking the header collapses it to a thin line.
  - Clicking the header again expands it.
  - Markdown formatting in question text and option descriptions is preserved when expanded.

---

## Definition of Done

- AskUserQuestion card renders with a collapse toggle in the message panel.
- Card starts expanded and can be folded to a thin header line.
- Collapse state is ephemeral and resets on reload.
- Multi-question AskUserQuestion calls collapse and expand as one card.
- Co-located component tests cover expand, collapse, multi-question, and invalid-input cases.
- Lint and jsdom tests pass.
- The implementation is visually verified in the message panel.

---

## Risks & Dependencies

- **Server-fetched state clobbering collapse state.** The message store is periodically refreshed from the server. Keeping collapse state local to the renderer prevents unexpected resets. Do not lift it to any store or message state.
- **First stateful renderer in the folder.** All other renderers in `src/client/components/tool-renderers/renderers/` are currently pure functions. Converting `AskUserQuestionRenderer` to a component is safe, but future renderers should not copy this pattern unless they also need local UI state.

---

## Sources & Research

- Current renderer: `src/client/components/tool-renderers/renderers/AskUserQuestionRenderer.tsx`
- Existing collapsible primitive: `src/client/components/ui/collapsible.tsx`
- Existing compactable/collapsible patterns: `src/client/components/ai-elements/compactable-container.tsx`, `src/client/components/ai-elements/reasoning.tsx`
- Existing renderer test pattern: `src/client/components/tool-renderers/renderers/ReadRenderer.test.tsx`
- Institutional learnings: `docs/solutions/integration-issues/sse-stream-resume-on-reconnect-2026-05-18.md` — keep collapse state local to avoid server-fetched message state overwriting it.
