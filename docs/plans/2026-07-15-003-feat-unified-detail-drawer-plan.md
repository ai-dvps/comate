---
title: Unified Detail Drawer - Plan
type: feat
date: 2026-07-15
topic: unified-detail-drawer
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Unified Detail Drawer - Plan

## Goal Capsule

- **Objective:** Replace the three separate, conflicting detail panels (process-region, subagent, workflow) with one right-hand detail drawer driven by a navigation stack, so drilling into a subagent or nested agent — from any level — navigates in place with a back button instead of dead-ending or stacking sibling panels.
- **Product authority:** Product behavior from the requirements-only brainstorm (preserved); implementation approach owned by this plan.
- **Execution profile:** Client-only React change; no server or persistence change.
- **Stop conditions:** The unified drawer ships; drilling works at every nesting level (process → subagent → nested, top-level subagent → nested, workflow → subagent); flows F1–F3 and acceptance examples AE1–AE4 pass under `npm run test:client` and a manual check.
- **Open blockers:** None. Workflow panel fold-in (modal → side-drawer view) is accepted.

---

## Product Contract

Product Contract unchanged from the requirements-only brainstorm (R/F/AE IDs and text preserved). This pass adds the Planning Contract, Implementation Units, Verification Contract, and Definition of Done.

### Summary

A single detail drawer with a back-stack. Opening a process region, a subagent, or a workflow from the main chat opens the drawer at that view and resets the stack; drilling into a subagent or nested agent from within the drawer pushes a new view onto the stack (the parent stays). A back button — shown only when the stack is deeper than one — returns to the parent view; the close (X) button dismisses the drawer and clears the whole stack. It covers process regions, subagents, nested agents, and workflows, reusing each existing panel's inner content behind one unified shell.

### Problem Frame

Today every nesting level is a dead end. `SubagentConversation` and `ProcessRegionDrawer` pass `onOpenDrawer={() => {}}`, so a subagent opened from inside the process-region drawer (or a nested agent from inside a subagent) does nothing; the workflow panel's nested subagent opens only one level before hitting the same no-op. On top of that, the three detail surfaces (`SubagentDrawer`, `ProcessRegionDrawer`, `WorkflowDetailPanel`) are separate siblings with independent state, so even when they do open they conflict or stack awkwardly instead of navigating. There is no way to drill arbitrarily deep.

### Key Decisions

- **One drawer, one navigation stack.** A single right-hand drawer holds a stack of views. Opening from the main chat resets the stack to that view; opening from within the drawer pushes. Back pops one level; X clears the stack. This makes nesting depth unbounded by design.
- **Push-from-within / reset-from-main-chat.** Drilling originates inside the drawer (push, parent retained); top-level opens originate from the main chat (reset, a fresh exploration). The two are distinguished by where the open call comes from, not by view type.
- **Back only when stack depth > 1.** The bottom view has no back button, only X — so the affordance matches the stack state.
- **Fold the workflow panel in.** `WorkflowDetailPanel` (today a modal that hosts its own nested `SubagentDrawer`) becomes another view type in the same drawer, so workflow → subagent drilling uses the same stack and stops being a special case. Accepting it moves workflow detail from a modal overlay to a side-drawer view for consistency.
- **Reuse the inner content; unify only the shell + nav.** Each view renders the existing body it already has — process region via `ChatMessageRenderer` (linear), subagent via `SubagentConversation` plus its status header, workflow via the `WorkflowDetailPanel` body. The new work is the drawer shell, the view-stack, and wiring the dead-end handlers to push.
- **Preserve the subagent status header.** The running/completed/error badge, duration, and tool count stay on the subagent view.

### Requirements

**Drawer shell and navigation**

- R1. There is one detail drawer slot. Opening a process region, a subagent, or a workflow from the main chat opens it and resets the view-stack to that single view.
- R2. Activating a subagent or nested agent from within the drawer pushes a new view onto the stack; the parent view remains in the stack.
- R3. A back button is shown only when the stack depth is greater than one; activating it returns to the parent view (pops one level). The back button carries a dynamic accessible name naming the parent view (e.g. "Back to <parent>"), and the close (X) button has an accessible name.
- R4. The close (X) button dismisses the drawer and clears the entire stack.

**View rendering**

- R5. The drawer renders the body appropriate to the top view's type — process region, subagent, nested subagent, or workflow — reusing the existing inner renderers.
- R6. The subagent view retains the status header (running/completed/error badge, duration, tool count).
- R7. A single resizable width is shared across all views (one width state, not per-panel).

**Behavior and a11y**

- R8. The previous dead-end handlers are removed: drilling into a subagent or nested agent works at every nesting level (process → subagent → nested, top-level subagent → nested, and workflow → subagent).
- R9. Escape closes the drawer; focus management (focus moves in on open, is trapped while open, and returns to the activating element on close) is preserved per open. On a drill (push) focus moves into the new view; on back (pop) focus returns to the element that triggered the push. An `aria-live` region announces the new view's title on each push/pop.

### Key Flows

- F1. Drill-down and back
  - **Trigger:** The user opens a process region from the main chat, then activates a subagent inside it, then a nested agent inside that.
  - **Steps:** The drawer opens on the process region (depth 1, no back). Activating the subagent pushes it (depth 2, back appears). Activating the nested agent pushes it (depth 3). Back returns to the subagent (depth 2); back again returns to the process region (depth 1, back hides).
  - **Outcome:** The user can drill arbitrarily deep and retrace without nested or sibling drawers.
  - **Covered by:** R1, R2, R3, R8
- F2. Top-level open resets the stack
  - **Trigger:** While the drawer is open on a nested agent, the user activates a different top-level subagent in the main chat.
  - **Steps:** The stack resets to that single subagent view (depth 1, back hidden).
  - **Covered by:** R1
- F3. Workflow drilling
  - **Trigger:** The user opens a workflow from the main chat, then activates a subagent inside it.
  - **Steps:** The drawer opens on the workflow view (depth 1); activating the subagent pushes it (depth 2); back returns to the workflow.
  - **Covered by:** R1, R2, R3, R5, R8

### Acceptance Examples

- AE1. **Covers R1–R3, R8.** Given a process region containing a subagent that itself spawns a nested agent, when the user opens the region then drills into the subagent then the nested agent, then presses back twice, the drawer returns exactly to the region view and at no point opens a second drawer.
- AE2. **Covers R1.** Given the drawer is open at depth 3, when the user activates a top-level subagent from the main chat, the stack resets to depth 1 showing only that subagent.
- AE3. **Covers R5, R8.** Given a workflow whose steps include a subagent, when the user opens the workflow then activates the subagent, the drawer navigates from the workflow view to the subagent view and back returns to the workflow.
- AE4. **Covers R4, R9.** Given the drawer open at any depth, pressing X or Escape closes the drawer and clears the stack; focus returns to the activating element.

### Scope Boundaries

- Out of scope: changing what each view renders internally (beyond wiring drilling to the stack); main-chat and result-mode rendering; the message grouping/turn-merge logic.
- In scope (accepted): moving workflow detail from a modal overlay to a side-drawer view.

### Dependencies and Assumptions

- Verified: `SubagentConversation.tsx:56` and `ProcessRegionDrawer.tsx:169` pass `onOpenDrawer={() => {}}` (dead-ends); `WorkflowDetailPanel.tsx` is modal-based (lines 64/77) and hosts its own nested `SubagentDrawer` (line 191); `ChatPanel.tsx` renders `SubagentDrawer`, `WorkflowDetailPanel`, and `ProcessRegionDrawer` as siblings with independent state.
- Assumption: workflow detail moving from a modal to a side-drawer view is acceptable (confirmed during brainstorm).

### Outstanding Questions

- Deferred to implementation:
  - Whether the three body components stay as-is behind the shell or share extracted header logic.
  - How a single shared width interacts with each view type's preferred width.
  - Whether a transition animation plays when the drawer swaps views.
  - The focus-across-swaps mechanism: whether parent views stay mounted (hidden) or unmount on push (requiring an explicit focus-memory map) — either satisfies R9's push/pop focus rule.

### Sources / Research

- Drawer wiring and state: `src/client/components/ChatPanel.tsx` (renders the three drawers; holds `openDrawerToolUseId`, `openWorkflowRunId`, `openProcessRegion`, and width state).
- Dead-end handlers: `src/client/components/SubagentConversation.tsx:56`, `src/client/components/ProcessRegionDrawer.tsx:169`.
- Panels to unify: `src/client/components/SubagentDrawer.tsx` (status header + `SubagentConversation` body, resizable aside, Escape), `src/client/components/ProcessRegionDrawer.tsx` (process-region body via `ChatMessageRenderer`, focus management), `src/client/components/WorkflowDetailPanel.tsx` (modal-based, workflow body, hosts nested `SubagentDrawer` at line 191).

---

## Planning Contract

### Key Technical Decisions

- **KTD1. One view-stack in `ChatPanel`, replacing the three separate states.** A `DrawerView` discriminated union (`process` / `subagent` / `workflow`) held as a stack array. `openDrawer(view)` resets to `[view]`; `pushDrawer(view)` appends; `popDrawer()` drops the top when depth > 1; `closeDrawer()` clears to `[]`. This is the single source of truth for what the drawer shows.
- **KTD2. One `DetailDrawer` shell composes the existing bodies.** The shell owns the `<aside>`, resize handle, Escape, focus management, and a header (back button when depth > 1 + title + X). It switches over `view.kind` to render the matching body, reusing each panel's existing inner renderer. The three current drawer components are refactored to expose a shell-less body used by `DetailDrawer`.
- **KTD3. Push vs reset is decided by call origin.** The main-chat open handlers (`onOpenDrawer`, `onOpenProcessRegion`, `onOpenWorkflow` threaded through `MessageList`) call `openDrawer` (reset). The drawer's own internal `onOpenDrawer` (passed into the bodies' `ChatMessageRenderer` / `SubagentBriefStatus`) calls `pushDrawer` (push). No view type special-cases the semantics.
- **KTD4. Workflow body extracted from its `Modal`.** `WorkflowDetailPanel`'s phase content is reused as a body view; its `Modal` wrapper and its private nested `SubagentDrawer` are removed (drilling goes through the shared stack).
- **KTD5. Shell owns width, Escape, and focus for all views.** A single shared resizable width, Escape-to-close, and the focus cycle (move-in, trap, return) live in `DetailDrawer` and apply uniformly — replacing the per-panel duplicates in `SubagentDrawer` / `ProcessRegionDrawer`.

### High-Level Technical Design

```mermaid
flowchart TB
  Main["Main chat: open process / subagent / workflow"] -->|openDrawer (reset)| Stack["DrawerView stack\nin ChatPanel"]
  InDrawer["Inside drawer: activate subagent / nested agent"] -->|pushDrawer (push)| Stack
  Stack --> Top["render top view in DetailDrawer"]
  Top --> Body{"view.kind?"}
  Body -->|process| PB["Process body\n(ChatMessageRenderer, linear)"]
  Body -->|subagent| SB["Subagent body\n(status header + SubagentConversation)"]
  Body -->|workflow| WB["Workflow body\n(phases)"]
  Back["Back button (depth > 1)"] -->|popDrawer (pop)| Stack
  X["X / Escape"] -->|closeDrawer (clear)| Closed["drawer closed"]
```

### Assumptions

- The subagent status header and the workflow phase content render correctly without their current panel/modal wrappers (they are self-contained bodies).
- A single shared width is acceptable even though the current panels used slightly different defaults (SubagentDrawer 400, WorkflowDetailPanel 360).

### Sequencing

U1 (view-stack model + handlers) is the foundation. U2 (DetailDrawer shell + bodies) depends on U1's model. U3 (ChatPanel wiring) depends on U1 and U2. U4 (tests) depends on U3. Order: U1 → U2 → U3 → U4.

---

## Implementation Units

### U1. Drawer view-stack model and handlers

- **Goal:** Define the `DrawerView` type and the stack operations (open/reset, push, pop, clear) as the single navigation model, independent of rendering.
- **Requirements:** R1, R2, R3, R4.
- **Dependencies:** None.
- **Files:**
  - `src/client/components/detail-drawer-view.ts` (create) — the `DrawerView` discriminated union and pure stack helpers (`openDrawer`, `pushDrawer`, `popDrawer`, `closeDrawer` operating on a `DrawerView[]`).
  - `src/client/components/detail-drawer-view.test.ts` (create).
- **Approach:** Pure functions over a `DrawerView[]`: reset returns `[view]`; push returns `[...stack, view]`; pop returns `stack.slice(0, -1)` when `length > 1` else `stack`; clear returns `[]`. Keeping them pure makes the navigation semantics unit-testable without React.
- **Patterns to follow:** the pure-function style of `src/client/components/message-grouping.ts`.
- **Test scenarios:**
  - openDrawer resets the stack to a single view (a prior 3-deep stack is discarded).
  - pushDrawer appends a view; the previous top remains.
  - popDrawer drops only the top view and only when depth > 1 (pop at depth 1 is a no-op).
  - closeDrawer returns an empty stack.
- **Verification:** Stack helpers are pure and covered by unit tests; behavior matches R1–R4.

### U2. DetailDrawer shell + per-view bodies

- **Goal:** Build the single `DetailDrawer` component — shell (aside, resize, Escape, focus management, header with back + X) that renders the top view's body by kind, reusing the existing inner renderers.
- **Requirements:** R3, R5, R6, R7, R9.
- **Dependencies:** U1.
- **Files:**
  - `src/client/components/DetailDrawer.tsx` (create) — the shell + body switch.
  - `src/client/components/SubagentDrawer.tsx` (modify) — extract the body (status header + `SubagentConversation`) so `DetailDrawer` can render it without the standalone aside/Escape duplication.
  - `src/client/components/ProcessRegionDrawer.tsx` (modify) — extract its body (read messages by id, group, render region via `ChatMessageRenderer`) as an embeddable body; the joined-id split logic stays.
  - `src/client/components/WorkflowDetailPanel.tsx` (modify) — extract the phase body, removing the `Modal` wrapper and its private nested `SubagentDrawer`.
  - `src/client/components/SubagentConversation.tsx` (modify) — accept an `onOpenDrawer` prop and thread it down to its inner `ChatMessageRenderer`, replacing the hardcoded line-56 no-op so a nested agent drills via `pushDrawer`.
  - `src/client/components/DetailDrawer.test.tsx` (create) — component-level body/header/handler tests.
- **Approach:** `DetailDrawer` takes the stack (or just the top view + depth), the four handlers from U1, `sessionId`, and the shared width. Header shows a back button when `stack.length > 1`, a per-kind title (process: step count; subagent: name + status; workflow: name), and X. The body switch renders the matching extracted body and passes an `onOpenDrawer` that calls `pushDrawer({kind:'subagent', parentToolUseId})`, removing the no-ops — including threading that handler through `SubagentConversation` to its inner `ChatMessageRenderer` (replacing the line-56 no-op) so nested agents drill via push. Subagent body preserves the status header (R6). Resize/Escape/focus live in the shell (R7, R9).
- **Patterns to follow:** the aside/resize/Escape/focus pattern already in `src/client/components/SubagentDrawer.tsx` and `src/client/components/ProcessRegionDrawer.tsx`.
- **Test scenarios:**
  - Renders the correct body for each view kind (process / subagent / workflow) given the top view.
  - Back button is present only when stack depth > 1; clicking it calls the pop handler.
  - X calls the close handler; Escape calls the close handler.
  - Subagent view renders the status header (badge + duration + tool count).
  - Activating a subagent inside a body calls the push handler (the dead-end no-op is gone).
- **Verification:** Each view kind renders its body; back/X/Escape/fire the right handlers; no second drawer opens.

### U3. Wire ChatPanel to the unified drawer

- **Goal:** Replace the three separate drawer states and sibling renders in `ChatPanel` with the view-stack + a single `DetailDrawer`, and route main-chat opens to reset.
- **Requirements:** R1, R2, R8.
- **Dependencies:** U1, U2.
- **Files:**
  - `src/client/components/ChatPanel.tsx` (modify) — replace `openDrawerToolUseId` / `openWorkflowRunId` / `openProcessRegion` and their setters with `drawerStack` + the U1 handlers (or a `useReducer` over them); render a single `<DetailDrawer>` when the stack is non-empty; thread `openDrawer` (reset) to `MessageList`'s `onOpenDrawer` / `onOpenProcessRegion` / `onOpenWorkflow`. Keep the displayMode-clear-on-mode-change behavior as `closeDrawer()` when leaving result mode.
- **Approach:** Main-chat open handlers call `openDrawer(view)` (reset) — so a top-level subagent/process/workflow open starts a fresh stack. The drawer's internal drilling is handled inside `DetailDrawer` via `pushDrawer` (U2). Remove the three old sibling `<SubagentDrawer>` / `<WorkflowDetailPanel>` / `<ProcessRegionDrawer>` renders and their per-panel width states (consolidate to one shared width).
- **Patterns to follow:** the existing `openDrawerToolUseId`/`setOpenDrawerToolUseId` threading pattern in `ChatPanel.tsx`.
- **Test scenarios:**
  - Opening a process region from the main chat sets the stack to `[process view]` (depth 1).
  - Opening a top-level subagent from the main chat resets any existing stack to `[subagent view]`.
  - Opening a workflow from the main chat resets the stack to `[workflow view]`.
  - The three old sibling drawers are no longer rendered; only `DetailDrawer` appears.
- **Verification:** One drawer slot; main-chat opens reset the stack (R1); the old siblings are gone; the mode-change close still works.

### U4. Navigation and integration tests

- **Goal:** End-to-end coverage of the drill-down, reset, workflow, and close flows.
- **Requirements:** R1–R9 (F1–F3, AE1–AE4).
- **Dependencies:** U3.
- **Files:**
  - `src/client/components/DetailDrawer.test.tsx` (modify/extend) — add the AE1–AE4 integration tests to the file created in U2.
  - `src/client/components/SubagentDrawer.test.tsx` (modify) — re-scope to the extracted body; drop shell/Escape assertions migrated to `DetailDrawer`.
  - `src/client/components/ProcessRegionDrawer.test.tsx` (modify) — re-scope; Escape/close assertions move to `DetailDrawer`.
  - `src/client/components/WorkflowDetailPanel.test.tsx` (modify) — re-scope; drop the modal + nested-`SubagentDrawer` assertions removed by KTD4.
- **Approach:** Render `DetailDrawer` (and where practical, `ChatPanel` with a mocked store) to exercise the stack transitions: open → drill → drill → back → back (AE1); top-level open resets a deep stack (AE2); workflow → subagent push + back (AE3); X and Escape clear the stack and restore focus (AE4). Mock `useChatStore` for messages/subagents/workflows as in existing component tests; stub `streamdown`.
- **Patterns to follow:** `src/client/components/MessageList.test.tsx` (mock `useChatStore`, stub `streamdown`, `I18nextProvider` wrapper) and `src/client/components/ProcessRegionDrawer.test.tsx`.
- **Test scenarios:**
  - Covers AE1, F1: process → subagent → nested drill, then back twice returns to the process view; no second drawer mounts.
  - Covers AE2, F2: with the stack at depth 3, a main-chat open resets to depth 1.
  - Covers AE3, F3: workflow view → activate subagent → subagent view; back returns to workflow.
  - Covers AE4: X and Escape both clear the stack; focus returns to the activating element.
- **Verification:** All four acceptance examples pass under `npm run test:client`.

---

## Verification Contract

- `npm run lint` — ESLint passes on all touched `.ts`/`.tsx`.
- `npm run test:client` — Vitest (jsdom) covers `detail-drawer-view.test.ts` (U1), the `DetailDrawer` body/header/handler tests (U2), and the navigation integration tests (U4).
- Manual check via `npm run dev:client` (or `npm run tauri:dev`): open a process region and drill into a subagent then a nested agent, confirm back retraces and only one drawer exists (F1); while deep, open a top-level subagent from the main chat and confirm the stack resets (F2); open a workflow, drill into its subagent, and back (F3); confirm X and Escape close the drawer at any depth and focus returns.

---

## Definition of Done

- Global: all four units implemented; `npm run lint` clean; `npm run test:client` green; flows F1–F3 and acceptance examples AE1–AE4 verified under the manual check; `CHANGELOG.md` updated (user-facing change).
- Per-unit:
  - U1: the view-stack helpers are pure and unit-tested against R1–R4.
  - U2: `DetailDrawer` renders each view kind, shows back only past depth 1, preserves the subagent status header, and the no-op dead-ends are replaced by push.
  - U3: `ChatPanel` holds one view-stack, renders one `DetailDrawer`, and main-chat opens reset.
  - U4: AE1–AE4 pass.
- Cleanup: the three standalone sibling drawer renders and their duplicated shell logic (aside/Escape/width) are removed, not left as dead code.
