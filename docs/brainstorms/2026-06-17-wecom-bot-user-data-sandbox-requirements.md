---
date: 2026-06-17
topic: wecom-bot-user-data-sandbox
---

# WeCom Bot User Data Sandbox

## Summary

Add a per-user filesystem sandbox for WeCom bot sessions. Each bot user can read and write only `data/<user-id>` while retaining read-only access to the rest of the workspace. The sandbox layers on top of the existing category-based tool-permission policy and is enforced by a centralized sandbox service.

---

## Problem Frame

Today, a WeCom bot user can ask the bot to read or write any file in the workspace that the category policy allows. There is no per-user isolation: one bot user's uploaded files and generated data live alongside other users' files and the workspace itself. This makes multi-user bot deployments risky because a prompt crafted by one user can read another user's files or overwrite shared workspace content. The existing tool-permission policy gates broad categories like `fileRead` and `fileWrite`, but it does not restrict where within the workspace those operations can occur.

---

## Actors

- A1. Bot user: A WeCom user interacting with the bot in a workspace.
- A2. Workspace admin: Configures the WeCom bot and reviews policy.

---

## Key Flows

- F1. First bot interaction in a workspace
  - **Trigger:** A bot user sends a message with an uploaded file.
  - **Actors:** A1
  - **Steps:**
    1. Determine the user folder name: plaintext WeCom user ID if resolved, encrypted ID otherwise.
    2. Create `data/<user-id>` if it does not exist.
    3. Save the uploaded file to that folder.
  - **Outcome:** The user's data folder exists and contains the upload.
  - **Covered by:** R1, R2, R3

- F2. Bot user reads a workspace file
  - **Trigger:** A bot user asks the bot to read a file outside `data/`.
  - **Actors:** A1
  - **Steps:**
    1. The tool call is allowed by the category policy.
    2. The sandbox service checks the path is outside other users' `data/` folders.
    3. The path is within the read-only workspace; the call is allowed.
  - **Outcome:** The bot returns the file content.
  - **Covered by:** R4, R5

- F3. Bot user tries to write outside their data folder
  - **Trigger:** A bot user asks the bot to edit a file in the workspace root.
  - **Actors:** A1
  - **Steps:**
    1. The tool call is allowed by the category policy.
    2. The sandbox service checks the target path.
    3. The path is outside `data/<user>`; the call is denied.
  - **Outcome:** The bot replies that it cannot write there.
  - **Covered by:** R4, R5, R6, R13

- F4. Plaintext user ID resolves after first interaction
  - **Trigger:** The WeCom resolver finishes mapping an encrypted ID to a plaintext ID.
  - **Actors:** A2
  - **Steps:**
    1. The resolver stores the mapping.
    2. The sandbox service renames `data/<encrypted-id>` to `data/<plaintext-id>` if it exists.
    3. Subsequent uploads use the new folder.
  - **Outcome:** The folder uses a human-readable name without data loss.
  - **Failure path:** If the plaintext folder already exists, the rename is skipped and logged.
  - **Covered by:** R2, R7, R14

- F5. Bot spawns a subagent
  - **Trigger:** A bot session invokes the `Agent` tool.
  - **Actors:** A1
  - **Steps:**
    1. The parent session passes the sandbox context to the subagent.
    2. The subagent's tool calls are evaluated against the same boundaries.
  - **Outcome:** The subagent cannot escape the sandbox.
  - **Covered by:** R8, R12

---

## Requirements

### Workspace structure

- R1. The workspace contains a `data/` folder at its root that holds per-user bot data.
- R2. Each WeCom bot user has a dedicated folder under `data/` named after the plaintext WeCom user ID, falling back to the encrypted ID until resolution completes.
- R3. The user's `data/<user>` folder is created automatically on the first bot interaction that needs it.

### Access rules

- R4. Bot users retain read-only access to all workspace files and folders outside `data/`.
- R5. Bot users have read/write access only to their own `data/<user>` folder.
- R6. Bot users have no read or write access to other users' folders under `data/`.
- R7. When the WeCom resolver maps an encrypted ID to a plaintext ID, the existing `data/<encrypted-id>` folder is renamed to `data/<plaintext-id>`.

### Policy layering

- R8. The path sandbox applies only to WeCom bot sessions; GUI sessions are unaffected.
- R9. The path sandbox is evaluated after the existing category-based tool-permission policy; a denied category still denies, and an allowed category is further checked against path rules.
- R10. File tools (`Read`, `Edit`, `Write`, `Glob`, `Grep`, `NotebookEdit`) are path-checked before execution.
- R11. Bash commands are parsed to detect file paths and write operations; commands that escape `data/<user>` or write to the read-only workspace are denied.
- R12. Agent subagents spawned by a sandboxed bot session inherit the same sandbox context.

### Behavior on denial and conflict

- R13. When a path check denies a tool call, the bot replies with a short explanation that the operation is outside the allowed area.
- R14. When a plaintext-ID rename would conflict with an existing `data/<plaintext-id>` folder, the operation is skipped and logged.

---

## Acceptance Examples

- AE1. **Covers R4, R5.** A bot user asks the bot to read `README.md` in the workspace root. The call succeeds because the path is in the read-only workspace.
- AE2. **Covers R5, R6.** A bot user asks the bot to list files in `data/other-user/`. The call is denied because it is another user's folder.
- AE3. **Covers R5, R9.** The category policy allows `fileWrite`, but a bot user asks the bot to edit `src/index.ts`. The path check denies the call because the target is outside `data/<user>`.
- AE4. **Covers R5.** A bot user asks the bot to write `data/<user>/notes.txt`. The call succeeds.
- AE5. **Covers R11.** A bot user asks the bot to run `ls src/`. The command is allowed because it reads the read-only workspace. A later `rm src/index.ts` is denied because it writes to the read-only workspace.
- AE6. **Covers R7.** A user's first upload goes to `data/<encrypted-id>/file.pdf`. Later the resolver maps the ID; the folder is renamed to `data/<plaintext-id>/`. A new upload goes to the renamed folder.
- AE7. **Covers R12.** A bot user asks the bot to spawn a subagent to write a file. The subagent's `Write` call to `data/<user>/report.md` succeeds; a call to `../workspace-file.md` is denied.

---

## Success Criteria

- A bot user cannot read or write files in another user's `data/` folder.
- A bot user cannot write files outside their own `data/` folder.
- A bot user can still read workspace documentation and source files.
- The sandbox is testable without running the full WeCom integration.

---

## Scope Boundaries

### Deferred for later

- GUI session sandboxing.
- OS-level process isolation.
- Migration of existing root-level user folders.
- Audit log of sandbox denials.
- Per-user quota or retention limits.

### Outside scope

- Changes to the WeCom connection or message routing.
- Changes to the category-based tool-permission policy model.
- General workspace file explorer write operations.

---

## Key Decisions

- **Layer path sandbox on top of category policy.** The category policy gates tools; the sandbox gates paths.
- **Centralized sandbox service.** Path and Bash validation live in one module rather than inline in the existing permission callback.
- **No migration.** Existing files saved directly under the workspace root stay where they are; only new bot uploads use `data/<user>`.
- **Rename on resolution.** The folder is renamed from encrypted to plaintext ID when resolution completes, giving admins human-readable folders.
- **Best-effort Bash parsing.** Bash is allowed but parsed heuristically; true isolation would require OS-level sandboxing that is not cross-platform.

---

## Dependencies / Assumptions

- The WeCom user resolver eventually provides plaintext IDs; until then, encrypted IDs are stable.
- The Claude Agent SDK's `canUseTool` and subagent APIs allow passing context to spawned agents.
- The workspace root path is known and stable for the lifetime of a bot session.

---

## Outstanding Questions

### Resolve before planning

_None._

### Deferred to planning

- Exact denial message wording.
- Whether to queue or lock around plaintext-ID rename to avoid upload races.
- Which Bash command patterns to support in the parser.
- How to represent sandbox context for subagents (environment variable, tool input, or session config).

---

## Deferred / Open Questions

### From 2026-06-17 review

- **Bash parsing cannot enforce the sandbox isolation guarantee** — Success Criteria / Key Decisions (P0, adversarial, product-lens, security-lens, confidence 100)

  The success criteria claim bot users "cannot read/write other users' data/" and "cannot write outside own data/," but the document acknowledges Bash parsing is best-effort and true isolation would require OS-level sandboxing. A determined user can trivially bypass the sandbox via shell variable expansion, command substitution, or indirect writes. The core promise of the feature is not reliably delivered for any user who can run Bash commands. Either deny Bash entirely for sandboxed sessions or rewrite the requirements to name bounded, detectable patterns and acknowledge the gap.

- **Symlink traversal is not addressed in path-based sandbox** — R10 / Key Flows (P1, adversarial, security-lens, confidence 100)

  A user who can write to their `data/<user>/` folder can create a symlink pointing to an arbitrary workspace path. The path checker compares the logical path and allows the operation, but the OS follows the symlink to the target. This is the most well-known class of filesystem sandbox escape and requires explicit symlink resolution or OS-level enforcement, neither of which is in the requirements.

- **Subagent sandbox inheritance mechanism is unverified** — R12 / Dependencies (P1, adversarial, security-lens, confidence 100)

  R12 requires subagents to inherit the sandbox context, but the dependencies section treats SDK context propagation as unverified. If the Claude Agent SDK's `canUseTool` callback does not propagate to spawned subagents, subagents operate with no sandbox and can read or write any file the host process can reach. The mechanism representation is deferred to planning without a fallback if the SDK cannot support it.

- **TOCTOU race between path check and tool execution** — R10 / F2 / F3 (P1, adversarial, security-lens, confidence 100)

  The sandbox architecture checks the path before the tool executes, but filesystem state can change between check and operation. A symlink swap or rename during this window bypasses the check entirely. The only race condition acknowledged in the document is the rename-vs-upload race for plaintext-ID folder renames; the TOCTOU window exists for every single file tool call.

- **"No migration" contradicts deferred migration listing** — Key Decisions / Scope Boundaries (P2, coherence, confidence 75)

  Key Decisions states "No migration" as an absolute permanent choice, while Scope Boundaries lists "Migration of existing root-level user folders" as deferred for later. An implementer reading one section concludes migration never happens; a reader of the other expects eventual migration. The document disagrees with itself on a fundamental scope question.

- **Actor mismatch on flow F4** — Key Flows → F4 (P2, coherence, confidence 75)

  F4 lists A2 (Workspace admin) as the actor, but the trigger and steps describe an automated system event — the WeCom resolver mapping and the sandbox service rename are not admin actions. An implementer would not know whether the admin must initiate something or whether the system handles it entirely.

- **Rename-on-resolution complexity disproportionate to value** — R7 / F4 / R14 (P2, adversarial, product-lens, confidence 100)

  R7 requires folder rename from encrypted to plaintext ID when the resolver completes. This introduces race handling, collision logic, conflict-skip behavior with logging, and async coordination — all for the cosmetic benefit of human-readable folder names for admins. Always using encrypted IDs as folder names eliminates all of this complexity while preserving the security properties intact. R7 and R14 could be removed or deferred to a post-MVP polish pass.

- **Problem statement lacks evidence of real user pain** — Problem Frame (P2, product-lens, confidence 75)

  The feature is motivated by multi-user deployment risk, but the document cites no incidents, user complaints, or metrics showing data leakage has ever occurred. For an internal tool, building a feature on a hypothetical risk rather than measured pain carries real opportunity cost. The problem frame should either cite concrete evidence or acknowledge the feature is hardening rather than addressing a demonstrated problem.

- **Read-only workspace access assumes no secrets in workspace files** — R4 / Success Criteria (P2, adversarial, confidence 75)

  R4 grants bot users read-only access to all workspace files outside `data/`. Workspaces commonly contain `.env` files, credentials, API keys, and proprietary source code. The document provides no justification that workspace files are safe to expose, nor does it define what constitutes "workspace documentation" versus sensitive configuration. An allowlist approach or an explicit assumption about secret management would close this gap.

- **Success criteria do not verify adversarial bypass scenarios** — Success Criteria (P2, adversarial, confidence 75)

  The four success criteria test the happy path (read own folder, write own folder, read workspace docs, testable without WeCom) but do not test the adversarial paths that motivated the feature. A Bash-expansion write to another user's folder, a symlink-based read, and a Glob error message leaking file existence could all pass the criteria while the real isolation guarantee is violated.

- **Rename race for encrypted-to-plaintext folder transition** — R7 / R14 (P2, security-lens, confidence 75)

  Renaming `data/<encrypted>` to `data/<plaintext>` while concurrent uploads are in flight creates a race window. An upload beginning with the encrypted name could target the old or new folder depending on timing. If the source folder is moved before the upload completes, the file is lost.

- **R7 rename missing general failure handling** — Access rules / Behavior on denial (P2, scope-guardian, confidence 75)

  R14 only handles the pre-existing-folder conflict case. Other rename failures — filesystem I/O errors, permission denied, concurrent upload races during rename — are silent. The encrypted folder persists while the resolver maps to the plaintext ID, creating a split-brain where some code paths use the old name and others the new name.

- **R3 auto-create trigger is underspecified** — Workspace structure → R3 (P3, scope-guardian, confidence 75)

  "The user's `data/<user>` folder is created automatically on the first bot interaction that needs it" is circular — "needs it" is not defined. Implementers need an exact trigger event, such as "on the first tool call that reads from or writes to the user's `data/<user>` folder."

---

## Sources

- Existing tool permission policy: `src/server/services/tool-permission-policy.ts`
- WeCom file storage behavior: `src/server/services/wecom-file-storage.ts`
- WeCom bot session routing: `src/server/services/wecom-bot-service.ts`
- WeCom user ID resolution: `src/server/services/wecom-user-resolver.ts`
- Tool-permission gating in chat: `src/server/services/chat-service.ts`
