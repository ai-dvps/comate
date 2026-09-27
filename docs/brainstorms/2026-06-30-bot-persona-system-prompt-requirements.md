---
date: 2026-06-30
topic: bot-persona-system-prompt
---

# Bot Persona / System Prompt

## Summary

Add a per-Bot editable system prompt ("persona") that is injected into Claude Code Agent SDK sessions created for WeCom and Feishu bot users. The prompt supports two modes: `append` (default), which appends the persona after Claude Code's default system prompt, and `replace`, which substitutes the entire system prompt. A dedicated "Persona" tab in Bot settings provides the editing UI.

---

## Problem Frame

When users ask a Comate-bound WeCom or Feishu bot questions like "what can you do" or "introduce yourself", the bot answers as Claude Code — describing Claude's built-in coding capabilities rather than the role, scope, and tone the team configured the bot for. There is currently no way to override this identity layer; the bot has a `name` and a per-provider `botName`, but no system-level instructions that shape replies.

---

## Key Decisions

- **KTD1. Use the SDK's `systemPrompt` option.** This is the supported mechanism for overriding identity and behavior across a session, rather than intercepting specific user questions or relying on project `CLAUDE.md` (which is shared with desktop GUI sessions and lacks Bot-specific targeting).
- **KTD2. Persona lives at the Bot level.** The same persona applies to both WeCom and Feishu users of a Bot. Provider-level or session-level personas are deferred.
- **KTD3. `append` is the default mode, `replace` is optional.** Append preserves Claude Code's coding/tooling capabilities while letting the bot answer identity and scope questions in the configured voice. Replace gives full control when needed.
- **KTD4. Store the persona in the Bot configuration.** Keeping it with the Bot record (rather than in a separate file) matches existing Bot settings lifecycle, migration, and backup behavior.

---

## Requirements

### Bot persona configuration

- R1. The `Bot` model supports a `systemPrompt` field that holds the persona text.
- R2. The `systemPrompt` field supports an optional mode: `append` or `replace`.
- R3. When no persona is configured, Bot sessions behave exactly as they do today.
- R4. Persona text is persisted with the Bot record and included in Bot CRUD operations.

### Runtime injection

- R5. When a Bot session runtime is created, the Bot's persona is translated into the SDK `Options.systemPrompt` field according to its mode.
- R6. GUI/desktop sessions do not inherit Bot personas; they continue to use the default or project-level system prompt behavior.
- R7. Changes to a Bot's persona take effect on the next newly created Bot session; existing open runtimes are not retroactively updated.

### UI editing

- R8. Bot settings include a dedicated "Persona" tab.
- R9. The tab provides a multi-line text editor for the persona Markdown/plain text.
- R10. The UI surfaces the selected mode (`append` / `replace`) with `append` as the default.
- R11. The UI shows a soft length warning when the persona exceeds a recommended token budget.

---

## Key Flows

### F1. Admin configures a Bot persona

- **Trigger:** Admin opens Bot settings and navigates to the "Persona" tab.
- **Actors:** Admin
- **Steps:**
  1. Admin enters persona text.
  2. Admin selects `append` or `replace` mode.
  3. Admin saves the Bot settings.
  4. Server persists the persona with the Bot record.
- **Outcome:** Future Bot sessions created for this Bot include the persona in their system prompt.
- **Covered by:** R1–R5, R8–R11

---

## Acceptance Examples

### AE1. Append mode shapes self-introduction

- **Given:** A Bot has `systemPrompt` set to append mode with text "你是团队的运维助手，只会回答运维相关的问题。" and is bound to an active workspace.
- **When:** A WeCom user sends "介绍一下你自己".
- **Then:** The bot replies as the team's ops assistant, not as Claude Code, and still retains the ability to use workspace tools.

### AE2. Replace mode fully customizes behavior

- **Given:** A Bot has `systemPrompt` set to replace mode with a fully custom prompt.
- **When:** A Feishu user sends "你能做什么？".
- **Then:** The bot replies strictly according to the custom system prompt, with no Claude Code default identity.

### AE3. Unconfigured Bot retains current behavior

- **Given:** A Bot has no `systemPrompt` configured.
- **When:** A user asks "介绍一下你自己".
- **Then:** The bot replies with the existing Claude Code default identity, unchanged from today.

### AE4. Desktop GUI sessions are unaffected

- **Given:** A workspace is bound to a Bot that has a custom persona.
- **When:** A user opens the same workspace in the Comate desktop app and starts a session.
- **Then:** The desktop session does not use the Bot's persona.

---

## Scope Boundaries

### Deferred for later

- Provider-level personas (different personas for WeCom vs Feishu under the same Bot).
- Session-level persona selection or per-user personas.
- Pre-built persona templates or a template marketplace.
- Auto-extracting persona from workspace `CLAUDE.md`.
- Fine-grained persona versioning or A/B testing.

### Outside this product's identity

- Removing Claude Code as the underlying runtime. The persona layer sits on top of Claude Code; even `replace` mode is still executed by the same agent runtime.

---

## Dependencies / Assumptions

- The Claude Code Agent SDK `Options.systemPrompt` field remains available and behaves as documented.
- `src/server/services/chat-service.ts` `buildSdkOptions()` is the correct injection point for both WeCom and Feishu Bot sessions.
- Project-level `CLAUDE.md` continues to be loaded by default for Bot sessions; the Bot persona is additive or overriding depending on mode, not a replacement for project instructions.

---

## Success Criteria

- A Bot with a configured persona answers identity/scope questions in the configured voice.
- Unconfigured Bots continue to behave exactly as before.
- Desktop GUI sessions never inherit a Bot persona.
- Admins can edit and save the persona from the Bot settings UI without restarting the server.
