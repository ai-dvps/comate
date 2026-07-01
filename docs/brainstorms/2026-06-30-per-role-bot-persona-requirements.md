---
date: 2026-06-30
topic: per-role-bot-persona
---

# Per-Role Bot Persona

## Summary

Extend the Bot Persona feature so a Bot can define distinct system-prompt text for Default, Owner, Admin, and Normal roles. Each role-specific persona has its own append/replace mode and falls back to the Default persona when unset. The existing per-Bot persona becomes the Default persona. Changes to persona, member role, or role permissions take effect on the next user turn by recreating the Bot runtime.

---

## Problem Frame

The current Bot Persona applies the same identity and instructions to every user who talks to the Bot through WeCom or Feishu. That is awkward because a team owner, an admin, and a normal member have different permissions and expectations. For example, the owner may want the Bot to describe itself as a full workspace assistant, while a normal member should see a more restricted identity that matches their tool whitelist. A single persona cannot express those differences without leaking role-specific capabilities to everyone.

---

## Key Decisions

- **KTD1. Keep a Default persona as the fallback.** The existing per-Bot persona is re-interpreted as the Default persona. Owner, Admin, and Normal personas override it only when configured.
- **KTD2. Non-members are treated as Normal.** If a user has no member record for the Bot, they receive the Normal persona when set, otherwise the Default persona.
- **KTD3. Each persona has its own append/replace mode.** The mode is not global; one role can append while another replaces the Claude Code default system prompt.
- **KTD4. Runtime resolution follows session → user → role → persona.** The Bot session stores enough information to look up the user, the user's role, and then the role's persona.
- **KTD5. Relevant changes take effect on the next user turn.** When persona, member role, or role-permission policy changes, the runtime is torn down and recreated on the next incoming message. This aligns role-based persona with role-based tool permissions.
- **KTD6. GUI/desktop sessions remain unaffected.** The per-role persona logic applies only to Bot sessions created for WeCom and Feishu users.

---

## Requirements

### Per-role persona configuration

- R1. The `Bot` model supports a Default persona plus optional personas for Owner, Admin, and Normal roles.
- R2. Each persona consists of a prompt string and an `append` or `replace` mode.
- R3. Existing Bots with a single persona migrate that value to the Default persona.
- R4. When a role-specific persona is unset, that role uses the Default persona.
- R5. When no persona is configured at all, Bot sessions behave exactly as they do today.
- R6. Per-role persona data is persisted with the Bot record and included in Bot CRUD operations.

### Runtime injection

- R7. When a Bot runtime is created or recreated, the Bot resolves the current user's role through `session → user → role`.
- R8. The resolved role's persona is translated into the SDK `Options.systemPrompt` field according to its mode.
- R9. Users without a member record are treated as Normal for persona selection.
- R10. GUI/desktop sessions do not use per-role Bot personas.
- R11. Changes to persona, member role, or role permissions mark active Bot runtimes as stale; the next incoming user turn recreates the runtime.

### UI editing

- R12. The Bot settings Persona tab provides sub-tabs for Default, Owner, Admin, and Normal.
- R13. Each sub-tab provides a multi-line text editor for the persona prompt and an append/replace mode selector.
- R14. The Persona view has a single page-level Save button that commits the entire Default + per-role configuration.
- R15. The UI shows a soft length warning when any persona exceeds a recommended token budget.

---

## Key Flows

### F1. Admin configures per-role personas

- **Trigger:** Admin opens Bot settings and navigates to the Persona tab.
- **Actors:** Admin
- **Steps:**
  1. Admin selects a role sub-tab (Default, Owner, Admin, or Normal).
  2. Admin enters or edits the persona text.
  3. Admin selects `append` or `replace` mode.
  4. Admin repeats for other roles as needed.
  5. Admin clicks the page-level Save button.
  6. Server persists the Default and per-role personas with the Bot record.
- **Outcome:** Future Bot runtimes use the role-specific persona when the user's role matches, falling back to Default otherwise.
- **Covered by:** R1–R6, R12–R15

### F2. Runtime selects persona on a user turn

- **Trigger:** A WeCom or Feishu user sends a message to the Bot.
- **Actors:** Bot runtime
- **Steps:**
  1. Bot resolves the user from the session.
  2. Bot resolves the user's role from the member record, defaulting to Normal if none exists.
  3. Bot selects the persona for that role, falling back to Default if unset.
  4. Bot translates the selected persona into the SDK `systemPrompt` field.
  5. Bot processes the turn using the resolved system prompt.
- **Outcome:** The user receives a response shaped by the persona appropriate to their role.
- **Covered by:** R7–R10

---

## Acceptance Examples

### AE1. Normal member sees a restricted persona

- **Given:** A Bot has Default persona "You are the team's assistant." and Normal persona "You are a read-only assistant for normal members; do not run shell commands or write files."
- **When:** A WeCom user with Normal role sends "介绍一下你自己".
- **Then:** The bot replies using the Normal persona and does not offer shell or write capabilities in its self-description.

### AE2. Owner sees the Default persona when no Owner persona is set

- **Given:** A Bot has only a Default persona and no Owner persona configured.
- **When:** A Feishu user with Owner role sends "你能做什么？".
- **Then:** The bot replies using the Default persona.

### AE3. Non-member is treated as Normal

- **Given:** A Bot has a Normal persona configured but no Default persona.
- **When:** A WeCom user who is not a recorded member sends a message.
- **Then:** The bot replies using the Normal persona.

### AE4. Persona change takes effect on the next turn

- **Given:** A Normal user has an active Bot session using the old Normal persona.
- **When:** An admin updates the Normal persona and the user sends another message.
- **Then:** The runtime is recreated and the bot replies using the updated Normal persona.

### AE5. Desktop session is unaffected

- **Given:** A Bot has Owner and Normal personas configured.
- **When:** A user opens the same workspace in the Comate desktop app and starts a session.
- **Then:** The desktop session does not use any Bot persona.

---

## Scope Boundaries

### Deferred for later

- Provider-level personas (different personas for WeCom vs Feishu on the same Bot).
- Session-level persona selection or per-user personas beyond role.
- Pre-built persona templates or a template marketplace.
- Persona versioning or A/B testing.
- Fine-grained change detection granularity smaller than one user turn.

### Outside this product's identity

- Removing Claude Code as the underlying runtime. The persona layer sits on top of Claude Code; even `replace` mode is still executed by the same agent runtime.

---

## Dependencies / Assumptions

- The Claude Code Agent SDK `Options.systemPrompt` field remains available and behaves as documented.
- The Bot session runtime can be torn down and recreated between user turns without losing essential conversation context, or the product accepts the trade-off of doing so.
- The session store keeps enough information to map a Bot session to a user and then to a member role.
- Project-level `CLAUDE.md` continues to load by default for Bot sessions; the Bot persona is additive or overriding depending on mode.

---

## Sources & Research

- Existing per-Bot persona requirements: `docs/brainstorms/2026-06-30-bot-persona-system-prompt-requirements.md`
- Existing per-Bot persona plan: `docs/plans/2026-06-30-002-feat-bot-persona-system-prompt-plan.md`
- Bot role and permission patterns discovered in `src/server/models/bot.ts`, `src/server/services/bot-service.ts`, `src/server/services/chat-service.ts`, and `src/client/components/BotRolePermissions.tsx`.
