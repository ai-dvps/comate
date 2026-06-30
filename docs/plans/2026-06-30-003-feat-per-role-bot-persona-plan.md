---
date: 2026-06-30
topic: per-role-bot-persona
type: feat
origin: docs/brainstorms/2026-06-30-per-role-bot-persona-requirements.md
---

# Per-Role Bot Persona

## Summary

Extend the Bot Persona feature so a Bot can define distinct system-prompt text for Default, Owner, Admin, and Normal roles. Each role-specific persona has its own append/replace mode and falls back to the Default persona when unset. Active Bot runtimes are closed when persona, member role, or role-permission policy changes, so the next incoming user turn recreates the runtime with the updated persona.

---

## Problem Frame

A single Bot persona is applied to every WeCom or Feishu user regardless of their role. Owners, admins, and normal members have different permissions and expectations, so a one-size-fits-all identity either leaks capability claims to restricted users or undersells the Bot to owners. Role-specific personas let each user see an identity that matches their permissions.

See the origin requirements doc for the full problem frame, actors, key flows, and acceptance examples.

---

## Requirements Traceability

This plan implements the following requirements from the origin document:

- R1–R6. Per-role persona configuration on the Bot model, persistence, and CRUD.
- R4–R5. Default fallback when role-specific persona is unset, and unchanged behavior when no persona is configured at all.
- R7–R10. Runtime role resolution, Default fallback, non-member-as-Normal, and GUI/desktop exclusion.
- R11. Runtime recreation on persona, member-role, or role-permission changes.
- R12–R15. Persona tab sub-tabs, per-role editor, single page-level save, and length warning.

---

## Key Technical Decisions

- **KTD1. Keep the existing `persona` field as the Default persona and add a separate `rolePersonas` map for role overrides.** The existing `persona_json` column and API field already serve as the Default; no data migration is required because existing bots implicitly use their current persona as Default, satisfying R3. A new `role_personas_json` column stores `{ owner?: BotPersona; admin?: BotPersona; normal?: BotPersona }` and keeps backward compatibility with current API consumers.
- **KTD2. Resolve role and select persona at runtime creation time inside `ChatService.buildSdkOptions()`.** `systemPrompt` is built once per runtime and cannot be swapped on a live runtime. Role-based tool permissions are still resolved dynamically per tool use; persona follows the snapshot-at-creation model.
- **KTD3. Treat users without a member record as Normal for persona selection.** `botService.getMemberRole` returns `null` for non-members; persona selection maps `null` to `'normal'` and then falls back to Default if no Normal persona is configured.
- **KTD4. Close active Bot runtimes on mutations that affect persona or role.** `ChatService` exposes `closeRuntimesForBot(botId)`. The bots route calls it after persona updates, role-policy updates, member additions, member role changes, and member removals. The next `pushMessage` recreates the runtime.
- **KTD5. Store role personas as a JSON blob following the existing `*_json` column convention.** This mirrors `role_policy_json` and `provider_settings_json` and fits the repo's additive migration pattern (`PRAGMA table_info` + `ALTER TABLE ADD COLUMN`).

---

## Implementation Units

### U1. Extend Bot model and SQLite schema for role personas

**Goal:** Define and persist the per-role persona shape while keeping the existing `persona` field as Default.

**Requirements:** R1, R2, R3, R6.

**Dependencies:** None.

**Files:**
- `src/server/models/bot.ts`
- `src/server/storage/sqlite-store.ts`

**Approach:**
- Add `rolePersonas?: Partial<Record<BotRole, BotPersona>>` to `Bot`, `CreateBotInput`, and `UpdateBotInput`.
- Add `role_personas_json TEXT` to the `bots` table CREATE TABLE statement and to any existing database via a migration check in the `SqliteStore` constructor (`PRAGMA table_info` + `ALTER TABLE bots ADD COLUMN role_personas_json TEXT`).
- Update `createBot` and `updateBot` to serialize `rolePersonas` into `role_personas_json` (or `null` when empty/absent).
- Update `parseBotRow` to deserialize `role_personas_json` into `rolePersonas`.

**Patterns to follow:**
- Mirror the existing `persona_json` handling in `sqlite-store.ts`.

**Test scenarios:**
- `createBot` stores and returns `rolePersonas`.
- `updateBot` replaces `rolePersonas` with the provided map.
- `getBot` returns `rolePersonas: undefined` for rows that pre-date the column after schema migration (no data migration is needed; existing `persona` remains Default per R3).
- Existing bots with only `persona` continue to load with `persona` as Default.

**Verification:** `npm run test:server` passes for `src/server/storage/sqlite-store.test.ts` and `src/server/services/bot-service.test.ts`.

---

### U2. Resolve role-based persona in ChatService buildSdkOptions

**Goal:** Select the correct persona for the current user role when a Bot runtime is created.

**Requirements:** R7, R8, R9, R10.

**Dependencies:** U1.

**Files:**
- `src/server/services/chat-service.ts`

**Approach:**
- In `buildSdkOptions`, inside the `session.botId` branch, keep the existing `provider` and `providerUserId` resolution for WeCom and Feishu.
- Resolve the effective role:
  ```typescript
  const roleForPersona = provider && providerUserId
    ? botService.getMemberRole(bot.id, provider, providerUserId) ?? 'normal'
    : undefined;
  ```
- Select the persona:
  ```typescript
  const persona = roleForPersona
    ? bot.rolePersonas?.[roleForPersona] ?? bot.persona
    : bot.persona;
  ```
- Translate the selected persona into `options.systemPrompt`:
  ```typescript
  if (persona) {
    if (persona.mode === 'append') {
      options.systemPrompt = { type: 'preset', preset: 'claude_code', append: persona.prompt };
    } else {
      options.systemPrompt = persona.prompt;
    }
  }
  ```
- GUI/desktop sessions never enter the `isBotSession` branch, so they remain unaffected.

**Patterns to follow:**
- Existing persona injection block inside the `session.botId` branch of `buildSdkOptions`, where `provider` and `providerUserId` are resolved for WeCom/Feishu and then translated into `options.systemPrompt`.

**Test scenarios:**
- Owner member receives Owner persona in `systemPrompt`.
- Normal member receives Normal persona.
- Non-member receives Normal persona when Normal is configured.
- Role with no specific persona falls back to Default.
- Default unset + role persona set uses role persona.
- GUI session receives no Bot persona.
- Per-role `replace` and `append` modes produce the correct SDK shapes.

**Verification:** `npm run test:server` passes for `src/server/services/chat-service.test.ts`.

---

### U3. Add runtime invalidation for Bot persona/role/permission changes

**Goal:** Ensure changes to persona, member role, or role policy take effect on the next user turn.

**Requirements:** R11.

**Dependencies:** U1, U2.

**Files:**
- `src/server/services/chat-service.ts`
- `src/server/routes/bots.ts`

**Approach:**
- Add `closeRuntimesForBot(botId: string): Promise<void>` to `ChatService`.
  - Iterate `this.runtimes`.
  - For each runtime, look up the local session via `workspaceStore.getLocalSession(sessionId)`.
  - If `session && session.botId === botId`, close the runtime.
- Import `chatService` into `src/server/routes/bots.ts`.
- After each of the following route handlers succeeds, call `chatService.closeRuntimesForBot(bot.id)`:
  - `PUT /api/bots/:id` when `persona`, `rolePersonas`, or `rolePolicy` is present in the request body. (`rolePolicy` is updated through this endpoint; there is no separate role-policy endpoint at this time.)
  - `POST /api/bots/:id/members`
  - `PUT /api/bots/:id/members/:providerUserId/role`
  - `DELETE /api/bots/:id/members/:providerUserId`
- Fire the close asynchronously without blocking the HTTP response; log failures but do not fail the request.

**Patterns to follow:**
- Existing `closeRuntimesForWorkspace` in `chat-service.ts` for iteration style.

**Test scenarios:**
- `closeRuntimesForBot` closes only runtimes whose session belongs to the target bot.
- `PUT /api/bots/:id` with a persona change triggers a close.
- `PUT /api/bots/:id/members/:providerUserId/role` triggers a close.
- The HTTP response succeeds even if closing a runtime throws.

**Verification:** `npm run test:server` passes for `src/server/routes/bots.test.ts` and `src/server/services/chat-service.test.ts`.

---

### U4. Update client Bot types and i18n

**Goal:** Make the client aware of per-role personas and provide localized labels for the new UI.

**Requirements:** R12, R13.

**Dependencies:** U1.

**Files:**
- `src/client/stores/bot-store.ts`
- `src/client/i18n/en/settings.json`
- `src/client/i18n/zh-CN/settings.json`

**Approach:**
- Add `rolePersonas?: Partial<Record<BotRole, BotPersona>>` to `Bot`, `CreateBotInput`, and `UpdateBotInput` in `bot-store.ts`.
- Add i18n keys under `bots.persona`:
  - `defaultTab`, `ownerTab`, `adminTab`, `normalTab`
  - `saveAll`
  - `defaultDescription`, `ownerDescription`, `adminDescription`, `normalDescription` (optional hints under each tab)
  - Reuse existing `bots.roleOwner`, `bots.roleAdmin`, `bots.roleNormal` where appropriate.

**Patterns to follow:**
- Existing `bots.persona.*` and `bots.roles.*` i18n structure.

**Test scenarios:**
- TypeScript compiles after type changes.
- Both language files contain all new keys.

**Verification:** `npm run lint` passes and `npm run dev:client` starts without i18n key errors.

---

### U5. Redesign BotPersonaEditor with role sub-tabs and single save

**Goal:** Provide sub-tabs for Default, Owner, Admin, and Normal with a single save that commits the whole configuration.

**Requirements:** R12, R13, R14, R15.

**Dependencies:** U4.

**Files:**
- `src/client/components/BotPersonaEditor.tsx`
- `src/client/components/BotManagementPage.tsx`

**Approach:**
- Define `type PersonaTab = 'default' | BotRole;` and replace the single editor state with `Record<PersonaTab, BotPersona>` where every tab has a prompt and a mode.
- Initialize from `bot.persona` (Default) and `bot.rolePersonas` (Owner/Admin/Normal).
- Render a segmented control for tab selection in the order Default | Owner | Admin | Normal, with Default as the initially active tab.
- Use a Radix Tabs primitive (or equivalent accessible tab component) so keyboard navigation and ARIA roles are handled automatically.
- Preserve unsaved changes when switching between tabs; the shared state record keeps edits for all tabs.
- Before navigating away from the Persona view (e.g., back to the bot list), if any tab has unsaved changes, show the existing unsaved-changes dialog to let the user save or discard.
- For Owner, Admin, and Normal tabs, show a fallback hint when no persona is configured for that role (e.g., "未设置；该角色将使用 Default 人设").
- Add a Cancel button next to Save that resets all tabs to the last successfully saved state.
- Reuse the existing textarea, mode selector, and length warning for the active tab.
- Track a saved snapshot of the full record. The Save button is enabled when any tab differs from its saved value.
- On save, derive:
  - `persona`: Default prompt trimmed to a `BotPersona` or `null` if empty.
  - `rolePersonas`: an object containing only roles with non-empty prompts.
- Call `onSave({ persona, rolePersonas })`.
- Update `BotManagementPage.handleSavePersona` to accept the combined payload and call `updateBot(selectedBot.id, { persona, rolePersonas })`.

**Patterns to follow:**
- `BotRolePermissions.tsx` for role tab styling.
- Existing dirty-state pattern in `BotPersonaEditor.tsx`.

**Test scenarios:**
- All four tabs render and switch.
- Editing one tab does not affect another.
- Dirty state is true when any tab changes and false after a successful save.
- Saving sends both `persona` and `rolePersonas` with the correct shape.
- Empty prompts are omitted from the saved role map and Default becomes `null`.
- Length warning appears when the active tab's prompt exceeds the budget, and any other tab that also exceeds the budget is indicated in the tab list.

**Verification:** `npm run test:client` passes for `src/client/components/BotPersonaEditor.test.tsx`; `npm run lint` passes.

---

### U6. Add end-to-end and regression tests for per-role persona behavior

**Goal:** Verify the full flow from storage through runtime injection and runtime invalidation.

**Requirements:** R1–R15.

**Dependencies:** U1–U5.

**Files:**
- `src/server/storage/sqlite-store.test.ts`
- `src/server/services/bot-service.test.ts`
- `src/server/routes/bots.test.ts`
- `src/server/services/chat-service.test.ts`
- `src/client/components/BotPersonaEditor.test.tsx`

**Approach:**
- Extend existing server-side tests; do not add new test frameworks.
- Follow the isolated-database convention: import `../test-utils/test-env.js` first and use `new SqliteStore(':memory:')` / `resetData()`.

**Test scenarios:**
- `sqlite-store.test.ts`: `role_personas_json` round-trip and migration of existing rows.
- `bot-service.test.ts`: create and update a Bot with `rolePersonas`; verify Default remains intact.
- `chat-service.test.ts`:
  - Owner member → Owner persona.
  - Normal member → Normal persona.
  - Non-member → Normal persona with fallback to Default.
  - Role persona missing → Default.
  - `append` and `replace` modes per role.
- `chat-service.test.ts`: `closeRuntimesForBot` closes only matching sessions.
- `bots.test.ts`: persona/role updates trigger runtime invalidation; member changes trigger invalidation.
- `BotPersonaEditor.test.tsx`: tab switching, multi-tab dirty state, single save payload.

**Verification:** `npm run test:server` and `npm run test:client` pass for all touched test files.

---

## Scope Boundaries

### Deferred for later

- Provider-level personas (different personas for WeCom vs Feishu on the same Bot).
- Session-level or per-user personas beyond role.
- Pre-built persona templates or marketplace.
- Persona versioning or A/B testing.
- Fine-grained invalidation that waits for an in-flight turn before closing the runtime.

### Outside this product's identity

- Removing Claude Code as the underlying runtime.

---

## Risks & Dependencies

- **Closing runtimes during an active turn.** `closeRuntimesForBot` closes runtimes immediately. If an admin mutates persona while the Bot is processing a turn, that turn may be interrupted. The first implementation does not guard against in-flight turns; this is acceptable because admin edits are low-frequency and the next user turn recreates the runtime. If it becomes a problem, add a guard that schedules the close after `runtime.isProcessingTurn()` returns false.
- **Role resolution depends on WeCom user mappings.** Non-member fallback works only when `providerUserId` can be resolved. If a WeCom user has no mapping, `providerUserId` is undefined and the persona branch falls back to Default. R9's non-member-as-Normal rule applies only when the user can be identified but has no member record; unidentified users fall back to Default, consistent with today's tool policy behavior.
- **Existing API consumers.** The API gains a new optional `rolePersonas` field; existing clients that only send `persona` continue to work because `rolePersonas` defaults to undefined.

---

## Open Questions

None. All known questions were resolved in the origin brainstorm.

---

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-30-per-role-bot-persona-requirements.md`
- Existing persona plan: `docs/plans/2026-06-30-002-feat-bot-persona-system-prompt-plan.md`
- WeCom bot tool-permissions plan: `docs/plans/2026-06-14-001-feat-wecom-bot-tool-permissions-plan.md`
- Bot role and permission patterns discovered in `src/server/models/bot.ts`, `src/server/services/bot-service.ts`, `src/server/services/bot-policy.ts`, `src/server/services/chat-service.ts`, and `src/client/components/BotRolePermissions.tsx`.
- Runtime lifecycle and persona injection discovered in `src/server/services/chat-service.ts`.
- UI patterns discovered in `src/client/components/BotPersonaEditor.tsx`, `src/client/components/BotManagementPage.tsx`, and `src/client/stores/bot-store.ts`.
