---
date: 2026-05-24
topic: workspace-path-git-status
---

# Workspace Path and Git Status Display

## Summary

Add the active workspace's folder path and current git checkout ref to the left side of the TokenUsageBar. Information refreshes when the workspace becomes active.

## Problem Frame

Users currently have no visual confirmation of which workspace folder is active or what git branch they are on. The workspace name alone may not disambiguate when multiple workspaces point to related directories, and git context is invisible unless the user checks outside the app.

## Requirements

- R1. When a workspace is active, display its `folderPath` in the status bar.
- R2. If the workspace folder is a git repository, also display the current checkout ref: branch name, tag name, or short SHA (in that priority order).
- R3. Place the path and git info on the left side of the existing `TokenUsageBar`.
- R4. Truncate long paths with an ellipsis; the full path is revealed on hover via a native browser `title` tooltip.
- R5. If the folder is not a git repository, show only the path with no git section.
- R6. Fetch git info once when the workspace becomes active; do not poll for changes.

## Acceptance Examples

- AE1. **Covers R1, R2, R3.** Given workspace `/Users/alice/projects/api-gateway` on branch `feature/auth`, when the workspace is active, the TokenUsageBar left side shows `/Users/alice/projects/api-gateway` and `feature/auth`.
- AE2. **Covers R2.** Given a detached-HEAD checkout at `a1b2c3d`, when the workspace is active, the status bar shows `a1b2c3d` instead of a branch name.
- AE3. **Covers R4.** Given a path longer than the available horizontal space, the displayed path is truncated with `…` and hovering reveals the full path.
- AE4. **Covers R5, R6.** Given a workspace folder that is not a git repo, when the workspace is active, only the path is shown and no git request is made.

## Success Criteria

- A user can glance at the bottom of the chat panel and know both the active workspace path and git branch without leaving the app.
- Planning can implement this by modifying `TokenUsageBar` and adding a lightweight backend endpoint (or reusing session-level git discovery) without inventing UI placement or behavior.

## Scope Boundaries

- Git status details beyond the current checkout ref (dirty file count, staged changes, ahead/behind) are excluded.
- Interactive git operations (branch switching, commit, push) from the UI are excluded.
- Live polling or file-system watching to detect git changes is excluded; info is snapshot on workspace activation.

## Key Decisions

- **Placement: left side of TokenUsageBar** — The TokenUsageBar already serves as the app's status bar. Adding workspace context to its left side keeps all bottom-of-panel status in one place without introducing new UI chrome.
- **Git ref priority: branch > tag > short SHA** — Matches standard developer expectations. The most human-readable identifier is preferred.

## Dependencies / Assumptions

- The app already knows each workspace's `folderPath` from the workspace store.
- A lightweight git command (`git symbolic-ref`, `git describe`, or `git rev-parse`) can be run from the backend to resolve the checkout ref; no new git library dependency is required.
- The TokenUsageBar has sufficient horizontal space on the left side on typical window widths.
