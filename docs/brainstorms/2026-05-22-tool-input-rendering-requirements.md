---
date: 2026-05-22
topic: tool-input-rendering
---

# Tool Input Rendering — From Raw JSON to Structured Displays

## Summary

Replace raw `JSON.stringify` tool input rendering in both the approval surface and chat message display with a shared registry of tool-aware renderers. The registry is populated by an extraction script that scans the upstream CLI's tool definitions for schemas and simple renderers, supplemented by hand-written DOM React components for complex tools. Tools are added incrementally, starting with WebFetch.

---

## Problem Frame

The GUI currently renders every tool input as a raw JSON string — both in the approval surface (`ApprovalSurface.tsx`) and in chat message tool cards (`src/client/components/ai-elements/tool.tsx`). This is a significant downgrade from the upstream CLI experience, where each tool has specialized rendering: Bash shows the command with syntax highlighting, FileEdit shows a diff, WebFetch shows the URL, and so on.

The result is that GUI users see dense, unformatted JSON when Claude requests tool approval, making it harder to scan, understand, and decide. The same raw JSON appears in the chat history after a tool runs, breaking visual consistency with the approval step. The CLI solved this by giving every tool its own `renderToolUseMessage` method; the GUI needs an equivalent mechanism that works in a browser context.

---

## Requirements

**Shared rendering system**

- R1. A shared tool rendering registry lives in the GUI codebase. Both the approval surface and chat `<Tool>` components consume it — no separate rendering paths.
- R2. The registry maps a tool name (e.g., `web_fetch`) to a rendering function that receives the tool's parsed input and returns a React node.
- R3. When a tool name is not present in the registry, the renderer falls back to a structured key-value display (collapsible nested objects, arrays as lists, primitives inline) — never raw `JSON.stringify`.

**Extraction from upstream CLI**

- R4. An extraction script scans the upstream CLI's `src/tools/` directory for tool definitions. For each tool, it extracts the Zod `inputSchema` (field names, types, optionality) and the `renderToolUseMessage` implementation.
- R5. The script automatically converts simple string-based renderers (return values that are plain strings or simple template literals) into GUI-compatible rendering functions.
- R6. Tools whose CLI renderers use complex Ink components (`<Box>`, `<Text>`, conditional layouts, interactive elements) are flagged for hand-written DOM React overrides in the GUI. The extraction script generates a stub; a developer fills in the DOM equivalent.
- R7. The extracted registry is a checked-in TypeScript file in the GUI repo. Regenerating it is a manual step (running the script) — not part of every build.

**Incremental rollout**

- R8. Tools are added to the registry one at a time, in order of simplicity and usage frequency. The first tool is WebFetch.
- R9. After each tool is extracted (or its stub generated), the output is reviewed and confirmed before moving to the next tool.
- R10. The full set of CLI tools is the target, but the rollout prioritizes the highest-traffic tools first: WebFetch, FileWrite, Bash, FileEdit, Glob, Grep.

**Fallback and consistency**

- R11. The approval surface's input display and the chat `<ToolInput>` component both delegate to the registry. No component renders raw JSON except the structured fallback.
- R12. The `inputSummary` field emitted by the server remains unchanged. The registry is used for the detailed input view (the "Show more" expanded state in approvals, and the tool card body in chat).

---

## Success Criteria

- Tool inputs in the approval surface are no longer rendered as raw JSON strings for tools present in the registry.
- Tool inputs in chat message history match the approval rendering for the same tool.
- The extraction script successfully generates at least one valid registry entry for a simple tool (WebFetch) without hand-written overrides.
- Adding a new tool to the registry follows the incremental workflow: extract, review, confirm, merge.

---

## Scope Boundaries

- **Deferred for later:** Auto-regeneration on every build; complex tools beyond the top 10; rendering of tool _outputs_ (currently out of scope — this focuses on tool _inputs_).
- **Outside this product's identity:** Changing the SDK or server protocol to emit pre-rendered HTML; reusing CLI Ink components directly in the browser; adding tool execution or editing capabilities to the GUI.

---

## Key Decisions

- **Shared rendering path:** Both approvals and chat messages use the same registry. This ensures consistency but means the registry must handle both contexts (approvals may want more detail; chat may want more compactness).
- **Auto-extraction from CLI source:** Rather than maintaining a parallel registry by hand, the GUI derives its registry from the CLI's tool definitions. This trades upfront extraction-script complexity for long-term sync fidelity.
- **Simple renderers auto-extracted, complex ones hand-written:** The CLI's `renderToolUseMessage` methods use Ink, a terminal React renderer. Mapping Ink to DOM automatically is infeasible for complex layouts, so the script extracts what it can and stubs the rest.

---

## Dependencies / Assumptions

- The upstream CLI source (`src/tools/`) is available when running the extraction script.
- CLI tool definitions follow discoverable patterns: each tool exports a `buildTool` call with an `inputSchema` property, and rendering logic lives in a co-located `UI.tsx` or `UI.ts` file with a `renderToolUseMessage` export.
- Simple `renderToolUseMessage` implementations (returning strings or simple template literals) are mechanically translatable to DOM React.
- The GUI's existing `CodeBlock`, diff, and path-styling components can be reused by the registry renderers.

---

## Outstanding Questions

### Resolve Before Planning

- [Affects R4–R6] **Registry format:** Should the registry be a flat object mapping tool names to render functions, or a nested structure grouping by tool category?

### Deferred to Planning

- [Affects R5] **Extraction strategy:** [Needs research] Should the script parse TypeScript AST to find schemas and renderers, or use a lighter regex/heuristic approach? The CLI's tool files follow conventions but are not machine-readable contracts.
- [Affects R6] **Ink → DOM mapping:** [Technical] For simple renderers that return strings, the mapping is trivial. For renderers that return JSX (Ink components), what level of auto-conversion is feasible? Planning should audit the actual `UI.tsx` files across all tools.
