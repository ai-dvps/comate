---
title: "feat: Syntax-highlight Write tool content in chat"
type: feat
status: completed
date: 2026-05-20
---

# feat: Syntax-highlight Write tool content in chat

## Summary

Replace the JSON Parameters view for `Write` tool_use blocks with a file-centric display: show the target file path and render the file content in a Shiki syntax-highlighted code block, using the file extension to infer the language.

---

## Problem Frame

When Claude uses the `Write` tool, the chat UI currently renders the tool input as generic JSON via `ToolInput`. The actual file content is shown as a JSON-escaped string inside the `"content"` field, which is hard to read and lacks syntax highlighting. The codebase already has Shiki-based highlighting (`CodeBlockContent`) and language detection (`getLanguageFromFilename`) used in `FilePanel`; the chat message rendering should leverage the same capabilities for Write tools.

---

## Scope Boundaries

### In Scope
- Write tool_use blocks in the chat message stream.
- File path display and content syntax highlighting.
- Language inference from file extension.

### Out of Scope
- Other tools (Edit, Bash, Read, etc.) remain rendered as JSON.
- Streaming Write tools: the partial JSON preview remains unchanged.
- No new syntax highlighting themes or customizations.

### Deferred to Follow-Up Work
- Streaming Write tools: add incremental syntax highlighting once partial JSON can be reliably parsed or the streaming format changes.

---

## Key Technical Decisions

- **Route Write tools at the message-list level.** `MessageList.tsx` already special-cases `Agent` tools (`SubagentBriefStatus`). Adding a Write special case there keeps tool-specific rendering logic out of the generic `ToolInput` component.
- **Reuse `FilePanel`'s `getLanguageFromFilename` and `EXT_TO_LANGUAGE` map.** Move both to a shared utility (`src/client/lib/language.ts`) so `FilePanel` and the new Write tool renderer share a single source of truth for extension-to-language mapping.
- **Use `CodeBlockContent` directly for the file body.** This reuses the existing Shiki tokenization, caching, and async loading infrastructure without duplicating rendering logic.
- **Show only file path and content for Write tools.** The JSON wrapper adds no value for this tool; displaying `file_path` as a header and `content` as a highlighted block is cleaner.

---

## Implementation Units

### U1. Extract language detection to shared utility

**Goal:** Make `getLanguageFromFilename` available to both `FilePanel` and the new Write tool renderer.

**Dependencies:** None

**Files:**
- Create: `src/client/lib/language.ts`
- Modify: `src/client/components/FilePanel.tsx`

**Approach:**
1. Move `EXT_TO_LANGUAGE` and `getLanguageFromFilename` from `FilePanel.tsx` to `src/client/lib/language.ts`.
2. Export both from the new module.
3. Update `FilePanel.tsx` to import from `src/client/lib/language.ts`.

**Patterns to follow:**
- Existing `src/client/lib/` conventions.

**Test expectation:** none — pure code relocation.

**Verification:**
- `FilePanel.tsx` compiles and continues to highlight files correctly.
- The new utility is importable from other components.

---

### U2. Create WriteToolInput component

**Goal:** Render Write tool input as a file path header plus syntax-highlighted content.

**Dependencies:** U1

**Files:**
- Create: `src/client/components/ai-elements/write-tool.tsx`

**Approach:**
1. Import `CodeBlockContent` from `./code-block` and `getLanguageFromFilename` from `../../lib/language`.
2. Define `WriteToolInputProps` with `input: unknown`.
3. Guard that `input` is an object with `file_path` and `content` string properties; fall back to rendering nothing if the shape is unexpected.
4. Render:
   - A small header showing the file path (e.g., "Writing to `src/foo.ts`").
   - `CodeBlockContent` with:
     - `code={content}`
     - `language={getLanguageFromFilename(file_path)}`
     - `showLineNumbers={true}`

**Patterns to follow:**
- `CodeBlockContent` usage from `FilePanel.tsx`.
- Tailwind styling consistent with `ToolInput` (rounded container, muted label style).

**Test scenarios:**
- **Happy path:** Write tool with `.ts` file — content highlighted as TypeScript with line numbers.
- **Happy path:** Write tool with `.json` file — content highlighted as JSON.
- **Edge case:** Write tool with unknown extension — falls back to plain text, no crash.
- **Edge case:** Missing or malformed input — component renders gracefully without throwing.

**Verification:**
- Write tool cards show a file path header and colored code tokens.
- Line numbers are visible.
- TypeScript compiles without errors.

---

### U3. Wire WriteToolInput into MessageList

**Goal:** Route completed Write tool_use parts to `WriteToolInput` instead of generic `ToolInput`.

**Dependencies:** U2

**Files:**
- Modify: `src/client/components/MessageList.tsx`

**Approach:**
1. Import `WriteToolInput` from `./ai-elements/write-tool`.
2. In the `tool_use` rendering branch, add a condition before the generic `Tool` rendering:
   - If `part.toolName === 'Write'` and state is not `input-streaming`, render a `Tool` card whose content uses `WriteToolInput` instead of `ToolInput`.
   - Keep the `ToolHeader`, `ToolContent`, `ToolOutput` (for results), and streaming preview unchanged.
   - The `ToolHeader` should still show the tool state badge.

**Patterns to follow:**
- Existing `Agent` tool special-case in the same file.
- Preserve `defaultOpen={isStreaming}` and result/output wiring.

**Test scenarios:**
- **Happy path:** Completed Write tool renders with `WriteToolInput`.
- **Integration:** Write tool with a result still shows the result below the highlighted content.
- **Integration:** Streaming Write tool still uses `StreamingToolInputPreview` until completion.

**Verification:**
- Completed Write tools show syntax-highlighted content.
- Streaming Write tools still show the JSON preview.
- Other tools (Bash, Read, etc.) continue to render as JSON.

---

## System-Wide Impact

- **Unchanged invariants:** All non-Write tools render identically. `FilePanel` highlighting behavior is unchanged.
- **Dependency:** `FilePanel` now imports language detection from a shared module instead of defining it locally.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `Write` tool name casing mismatch | Use exact string match `'Write'` (consistent with existing `'Agent'` and `'AskUserQuestion'` checks in the codebase). |
| Unknown file extensions cause Shiki to fail | `getLanguageFromFilename` falls back to the raw extension; `highlightCode` already catches loader errors and falls back to raw tokens. |
