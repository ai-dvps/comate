---
title: Unify Bot Page Save/Cancel Footer - Plan
type: refactor
date: 2026-07-03
topic: unify-bot-page-save-cancel
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Unify Bot Page Save/Cancel Footer - Plan

## Goal Capsule

- **Objective:** Consolidate the Bot Management page's Save/Cancel controls into a single, always-visible, fixed-bottom footer, removing inline buttons from the Roles and Persona sections.
- **Product authority:** The recent settings footer refactor established the same fixed-bottom pattern for General and Workspace tabs; extend that pattern to Bot Management for a consistent settings experience.
- **Execution profile:** Client-only React refactor in the Bot Management page and its section components; no new backend endpoints.
- **Stop conditions / tail ownership:** Stop if the refactor forces backend API changes or breaks the existing runtime-rebuild scheduling that depends on bot updates.

## Product Contract

*Product Contract unchanged from the requirements-only artifact.*

### Summary

Remove the section-level Save/Cancel controls from Bot Management's Roles and Persona tabs. The existing fixed-bottom page footer becomes the single control for committing or discarding changes across Basic config, Role permissions, and Persona.

### Problem Frame

Bot Management currently shows Save/Cancel in the page footer only when Basic config is dirty. The Roles tab has an inline Save button with no cancel, and the Persona tab has its own inline Save/Cancel pair. This creates inconsistent placement and behavior: some sections save independently, some have no discard path, and the page footer sometimes appears and disappears. Users expect the same always-visible, fixed-bottom control they see on General and Workspace settings.

### Requirements

- R1. The page-level Save/Cancel footer in Bot Management is always visible and fixed at the bottom of the right pane, regardless of which section is active.
- R2. The footer buttons are disabled when no unsaved changes exist across Basic config, Role permissions, or Persona.
- R3. The inline Save button in the Roles section is removed; pending role-policy edits are committed by the page-level Save and discarded by the page-level Cancel.
- R4. The inline Save/Cancel buttons in the Persona editor are removed; persona drafts are committed by the page-level Save and discarded by the page-level Cancel.
- R5. When the footer Save is activated, all dirty slices are saved in order: Basic config, then Role permissions, then Persona.
- R6. When the footer Cancel is activated, all dirty slices are reverted to their last saved state.
- R7. The existing bot-switch and filter-out unsaved-changes guards continue to protect dirty state from all three slices.

### Key Decisions

- **Single footer handles Basic, Roles, and Persona together.** This keeps the UX consistent with General/Workspace settings and avoids multiple competing Save/Cancel controls on one page.
- **Save/Cancel is all-or-nothing across slices.** A single Save commits every dirty slice; a single Cancel reverts every dirty slice. This is simpler than per-section commit and matches the existing global guard behavior.
- **Members add flow and Danger delete confirmation keep their existing inline controls.** They are transient dialogs, not persistent configuration sections, so they stay outside the page-level footer model.

### Scope Boundaries

- Members add-member Cancel and Danger delete Cancel are unchanged.
- Provider settings and Appearance auto-save behavior are unchanged.
- No backend API changes; reuse existing `updateBot` endpoints.

### Acceptance Examples

AE1. User edits the persona prompt but not basic config.
- **Given:** Persona is dirty and Basic config is clean.
- **When:** The user clicks the page-level Save button.
- **Then:** The persona changes are saved, and both footer buttons become disabled.

AE2. User edits role policy and then decides to discard.
- **Given:** Role policy is dirty.
- **When:** The user clicks the page-level Cancel button.
- **Then:** Role policy reverts to its last saved state, and both footer buttons become disabled.

AE3. User edits basic config and persona simultaneously.
- **Given:** Basic config and Persona are both dirty.
- **When:** The user clicks the page-level Save button.
- **Then:** Both slices are saved, and the footer buttons become disabled.

### Sources / Research

- `src/client/components/BotManagementPage.tsx` — existing page footer, dirty detection, and save/discard handlers.
- `src/client/components/BotRolePermissions.tsx` — inline Save button to remove; needs dirty tracking and a revert path.
- `src/client/components/BotPersonaEditor.tsx` — inline Save/Cancel to remove; already exposes save/discard via an imperative handle.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Role permissions will mirror the Persona editor's imperative-handle pattern.** `BotRolePermissions` will expose `isDirty()`, `save()`, and `discard()` via `forwardRef` + `useImperativeHandle`, and report dirty changes upward through an optional `onDirtyChange` prop. This keeps section-level draft state local, matches the existing Persona pattern, and avoids a large state-lift into `BotManagementPage`.
- **KTD2. The page footer is all-or-nothing across Basic, Roles, and Persona.** `BotManagementPage` will combine `basicDirty`, `isPersonaDirty`, and `isRolesDirty` into a single `isDirty()` result. Footer Save will call an updated `handleSaveAll()` (Basic, then Roles, then Persona); footer Cancel will call an updated `handleDiscardAll()`.
- **KTD3. Section-level save errors remain rendered inside each section.** `BotRolePermissions` and `BotPersonaEditor` already render their own `saveError` above their editors. The footer message area will continue to show only `pageError` or the generic unsaved-changes hint, so sections do not lose error context and the footer does not need to aggregate multiple error sources.

### Assumptions

- The existing `BotPersonaEditor` ref contract (`save`, `isDirty`, `discard`) is sufficient; no new ref methods are needed.
- The current `isSavingBasic` state can be widened to represent any active save operation on the page and renamed to `isSaving` for clarity.

### Sequencing

1. **U1** adds the imperative handle and dirty reporting to `BotRolePermissions` so the page can observe and control it.
2. **U2** wires the new Roles slice into `BotManagementPage`'s combined dirty/save/discard logic and updates the footer.
3. **U3** removes the inline Save/Cancel from `BotPersonaEditor` and updates its tests to expect page-level save behavior.
4. **U4** runs quality gates and updates the changelog.

---

## Implementation Units

### U1. Expose role-permission dirty/save/discard via imperative handle

- **Goal:** Remove the inline Save button from `BotRolePermissions`, track a saved snapshot, and expose `isDirty`, `save`, and `discard` through an imperative handle so the parent page can coordinate the section.
- **Requirements:** R3.
- **Dependencies:** None.
- **Files:**
  - `src/client/components/BotRolePermissions.tsx`
  - `src/client/components/BotRolePermissions.test.tsx`
- **Approach:** Convert `BotRolePermissions` to `forwardRef`. Store a `saved` snapshot of the incoming `bot.rolePolicy` and the local editor state (`normalToolPolicy`, `skillAllowlist`, `bashWhitelist`). Compute dirty by comparing local state to `saved`. Expose `isDirty()`, `save()`, and `discard()` via `useImperativeHandle`. Call an optional `onDirtyChange` prop when dirty changes. Keep `onSave` as the prop that submits the final policy; `save()` builds the policy object and delegates to `onSave`, then updates `saved` on success.
- **Patterns to follow:** Mirror `BotPersonaEditor`'s existing ref/dirty contract and snapshot pattern.
- **Test scenarios:**
  - Update `BotRolePermissions.test.tsx` to remove assertions for the inline Save button and add assertions for the new ref contract and `onDirtyChange` behavior.
  - Renders Normal role editors with no inline Save button.
  - Calls `onDirtyChange(false)` on mount, `onDirtyChange(true)` when allowlist changes, and `onDirtyChange(false)` after `discard`.
  - `ref.current.isDirty()` returns `true` after edits and `false` after `save` or `discard`.
  - `ref.current.save()` calls `onSave` with the parsed policy and updates the saved snapshot on success.
  - `ref.current.discard()` reverts local state to the last saved snapshot.
  - Error path: when `onSave` rejects, the saved snapshot is not updated and the local error message is surfaced.
- **Verification:** `BotRolePermissions.test.tsx` passes and the inline Save button no longer appears.

### U2. Wire role slice into page-level footer

- **Goal:** Make the page footer the single Save/Cancel control for Basic, Roles, and Persona by combining dirty state and delegating save/discard to each section's handle.
- **Requirements:** R1, R2, R5, R6, R7.
- **Dependencies:** U1.
- **Files:**
  - `src/client/components/BotManagementPage.tsx`
  - `src/client/components/BotManagementPage.test.tsx`
- **Approach:** Add `isRolesDirty` state and a `rolesRef` for `BotRolePermissions`. Update `isDirty()` to include `isRolesDirty`. Update `handleSaveAll()` to save Basic first, then Roles (`rolesRef.current.save()`), then Persona. Update `handleDiscardAll()` to cancel Basic and discard Roles and Persona. Change the footer buttons to call `handleSaveAll`/`handleDiscardAll` and disable them when no slice is dirty. Rename `isSavingBasic` to `isSaving` and pass it to the footer and sections. Keep the existing unsaved-changes dialog wired to the combined `isDirty` so bot switching and filter fallback still block on any dirty slice.
- **Patterns to follow:** The combined-dirty footer pattern used in `GeneralTab` and the workspace tab shell in `SettingsPanel.tsx`; the existing `handleSaveAll`/`handleDiscardAll` orchestration.
- **Test scenarios:**
  - Footer Save and Cancel buttons are always rendered and disabled when all slices are clean.
  - Editing a role policy enables the footer Save/Cancel buttons.
  - Clicking footer Save with only Roles dirty calls `updateBot` with the expected `rolePolicy` and disables the buttons.
  - Clicking footer Cancel with only Roles dirty reverts the role editors.
  - Dirty state across Basic + Roles + Persona saves all three slices in one Save click and disables the buttons.
  - Bot switching and search-filter fallback still open the unsaved-changes dialog when only Roles or only Persona is dirty.
- **Verification:** `BotManagementPage.test.tsx` passes and the footer is visible and behaves consistently across sections.

### U3. Remove Persona inline Save/Cancel

- **Goal:** Remove the inline Save/Cancel button pair from `BotPersonaEditor` so the page-level footer is the only commit/discard path.
- **Requirements:** R4.
- **Dependencies:** U2.
- **Files:**
  - `src/client/components/BotPersonaEditor.tsx`
  - `src/client/components/BotPersonaEditor.test.tsx`
- **Approach:** Remove the button block that renders the inline Cancel and Save/Saved buttons. Keep the internal `draft`/`saved` state and the imperative handle (the page footer now drives it). Optionally keep a static non-button "Saved" indicator when clean, or remove the indicator entirely; the existing `onDirtyChange` and ref contract stay in place. Ensure `onSave` is still invoked only through the ref's `save()` method.
- **Patterns to follow:** The same ref/dirty contract already used by `BotPersonaEditor`; the page-footer-driven save model from `GeneralTab`.
- **Test scenarios:**
  - Update `BotPersonaEditor.test.tsx` to remove all assertions for inline Save/Cancel/Saved buttons and replace them with assertions that verify the ref save/discard contract and `onDirtyChange` behavior when driven externally.
  - Update `BotManagementPage.test.tsx` to remove assertions for the inline "Save persona" button and instead trigger persona save via the page-level footer.
  - No inline Save persona or Cancel buttons are rendered after edits.
  - Editing a prompt still fires `onDirtyChange(true)` and the page-level Save can commit it.
  - `ref.current.discard()` reverts the prompt to the last saved value.
  - `ref.current.save()` still submits `persona`/`rolePersonas` correctly when called from the page.
  - If a static saved indicator is retained, it is not an interactive button.
- **Verification:** `BotPersonaEditor.test.tsx` passes and no inline Save/Cancel buttons remain in the Persona section.

### U4. Quality gates and changelog

- **Goal:** Keep the codebase green and record the user-facing change.
- **Requirements:** None (process unit).
- **Dependencies:** U1, U2, U3.
- **Files:**
  - `CHANGELOG.md`
- **Approach:** Run ESLint across the changed files. Run the affected client tests. Update `CHANGELOG.md` under the unreleased section noting that Bot Management now uses the same always-visible fixed-bottom Save/Cancel footer as General and Workspace settings.
- **Test scenarios:** None — verification is the gate itself.
- **Verification:** `npm run lint` is clean and `npm run test:client -- src/client/components/BotManagementPage.test.tsx src/client/components/BotRolePermissions.test.tsx src/client/components/BotPersonaEditor.test.tsx` passes.

---

## Verification Contract

| Gate | Command / Check | When it applies |
|---|---|---|
| Lint | `npm run lint` | Always before considering the work complete. |
| Unit tests | `npm run test:client -- src/client/components/BotManagementPage.test.tsx src/client/components/BotRolePermissions.test.tsx src/client/components/BotPersonaEditor.test.tsx` | After U2 and U3. |
| Manual smoke | Open Settings → Bots; edit Role permissions and Persona; verify the footer enables, saves, and cancels as expected. | Optional local verification. |

---

## Definition of Done

- The Bot Management page footer is always visible and fixed at the bottom of the right pane.
- Footer Save/Cancel are disabled when Basic, Roles, and Persona are all clean, and enabled when any slice is dirty.
- The inline Save button in `BotRolePermissions` and the inline Save/Cancel buttons in `BotPersonaEditor` are removed.
- `BotRolePermissions` exposes `isDirty`, `save`, and `discard` through an imperative handle and reports dirty changes via `onDirtyChange`.
- The Settings-panel close guard and bot-switch/filter-fallback guards continue to block when any slice is dirty.
- All affected tests pass, lint is clean, and `CHANGELOG.md` is updated.
- No backend API changes are introduced.
