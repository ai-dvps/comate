---
title: Edit Tool Unified Diff - Plan
type: refactor
date: 2026-08-10
origin: docs/brainstorms/2026-05-22-tool-input-rendering-requirements.md
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Edit Tool Unified Diff - Plan

## Goal Capsule

- **Objective:** Replace the Edit tool's separate Before and After code blocks with one read-only unified diff.
- **Product authority:** The confirmed session scope governs the diff shape and edge cases. The legacy tool-input-rendering requirements remain background for the shared renderer contract.
- **Execution profile:** One localized client-renderer change with focused component tests.
- **Stop conditions:** Stop if the Edit tool input lacks enough information to render additions and deletions without inventing file positions, or if the shared tool renderer path does not reach both approval and chat surfaces as documented.
- **Tail ownership:** The implementer owns the renderer update, regression coverage, cleanup, and repository verification gates.

## Product Contract

### Summary

The Edit tool will present `old_string` and `new_string` as one compact unified diff. The existing file header and Replace all badge remain unchanged.

### Problem Frame

The current renderer places the old and new snippets in separate labeled blocks. Users must compare the blocks mentally, which makes even small edits slower to scan than a conventional diff.

### Requirements

- R1. A normal Edit tool input renders one read-only unified diff with deleted and inserted lines visually distinguished.
- R2. The renderer preserves the Editing label, clickable file path, syntax-aware code presentation, and conditional Replace all badge.
- R3. An empty `old_string` renders the non-empty `new_string` as a pure addition.
- R4. An empty `new_string` renders the non-empty `old_string` as a pure deletion.
- R5. When both strings are empty, the renderer keeps the Edit metadata header and omits an empty diff surface.
- R6. The renderer continues to return `null` for inputs that do not provide string values for `file_path`, `old_string`, and `new_string`.

### Key Decisions

- **Unified diff is the only Edit tool diff mode.** (session-settled: user-directed — chosen over side-by-side and word-level highlighting: the single-column shape stays readable in the chat surface.) Governs R1, R3, and R4.

### Acceptance Examples

- AE1. **Covers R1 and R2.** Given non-empty old and new snippets, when the Edit tool card renders, then one diff surface shows both deletions and additions while the file metadata remains visible.
- AE2. **Covers R3.** Given an empty old snippet and a non-empty new snippet, when the card renders, then the diff contains additions without a separate After section.
- AE3. **Covers R4.** Given a non-empty old snippet and an empty new snippet, when the card renders, then the diff contains deletions without a separate Before section.
- AE4. **Covers R5.** Given two empty snippets, when the card renders, then the metadata header remains and no blank editor is mounted.

### Scope Boundaries

- **In scope:** The Edit renderer's expanded tool-input body and its focused regression tests.
- **Deferred to follow-up work:** A reusable compact diff component if another tool renderer later needs the same embedded presentation.
- **Out of scope:** Side-by-side mode, a mode toggle, word-level highlighting, tool output rendering, protocol changes, and broader refactoring of the full-file diff panel.

## Planning Contract

### Key Technical Decisions

- KTD1. **Reuse the existing CodeMirror unified merge extension.** Render `new_string` as the modified document and pass `old_string` as the extension's original document. Use the same change highlighting, gutter, deletion syntax highlighting, and disabled merge controls as the full-file diff viewer. Governs R1, R3, and R4.
- KTD2. **Keep the compact diff local to the Edit renderer.** Reuse `CodeMirrorEditor` and the established merge configuration without embedding the full `CodeMirrorDiffViewer`, whose file-tab header, mode state, width threshold, and full-height layout do not fit a tool card. Governs R1 and R2.
- KTD3. **Do not synthesize Git hunk coordinates.** Edit inputs contain replacement snippets but no source offsets, so the renderer must not display fabricated `@@` ranges or pretend its snippet line numbers are file line numbers. Governs R1.

### Existing Patterns and Constraints

- `src/client/components/CodeMirrorDiffViewer.tsx:49-60` defines the existing unified merge configuration to mirror.
- `src/client/components/CodeMirrorEditor.tsx:18-55` provides read-only CodeMirror rendering, theme integration, line numbers, language support, and extension composition.
- `src/client/components/tool-renderers/renderers/EditRenderer.tsx:32-74` owns the current metadata header and separate Before and After blocks.
- `src/client/components/tool-renderers/renderers/EditRenderer.test.tsx:21-52` establishes the focused renderer test harness and protects file-path and Replace all behavior.
- `docs/brainstorms/2026-05-22-tool-input-rendering-requirements.md:24-46` requires approval and chat to share the same registry renderer.

### Sequencing

Implement the renderer and its regression tests as one atomic unit. No dependency, schema, server, localization, or migration work is required.

## Implementation Units

### U1. Replace the split Edit display with a unified diff

- **Goal:** Deliver the confirmed compact unified diff behavior and preserve existing Edit metadata interactions.
- **Requirements:** R1-R6 and AE1-AE4.
- **Dependencies:** None.
- **Files:**
  - Modify `src/client/components/tool-renderers/renderers/EditRenderer.tsx`.
  - Modify `src/client/components/tool-renderers/renderers/EditRenderer.test.tsx`.
- **Approach:**
  1. Replace the Pencil icons, Before and After labels, and two `CodeBlockContent` instances with a small renderable component that accepts the old snippet, new snippet, and filename-derived CodeMirror language.
  2. Memoize the unified merge extension from `old_string` and mount one read-only `CodeMirrorEditor` whose value is `new_string`, following KTD1.
  3. Preserve the existing outer spacing, metadata header, file-path behavior, Replace all badge, rounded clipping, and horizontal overflow behavior.
  4. Mount the diff only when at least one snippet is non-empty, per R5.
  5. Keep input validation and tool registration unchanged, per R6.
- **Patterns to follow:** Mirror the unified branch in `src/client/components/CodeMirrorDiffViewer.tsx` and the provider-based renderer tests already in `src/client/components/tool-renderers/renderers/EditRenderer.test.tsx`.
- **Test scenarios:**
  1. Covers AE1. Render different non-empty snippets and verify a single read-only diff receives the new snippet as its value and the old snippet as its original document; verify Before and After labels are absent.
  2. Covers AE2. Render an empty old snippet and non-empty new snippet and verify the diff mounts as an addition-only comparison.
  3. Covers AE3. Render a non-empty old snippet and empty new snippet and verify the diff mounts as a deletion-only comparison.
  4. Covers AE4. Render two empty snippets and verify the metadata header remains while no CodeMirror diff mounts.
  5. Preserve the existing clickable relative path behavior and Replace all badge assertions.
  6. Pass a malformed input and verify the registry renderer returns no content.
- **Verification:** The focused tests prove prop wiring, conditional mounting, and metadata preservation. Type checking proves the CodeMirror extension and language types compose correctly.

## Verification Contract

| Gate | Command | Done signal |
|---|---|---|
| Focused renderer tests | `npm run test:client -- src/client/components/tool-renderers/renderers/EditRenderer.test.tsx` | All Edit renderer scenarios pass. |
| Client type safety | `npm run typecheck` | No TypeScript errors in the renderer or test mocks. |
| Repository quality gate | `npm run check` | Lint, type checks, and all test suites pass before landing. |

Manual review should confirm the unified diff remains readable at the narrow width used by chat tool cards in both light and dark themes.

## Definition of Done

- The Edit tool displays one unified diff for replacements, additions, and deletions.
- The file path, Editing label, and Replace all badge retain their current behavior.
- Empty and malformed inputs follow R5 and R6 without blank or broken editor surfaces.
- Focused tests cover AE1-AE4 and the existing metadata interactions.
- The repository verification gates pass.
- No unused imports, obsolete Before/After markup, or abandoned experimental diff code remains.
