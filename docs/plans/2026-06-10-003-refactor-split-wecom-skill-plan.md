---
date: 2026-06-10
sequence: 003
type: refactor
status: active
---

# Split WeCom Message Skill into Send and Enqueue Skills

## Summary

Split the monolithic `send-wecom-message` skill into two focused skills. The existing skill retains normal/current-conversation sends and the recipient-side proactive execution directive. A new `enqueue-wecom-proactive-message` skill handles sender-side proactive initiation. This gives each skill a tight description so the agent routes more reliably when the user asks to send to another user.

---

## Problem Frame

The current `send-wecom-message` skill handles three distinct behaviors in a single file:
1. **Normal sends**: `wecom msg send` for messages in the current conversation
2. **Proactive initiation**: `wecom queue enqueue` when A asks to send to B
3. **Proactive execution**: Handling `[Proactive Send]` directives in B's session

The agent in A's session frequently confuses (1) and (2), using `wecom msg send` when it should enqueue. The skill description is broad ("send a WeCom message, notify someone, or communicate via WeCom") and its workflow asks the agent to classify intent before choosing a command. A focused skill with a tight description should route the agent more reliably.

---

## Key Technical Decisions

- **Two skills, not three**: The proactive execution (`<proactive_send>`) stays in `send-wecom-message` because it uses the same command (`wecom msg send`) and the same session context as normal sends. Extracting it would create a third skill that still loads everywhere.
- **Separate generation script**: A new `scripts/generate-wecom-proactive-skill.ts` is created rather than extending the existing script. This keeps the two generation pipelines decoupled.
- **Skill names**: `send-wecom-message` (existing) and `enqueue-wecom-proactive-message` (new). The new name uses "enqueue" to align with the CLI subcommand.
- **No new automated tests**: The skill generation and bot service skill writing have no existing test coverage. This refactor is a content reorganization with no behavioral change to the queue, CLI, or endpoints, so the test scope is manual verification only.

---

## High-Level Technical Design

### Skill Split

```text
Before:
send-wecom-message.md
  ├─ normal send workflow (wecom msg send)
  ├─ proactive initiation workflow (wecom queue enqueue)
  ├─ proactive execution directive (<proactive_send>)
  └─ shared rules (exit codes, quoting, markdown detection)

After:
send-wecom-message.md
  ├─ normal send workflow (wecom msg send)
  ├─ proactive execution directive (<proactive_send>)
  └─ shared rules (exit codes, quoting, markdown detection)

enqueue-wecom-proactive-message.md
  ├─ proactive initiation workflow (wecom queue enqueue)
  └─ examples of "send to X", "notify Y" phrasings
```

### Generation Pipeline

```text
send-wecom-message.md
  → scripts/generate-wecom-skill.ts
  → src/server/assets/wecom-skill.ts (export const SKILL_MD)

enqueue-wecom-proactive-message.md
  → scripts/generate-wecom-proactive-skill.ts
  → src/server/assets/wecom-proactive-skill.ts (export const PROACTIVE_SKILL_MD)
```

### Bot Service Deployment

```text
wecomBotService.writeSkillFiles(workspace)
  ├─ writes .claude/skills/send-wecom-message/SKILL.md
  └─ writes .claude/skills/enqueue-wecom-proactive-message/SKILL.md
```

---

## Implementation Units

### U1. Create the new proactive skill markdown source

**Goal:** Create a standalone skill markdown file for proactive send initiation.

**Requirements:** R1 (see origin: `docs/brainstorms/2026-06-10-wecom-skill-split-requirements.md`)

**Dependencies:** None

**Files:**
- `src/server/assets/enqueue-wecom-proactive-message.md` (create)

**Approach:**
Write a new skill file with:
- Frontmatter: `name: enqueue-wecom-proactive-message`, description focused on queueing messages to other users' sessions
- `<objective>`: Queue WeCom proactive messages using `wecom queue enqueue`
- `<quick_start>`: Example of `wecom queue enqueue --to-user USERID --message "..."`
- `<workflow>`: Extract recipient and message, run `wecom queue enqueue`, report queue entry ID
- `<examples>`: 2-3 examples of "send to ZhangSan", "notify LiSi" phrasings
- `<anti_patterns>`: Exit codes scoped to enqueue, quoting rules, never guess recipient
- No `<proactive_send>` or `<proactive_send_initiate>` sections — this skill is purely for A's session initiation

**Patterns to follow:** Existing `send-wecom-message.md` structure and tone.

**Test scenarios:**
- Happy path: skill markdown is valid, parses correctly by frontmatter parser
- Verification: `scripts/generate-wecom-proactive-skill.ts` can read and escape the markdown successfully

---

### U2. Trim proactive initiation content from the existing skill

**Goal:** Remove proactive initiation logic from `send-wecom-message.md` so it focuses on normal sends and proactive execution.

**Requirements:** R2, R3

**Dependencies:** None (can be done in parallel with U1)

**Files:**
- `src/server/assets/send-wecom-message.md` (modify)

**Approach:**
Edit the existing skill to remove:
- The `<proactive_send_initiate>` section entirely
- `wecom queue enqueue` references in quick_start, workflow, and examples
- Recipient-type decision logic ("if the user names a recipient other than themselves...")

Keep:
- Normal send workflow (`wecom msg send`)
- Markdown detection and drafting guidance
- The `<proactive_send>` directive execution section for B's session
- Normal send examples
- Anti-patterns (exit codes, quoting)

**Patterns to follow:** Existing skill section structure.

**Test scenarios:**
- Happy path: skill markdown is valid after edits, frontmatter intact
- Verification: `scripts/generate-wecom-skill.ts` can read and escape the modified markdown successfully

---

### U3. Create the new skill generation script

**Goal:** Add a generation script for the new proactive skill, mirroring the existing pattern.

**Requirements:** R4

**Dependencies:** U1

**Files:**
- `scripts/generate-wecom-proactive-skill.ts` (create)

**Approach:**
Create a new script that:
1. Reads `src/server/assets/enqueue-wecom-proactive-message.md`
2. Escapes backslashes, `$`, and backticks
3. Writes `src/server/assets/wecom-proactive-skill.ts` exporting `PROACTIVE_SKILL_MD`

This mirrors the existing `scripts/generate-wecom-skill.ts` exactly, just with different input/output paths and export name.

**Patterns to follow:** `scripts/generate-wecom-skill.ts`

**Test scenarios:**
- Happy path: script runs without error
- Verification: `src/server/assets/wecom-proactive-skill.ts` is created and contains a valid exported string constant

---

### U4. Update package.json to run both generation scripts

**Goal:** Ensure `npm run generate:skills` produces both skill assets.

**Requirements:** R4

**Dependencies:** U3

**Files:**
- `package.json` (modify)

**Approach:**
Update the `generate:skills` script from:
```
"generate:skills": "tsx scripts/generate-wecom-skill.ts"
```
to:
```
"generate:skills": "tsx scripts/generate-wecom-skill.ts && tsx scripts/generate-wecom-proactive-skill.ts"
```

**Patterns to follow:** Existing npm script conventions in `package.json`.

**Test scenarios:**
- Happy path: `npm run generate:skills` executes both scripts successfully
- Verification: both `src/server/assets/wecom-skill.ts` and `src/server/assets/wecom-proactive-skill.ts` are updated

---

### U5. Update wecomBotService to write and remove both skills

**Goal:** Deploy both skills to each workspace on bot connect/disconnect.

**Requirements:** R4, R5

**Dependencies:** U2, U4

**Files:**
- `src/server/services/wecom-bot-service.ts` (modify)

**Approach:**
1. Add import: `import { PROACTIVE_SKILL_MD } from '../assets/wecom-proactive-skill.js';`
2. Update `writeSkillFiles(workspace)`:
   - Create both `.claude/skills/send-wecom-message/` and `.claude/skills/enqueue-wecom-proactive-message/`
   - Write `SKILL_MD` to the first directory
   - Write `PROACTIVE_SKILL_MD` to the second directory
3. Update `removeSkillFiles(workspaceId)`:
   - Remove both skill directories (or both `SKILL.md` files)

**Patterns to follow:** Existing `writeSkillFiles` and `removeSkillFiles` implementations.

**Test scenarios:**
- Happy path: bot connect writes both skill directories with valid `SKILL.md` files
- Verification: manual test — reconnect bot, verify both `.claude/skills/send-wecom-message/SKILL.md` and `.claude/skills/enqueue-wecom-proactive-message/SKILL.md` exist

---

### U6. Regenerate skill assets and verify end-to-end

**Goal:** Produce the generated `.ts` files and confirm the full pipeline works.

**Requirements:** R4, R5

**Dependencies:** U5

**Files:**
- `src/server/assets/wecom-skill.ts` (regenerate)
- `src/server/assets/wecom-proactive-skill.ts` (regenerate)

**Approach:**
1. Run `npm run generate:skills`
2. Verify both generated files exist and contain valid exported constants
3. Verify the server builds successfully (`npm run build:server`)
4. Optionally: reconnect a WeCom bot and verify both skill files are written to the workspace

**Test scenarios:**
- Happy path: `npm run generate:skills` succeeds
- Integration: server build passes with new import
- Manual end-to-end: bot reconnect writes both skills

---

## Scope Boundaries

### Out of scope
- Changes to the CLI (`wecom msg send` and `wecom queue enqueue` already exist)
- Changes to the queue worker, storage, or HTTP endpoints
- Changes to the agent SDK or skill loading mechanism
- Session-specific skill loading (both skills still load in all sessions)

### Deferred to Follow-Up Work
- Deduplicating shared content (exit codes, quoting rules) via a shared template or include mechanism
- Evaluating whether agent routing improves with the split (observational)
- Adding automated tests for skill generation and bot service skill writing

---

## Dependencies / Assumptions

- The agent SDK respects skill descriptions for routing decisions
- `wecomBotService.writeSkillFiles` can write multiple skills per workspace without conflicts
- `npm run generate:skills` can chain multiple script invocations
- Existing `.claude/skills/send-wecom-message/SKILL.md` files are overwritten safely on bot reconnect

---

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Agent still confuses modes despite split | Medium | Medium | The split is a heuristic improvement, not a guarantee. Observational evaluation deferred to follow-up. |
| Old combined skill file left behind in existing workspaces | Low | Low | `removeSkillFiles` cleans up on disconnect; `writeSkillFiles` overwrites on reconnect. No stale file accumulation. |
| Build breaks due to new import or generated file | Low | Low | Verify build in U6 before considering complete. |

---

## Test Strategy Summary

- **Unit tests:** None — this is a content refactor with no new logic.
- **Integration tests:** Server build verification, manual bot reconnect test.
- **Characterization tests:** None required.
- **Manual verification:** Run `npm run generate:skills`, inspect generated `.ts` files, reconnect bot and verify both skill directories exist.
