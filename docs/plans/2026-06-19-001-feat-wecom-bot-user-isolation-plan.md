---
title: "feat: Per-user file, transcript and skill isolation for WeCom bot sessions"
type: feat
date: 2026-06-19
origin: docs/brainstorms/2026-06-19-wecom-bot-user-isolation-requirements.md
---

# feat: Per-user file, transcript and skill isolation for WeCom bot sessions

## Summary

Strengthen WeCom bot session isolation without copying workspaces or changing `CLAUDE_CONFIG_DIR`. For every bot runtime we snapshot the caller's canonical WeCom user id and a workspace isolation policy, then enforce it inside the existing `canUseTool` hook:

- **File paths:** bot users can read/write only inside their own user directory; shared workspace files may be read only after passing a deny-before-allow filter that excludes credentials, env files, private keys, databases, logs, `.claude/` (session transcripts), and other users' directories.
- **Session transcripts:** all bot session JSONL remains in the shared `CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/` tree; access is blocked by path policy rather than by directory replication.
- **Bash:** denied by default; admins configure a whitelist of commands and argument patterns. Shell metacharacters are rejected and every file/path argument is re-validated by the path policy.
- **Skills:** bot users use a default restricted skill set; users on an admin list use a wider set.
- **GUI sessions are unchanged.**

## Problem Frame

See `docs/brainstorms/2026-06-19-wecom-bot-user-isolation-requirements.md`. In short: every WeCom bot session currently runs in the same workspace directory and shares a single `CLAUDE_CONFIG_DIR`. A motivated user can prompt the bot to write files anywhere in the workspace, read another user's directory, read session JSONL, or invoke any installed Skill. This plan closes those gaps in the narrowest way compatible with the existing SessionRuntime architecture.

## Requirements

Carried forward from the brainstorm. Implementation units below map to these requirements.

- **File isolation:** R1, R2, R3, R4, R5
- **Bash control:** R6, R7, R8, R9
- **Skill invocation isolation:** R10, R11, R12
- **Configuration & interaction:** R13, R14

Origin flows covered: F1 (upload file), F2 (read own file), F3 (read other user / transcript), F4 (skill denial), F5 (policy change), F6 (whitelist bash).
Origin acceptance examples covered: AE1–AE5.

## Scope Boundaries

### In scope

- Per-bot-user path policy enforced in `canUseTool` for `Read`, `Glob`, `Grep`, `Edit`, `Write`, `NotebookEdit`.
- Deny-before-allow shared-read policy for workspace files, with a fixed sensitive-path denylist.
- Protection of `.claude/` (including `CLAUDE_CONFIG_DIR/projects/`) from bot reads.
- Bash whitelist: command + argument pattern matching, shell-meta rejection, path-argument re-validation.
- Per-user Skill restriction using an admin list and two skill allowlists (default vs admin).
- Workspace settings UI for the three new policy surfaces.
- Generic denial replies that do not name the blocked path, command, or Skill.
- Snapshotting policy at runtime creation; changes apply to the next runtime (consistent with existing tool-permission behavior).

### Deferred to follow-up work

- MCP tool permission gating — same gap as the existing tool-permission feature; MCP calls pass `canUseTool` but are not categorized yet.
- OS-level sandbox/container isolation.
- GUI session isolation.
- Bidirectional sync of bot-generated files back to the original workspace.
- Audit log of policy changes.
- Runtime invalidation of cached bot sessions on policy change.

### Outside scope

- Changing GUI session permissions or approval flow.
- Changing WeCom connection, file upload, or prompt-template logic.
- Changing SDK initialization beyond the `canUseTool` branch.
- Modifying `CLAUDE_CONFIG_DIR` per user.

## Context & Research

### Relevant code and patterns

- **`canUseTool` injection point:** `src/server/services/chat-service.ts:846–873` inside `buildSdkOptions`. It currently evaluates `evaluateToolPermission(policy, toolName)` and returns allow/deny. This is the single integration point for file, Bash, and Skill checks.
- **Runtime creation / policy snapshot:** `ChatService.getOrCreateRuntime` caches by `sessionId` and builds options once. Existing tool-permission policy is already snapshotted at runtime creation (`chat-service.ts:852`). The new isolation policy will use the same snapshot semantics.
- **Bot session identity plumbing:** `WeComBotService.getOrCreateSession` stores `(workspaceId, wecomUserId, sessionId)` in `wecom_user_sessions`. `SqliteStore.getWecomUserIdBySession(workspaceId, sessionId)` returns the `wecomUserId` stored at session creation. The canonical user id for file paths is the plaintext id if a mapping exists, otherwise the encrypted id — same logic as `wecom-file-storage.ts:279–280`.
- **User directory layout:** `saveMediaFile` writes uploaded files to `workspaceFolder/<userFolderName>/<filename>` (`wecom-file-storage.ts:20`). Bot-generated files must also be constrained to this directory for writes.
- **Tool input schemas (SDK):** `node_modules/@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts`
  - `Read` / `Edit` / `Write`: `file_path: string`
  - `NotebookEdit`: `notebook_path: string`
  - `Glob`: `pattern: string`, optional `path?: string`
  - `Grep`: `pattern: string`, optional `path?: string`, optional `glob?: string`
  - `Bash`: `command: string`
  - `Skill`: not declared in `.d.ts`, but the SDK source maps `options.skills` to `allowedTools` entries `Skill` or `Skill(<name>)`; runtime `canUseTool` receives `toolName === 'Skill'` with an input object containing the skill identifier. Field name assumed `skill_name` or `name`; implementation will probe both and log the resolved field.
- **Existing permission UI precedent:** `src/client/components/PermissionsSubTab.tsx` for the tool-category Permissions tab; `SettingsPanel.tsx:1232` declares `WeComSubTab` including `'permissions'`. The new isolation surface adds a new sub-tab, e.g. `'isolation'`.
- **Workspace settings persistence:** `WorkspaceSettings` in `src/server/models/workspace.ts` is a flat JSON blob stored in `workspaces.settings` (`sqlite-store.ts:49`). No DDL migration is needed for new fields.
- **Server test pattern:** `node:test` + `node:assert`, adjacent `<name>.test.ts` files, mocks via direct singleton replacement. See `chat-service.test.ts` / `tool-permission-policy.test.ts`.

### Research findings that shape the design

1. **Skill tool name is `Skill`.** The SDK's `allowedTools` argument is constructed with literal `Skill` or `Skill(<name>)` entries, confirming the tool name passed to `canUseTool` is `'Skill'`. The input object schema is not exported; we will treat `skill_name`, `name`, and `skill` as candidate fields and fail closed if none is present.
2. **`Glob`/`Grep` output cannot be filtered in `canUseTool`.** The callback only sees input. We can reject patterns that escape the workspace, traverse to `.claude/`, target other users' directories, or contain shell-style `..`; we cannot rewrite returned file lists. This matches the requirement to validate input paths and glob expansion intent.
3. **Canonical user id is the plaintext WeCom id when available.** The resolver stores mappings in `wecom_user_id_mappings`. The file storage already uses `workspaceStore.getWecomUserMapping(wecomUserId)`; the path policy will use the same resolution so that user directories and admin lists align.
4. **Policy changes only affect the next runtime.** The existing architecture caches runtimes by session id. This is acceptable per R9 and matches the existing tool-permission behavior.

## Key Technical Decisions

- **Path policy lives in a new service, not in `chat-service.ts`.** `buildSdkOptions` already has enough responsibility. A dedicated `bot-isolation-policy.ts` (or split into `bot-path-policy.ts`, `bot-bash-policy.ts`, `bot-skill-policy.ts`) keeps the `canUseTool` callback readable and testable.
- **Deny-before-allow with a fixed denylist.** Shared workspace reads are allowed only if the resolved path is inside the workspace, outside `.claude/`, outside every user directory except the caller's, and does not match the sensitive-file denylist. This gives bot users read access to project source while blocking the obvious exfiltration targets.
- **Bash whitelist uses command + argument patterns with typed placeholders.** Each entry specifies the command basename and an ordered list of arguments. Arguments may be literal strings or placeholders (`{{user_path}}`, `{{shared_path}}`, `{{arg}}`). Placeholders keep the parser simple and make path arguments explicit. Complex shell structures (pipes, redirection, command substitution, logical operators, semicolons) are rejected before pattern matching.
- **Allowed Bash runs with a sanitized environment and cwd restricted to the workspace root.** Unless the whitelist entry explicitly opts in, the spawned command does not inherit provider/bot credentials, network is not blocked at the OS level but no network-sensitive env vars are forwarded, and stdout/stderr is returned normally. The requirement's "minimalized non-sensitive environment" is implemented by filtering env (remove `ANTHROPIC_*`, `WECOM_*`, provider keys) and setting cwd to workspace root; true network containment is deferred to OS sandboxing.
- **Skill restriction is admin-tiered with named allowlists.** Workspace settings store `wecomBotAdminUserIds`, `wecomBotDefaultAllowedSkills`, and `wecomBotAdminAllowedSkills`. Non-admin bot users get the default list; admins get the union of default + admin lists. This satisfies R11/R12 while avoiding a full per-user matrix in the first version.
- **Generic denial message reused from existing tool-permission branch.** "I can't do that in this workspace." Avoids leaking blocked resources.
- **MCP remains ungated for bot sessions.** Both the existing tool-permission feature and this plan defer MCP. The UI and docs must call this out so the isolation claim is not overstated.

## High-Level Technical Design

### Runtime policy snapshot

When `buildSdkOptions` is called with `isBotSession === true`:

1. Resolve the effective tool-permission policy (existing).
2. Look up `wecomUserId = workspaceStore.getWecomUserIdBySession(workspaceId, session.id)`. If missing, deny all file/Bash/Skill tools (identity failure = fail closed per R1/R10).
3. Resolve canonical user id: `plaintextUserId = workspaceStore.getWecomUserMapping(wecomUserId) ?? wecomUserId`.
4. Compute `userDirName = plaintextUserId ?? wecomUserId` (same as file storage).
5. Build a snapshot object:
   ```ts
   {
     workspace,
     toolPolicy,
     wecomUserId,
     canonicalUserId,
     userDirName,
     bashPolicy: workspace.settings.wecomBotBashWhitelist ?? [],
     isAdmin: workspace.settings.wecomBotAdminUserIds?.includes(canonicalUserId) ?? false,
     defaultSkills: workspace.settings.wecomBotDefaultAllowedSkills ?? [],
     adminSkills: workspace.settings.wecomBotAdminAllowedSkills ?? [],
   }
   ```
6. The `canUseTool` callback closes over this snapshot and delegates to policy functions.

### `canUseTool` decision order

```
1. Existing category permission (deny → generic reply)
2. If tool is file-class (Read/Glob/Grep/Edit/Write/NotebookEdit)
   → validate all input paths/patterns against path policy
3. If tool is Bash
   → validate command against Bash whitelist + path args against path policy
4. If tool is Skill
   → extract skill name; validate against user skill set
5. Otherwise (MCP, unknown SDK tool) → allow (today's behavior)
```

Any policy failure returns `{ behavior: 'deny', message: "I can't do that in this workspace." }`.

### Path policy rules

For a resolved absolute path `p`:

- **User containment:** `p` starts with `workspaceFolder/<userDirName>/` → allow for read or write.
- **Workspace containment:** `p` must start with `workspaceFolder/`; else deny.
- **Denylist (checked before shared-read allow):**
  - `.claude/` and all subpaths (covers config, projects/transcripts, wecom-context).
  - Other user directories: any sibling of `<userDirName>` that is a known WeCom user folder.
  - Sensitive patterns: `.env*`, `*id_rsa*`, `*.pem`, `*.key` (private keys), `*.db`, `*.sqlite*`, `*.log`.
  - Configurable workspace denylist (optional V1 addition in settings).
- **Shared read allow:** if none of the above deny and `p` is inside the workspace, allow read-only.
- **Shared write deny:** any path inside the workspace that is not the user's own directory is denied for write tools (`Edit`, `Write`, `NotebookEdit`).

For symlinks/hardlinks: resolve with `fs.realpathSync` where the target exists; for write targets, resolve the parent directory's realpath and verify the joined path remains inside the allowed root.

For `Glob`:
- If `path` is provided, it must pass workspace + denylist checks.
- `pattern` must not start with `/`, contain `..`, or match a denylisted segment when resolved.
- Absolute patterns and patterns targeting `.claude/` or other users' dirs are denied.

For `Grep`:
- `path` and `glob` filters are validated the same way.

### Bash whitelist rules

Parsing:
1. Reject if the raw command string contains any shell metacharacter: `|`, `&`, `;`, `$`, `` ` ``, `(`, `)`, `<`, `>`, `\`, `*`, `?`, `{`, `}`, `[`, `]`, `~`, `#`, `!`.
   - Exception: characters inside a single-quoted string may exist, but we still reject the command if quotes are unbalanced or if any metachar appears outside quotes. For V1 we keep parsing conservative: reject any of those characters anywhere; admins who need arguments with spaces can whitelist quoted literals.
2. Tokenize the command using a simple shell-like tokenizer that supports double/single quotes and backslash escapes. Reject unbalanced quotes or nested command substitution.
3. Command basename must match a whitelist entry's `command` exactly.
4. Number of tokens must match the entry's `args` length.
5. Each token matches:
   - literal string → exact match
   - `{{user_path}}` → resolve the token against workspace cwd; must be inside the caller's user directory
   - `{{shared_path}}` → resolve against workspace cwd; must pass shared-read path policy
   - `{{arg}}` → any non-empty token that itself contains no shell metacharacters

Execution context for allowed commands:
- cwd = workspace folder root
- env = filtered copy of `process.env` with `ANTHROPIC_*`, `WECOM_*`, provider keys, `CLAUDE_CONFIG_DIR` removed; PATH kept for command resolution
- `timeout` forwarded from input
- return stdout/stderr as normal

### Skill policy rules

1. `toolName !== 'Skill'` → skip.
2. Extract skill name from input: try `input.skill_name`, then `input.name`, then `input.skill`. If none, deny.
3. Compute allowed set:
   - If user is admin: `new Set([...defaultSkills, ...adminSkills])`
   - Else: `new Set(defaultSkills)`
4. If skill name not in allowed set → deny.

Skill names are compared case-insensitively? The vercel skill tooling uses normalized names. We'll compare using the same normalization function used by `skills-service.ts` if exported; otherwise exact match with a note to align.

## Implementation Units

### U1. Workspace settings schema & persistence

**Files:**
- `src/server/models/workspace.ts` — add `WeComBotIsolationSettings` and fields on `WorkspaceSettings`.
- `src/server/routes/workspaces.ts` — validate new fields in the PUT handler (defensive; existing wholesale merge).
- `src/client/stores/workspace-store.ts` — include new fields when sending `UpdateWorkspaceInput`.
- `src/client/components/SettingsPanel.tsx` — add fields to `WorkspaceFormState`, `buildWorkspaceFormState`, and the save spread.

**New types:**
```ts
export interface BashWhitelistEntry {
  command: string;
  args: Array<string | { type: 'user_path' | 'shared_path' | 'any'; value?: string }>;
  description?: string;
}

export interface WeComBotIsolationSettings {
  /** Canonical WeCom user ids with the wider skill set. */
  adminUserIds: string[];
  /** Skills allowed to every bot user. */
  defaultAllowedSkills: string[];
  /** Additional skills allowed only to admin users. */
  adminAllowedSkills: string[];
  /** Allowed Bash commands and argument patterns. */
  bashWhitelist: BashWhitelistEntry[];
}
```

Add to `WorkspaceSettings`:
```ts
wecomBotIsolation?: WeComBotIsolationSettings;
```

Default values when undefined: admin list empty, skill lists empty, bash whitelist empty → maximum restriction (Bash fully denied, no skills allowed). This is safe for new workspaces; existing workspaces will be grandfathered by leaving the field undefined? The brainstorm does not explicitly require grandfathering for isolation; existing bot-enabled workspaces currently allow everything. To avoid breaking production bots on upgrade, we should treat `undefined` as "allow-all for isolation" in the evaluator until an admin configures it. Document this explicitly.

**Requirements:** R13.

### U2. Bot identity & policy snapshot in ChatService

**Files:**
- `src/server/services/chat-service.ts` (`buildSdkOptions`)

**Changes:**
- After resolving the tool-permission policy, resolve the WeCom user identity:
  ```ts
  const wecomUserId = workspaceStore.getWecomUserIdBySession(workspace.id, session.id);
  const canonicalUserId = wecomUserId ? (workspaceStore.getWecomUserMapping(wecomUserId) ?? wecomUserId) : undefined;
  ```
- If `isBotSession` and `canonicalUserId` is missing, install a `canUseTool` that denies everything except maybe Reply? Actually the reply path is outside `canUseTool`. To satisfy R1/R10 identity-missing = deny tool access, deny all file/Bash/Skill tools. Unknown SDK tools and MCP still fall through to allow, but without identity we cannot safely allow file-class tools. The simplest is: if identity missing, deny every tool whose name is in a known sensitive category (fileRead/fileWrite/shell/subagents/network/Skill). Reply is not gated here.
- Build snapshot and close it over the callback.

**Requirements:** R1, R10.

### U3. Path policy engine

**New file:** `src/server/services/bot-path-policy.ts`

**Exports:**
```ts
export interface PathPolicyContext {
  workspaceFolder: string;
  userDirName: string;
  knownUserDirNames?: string[];
  extraDenyGlobs?: string[];
}

export interface PathValidationResult {
  allowed: boolean;
  reason?: 'outside-workspace' | 'outside-user-dir-write' | 'denylist' | 'other-user-dir' | 'invalid-pattern';
}

export function createPathPolicyContext(workspace: Workspace, canonicalUserId: string): PathPolicyContext;
export function validateToolInput(ctx: PathPolicyContext, toolName: string, input: Record<string, unknown>): PathValidationResult;
export function resolveAndCheckPath(ctx: PathPolicyContext, rawPath: string, opts: { write: boolean }): PathValidationResult;
export function checkGlobPattern(ctx: PathPolicyContext, pattern: string, basePath?: string): PathValidationResult;
```

**Behavior:**
- Resolve paths with `path.resolve(workspaceFolder, rawPath)`.
- For writes: target must be inside `workspaceFolder/<userDirName>/`.
- For reads: target may be inside user dir, or inside workspace and pass denylist.
- `validateToolInput` dispatches on tool name and validates `file_path`, `notebook_path`, `pattern`/`path`, `path`/`glob`.

**Sensitive denylist constants (hardcoded, documented):**
```ts
const DEFAULT_DENY_GLOBS = [
  '.claude/**',
  '.env*',
  '*id_rsa*',
  '*.pem',
  '*.key',
  '*.db',
  '*.sqlite*',
  '*.log',
];
```

**Requirements:** R2, R3, R4, R5.

### U4. Bash whitelist engine

**New file:** `src/server/services/bot-bash-policy.ts`

**Exports:**
```ts
export interface BashPolicyResult { allowed: boolean; reason?: string; sanitizedCommand?: string }
export function evaluateBash(ctx: BashPolicyContext, input: Record<string, unknown>): BashPolicyResult;
```

**Internals:**
- `hasShellMetacharacters(command): boolean`
- `tokenize(command): string[]` — supports quotes, backslash escapes; rejects unbalanced quotes.
- `matchWhitelist(command: string, tokens: string[], whitelist): BashWhitelistEntry | undefined`
- `validateTokens(ctx, entry, tokens): PathValidationResult[]`
- `buildSanitizedEnv(env): Record<string, string | undefined>`

The result returns the original input unchanged if allowed; we do not rewrite the command. The path-arg check is purely for authorization. The actual `Bash` tool execution uses the original command, which by construction only references allowed paths.

**Requirements:** R6, R7, R8.

### U5. Skill policy engine

**New file:** `src/server/services/bot-skill-policy.ts`

**Exports:**
```ts
export function evaluateSkill(ctx: SkillPolicyContext, toolName: string, input: Record<string, unknown>): { allowed: boolean; skillName?: string };
```

**Internals:**
- If `toolName !== 'Skill'` return `{ allowed: true }`.
- Extract skill name: `input.skill_name ?? input.name ?? input.skill`.
- Normalize skill name using the same function as the skills service if available.
- Compute allowed set based on admin flag.

**Requirements:** R10, R11, R12.

### U6. `canUseTool` integration

**File:** `src/server/services/chat-service.ts`

**Changes inside the `isBotSession` branch:**
```ts
const snapshot = buildIsolationSnapshot(workspace, session);
options.canUseTool = async (toolName, input) => {
  const categoryDecision = evaluateToolPermission(snapshot.toolPolicy, toolName);
  if (categoryDecision === 'deny') {
    return { behavior: 'deny', message: "I can't do that in this workspace." };
  }

  if (isFileTool(toolName)) {
    const r = validateToolInput(snapshot.pathContext, toolName, input);
    if (!r.allowed) return { behavior: 'deny', message: "I can't do that in this workspace." };
  }

  if (toolName === 'Bash') {
    const r = evaluateBash(snapshot.bashContext, input);
    if (!r.allowed) return { behavior: 'deny', message: "I can't do that in this workspace." };
  }

  if (toolName === 'Skill') {
    const r = evaluateSkill(snapshot.skillContext, toolName, input);
    if (!r.allowed) return { behavior: 'deny', message: "I can't do that in this workspace." };
  }

  return { behavior: 'allow', updatedInput: input };
};
```

If the snapshot cannot be built (e.g. identity missing), the callback denies file/Bash/Skill tools and allows others.

**Requirements:** R1, R5, R6, R8, R10, R14.

### U7. Settings UI

**Files:**
- `src/client/components/IsolationSubTab.tsx` — new component
- `src/client/components/SettingsPanel.tsx` — register sub-tab, pass form state
- `src/client/i18n/en/settings.json` and `zh-CN/settings.json` — new keys

**Component sections:**
1. **Skill admin list:** textarea or tag input for canonical WeCom user ids; help text explains ids can be plaintext or encrypted (resolved at runtime).
2. **Default allowed skills:** tag input for skill names allowed to every bot user.
3. **Admin allowed skills:** tag input for skill names allowed only to admins.
4. **Bash whitelist:** list editor. Each row has:
   - command basename
   - args pattern (space-separated; placeholders rendered as chips or badges)
   - description
   - add/remove buttons
   Help text with examples: `python {{user_path}}`.

**Validation on save:**
- Bash whitelist entries must have non-empty `command` and `args`.
- Placeholders must be one of the known types.
- Skill names cannot contain path separators or shell metacharacters.
- Show a warning if default/admin skill lists are empty (bot cannot use any Skill).

**Requirements:** R13.

### U8. Tests

**New test files:**
- `src/server/services/bot-path-policy.test.ts`
- `src/server/services/bot-bash-policy.test.ts`
- `src/server/services/bot-skill-policy.test.ts`

**Coverage:**
- Path policy:
  - user can read/write inside own dir
  - user cannot read/write another user's dir
  - user cannot read `.claude/projects/`
  - user can read shared source files
  - user cannot read `.env`, `.pem`, `.db`, `.log`
  - symlinks escaping user dir are rejected
  - write to shared workspace root is rejected
  - `Glob`/`Grep` patterns with `..` or absolute paths are rejected
- Bash policy:
  - empty whitelist denies everything
  - allowed literal command passes
  - command with shell metacharacter denied
  - `python {{user_path}}` passes for user file, fails for shared file
  - `cat userB/file.txt` denied (command not whitelisted)
  - unbalanced quotes denied
- Skill policy:
  - non-admin allowed only default skills
  - admin allowed default + admin skills
  - unknown Skill input field denied
- Integration: extend `chat-service.test.ts` to assert that `canUseTool` denies cross-user reads and unlisted skills for bot sessions.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| MCP tools remain ungated and could read files or transcripts. | Explicitly call out in scope boundaries and UI copy. Do not claim full isolation when MCP servers are enabled. |
| Bash whitelist cannot enforce isolation *inside* the allowed process (e.g. `python` can open arbitrary files). | Keep allowlists extremely narrow; only permit commands the admin trusts. Document that this is an administrative trust boundary, not a kernel sandbox. |
| Shared workspace reads expose project files to untrusted bot users. | UI warns that bot users can read non-sensitive project files. Default denylist covers common secrets. Admins can extend denylist. |
| Transcript isolation relies entirely on `canUseTool` gating every file-like access to `.claude/`. | Deny `.claude/**` at the path policy layer. Monitor SDK updates for new file tools and add them to `isFileTool`. |
| Policy revocation does not affect running bot runtimes. | Document in UI: changes apply to next conversation. Idle-close already recycles runtimes eventually. |
| Skill restriction is binary (admin/default), not per-user per-skill. | Satisfies R11/R12. Document as V1; per-user per-skill allowlists are a follow-up. |
| Unknown Skill input field name could cause false denials. | Probe multiple candidate fields; log the resolved field at debug level; fail closed. |
| Canonical user id changes when WeCom resolver maps encrypted → plaintext, changing the user directory. | Existing files under the encrypted id remain accessible because the directory name is computed the same way at runtime as at upload time. Old and new directories are not merged; this matches today's behavior. |

## Acceptance Criteria

- [ ] User A's bot session cannot `Read` files in `userB/`.
- [ ] User A cannot `Read` or `Glob` `.claude/projects/`.
- [ ] User A can `Write` to `userA/summary.md` but not to `src/main.ts`.
- [ ] A non-admin bot user cannot invoke a Skill outside the default allowlist; an admin can invoke skills in the admin allowlist.
- [ ] An allowed `python {{user_path}}` command succeeds; the same command targeting `userB/file.txt` is denied.
- [ ] A Bash command containing `|` or `;` is denied even if the command name is whitelisted.
- [ ] GUI sessions are unaffected by the new restrictions.
- [ ] Denial replies do not contain the blocked path, command, or Skill name.
- [ ] Settings changes are persisted and survive app restart.

## Dependencies / Assumptions

- SDK `canUseTool` fires for every built-in tool, Bash, Skill, and MCP invocation.
- Skill invocation tool name is `'Skill'` and the input carries a skill name in `skill_name`, `name`, or `skill`.
- The workspace folder path is trustworthy (admins configure it).
- WeCom user id mapping resolution is asynchronous; the snapshot uses the mapping available at runtime creation.
- The existing runtime cache means policy changes apply to the next session, not the current one.
