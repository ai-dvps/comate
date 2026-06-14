---
title: "feat: Redesign session status filter as custom popover dropdown"
type: feat
date: 2026-06-14
origin: docs/brainstorms/2026-06-14-session-filter-dropdown-redesign-requirements.md
---

## Summary

Replace the native `<select>` status filter in the session list with a reusable custom popover filter. The trigger is a compact icon-plus-chevron button next to the search box, and the popover lists All / Active / Archived / WIP as selectable rows with Lucide icons, labels, and a selected checkmark.

## Problem Frame

The current filter is rendered as a native browser `<select>`. Its default styling, generic arrow, and inconsistent sizing make the sidebar feel less polished than the rest of the app, especially next to custom controls like `ProviderSelector`. The user wants the filter to look like a first-class, app-native control.

## Requirements

- R1. Replace the native `<select>` status filter with a custom popover-based filter control.
- R2. The filter trigger sits to the right of the session search box on the same row.
- R3. The trigger is a compact button showing the Lucide icon for the selected status plus a chevron.
- R4. The trigger does not display the text label or a tooltip.
- R5. The trigger exposes an accessible name via `aria-label` that communicates the control purpose and current filter value.
- R6. The popover lists the options in order: All, Active, Archived, WIP.
- R7. Each option row shows a status Lucide icon, the translated label, and a checkmark when selected.
- R8. Selecting an option updates the filter state, closes the popover, and immediately re-filters the list.
- R9. The popover opens and closes with a subtle fade/slide animation.
- R10. The popover is fully keyboard operable: Enter or Space opens the popover, Arrow keys move focus between options, Enter or Space selects the focused option, and Escape closes the popover.
- R11. Existing filter semantics and the workspace-switch reset to Active remain unchanged.

## Key Technical Decisions

- **Extract a reusable `SessionStatusFilterControl` component.** Keeps `SessionList` focused on list behavior and lets the popover control be tested independently. The component name differs from the `SessionStatusFilter` type in `src/client/lib/session-filter.ts` to avoid namespace collisions.
- **Use the existing Radix `Popover` primitive.** It is already wrapped in `src/client/components/ui/popover.tsx` and used by `ProviderSelector` and `ApprovalModeToggle`, so the redesign stays consistent with established patterns without adding dependencies.
- **Lucide icon mapping.** `all` → `Layers`, `active` → `CircleDot`, `archived` → `Archive`, `wip` → `FlaskConical`. These icons are already available from `lucide-react` and map cleanly to the status concepts.
- **Manual keyboard navigation inside the popover.** Plain buttons inside a Radix Popover do not provide roving focus automatically, so the component will handle ArrowUp/ArrowDown focus movement and Enter/Space selection itself.
- **Animation via Tailwind data-state classes.** Radix Popover exposes `data-state="open|closed"` on `PopoverContent`. The component can use `data-[state=open]:animate-in`, `data-[state=closed]:animate-out`, and directional slide/fade classes. If the project's Tailwind setup does not already include those utilities, the implementer should add the minimal keyframes to `src/client/index.css` rather than introducing a new dependency.

## Implementation Units

### U1. Build the `SessionStatusFilterControl` popover component

- **Goal:** Create a reusable, accessible popover filter control that renders the trigger and option list.
- **Requirements:** R1, R3, R4, R5, R6, R7, R9, R10.
- **Dependencies:** None.
- **Files:**
  - Create `src/client/components/SessionStatusFilterControl.tsx`
  - Test `src/client/components/SessionStatusFilterControl.test.tsx`
- **Approach:** Build a controlled component that accepts `value`, `onChange`, an optional `disabled` prop, and an `aria-label` prop. Render a controlled Radix `Popover` (`open`/`onOpenChange`). The trigger is a plain styled `<button>` (not the `Button` component) showing the selected status icon and a chevron, with `aria-label` combining the control purpose and the currently selected translated label, and `aria-expanded={open}`. When disabled, the trigger ignores activation and uses `opacity-40 cursor-not-allowed`. The popover content has `role="listbox"`, `min-w-[180px]`, and aligns to the top-end of the trigger with `sideOffset={6}` and `collisionPadding={8}`. Each option is a full-width `<button>` with `role="option"`, `aria-selected={isActive}`, the status Lucide icon, the translated label, and a trailing `Check` icon visible only for the selected value. Focus the selected option on open using `onOpenAutoFocus={(e) => { e.preventDefault(); selectedRef.current?.focus() }}`; return focus to the trigger on close via `onCloseAutoFocus={(e) => e.preventDefault()}`. Implement `ArrowUp`/`ArrowDown` to move focus between options, `Enter`/`Space` to select the focused option and close, and `Escape` to close without selecting. Clicking outside the popover closes it without changing the filter (Radix default). Apply a subtle fade/slide animation: `data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-top-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:slide-out-to-top-2`. Respect `prefers-reduced-motion` by disabling the slide/scale portion of the animation for users with motion sensitivity.
- **Patterns to follow:** `src/client/components/ProviderSelector.tsx` for popover structure, trigger styling, active/inactive item styling, trailing checkmark pattern, and focus management; `src/client/components/WorkspaceSwitcher.tsx` for popover open/close conventions.
- **Test scenarios:**
  - Renders the trigger with the icon that matches the current `value`.
  - The trigger has `aria-expanded="false"` when closed and `aria-expanded="true"` when open.
  - The trigger is not interactive when `disabled` is true.
  - Clicking the trigger opens the popover and shows the four options in order: All, Active, Archived, WIP.
  - The popover content has `role="listbox"` and each option has `role="option"`.
  - The option matching `value` has `aria-selected="true"` and a visible trailing checkmark.
  - Clicking a different option calls `onChange` with that value and closes the popover.
  - Pressing Enter on the focused trigger opens the popover.
  - ArrowDown/ArrowUp move focus through options; Enter selects the focused option and closes.
  - Escape closes the popover without calling `onChange`.
  - Closing the popover returns focus to the trigger.
- **Verification:** `SessionStatusFilterControl.test.tsx` passes; the component renders without accessibility errors and follows the visual patterns of `ProviderSelector`.

### U2. Integrate the new filter into `SessionList`

- **Goal:** Swap the native `<select>` for `SessionStatusFilterControl` while preserving all existing behavior.
- **Requirements:** R2, R8, R11.
- **Dependencies:** U1.
- **Files:**
  - Modify `src/client/components/SessionList.tsx`
- **Approach:** Replace the native-select wrapper in the search row with `<SessionStatusFilterControl value={statusFilter} onChange={setStatusFilter} disabled={searchDisabled} aria-label={t('statusFilterLabel')} />`. The `SessionStatusFilterControl` trigger is a plain `<button>`, not the `Button` component. Keep the `statusFilter` state, the `filteredSessions` memo, the workspace-switch reset effect, and the filter-specific empty states exactly as they are. Remove the `<Filter>` import from `lucide-react` and delete the old select wrapper, because the generic filter icon is no longer needed. Ensure the search row layout remains a flex row with the search input on the left and the filter trigger on the right.
- **Patterns to follow:** Existing `SessionList` state and effect conventions; `ProviderSelector` trigger sizing for height alignment.
- **Test scenarios:**
  - The session list still hides archived sessions by default.
  - Selecting a different filter still updates the listed sessions.
  - Switching workspaces still resets the filter to Active.
- **Verification:** Manual smoke test: render `SessionList` and verify no `<select>` element is present, the filter trigger appears next to the search box, and selecting a filter updates the list. Once U3 is complete, the updated `SessionList.test.tsx` provides automated coverage.

### U3. Update `SessionList` tests for the popover interaction model

- **Goal:** Rewrite the existing filter assertions to drive the new popover control instead of the native select.
- **Requirements:** R11.
- **Dependencies:** U2.
- **Files:**
  - Modify `src/client/components/SessionList.test.tsx`
- **Approach:** Replace queries for the `<select>` element and `fireEvent.change` calls with helper functions that click the filter trigger and then click the desired option button. Query the trigger with `screen.getByRole('button', { name: /Filter sessions/i })` (or `getByLabelText(/Filter sessions/i)` if the `aria-label` is preserved), click it to open the popover, then query options by their translated label text. Keep the same five test cases (default Active hides archived, Archived reveals archived, WIP shows archived WIP, All shows both, workspace switch resets to Active) and the same mock-store setup.
- **Patterns to follow:** Existing test wrapper with `I18nextProvider`; `ProviderSelector` test style if one exists, otherwise use `@testing-library/react` click + `await` patterns.
- **Test scenarios:**
  - Covers AE1. Default Active hides archived sessions.
  - Covers AE3. Selecting Archived reveals archived sessions.
  - Covers AE4. Selecting WIP reveals a session that is both WIP and archived.
  - Covers AE5. Selecting All lists active and archived sessions together.
  - Covers AE7. Changing workspaces resets the filter to Active.
- **Verification:** `npm run test:client` passes for `SessionList.test.tsx` and the full client suite remains green.

## Scope Boundaries

### Deferred for later

- Colored status dots or per-status colors.
- A header or section label inside the popover.
- A tooltip on the trigger.
- A segmented button group alternative.
- Multi-select filter combinations or additional statuses such as Draft.

### Outside this product's identity

- Changing the status filter semantics (what Active / Archived / WIP / All mean).
- Bulk archive/unarchive actions.

## Risks & Dependencies

- **Tailwind animation utilities may not be defined.** The codebase references `animate-in` / `animate-out` classes in `src/client/components/ui/tooltip.tsx` and `src/client/components/ai-elements/reasoning.tsx`, but `tailwindcss-animate` is not listed in `package.json` and the project's `tailwind.config.js` registers no plugins. Before relying on those utilities, verify they are generated by the current Tailwind setup. If they are absent, add the minimal keyframes to `src/client/index.css` rather than adding a dependency.
- **Manual keyboard navigation must be tested in jsdom.** Focus movement, `aria-expanded`, and Escape handling should be covered by component tests to avoid regressions in accessibility.
- **Icon-only trigger reduces scannability.** The accessible name carries the current value for screen-reader users, but sighted users will learn the icon meaning from the popover labels.
- **i18n key assumptions.** The plan assumes the `chat` namespace already contains `statusFilterLabel`, `statusFilterAll`, `statusFilterActive`, `statusFilterArchived`, and `statusFilterWip`. These keys were added by the prior filter work and must remain present.

## Acceptance Examples

- AE1. **Default view**
  - **Given** the user opens a workspace with active and archived sessions,
  - **When** the sidebar loads,
  - **Then** the trigger shows the Active icon and archived sessions are hidden.
- AE2. **Open the popover**
  - **Given** the filter is set to Active,
  - **When** the user clicks the trigger,
  - **Then** the popover opens, lists All / Active / Archived / WIP in that order, and the Active row shows a checkmark.
- AE3. **Select Archived**
  - **Given** the popover is open and the filter is Active,
  - **When** the user clicks the Archived row,
  - **Then** the popover closes, the trigger icon changes to the Archived icon, and the list shows only archived sessions.
- AE4. **Select WIP**
  - **Given** the user has a session that is both WIP and archived,
  - **When** the user opens the popover and clicks the WIP row,
  - **Then** the WIP and archived session appears in the list.
- AE5. **Select All**
  - **Given** the workspace has active and archived sessions,
  - **When** the user opens the popover and clicks the All row,
  - **Then** active and archived sessions appear together.
- AE6. **Keyboard selection**
  - **Given** the trigger has focus,
  - **When** the user presses Space, ArrowDown to WIP, and Enter,
  - **Then** the popover closes and the list filters to WIP sessions.
- AE7. **Workspace switch resets the control**
  - **Given** the user has changed the filter to Archived,
  - **When** the user switches to another workspace,
  - **Then** the trigger icon returns to Active and the list shows active sessions.

## Sources / Research

- Requirements origin: `docs/brainstorms/2026-06-14-session-filter-dropdown-redesign-requirements.md`.
- Current filter implementation: `src/client/components/SessionList.tsx` and `src/client/components/SessionList.test.tsx`.
- Popover pattern to mirror: `src/client/components/ProviderSelector.tsx` and `src/client/components/WorkspaceSwitcher.tsx`.
- UI primitives: `src/client/components/ui/popover.tsx`, `src/client/components/ui/button.tsx`, `src/client/components/ui/utils.ts`.
- Tailwind animation precedent: `src/client/components/ui/tooltip.tsx` and `src/client/components/ai-elements/reasoning.tsx`.
- Filter logic: `src/client/lib/session-filter.ts`.
