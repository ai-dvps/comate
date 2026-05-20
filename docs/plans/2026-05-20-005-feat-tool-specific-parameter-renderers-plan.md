---
title: "feat: Tool-specific parameter renderers"
type: feat
created: 2026-05-20
status: active
---

## Problem Frame

Currently, all tool inputs render as generic JSON via `ToolInput`, regardless of the tool type. Users see raw JSON for Bash commands, Read file paths, and Edit operations — even though these have well-known schemas that could be rendered much more readably. The existing `WriteToolInput` already demonstrates the value of tool-specific rendering (file path header + syntax-highlighted code). This plan extends that pattern to the most common remaining tool types.

---

## Requirements

- If a tool input has a `description` field, use it as the header summary text
- `Bash` tool: render `command` with shell syntax highlighting (not raw JSON)
- `Read` tool: display the file path cleanly (not wrapped in JSON)
- `Edit` tool: render `old_string` / `new_string` as a diff-style view
- Fall back to generic `ToolInput` for unknown tool shapes
- Keep `WriteToolInput` and `Agent` tool behavior unchanged

---

## Scope Boundaries

### In Scope
- Update `summarizeToolInput` to prefer `description`
- Create `BashToolInput`, `ReadToolInput`, `EditToolInput` components
- Wire new renderers into `MessageList.tsx`

### Deferred for Later
- Tool-specific renderers for less common tools (e.g., `Grep`, `URLFetch`)
- Side-by-side diff view for Edit (unified diff is sufficient for now)
- Copy-to-clipboard on the Bash command

---

## Key Technical Decisions

1. **Follow the `WriteToolInput` pattern.** Each tool-specific component validates the input shape and falls back to `ToolInput` if the shape doesn't match expectations. This keeps the renderer robust against schema drift.

2. **Edit diff view: two labeled blocks, not line-by-line diff.** Computing a real line diff adds complexity for marginal UX gain. Two stacked code blocks — "Before" (old_string, red-tinted) and "After" (new_string, green-tinted) — communicate the change clearly and are simple to implement.

3. **`description` replaces the auto-generated summary, not appends to it.** When `description` is present, it's almost always the human-readable intent of the tool call. Showing both would be noisy.

---

## Implementation Units

### U1. Prefer `description` in tool header summary

**Goal:** When a tool input contains `description`, use it as the header summary instead of the auto-extracted parameter preview.

**Files:**
- `src/client/components/MessageList.tsx`

**Approach:**
- Modify `summarizeToolInput` to check for `description` first, before any other keys
- Truncate to 120 chars with ellipsis if needed
- Only fall back to the existing primary/secondary key logic when `description` is absent

**Test scenarios:**
- Tool input with `description` → summary shows description text
- Tool input with `description` > 120 chars → truncated with `…`
- Tool input without `description` → falls back to existing behavior

**Verification:**
- Tools with descriptions render human-readable summaries in the header

---

### U2. Create `BashToolInput` component

**Goal:** Render Bash tool `command` parameter with shell syntax highlighting instead of raw JSON.

**Files:**
- `src/client/components/ai-elements/bash-tool.tsx` (new)

**Approach:**
- Validate input shape: `{ command: string }`
- On match: render a clean code block with `command` as the content, language `bash`
- On mismatch: fall back to `<ToolInput input={input} />`
- Reuse `CodeBlockContent` from `code-block.tsx` for syntax highlighting
- Style: no "Parameters" header label — the command itself is self-describing

**Patterns to follow:**
- `WriteToolInput` (`src/client/components/ai-elements/write-tool.tsx`) for shape validation and fallback pattern

**Test scenarios:**
- Valid `{ command: "ls -la" }` → renders syntax-highlighted bash code block
- Invalid shape (no command) → falls back to generic `ToolInput`
- Multi-line command → renders with line numbers for readability

**Verification:**
- Bash tools display clean, highlighted shell commands

---

### U3. Create `ReadToolInput` component

**Goal:** Render Read tool `file_path` as a clean file reference, not wrapped in JSON.

**Files:**
- `src/client/components/ai-elements/read-tool.tsx` (new)

**Approach:**
- Validate input shape: `{ file_path: string }` (or `{ path: string }` as fallback)
- On match: render a minimal row with a file icon + the file path in monospace
- On mismatch: fall back to `<ToolInput input={input} />`
- No code block wrapper — the point is minimal visual weight

**Patterns to follow:**
- `WriteToolInput` for shape validation and fallback pattern

**Test scenarios:**
- Valid `{ file_path: "/foo/bar.ts" }` → shows file icon + path
- Valid `{ path: "/foo/bar.ts" }` → shows file icon + path (fallback key)
- Invalid shape → falls back to generic `ToolInput`

**Verification:**
- Read tools display as a clean file reference line

---

### U4. Create `EditToolInput` component

**Goal:** Render Edit tool parameters as a diff-style before/after view.

**Files:**
- `src/client/components/ai-elements/edit-tool.tsx` (new)

**Approach:**
- Validate input shape: `{ file_path: string, old_string: string, new_string: string }`
- On match: render:
  1. File path header (similar to WriteToolInput)
  2. "Before" section: `old_string` in a code block with red-tinted background (`bg-red-900/10`)
  3. "After" section: `new_string` in a code block with green-tinted background (`bg-green-900/10`)
- Detect language from `file_path` for syntax highlighting via `getLanguageFromFilename`
- On mismatch: fall back to `<ToolInput input={input} />`
- `replace_all` field can be shown as a small badge/tag if true

**Patterns to follow:**
- `WriteToolInput` for file path header + language detection
- `CodeBlockContent` for syntax highlighting

**Test scenarios:**
- Valid edit input → shows file path, Before (red bg), After (green bg)
- `replace_all: true` → shows a small "Replace all" indicator
- Invalid shape → falls back to generic `ToolInput`
- Empty `old_string` (insertion) → Before section shows placeholder or empty block
- Empty `new_string` (deletion) → After section shows placeholder or empty block

**Verification:**
- Edit tools render as a clear before/after diff view

---

### U5. Wire tool-specific renderers into MessageList

**Goal:** Route Bash, Read, and Edit tools to their custom renderers.

**Files:**
- `src/client/components/MessageList.tsx`

**Approach:**
- Import `BashToolInput`, `ReadToolInput`, `EditToolInput`
- In the tool rendering switch, add branches before the generic `ToolInput` fallback:
  - `part.toolName === 'Bash'` → `<BashToolInput input={part.input} />`
  - `part.toolName === 'Read'` → `<ReadToolInput input={part.input} />`
  - `part.toolName === 'Edit'` → `<EditToolInput input={part.input} />`
  - Existing `Write` branch stays
  - Existing streaming branch stays
  - Default fallback stays as `<ToolInput input={part.input} />`

**Test scenarios:**
- Bash tool → renders with `BashToolInput`
- Read tool → renders with `ReadToolInput`
- Edit tool → renders with `EditToolInput`
- Write tool → still renders with `WriteToolInput`
- Unknown tool → still renders with generic `ToolInput`
- Agent tool → still renders with `SubagentBriefStatus`

**Verification:**
- Each tool type renders with its appropriate custom renderer

---

## Deferred Implementation Notes

- The diff view for Edit is a simple before/after, not a line-by-line unified diff with `+`/`-` prefixes. A true diff algorithm could be added later if the two-block view proves insufficient for complex edits.
- `Read` tool may also accept `offset` and `limit` parameters in some contexts — these are ignored for now since the primary value is showing the file path.

---

## Risks

- **Schema drift:** If the CLI changes parameter names (e.g., `filePath` instead of `file_path`), the shape validation will fail and fall back to generic JSON rendering. The fallback behavior mitigates this.
- **Language detection accuracy:** `getLanguageFromFilename` may not detect the correct language for all file types. This affects syntax highlighting quality but not functionality.
