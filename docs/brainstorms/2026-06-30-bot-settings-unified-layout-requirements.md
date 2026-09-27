---
date: 2026-06-30
topic: bot-settings-unified-layout
---

# Bot Settings Unified Layout

## Summary

Rebuild the Bots tab in Settings so it follows the same two-column layout as the Workspace tab: a bot list in the left sidebar and section tabs in the right content area. General and Provider configuration use the page-level Save/Cancel dirty-tracking pattern; Members, Roles, and Persona keep their existing per-section save behavior.

---

## Problem Frame

The current Bots settings page (`src/client/components/BotManagementPage.tsx`) uses a list-to-drill-in navigation model. A user sees a list of bots, then navigates to separate full-page views for editing a bot, managing members, configuring role permissions, or editing personas. Each of these views has its own back button and save model. This is functionally usable but visually and behaviorally different from the Workspace tab, which uses a stable two-column layout with a left sidebar and horizontal section tabs.

Because bots are now first-class entities decoupled from workspaces, they accumulate more settings (providers, members, roles, persona, delete) and benefit from the same persistent navigation and spatial layout that workspace settings already use. Unifying the layout reduces context-switching and makes the Settings overlay feel coherent.

---

## Key Decisions

- **Mirror the Workspace tab's two-column shell.** A left sidebar lists bots; the right pane shows horizontal section tabs. This reuses the layout vocabulary users already learned in workspace settings.
- **Batch only General and Provider edits at the page level.** Members, Roles, and Persona are already edited through components with their own Save buttons and immediate persistence. Keeping them immediate avoids backend changes to batch member mutations and preserves the persona dirty-guard behavior.
- **Providers get their own section tab.** Grouping WeCom and Feishu credentials under a dedicated "Providers" tab keeps the General tab short and mirrors how the workspace tab separates concerns.
- **New bots are staged in the sidebar before creation.** Clicking "Create bot" inserts a temporary entry. The user fills General and Providers, then clicks Save to create the real bot. Cancel discards the staged entry.

---

## Requirements

### Page structure and navigation

- R1. The Bots tab displays a two-column layout: a left sidebar listing bots and a right content area showing the selected bot's settings.
- R2. The left sidebar shows each bot's name only, with the selected bot highlighted.
- R3. The sidebar includes a "Create bot" action that stages a new, unsaved bot entry.
- R4. The right content area shows horizontal section tabs: General, Providers, Members, Roles, Persona, Danger.
- R5. The active section tab is visually highlighted using existing accent styling conventions.
- R6. The General section is the default active section when selecting a bot.
- R7. Section tab labels are translatable via i18n keys in English and Chinese.
- R8. When no bots exist, the right content area shows an empty state with a create action instead of section tabs.

### Basic config staging and save

- R9. General section contains: bot name and active workspace selection.
- R10. Providers section contains: WeCom and Feishu enable toggles, credentials, and bot name per provider.
- R11. Edits to General and Providers are held in local draft state and are not persisted until the user clicks Save.
- R12. The page footer shows Save and Cancel buttons when a bot's basic config is dirty.
- R13. Clicking Save validates required fields (e.g., bot name, provider-required IDs) and then calls the bot creation or update API.
- R14. Clicking Cancel reverts General and Provider edits to the last saved snapshot.
- R15. Attempting to switch to another bot in the sidebar with unsaved basic changes shows the same unsaved-changes dialog used when closing Settings, with Save, Discard, and Keep editing options.
- R16. Attempting to close Settings with unsaved basic changes shows the existing unsaved-changes dialog.

### Members, Roles, and Persona

- R17. The Members section embeds the existing member-management UI and keeps its current immediate-save behavior for add, remove, and role assignment.
- R18. The Roles section embeds the existing role-permissions editor and keeps its current per-section Save button.
- R19. The Persona section embeds the existing per-role persona editor and keeps its current per-section Save/Cancel dirty guard.
- R20. Errors from immediate-save actions in Members, Roles, or Persona are surfaced inside their respective sections and do not block the page-level Save/Cancel flow.

### Danger

- R21. The Danger section contains a Delete bot action with a confirmation dialog.
- R22. The confirmation dialog explains that deletion disconnects providers and that existing sessions remain in their workspaces.
- R23. Deleting a bot removes it from the sidebar and clears the selection to another bot or the empty state.

### Create flow

- R24. Clicking "Create bot" inserts a temporary "New bot" row in the sidebar, selects it, and opens the General section with empty fields.
- R25. The temporary bot is not persisted until the user clicks Save.
- R26. Clicking Cancel while a temporary bot is selected removes the temporary row and reverts to the previously selected bot, or to the empty state if no bots exist.
- R27. Saving a new bot creates it via the bot creation API and replaces the temporary row with the persisted bot.

---

## Key Flows

### F1. Owner edits a bot's provider credentials

- **Trigger:** Owner opens Settings, clicks Bots, selects a bot, and clicks the Providers tab.
- **Actors:** Bot Owner (Comate operator).
- **Steps:**
  1. Owner enables WeCom and enters Bot ID.
  2. Owner clicks Save in the page footer.
  3. System validates and updates the bot.
- **Outcome:** Provider credentials are persisted; sidebar selection remains on the same bot.
- **Covered by:** R2, R4, R10, R11, R12, R13.

### F2. Owner creates a new bot

- **Trigger:** Owner clicks "Create bot" in the left sidebar.
- **Actors:** Bot Owner.
- **Steps:**
  1. A temporary "New bot" row appears and is selected.
  2. Owner enters a name in General and provider credentials in Providers.
  3. Owner clicks Save.
  4. System creates the bot and replaces the temporary row.
- **Outcome:** The new bot appears in the sidebar and is selected for further editing.
- **Covered by:** R3, R24, R25, R27.

### F3. Owner switches bots with unsaved basic changes

- **Trigger:** Owner edits a bot's name and clicks a different bot in the sidebar.
- **Actors:** Bot Owner.
- **Steps:**
  1. System detects unsaved basic config changes.
  2. An unsaved-changes dialog appears.
  3. Owner chooses Discard.
  4. System discards the edits and switches to the selected bot.
- **Outcome:** The first bot's edits are lost; the second bot is selected.
- **Covered by:** R15.

### F4. Owner edits a persona and then cancels basic config

- **Trigger:** Owner edits a persona, saves it, then edits the bot name and clicks Cancel.
- **Actors:** Bot Owner.
- **Steps:**
  1. Owner saves the persona in the Persona section.
  2. Owner changes the bot name in General.
  3. Owner clicks Cancel.
- **Outcome:** The name change is reverted; the saved persona change remains because it was already persisted.
- **Covered by:** R14, R19, R20.

---

## Acceptance Examples

### AE1. Basic config follows page-level Save

- **Covers:** R9, R11, R12, R13.
- **Given:** A bot named "TeamBot" is selected on the General section.
- **When:** The owner changes the name to "TeamBot v2" and clicks Save.
- **Then:** The bot is updated, the sidebar shows "TeamBot v2", and the Save/Cancel buttons return to their inactive state.

### AE2. Provider split keeps General short

- **Covers:** R4, R10.
- **Given:** A bot is selected and the owner clicks the Providers tab.
- **When:** The owner views the page.
- **Then:** WeCom and Feishu credentials appear under the Providers tab, not inside General.

### AE3. Create bot is staged before persistence

- **Covers:** R3, R24, R25, R26, R27.
- **Given:** The Bots tab shows one existing bot.
- **When:** The owner clicks "Create bot", enters "NewBot" as the name, and clicks Save.
- **Then:** A new bot named "NewBot" is created, appears in the sidebar, and is selected.

### AE4. Mixed save model is visible to users

- **Covers:** R17, R18, R19, R20.
- **Given:** A bot is selected.
- **When:** The owner adds a member in Members, saves role permissions in Roles, and edits the bot name in General without saving.
- **Then:** The member and role changes are persisted; the name change remains draft and is reverted if the owner clicks Cancel.

### AE5. Unsaved changes guard bot switching

- **Covers:** R15.
- **Given:** The owner edits the active workspace in General without saving.
- **When:** The owner clicks another bot in the sidebar.
- **Then:** An unsaved-changes dialog appears with Save, Discard, and Keep editing options.

---

## Scope Boundaries

### In scope

- Restructuring the Bots tab to a two-column, section-tab layout.
- Page-level Save/Cancel for General and Providers.
- Staged new-bot creation in the sidebar.
- Reusing existing Members, Roles, and Persona editors inside section tabs.
- Unsaved-changes guard when switching bots or closing Settings.

### Deferred for later

- Batch-saving Members, Roles, or Persona together with basic config.
- Inline editing of bot names directly in the sidebar.
- Search or filtering in the bot list.
- Drag-to-reorder bots in the sidebar.

### Outside this product's identity

- Changing the Workspace tab layout or top-level Settings tabs.
- Changing runtime bot behavior, persona injection, or role permission enforcement.
- Adding new bot providers beyond WeCom and Feishu.

---

## Dependencies / Assumptions

- The existing bot data model (`Bot`, `BotProviderSettings`, `BotRolePolicy`, `BotPersona`) remains unchanged.
- The existing bot CRUD API (`/api/bots`) and member-management API continue to work as-is.
- The existing `BotMemberList`, `BotRolePermissions`, and `BotPersonaEditor` components can be embedded inside section tabs without changing their save behavior.
- The Workspace tab shell in `src/client/components/SettingsPanel.tsx` is the reference layout pattern.

---

## Sources / Research

- Current Bots tab implementation: `src/client/components/BotManagementPage.tsx`
- Bot basic config form: `src/client/components/BotForm.tsx`
- Member management editor: `src/client/components/BotMemberList.tsx`
- Role permissions editor: `src/client/components/BotRolePermissions.tsx`
- Per-role persona editor: `src/client/components/BotPersonaEditor.tsx`
- Bot client-side state: `src/client/stores/bot-store.ts`
- Reference layout pattern: `src/client/components/SettingsPanel.tsx` (Workspace tab shell with left sidebar and section tabs)
- Prior bot-workspace decoupling requirements: `docs/brainstorms/2026-06-28-bot-workspace-decoupling-requirements.md`
- Prior workspace section tabs requirements: `docs/brainstorms/2026-05-28-workspace-settings-section-tabs-requirements.md`
