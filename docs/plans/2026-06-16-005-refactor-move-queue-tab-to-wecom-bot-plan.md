---
title: Move Queue tab into WeCom Bot settings
type: refactor
date: 2026-06-16
---

# Move Queue tab into WeCom Bot settings

## Summary

Move the WeCom proactive message Queue UI from the top-level sidebar into the WeCom Bot section of workspace settings. The Queue becomes a fifth sub-tab alongside Connection, Users, Prompts, and Permissions, scoped to the workspace selected in settings. The top-level Queue sidebar tab is removed.

## Problem Frame

The Queue panel is logically part of WeCom Bot operations, but it currently lives as a peer to Sessions, Todos, and Files in the sidebar. That placement makes it harder to discover for admins already configuring the bot and clutteres the main navigation for workspaces that do not use the WeCom bot. Co-locating the queue with the bot's other management surfaces keeps operational tools together.

## Requirements

- R1. The Queue panel renders as a sub-tab inside Settings → Workspace → WeCom Bot.
- R2. The Queue sub-tab uses the workspace selected in the settings workspace list, not the main app's active workspace.
- R3. The top-level Queue tab is removed from the sidebar.
- R4. Existing Queue behavior is preserved: list, status filter, retry, delete, and auto-refresh.
- R5. The Queue sub-tab label is translated in both `en` and `zh-CN`.
- R6. The Queue sub-tab is always visible under WeCom Bot settings, regardless of the bot enable toggle.

## Key Technical Decisions

- **Queue sub-tab lives inside `WeComBotSection`.** The existing `WeComSubTab` union and tab bar provide the seam; adding `'queue'` there is the smallest change that matches the other bot management surfaces.
- **Panel content keeps the `chat` i18n namespace.** The Queue panel's internal strings (status labels, empty states, actions) already resolve from `chat.json`. Only the new sub-tab label moves to `settings.json` under `wecom.tabs.queue`, minimizing translation churn.
- **Remove the sidebar Queue tab entirely.** Keeping a duplicate shortcut would split the mental model and leave dead navigation. The move is treated as a relocation, not an addition.
- **Let the Queue sub-tab use the full settings content width.** The existing `WorkspaceTabShell` wraps all section content in `max-w-xl`, which is appropriate for forms but cramps the data-dense Queue list. The width constraint will be moved into each section's own content so the Queue sub-tab can use the available horizontal space.
- **Show a disabled-state banner when the bot toggle is off.** Because the tab is always visible, a banner clarifies that the queue shows historical entries while the bot is disabled.
- **Preserve existing polling behavior.** The 5-second auto-refresh interval stays unchanged; pausing it when the tab is hidden is deferred as future polish.

## Implementation Units

### U1. Restructure workspace settings content width

**Goal:** Allow the WeCom Bot section to render the Queue sub-tab at full width while keeping form-like sections constrained.

**Requirements:** R1

**Dependencies:** None

**Files:**
- `src/client/components/SettingsPanel.tsx`

**Approach:**
Move the `max-w-xl` width constraint out of `WorkspaceTabShell` and into the individual section content wrappers (`BasicInfoSection`, `SkillsRedirectCard`, `PluginRedirectPlaceholder`). Keep `WeComBotSection` unconstrained so its sub-tabs can choose their own width. Inside `WeComBotSection`, apply `max-w-xl` only to the form-like sub-tabs (Connection, Users, Prompts, Permissions), not to the Queue sub-tab.

**Patterns to follow:** Existing `WorkspaceTabShell` two-column layout and `WeComBotSection` sub-tab rendering.

**Test scenarios:**
- Happy path: Basic Info and WeCom Connection sub-tabs still render at `max-w-xl` width.
- Edge case: Queue sub-tab renders without the `max-w-xl` constraint.

**Verification:** Visual inspection confirms form sections are unchanged and the Queue list has adequate horizontal space.

### U2. Add Queue sub-tab to WeCom Bot section

**Goal:** Render the existing `WeComQueuePanel` as a new sub-tab inside `WeComBotSection`.

**Requirements:** R1, R2, R4

**Dependencies:** U1

**Files:**
- `src/client/components/SettingsPanel.tsx`
- `src/client/components/WeComQueuePanel.tsx`

**Approach:**
Extend `WeComSubTab` with `'queue'`. Add `{ id: 'queue', label: t('wecom.tabs.queue') }` to the `subTabs` array. Import `WeComQueuePanel` and render it when `activeSubTab === 'queue'`, passing the `workspaceId` prop already available in `WeComBotSection`. Add a disabled-state banner inside `WeComQueuePanel` when `wecomBotEnabled` is false; pass the bot enabled state from `WeComBotSection` via a new optional prop so the banner does not affect other call sites.

**Patterns to follow:** Existing `WeComBotSection` sub-tab switcher; `PermissionsSubTab` receives `workspaceId` the same way.

**Test scenarios:**
- Happy path: clicking the Queue sub-tab renders `WeComQueuePanel` and fetches entries for the selected workspace.
- Happy path: switching between WeCom sub-tabs mounts and unmounts the Queue panel correctly.
- Edge case: workspace switch inside settings resets the active section to Basic Info (existing behavior) and stops Queue polling.
- Edge case: closing settings unmounts the Queue panel and stops polling.
- Error path: queue API failure shows the existing error banner.

**Verification:** Manual smoke test through Settings → Workspace → WeCom Bot → Queue loads entries and actions work.

### U3. Remove Queue from sidebar

**Goal:** Eliminate the top-level Queue tab from `Sidebar`.

**Requirements:** R3

**Dependencies:** None

**Files:**
- `src/client/components/Sidebar.tsx`

**Approach:**
Remove `'queue'` from the `SidebarTab` union, delete the Queue tab button, and delete the `activeTab === 'queue'` content blocks. Remove the `WeComQueuePanel` import.

**Patterns to follow:** Existing sidebar tab switcher.

**Test scenarios:**
- Happy path: Sidebar renders only Sessions, Todos, and Files tabs.
- Edge case: no residual `queue` references in `Sidebar` types or rendered output.

**Verification:** `Sidebar` renders without the Queue tab; no TypeScript errors.

### U4. Update i18n keys

**Goal:** Add the Queue sub-tab label to the settings namespace and remove the unused sidebar Queue label.

**Requirements:** R5

**Dependencies:** U2, U3

**Files:**
- `src/client/i18n/en/settings.json`
- `src/client/i18n/zh-CN/settings.json`
- `src/client/i18n/en/common.json`
- `src/client/i18n/zh-CN/common.json`

**Approach:**
Add `"queue": "Queue"` and `"queue": "队列"` under `wecom.tabs` in `settings.json` for `en` and `zh-CN`. Add banner strings under `wecom.queue` for the disabled state in both locales. Remove `sidebar.queue` from both `common.json` files.

**Patterns to follow:** Existing nested i18n structure; update both languages in parallel.

**Test scenarios:**
- Happy path: Queue sub-tab label renders in English and Chinese.
- Edge case: removed `sidebar.queue` key no longer referenced.

**Verification:** No runtime key fallback strings for the new labels; lint/build passes.

### U5. Add Queue sub-tab tests

**Goal:** Verify the Queue sub-tab renders and the sidebar no longer shows a Queue tab.

**Requirements:** R1, R3

**Dependencies:** U2, U3

**Files:**
- Create: `src/client/components/WeComBotSection.test.tsx` (or extend `SettingsPanel.test.tsx` if one exists)

**Approach:**
Create a focused test file for `WeComBotSection` that mocks `useWeComQueueStore` and wraps the component with `I18nextProvider`. Test that the Queue tab appears, clicking it renders queue entries, and switching sub-tabs unmounts the panel. Optionally add a sidebar test to assert the Queue tab is gone.

**Patterns to follow:** `PermissionsSubTab.test.tsx` for i18n wrapping and RTL patterns; `TaskPanel.test.tsx` for store mocking with `vi.mock`.

**Test scenarios:**
- Happy path: Queue sub-tab label is visible in the WeCom Bot section.
- Happy path: clicking Queue sub-tab renders entries fetched from the mocked store.
- Happy path: switching to Connection sub-tab removes Queue entries from the document.
- Edge case: Sidebar renders exactly three tabs (Sessions, Todos, Files).

**Verification:** `npm run test:client` passes for the new tests.

### U6. Verify and clean up

**Goal:** Confirm no stale references and that the relocated UI works end-to-end.

**Requirements:** R1–R6

**Dependencies:** U1–U5

**Files:**
- All files touched above.

**Approach:**
Run `npm run build:client` (or the relevant build command) and `npm run test:client`. Grep for `sidebar.queue`, `activeTab === 'queue'`, and other removed identifiers. Run the app in dev mode and exercise Settings → Workspace → WeCom Bot → Queue.

**Test scenarios:**
- Integration: build passes with no TypeScript errors.
- Integration: client tests pass.
- Edge case: grep confirms zero stale references.

**Verification:** Clean build, tests green, manual smoke test successful.

## Scope Boundaries

- **In scope:** Client-side relocation of the Queue UI, i18n key updates, disabled-state banner, layout width adjustment, and component tests.
- **Unchanged:** Queue server endpoints (`/api/workspaces/:id/wecom-queue`), the queue worker, the queue store API, and proactive message behavior.
- **Out of scope:** Pausing Queue polling when hidden, per-workspace status filters, queue analytics, and changes to bot configuration fields.

### Deferred to Follow-Up Work

- Pause Queue auto-refresh when the Settings panel or Queue sub-tab is not visible.
- Scope the status filter per workspace instead of globally.
- Consider a keyboard-navigable list with roving focus for the Queue panel.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Users cannot find the Queue after the sidebar tab is removed | The new location is under the same WeCom Bot section admins already use; the disabled-state banner also surfaces the tab. |
| `max-w-xl` removal affects other workspace sections | Apply the constraint inside each section's own content rather than removing it globally. |
| Bot-disabled banner text missing in one locale | Update both `en` and `zh-CN` `settings.json` in U4. |
| Queue panel fetches for a workspace without bot config | The API returns an empty list; the banner explains historical-only data when the bot is disabled. |

## Sources & Research

- Existing Queue UI: `src/client/components/WeComQueuePanel.tsx`, `src/client/stores/wecom-queue-store.ts`
- Sidebar tab switcher: `src/client/components/Sidebar.tsx`
- WeCom Bot settings and sub-tabs: `src/client/components/SettingsPanel.tsx` (`WeComBotSection`, `WorkspaceTabShell`)
- i18n structure: `src/client/i18n/en/settings.json`, `src/client/i18n/zh-CN/settings.json`, `src/client/i18n/en/common.json`, `src/client/i18n/zh-CN/common.json`
- Test patterns: `src/client/components/PermissionsSubTab.test.tsx`
- Planning convention: `docs/solutions/conventions/commit-plan-and-brainstorm-files-with-code-changes.md`
