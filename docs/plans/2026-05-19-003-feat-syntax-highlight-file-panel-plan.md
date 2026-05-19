---
title: "feat: Syntax highlighting for opened files in FilePanel"
type: feat
status: active
date: 2026-05-19
---

# feat: Syntax highlighting for opened files in FilePanel

## Summary

Add Shiki syntax highlighting to files opened in the side-panel FilePanel by wiring the existing `CodeBlockContent` component into the panel, replacing the current plain-text rendering.

---

## Requirements

- R1. Files opened in FilePanel display syntax-highlighted content instead of plain text.
- R2. The highlighting language is inferred from the file extension.
- R3. Unknown or unsupported file extensions fall back to plain text gracefully.
- R4. Line numbers remain visible in FilePanel.

---

## Scope Boundaries

- Only FilePanel is in scope; code blocks in chat messages are already highlighted and unchanged.
- No file-editing capabilities are added.
- No new theme or color customizations; existing Shiki themes (`github-light`, `github-dark`) are used.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/FilePanel.tsx` — renders opened files with a manual line-number column and a raw `<pre>` tag.
- `src/client/components/ai-elements/code-block.tsx` — full Shiki integration. Exports `CodeBlockContent` which accepts `code`, `language`, and `showLineNumbers` props. Internally renders tokenized spans via `CodeBlockBody`.
- `highlightCode` in `code-block.tsx` falls back to `'text'` when a language is not loaded.

### External References

- [Shiki Bundled Languages](https://shiki.style/languages) — list of supported `BundledLanguage` values.

---

## Key Technical Decisions

- **Use `CodeBlockContent` with `showLineNumbers={true}` instead of reimplementing token rendering.** This keeps FilePanel consistent with chat code blocks and avoids duplicating Shiki token-span logic.
- **Add a `className` prop to `CodeBlockContent` and pass it through to `CodeBlockBody`.** FilePanel already wraps its content area in `p-4`; without this override `CodeBlockBody` adds a second layer of padding (`p-4`) which doubles the inset.
- **Map file extensions to Shiki `BundledLanguage` via a small lookup object with fallback to the extension itself, then `'text'`.** Shiki language names do not always match extensions (e.g. `.py` → `python`, `.rs` → `rust`). A lightweight mapping covers common mismatches; everything else falls back safely.

---

## Implementation Units

### U1. Extend CodeBlockContent with className prop

**Goal:** Allow consumers to override `CodeBlockBody` styling (e.g. remove padding when embedded inside another padded container).

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src/client/components/ai-elements/code-block.tsx`

**Approach:**
- Add optional `className?: string` to `CodeBlockContent`'s props interface.
- Pass `className` through to the `CodeBlockBody` component call inside `CodeBlockContent`.

**Patterns to follow:**
- Existing optional prop conventions in the same file (`showLineNumbers`).

**Test expectation:** none — pure prop plumbing.

**Verification:**
- `CodeBlockContent` accepts a `className` prop without TypeScript errors.
- Existing `CodeBlock` usage in chat messages continues to render correctly.

---

### U2. Add syntax highlighting to FilePanel

**Goal:** Replace plain-text rendering with Shiki syntax highlighting.

**Requirements:** R1, R2, R3, R4

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/FilePanel.tsx`

**Approach:**
1. Import `CodeBlockContent` from `./ai-elements/code-block`.
2. Create a small `getLanguageFromFilename(name: string): BundledLanguage` helper that:
   - Extracts the extension (lowercase).
   - Looks it up in a mapping for common mismatches (`py` → `python`, `rs` → `rust`, etc.).
   - Returns the mapped language, the raw extension, or `'text'` as fallback.
3. Replace the manual line-number column + raw `<pre>` block with `CodeBlockContent`:
   - `code={file.content}`
   - `language={getLanguageFromFilename(file.name)}`
   - `showLineNumbers={true}`
   - `className="!p-0"` (or equivalent to neutralize the inner padding since FilePanel already provides `p-4`).

**Patterns to follow:**
- FilePanel's existing header/close-button layout is preserved.
- Tailwind styling from the existing FilePanel container.

**Test scenarios:**
- **Happy path:** Open a `.ts` file — content is highlighted as TypeScript with line numbers.
- **Happy path:** Open a `.json` file — content is highlighted as JSON.
- **Edge case:** Open a file with an unknown extension (e.g. `.xyz`) — renders as plain text without errors.
- **Edge case:** Open an empty file — renders an empty highlighted block without errors.
- **Integration:** Scroll behavior remains smooth (no nested conflicting overflow containers).

**Verification:**
- FilePanel shows colored tokens for supported languages.
- Line numbers are visible and aligned.
- Unsupported files render as plain text.
- TypeScript compiles without errors.

---

## System-Wide Impact

- **Unchanged invariants:** Chat message code blocks, approval surfaces, and streaming previews continue to use `CodeBlock`/`CodeBlockContent` exactly as before.
- **API surface parity:** Not applicable — no exported public API changes.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `className` prop breaks existing `CodeBlockContent` consumers | Prop is optional; default behavior is unchanged. |
| Nested `overflow-auto` containers cause scroll jank | FilePanel's outer container handles vertical scroll; `CodeBlockContent`'s inner `overflow-auto` is sized to content and should not conflict. Verify visually. |

---

## Sources & References

- Related code: `src/client/components/FilePanel.tsx`
- Related code: `src/client/components/ai-elements/code-block.tsx`
- External docs: [Shiki Languages](https://shiki.style/languages)
