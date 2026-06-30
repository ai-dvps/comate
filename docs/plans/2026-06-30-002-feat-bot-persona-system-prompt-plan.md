---
date: 2026-06-30
topic: bot-persona-system-prompt
type: feat
origin: docs/brainstorms/2026-06-30-bot-persona-system-prompt-requirements.md
---

# Bot Persona / System Prompt

## Summary

Add a per-Bot editable system prompt ("persona") that is injected into Claude Code Agent SDK sessions created for WeCom and Feishu bot users. The persona is stored on the Bot record, edited through a new "Persona" tab in Bot Management, and translated into the SDK `Options.systemPrompt` field at runtime. The default mode appends the persona to Claude Code's default system prompt; an optional `replace` mode substitutes it entirely.

---

## Problem Frame

When users ask a Comate-bound WeCom or Feishu bot questions like "what can you do" or "introduce yourself", the bot answers as Claude Code — describing Claude's built-in coding capabilities rather than the role, scope, and tone the team configured the bot for. There is currently no way to override this identity layer.

See the origin requirements doc for the full problem frame, actors, and acceptance examples.

---

## Requirements Traceability

This plan implements the following requirements from the origin document:

- R1. `Bot` model supports a `systemPrompt` field.
- R2. `systemPrompt` supports `append` and `replace` modes.
- R3. Unconfigured Bots behave exactly as today.
- R4. Persona text is persisted with the Bot record and included in CRUD.
- R5. Bot session runtime creation translates persona into SDK `Options.systemPrompt`.
- R6. GUI/desktop sessions do not inherit Bot personas.
- R7. Persona changes apply to the next newly created Bot session.
- R8–R11. Bot settings UI includes a dedicated Persona tab with editor, mode selector, and length warning.

---

## Key Technical Decisions

- **KTD1. Store persona as a JSON blob on the `bots` table.** This mirrors how `rolePolicy` and `providerSettings` are stored and avoids a migration framework the repo does not have.
- **KTD2. Add the field to the `Bot` model as a nested object `{ prompt, mode }`, not flat columns.** The nested shape keeps the model readable and makes future extensions (e.g., per-provider overrides) easier.
- **KTD3. Inject the persona in `ChatService.buildSdkOptions()` when `isBotSession` is true.** Both WeCom and Feishu bot sessions flow through this function, so a single injection point covers both channels.
- **KTD4. Use the SDK's preset-with-append form for `append` mode.** This preserves Claude Code's default system prompt behavior while adding the Bot persona. For `replace` mode, pass the prompt string directly.
- **KTD5. Do not invalidate open runtimes when persona changes.** This matches the existing tool-permissions behavior: changes take effect on the next newly created session.

---

## Implementation Units

### U1. Add persona field to Bot model and SQLite schema

**Goal:** Define the `persona` shape on the server-side `Bot` model and persist it in SQLite.

**Requirements:** R1, R2, R4.

**Dependencies:** None.

**Files:**
- `src/server/models/bot.ts`
- `src/server/storage/sqlite-store.ts`

**Approach:**
- Add a `BotPersona` interface with `prompt: string` and `mode: 'append' | 'replace'`.
- Add optional `persona?: BotPersona` to `Bot`, `CreateBotInput`, and `UpdateBotInput`.
- Add a `persona_json TEXT` column to the `bots` table schema.
- Add a migration check in the `SqliteStore` constructor using `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` for existing deployments.
- Update `parseBotRow`, `createBot`, and `updateBot` to serialize/deserialize the JSON blob with a safe default of `undefined`.

**Patterns to follow:**
- Mirror the existing `rolePolicy_json` and `provider_settings_json` patterns in `sqlite-store.ts`.

**Test scenarios:**
- `createBot` with a persona stores and returns it.
- `getBot` returns `persona: undefined` for rows that have no persona.
- `updateBot` clears the persona when `persona: undefined` is passed.
- Existing rows without the new column still load after schema migration.

**Verification:** `npm run test:server` passes for `src/server/storage/sqlite-store.test.ts`.

---

### U2. Wire persona through Bot service and routes

**Goal:** Ensure persona flows through `BotService` and the bots REST API without being dropped or redacted.

**Requirements:** R4.

**Dependencies:** U1.

**Files:**
- `src/server/services/bot-service.ts`
- `src/server/routes/bots.ts`

**Approach:**
- No validation logic is needed for persona text; pass it through.
- Confirm that `PUT /api/bots/:id` accepts `persona` in `UpdateBotInput` and returns it in the response.
- Confirm that `redactBot()` does not strip the persona field (it is not a secret).

**Patterns to follow:**
- Existing `rolePolicy` pass-through behavior.

**Test scenarios:**
- `PUT /api/bots/:id` with a persona returns the updated bot with the same persona.
- `GET /api/bots/:id` returns the persona.
- Persona is not redacted in list/get responses.

**Verification:** `npm run test:server` passes for `src/server/routes/bots.test.ts`.

---

### U3. Inject persona into SDK Options for Bot sessions

**Goal:** Translate the Bot persona into the SDK `systemPrompt` option when a Bot session runtime is created.

**Requirements:** R3, R5, R6, R7.

**Dependencies:** U1, U2.

**Files:**
- `src/server/services/chat-service.ts`

**Approach:**
- In `buildSdkOptions`, after resolving the bot via `session.botId` and `botService.getBot()`, read `bot.persona`.
- If `persona` is configured and `isBotSession` is true:
  - `append`: set `options.systemPrompt = { type: 'preset', preset: 'claude_code', append: persona.prompt }`.
  - `replace`: set `options.systemPrompt = persona.prompt`.
- If persona is not configured or this is a GUI session, do not set `systemPrompt`.

**Patterns to follow:**
- Existing bot session branch in `buildSdkOptions` where `botService.getBot(session.botId)` is resolved.

**Test scenarios:**
- `buildSdkOptions` for a Bot session with `append` persona sets the preset-with-append form.
- `buildSdkOptions` for a Bot session with `replace` persona sets the prompt string.
- `buildSdkOptions` for a Bot session with no persona leaves `systemPrompt` unset.
- `buildSdkOptions` for a GUI session never sets `systemPrompt` from a Bot persona.

**Verification:** `npm run test:server` passes for `src/server/services/chat-service.test.ts`.

---

### U4. Add client-side Bot types and i18n for persona

**Goal:** Make the client aware of the persona field and provide localized labels.

**Requirements:** R8–R11.

**Dependencies:** U1.

**Files:**
- `src/client/stores/bot-store.ts`
- `src/client/i18n/en/settings.json`
- `src/client/i18n/zh-CN/settings.json`

**Approach:**
- Add `BotPersona` interface and optional `persona?: BotPersona` to the `Bot` and `UpdateBotInput` types in `bot-store.ts`.
- Add `bots.persona.*` keys for tab label, editor label, mode selector, hints, and length warning in both language files.

**Patterns to follow:**
- Existing `bots.roles.*` and `bots.rolePermissions.*` i18n structure.

**Test scenarios:**
- TypeScript compiles without errors after type changes.
- Both language files contain all new keys.

**Verification:** `npm run lint` passes and `npm run dev:client` starts without i18n key errors.

---

### U5. Add Persona tab to Bot Management UI

**Goal:** Provide the admin UI for editing the Bot persona.

**Requirements:** R8–R11.

**Dependencies:** U4.

**Files:**
- `src/client/components/BotManagementPage.tsx`
- `src/client/components/BotPersonaEditor.tsx` (new)

**Approach:**
- Add `'persona'` to the `view` union in `BotManagementPage`.
- Add a "Persona" button/tab in the bot list/detail view.
- Render a new `BotPersonaEditor` component when the persona view is active.
- `BotPersonaEditor` receives a `Bot`, an `onSave(persona)` callback, and saving/error state.
- The editor contains:
  - A multi-line textarea for the prompt text.
  - A segmented control or radio group for `append` / `replace` with `append` default.
  - A soft length warning when text exceeds a recommended budget.
  - A save button.

**Patterns to follow:**
- `BotRolePermissions.tsx` for the sub-tab structure and save flow.
- Existing textarea styling from `BotRolePermissions`.

**Test scenarios:**
- Selecting the Persona tab renders the editor.
- Saving a persona calls `updateBot` with the correct `persona` object.
- Switching modes updates the form state.
- Length warning appears when prompt exceeds the budget.

**Verification:** Manual UI verification or existing browser tests pass; `npm run lint` passes.

---

### U6. Add end-to-end tests for persona behavior

**Goal:** Verify the persona is persisted and injected correctly across the stack.

**Requirements:** R1–R7.

**Dependencies:** U1–U5.

**Files:**
- `src/server/services/chat-service.test.ts`
- `src/server/routes/bots.test.ts`
- `src/server/services/bot-service.test.ts`
- `src/server/storage/sqlite-store.test.ts`

**Approach:**
- Extend existing server-side tests to cover persona CRUD and SDK option injection.
- Do not add new test frameworks; use the existing `node:test` setup.
- Follow the isolated-database convention: import `../test-utils/test-env.js` first and use `new SqliteStore(':memory:')` / `resetData()`.

**Test scenarios:**
- `bot-service.test.ts`: create and update a Bot with persona; verify defaults.
- `sqlite-store.test.ts`: persona round-trip through the database.
- `bots.test.ts`: HTTP PUT/GET round-trip with persona.
- `chat-service.test.ts`: `buildSdkOptions` produces the expected `systemPrompt` for append and replace modes, and leaves GUI sessions unaffected.
- `chat-service.test.ts`: persona changes take effect only on the next newly created Bot session; already-open runtimes are not retroactively updated.

**Verification:** `npm run test:server` passes for all touched test files.

---

## Scope Boundaries

### Deferred for later

- Provider-level personas (different persona for WeCom vs Feishu on the same Bot).
- Session-level persona selection.
- Pre-built persona templates or marketplace.
- Auto-extraction of persona from workspace `CLAUDE.md`.
- Persona versioning or A/B testing.
- Force-closing open runtimes when persona changes.

### Outside this product's identity

- Removing Claude Code as the underlying runtime.

---

## Dependencies / Assumptions

- The Claude Code Agent SDK `Options.systemPrompt` field remains available and behaves as documented.
- `buildSdkOptions()` is the single injection point for both WeCom and Feishu Bot sessions.
- Project-level `CLAUDE.md` continues to load by default; the Bot persona is additive or overriding depending on mode.
- No formal migration framework exists; additive schema changes via `ALTER TABLE` are acceptable.

---

## Open Questions

None. All known questions were resolved in the origin brainstorm.

---

## Sources & Research

- Origin requirements: `docs/brainstorms/2026-06-30-bot-persona-system-prompt-requirements.md`
- Bot-Workspace decoupling plan: `docs/plans/2026-06-28-001-feat-bot-workspace-decoupling-plan.md`
- WeCom bot tool-permissions plan: `docs/plans/2026-06-14-001-feat-wecom-bot-tool-permissions-plan.md`
- SDK type definition confirming `systemPrompt` support: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
- Existing Bot UI and storage patterns discovered in `src/client/components/BotManagementPage.tsx`, `src/client/components/BotRolePermissions.tsx`, `src/client/stores/bot-store.ts`, `src/server/storage/sqlite-store.ts`, and `src/server/services/chat-service.ts`.
