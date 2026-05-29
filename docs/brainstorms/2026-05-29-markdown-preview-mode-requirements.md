---
title: Markdown Preview Mode for File Panel
type: feat
status: active
date: 2026-05-29
---

# Markdown Preview Mode for File Panel

## Summary

When a markdown file is opened in the file panel, render its content as formatted preview instead of raw source code. All other file types continue to display in the existing syntax-highlighted code view.

## Problem Frame

Markdown files are meant to be read as rendered documents, not raw source. Currently, opening a `.md` file in the file panel shows the raw markdown syntax (headings as `# Heading`, links as `[text](url)`, etc.), which is harder to read than a formatted preview. This creates friction when browsing documentation, READMEs, or notes within the workspace.

## Requirements

- R1. Files with `.md` or `.markdown` extension render in preview mode instead of code view
- R2. Preview mode displays formatted markdown (headings, paragraphs, lists, links, code blocks, bold/italic)
- R3. Non-markdown files continue to render in the existing syntax-highlighted code view
- R4. The active tab indicator, file name display, and close button behavior remain unchanged regardless of render mode
- R5. Markdown preview styling matches the application's existing dark/light theme

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

## Success Criteria

- Opening a `.md` file shows formatted text instead of raw markdown syntax
- Opening a `.ts` or `.json` file continues to show syntax-highlighted code
- Preview respects the current theme (dark/light)
- No layout shifts or flicker when switching between markdown and non-markdown tabs
