---
title: Workspace Path and Git Status Display
type: feat
status: active
date: 2026-05-24
origin: docs/brainstorms/2026-05-24-workspace-path-git-status-requirements.md
---

# Workspace Path and Git Status Display

## Summary

Add a lightweight backend endpoint to resolve a workspace's current git checkout ref, then display the workspace folder path and git ref on the left side of the existing TokenUsageBar.

## Requirements

- R1. When a workspace is active, display its `folderPath` in the status bar.
- R2. If the workspace folder is a git repository, also display the current checkout ref: branch name, tag name, or short SHA (in that priority order).
- R3. Place the path and git info on the left side of the existing `TokenUsageBar`.
- R4. Truncate long paths with an ellipsis; the full path is revealed on hover via a native browser `title` tooltip.
- R5. If the folder is not a git repository, show only the path with no git section.
- R6. Fetch git info once when the workspace becomes active; do not poll for changes.

**Origin acceptance examples:** AE1 (covers R1, R2, R3), AE2 (covers R2), AE3 (covers R4), AE4 (covers R5, R6)

## Scope Boundaries

- Git status details beyond the current checkout ref (dirty file count, staged changes, ahead/behind) are excluded.
- Interactive git operations from the UI are excluded.
- Live polling or file-system watching to detect git changes is excluded.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/TokenUsageBar.tsx` — existing status bar component that reads from `chat-store` and `workspace-store`; styled with `text-[11px] text-text-tertiary whitespace-nowrap shrink-0`.
- `src/server/routes/workspace-commands.ts` — pattern for workspace-scoped Express routes using `Router({ mergeParams: true })` and `store` from `sqlite-store`.
- `src/server/index.ts` — where routes are mounted.
- `src/server/index.ts:58` — existing `execSync` usage for health check; `child_process` is already available.
- `src/client/i18n/en/chat.json` and `src/client/i18n/zh-CN/chat.json` — existing i18n keys under `chat` namespace; TokenUsageBar already uses `useTranslation('chat')`.

### Institutional Learnings

- SSE stream clean-close retry logic exists in `chat-store.ts` — not directly relevant, but confirms the store pattern for data fetching.
- Commit plan and brainstorm files alongside code changes.

## Key Technical Decisions

- **On-demand endpoint over stored field:** A `GET /api/workspaces/:id/git-ref` endpoint avoids DB schema changes and stale data. The frontend fetches when `workspaceId` changes.
- **Git ref resolution chain:** `git symbolic-ref --short HEAD` → `git describe --tags --exact-match` → `git rev-parse --short HEAD`, run via `execSync` with `cwd: folderPath` and a short timeout. This matches the existing backend shell execution pattern and requires no new dependencies.
- **No icon for git ref:** The TokenUsageBar is space-constrained. A plain text ref next to the path keeps the left side compact.

## Implementation Units

### U1. Backend Git-Ref Endpoint

**Goal:** Add an Express route that returns the current git checkout ref for a workspace.

**Requirements:** R2, R5, R6

**Dependencies:** None

**Files:**
- Create: `src/server/routes/git-status.ts`
- Modify: `src/server/index.ts`

**Approach:**
- Create a new route file following the workspace-scoped pattern (`Router({ mergeParams: true })`).
- Look up the workspace by ID via `store.get()`.
- Run the git command chain with `execSync`, `cwd` set to `workspace.folderPath`, `stdio: 'pipe'`, `timeout: 5000`, and `encoding: 'utf-8'`.
- If any step fails or the folder is not a git repo, return `{ ref: null }`.
- On success, return `{ ref: string }`.
- Mount the route at `/api/workspaces/:id/git-ref` in `src/server/index.ts`.

**Patterns to follow:**
- `src/server/routes/workspace-commands.ts` for route structure and error handling.
- `src/server/index.ts:58` for `execSync` usage pattern.

**Test scenarios:**
- Happy path: Workspace folder is a git repo on a branch. Endpoint returns `{ ref: "main" }`.
- Happy path: Workspace folder is on an exact tag. Endpoint returns `{ ref: "v1.0.0" }`.
- Edge case: Workspace folder is in detached HEAD. Endpoint returns `{ ref: "a1b2c3d" }` (short SHA).
- Edge case: Workspace folder is not a git repo. Endpoint returns `{ ref: null }`.
- Error path: Git command throws. Endpoint returns `{ ref: null }` with 200 (graceful degradation, not an error).
- Error path: Workspace ID does not exist. Endpoint returns 404.

**Verification:**
- `curl /api/workspaces/:id/git-ref` returns the correct ref for a git workspace and `null` for a non-git workspace.

### U2. Frontend TokenUsageBar Display

**Goal:** Display the workspace folder path and git ref on the left side of the TokenUsageBar.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/TokenUsageBar.tsx`
- Modify: `src/client/i18n/en/chat.json`
- Modify: `src/client/i18n/zh-CN/chat.json`

**Approach:**
- Add local component state for `gitRef` (string | null).
- Add a `useEffect` that fetches `/api/workspaces/${workspaceId}/git-ref` when `workspaceId` changes, and updates state.
- On the left side of the TokenUsageBar flex container, render:
  - The workspace `folderPath` (truncated with `truncate max-w-[...]`, full path in `title` attribute).
  - If `gitRef` is present, render it next to the path with a separator.
- Use existing styling classes: `text-[11px] text-text-tertiary whitespace-nowrap shrink-0`.
- Add i18n keys for any new labels (e.g., separator or tooltip prefix) to both `en/chat.json` and `zh-CN/chat.json`.

**Patterns to follow:**
- Existing TokenUsageBar styling and store access patterns.
- Existing i18n namespace conventions (`chat`).

**Test scenarios:**
- Happy path: Active workspace has a git branch. TokenUsageBar left side shows path and branch name.
- Edge case: Active workspace is not a git repo. Only the path is shown.
- Edge case: Path exceeds available width. Displayed path is truncated; hovering shows full path in native tooltip.
- Edge case: Switching workspaces updates the displayed path and git ref.
- Error path: Git-ref endpoint returns `null`. Git ref section is hidden.

**Verification:**
- Open a git-initialized workspace. The TokenUsageBar shows the folder path and current branch.
- Open a non-git workspace. Only the path is shown.
- Resize the window to a narrow width. The path truncates gracefully.

## System-Wide Impact

- **Unchanged invariants:** The existing token usage display on the right side of TokenUsageBar is untouched. The workspace store and chat store are read-only for this change. No SSE streams or session runtimes are affected.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Git command execution on Windows | `execSync` with `cwd` is cross-platform in Node.js; the git CLI is the only dependency. |
| TokenUsageBar horizontal overflow on small windows | Path truncation with `truncate` and `max-w` prevents overflow; git ref is omitted before path if space is critically tight. |
| Stale git ref after branch switch outside the app | Accepted per scope boundary (R6: no polling). The ref refreshes on workspace re-activation. |
