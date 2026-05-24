---
title: Commit plan and brainstorm files alongside code changes
date: 2026-05-24
category: conventions
module: git workflow
problem_type: convention
component: development_workflow
severity: low
applies_when:
  - "Committing code changes that were guided by a plan or brainstorm doc"
  - "A feature branch includes both implementation code and planning docs"
tags:
  - git
  - workflow
  - documentation
  - conventions
---

# Commit plan and brainstorm files alongside code changes

## Context

This project uses `docs/plans/` and `docs/brainstorms/` to capture requirements, technical decisions, and implementation strategies before coding begins. These documents are valuable context for reviewers, future maintainers, and team members onboarding to a feature. However, it is easy to focus on the code changes and forget to include the planning documents in the same commit or branch, leaving the documentation out of sync with the implementation or entirely absent from the repository.

## Guidance

When committing code changes that were driven by a plan or brainstorm document, **stage and commit the related planning documents in the same commit (or a closely related commit on the same branch)**.

Specifically:

1. **Check for related docs before committing.** Before running `git add` on code files, scan `docs/plans/` and `docs/brainstorms/` for documents tied to the current work. If a plan doc exists and its status is still `active`, update it to `completed` (or the appropriate final status) before committing.
2. **Commit planning docs with the implementation.** Include the plan and brainstorm files in the same commit as the code, or in a dedicated `chore(docs): ...` commit immediately before or after the implementation commit.
3. **Do not leave planning docs untracked.** Untracked plan files on a feature branch are invisible to reviewers and will not survive branch cleanup.
4. **Push planning docs with the branch.** Ensure the planning documents are part of the branch that gets pushed for PR review so reviewers can trace decisions back to requirements.

## Why This Matters

- **Reviewability:** Reviewers need requirements and technical rationale to evaluate whether the implementation matches intent. A PR with code but no plan forces reviewers to reverse-engineer the requirements from the diff.
- **Traceability:** Plans capture *why* a decision was made. When the code is revisited months later, the plan explains constraints and rejected alternatives that are not obvious from the code alone.
- **Consistency:** Committed plans become the single source of truth. If plans live only in working trees or session memory, different team members will operate from divergent understandings.
- **Onboarding:** New contributors can read committed plans to understand the architecture and decisions behind a feature without needing to ask the original author.

## When to Apply

- Any feature branch that was created after a `ce-plan` or `ce-brainstorm` session
- Any bug fix that references a plan document (e.g., `docs/plans/2026-05-24-006-fix-code-block-chat-font-size-plan.md`)
- Any refactor or migration with an associated technical design document

## Examples

### Good

A feature branch for configurable font size includes:

```
feat/configurable-font-size
├── docs/brainstorms/2026-05-24-configurable-chat-font-size-requirements.md
├── docs/plans/2026-05-24-004-feat-configurable-font-size-plan.md
├── docs/plans/2026-05-24-006-fix-code-block-chat-font-size-plan.md
├── src/client/components/ai-elements/code-block.tsx
├── src/client/components/MessageList.tsx
└── src/client/components/VirtualizedMessageList.tsx
```

All planning documents are committed alongside the implementation.

### Bad

The same branch only commits the code files:

```
feat/configurable-font-size
├── src/client/components/ai-elements/code-block.tsx
├── src/client/components/MessageList.tsx
└── src/client/components/VirtualizedMessageList.tsx
```

The plan and brainstorm files remain untracked in the working tree. If the branch is deleted or the working tree is cleaned, the rationale behind the changes is lost.

## Related

- Related workflow: `ce-plan` (create technical plan), `ce-brainstorm` (capture requirements), `ce-compound` (document learnings)
