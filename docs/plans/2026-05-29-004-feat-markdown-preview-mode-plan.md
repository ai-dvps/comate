---
title: Markdown Preview Mode for File Panel
type: feat
status: completed
date: 2026-05-29
origin: docs/brainstorms/2026-05-29-markdown-preview-mode-requirements.md
---

# Markdown Preview Mode for File Panel

## Summary

When a markdown file is opened in the file panel, render its content as formatted preview using the existing `streamdown` dependency. All other file types continue to display in the existing syntax-highlighted code view via `CodeBlockContent`.

---

## Problem Frame

Markdown files are meant to be read as rendered documents, not raw source. Currently, opening a `.md` file in the file panel shows raw markdown syntax (`# Heading`, `[text](url)`, etc.), which is harder to read than a formatted preview. This creates friction when browsing documentation, READMEs, or notes within the workspace.

(see origin: docs/brainstorms/2026-05-29-markdown-preview-mode-requirements.md)

---

## Requirements

- R1. Files with `.md` or `.markdown` extension render in preview mode instead of code view
- R2. Preview mode displays formatted markdown (headings, paragraphs, lists, links, code blocks, bold/italic)
- R3. Non-markdown files continue to render in the existing syntax-highlighted code view
- R4. The active tab indicator, file name display, and close button behavior remain unchanged regardless of render mode
- R5. Markdown preview styling matches the application's existing dark/light theme

**Origin requirements:** R1–R5 (see origin doc)
**Origin acceptance examples:** Opening `README.md` shows formatted headings and links; opening `package.json` continues to show syntax-highlighted JSON

---

## Scope Boundaries

- No source/preview toggle for v1 — markdown files always render as preview
- No markdown editing in the file panel
- No custom CSS or theme injection beyond matching the app theme
- No table of contents or outline sidebar
- No support for rendering remote images (local workspace images are acceptable)
- Changes to the file search, tab behavior, or sidebar are not included

### Deferred to Follow-Up Work

- Source/preview toggle button for markdown files
- Support for additional markdown flavors or plugins (GFM task lists, mermaid diagrams, math blocks)

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/FilePanel.tsx` — Tabbed file panel with conditional content rendering. Currently always renders `CodeBlockContent`. Content area is `flex-1 overflow-auto`.
- `src/client/components/ai-elements/message.tsx` — `MessageResponse` wraps `Streamdown` with Tailwind arbitrary-variant overrides for lists, headings, and margins (`[&_ul]:list-disc`, `[&_h1]:text-[1.875em]`, etc.). Demonstrates the project's established pattern for styling Streamdown output.
- `src/client/components/ai-elements/code-block.tsx` — `CodeBlockContent` component used for syntax-highlighted file display via Shiki.
- `src/client/hooks/use-theme.ts` — Theme system toggles `dark` class on `document.documentElement`; Tailwind dark-mode classes respond automatically.

### External Dependencies

- `streamdown` v1.0.0 (already in `package.json` dependencies) — React markdown renderer with Shiki syntax highlighting support. Used throughout the chat UI for assistant message rendering.

### Institutional Learnings

- Commit planning docs alongside code changes and update plan status to `completed` before committing.
- Tailwind arbitrary variants (`[&_element]:property`) are the project's preferred mechanism for styling rendered markup children without global CSS.

---

## Key Technical Decisions

- **Reuse `streamdown` instead of adding a new dependency:** `streamdown` is already a project dependency, battle-tested in the chat UI, and supports Shiki syntax highlighting for code blocks within markdown. Adding `react-markdown` or `marked` would increase bundle size and introduce a second markdown rendering stack with divergent styling behavior.
- **Create a dedicated `MarkdownPreview` wrapper component:** Rather than inlining Streamdown with Tailwind overrides inside `FilePanel`, a dedicated component encapsulates the document-oriented styling (headings, paragraphs, spacing, links) and keeps `FilePanel` focused on layout/tab logic. This mirrors how `MessageResponse` encapsulates chat-oriented styling.
- **Document-oriented styling differs from chat-oriented styling:** Chat messages use compact spacing (`[&>*:first-child]:mt-0`) because they sit in a scrollback stream. Document preview needs comfortable reading margins (`px-6 py-4`, proper heading margins, paragraph spacing). The `MarkdownPreview` wrapper uses its own Tailwind variant set rather than reusing `MessageResponse`.
- **Extension detection in `FilePanel`, not `MarkdownPreview`:** `FilePanel` decides whether to render `MarkdownPreview` or `CodeBlockContent` based on the active file's extension. `MarkdownPreview` is a pure rendering component and remains agnostic about when it is used.

---

## Open Questions

### Resolved During Planning

- **Which markdown library?** Use existing `streamdown` dependency.
- **Where to place the new component?** `src/client/components/MarkdownPreview.tsx` — alongside other top-level components, not in `ai-elements/` since it is not AI-specific.
- **Should markdown preview and code view share a scroll container?** Yes — both render inside the same `flex-1 overflow-auto` div in `FilePanel`. This prevents layout shifts when switching tabs.

### Deferred to Implementation

- **Exact color tokens for links and blockquotes:** Use existing Tailwind theme tokens (`text-accent`, `border-border`, `bg-surface-hover`). Minor visual tuning during implementation if contrast is insufficient.

---

## Implementation Units

### U1. Create MarkdownPreview component

**Goal:** Build a reusable component that renders markdown source as formatted HTML using `Streamdown`, with document-appropriate Tailwind styling for dark/light theme compatibility.

**Requirements:** R2, R5

**Dependencies:** None

**Files:**
- Create: `src/client/components/MarkdownPreview.tsx`

**Approach:**
- Import `Streamdown` from `'streamdown'`.
- Accept props: `content: string` (the markdown source).
- Render a wrapper `div` with:
  - `className="size-full px-6 py-4 text-text-primary prose prose-invert max-w-none"` or equivalent Tailwind arbitrary variants
  - Document-oriented overrides:
    - Headings: `[&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:mb-4 [&_h1]:mt-6`, `[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mb-3 [&_h2]:mt-5`, etc.
    - Paragraphs: `[&_p]:mb-3 [&_p]:leading-relaxed`
    - Lists: `[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mb-3`, `[&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:mb-3`
    - Links: `[&_a]:text-accent [&_a]:underline hover:[&_a]:opacity-80`
    - Code (inline): `[&_code]:bg-surface-hover [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm`
    - Code blocks: `[&_pre]:bg-surface-hover [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:mb-3 [&_pre]:overflow-auto` — Streamdown handles Shiki highlighting inside `pre`
    - Blockquotes: `[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-text-secondary [&_blockquote]:mb-3`
    - Horizontal rules: `[&_hr]:border-border [&_hr]:my-4`
    - Images: `[&_img]:max-w-full [&_img]:rounded-lg`
  - No animation props needed (unlike chat messages).

**Patterns to follow:**
- `src/client/components/ai-elements/message.tsx` — `MessageResponse` Streamdown wrapping pattern and arbitrary-variant syntax.
- `src/client/hooks/use-theme.ts` — Theme is class-based (`dark` on root); Streamdown output inherits parent text colors automatically.

**Test scenarios:**
- Happy path: Markdown with headings, paragraphs, lists, links, code blocks, and bold/italic renders with correct formatting and spacing.
- Happy path: Inline code spans have subtle background and rounded corners.
- Happy path: Code blocks inside markdown have Shiki syntax highlighting and rounded container.
- Edge case: Empty string renders an empty container without errors.
- Edge case: Plain text without markdown syntax renders as a single paragraph.
- Theme integration: Component renders legibly in both dark and light themes (manual visual verification).

**Verification:**
- TypeScript compiles without errors.
- Component renders markdown content with proper document styling.
- No prop-type or runtime errors on empty or plain-text input.

---

### U2. Integrate markdown preview into FilePanel

**Goal:** Wire `MarkdownPreview` into `FilePanel` so markdown files render as preview while all other files continue to use `CodeBlockContent`.

**Requirements:** R1, R3, R4

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/FilePanel.tsx`

**Approach:**
- Add a helper `isMarkdown(name: string): boolean` that checks extension against `.md` and `.markdown` (case-insensitive).
- In the content area, replace the unconditional `<CodeBlockContent ... />` with conditional rendering:
  - If `isMarkdown(activeFile.name)` → render `<MarkdownPreview content={activeFile.content} />`
  - Otherwise → render existing `<CodeBlockContent ... />`
- Ensure both branches render inside the same `flex-1 overflow-auto` container so tab switches cause no layout shift.
- The header (file name, copy button) and tab bar remain completely unchanged.
- The copy button continues to copy the raw file content (not rendered HTML), which is the expected behavior.

**Patterns to follow:**
- Existing `CodeBlockContent` usage in `FilePanel.tsx`.
- Existing `getLanguageFromFilename` pattern for extension detection (though markdown detection is simpler).

**Test scenarios:**
- Happy path: Opening `README.md` shows formatted markdown preview.
- Happy path: Opening `package.json` continues to show syntax-highlighted code view.
- Happy path: Switching from a markdown tab to a code tab and back renders correctly without stale content.
- Edge case: Opening a file with `.MD` (uppercase) extension renders as preview (case-insensitive check).
- Edge case: Rapid tab switching between markdown and non-markdown files does not cause flicker or errors.
- Integration: Closing and reopening a markdown file restores preview mode.

**Verification:**
- FilePanel compiles and runs.
- Markdown files render as preview; non-markdown files render as code.
- Tab bar, header, copy button, and resize behavior are unchanged.
- No console errors when switching between file types.

---

## System-Wide Impact

- **Interaction graph:** `FilePanel` gains a conditional content branch. `MarkdownPreview` is a leaf presentational component with no upstream dependencies beyond `streamdown`.
- **Bundle impact:** Zero — `streamdown` is already a dependency and is used elsewhere in the app.
- **Unchanged invariants:**
  - File tab behavior (open, close, switch, active state)
  - File panel resizing and width persistence
  - `CodeBlockContent` behavior for non-markdown files
  - Copy button copies raw source text
  - Theme switching logic

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Streamdown default margins or heading sizes conflict with file panel compact layout | Encapsulate all Streamdown styling inside `MarkdownPreview` wrapper with explicit Tailwind overrides; verify visually during implementation. |
| Local image references in markdown (e.g., `![](./image.png)`) fail to load | Images use relative paths from the markdown file's location. The file panel has no base URL context, so local images may 404. Accept this limitation for v1 — document it in code comments. |
| Theme color tokens insufficient for markdown-specific elements (blockquotes, inline code) | Use existing palette tokens first; adjust if contrast fails manual visual check. |

---

## Documentation / Operational Notes

- No additional operational monitoring required — this is a pure client-side UI change with no production runtime impact.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-29-markdown-preview-mode-requirements.md](docs/brainstorms/2026-05-29-markdown-preview-mode-requirements.md)
- Related code:
  - `src/client/components/FilePanel.tsx` — integration target
  - `src/client/components/ai-elements/message.tsx` — Streamdown wrapping pattern
  - `src/client/components/ai-elements/code-block.tsx` — existing file content renderer
  - `src/client/hooks/use-theme.ts` — theme system
