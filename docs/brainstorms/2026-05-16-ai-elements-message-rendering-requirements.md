---
date: 2026-05-16
topic: ai-elements-message-rendering
---

# AI Elements Message Rendering

## Summary

Render Claude Code session messages with AI Elements components vendored directly into the repo — markdown, code blocks, tool calls, and reasoning/thinking blocks — without adopting shadcn/ui, React 19, Tailwind 4, or the Vercel AI SDK. v1 covers the message renderer only; the prompt input area is unchanged.

---

## Problem Frame

The current renderer at `src/client/components/MessageList.tsx` displays each message as a single plain-text bubble keyed by role. Behind it, both the load path (`src/client/stores/chat-store.ts`) and the streaming path (`src/server/routes/chat.ts`) flatten the SDK's structured content blocks down to a string: only `text` blocks survive, tool calls collapse to a "Using X…" placeholder, and `thinking` blocks are dropped entirely. The result is that a Claude Code conversation containing typical features — fenced code, tool invocations, internal reasoning — renders as plain prose with no syntax highlighting, no visible tool inputs or outputs, and no thinking content at all.

Building the missing primitives from scratch (markdown rendering, code blocks with copy and highlighting, collapsible tool and reasoning containers) duplicates work that AI Elements already implements. AI Elements is designed for copy-into-repo use, so its components can be lifted directly without adopting the canonical install path — which would require migrating React 18 → 19, Tailwind 3 → 4, initializing shadcn/ui, and installing the Vercel AI SDK just to render messages.

---

## Requirements

**Vendoring**
- R1. The minimum set of AI Elements components needed to render the in-scope content types is copied into the repo as source files the project owns and maintains. The set covers: conversation container, message wrapper, response/markdown, code block, tool (with header, content, input, output sub-parts), and reasoning (with trigger, content sub-parts).
- R2. Vendored files are adapted at copy time to consume the in-app message shape directly — they do not import from `ai` or `@ai-sdk/react`.

**Content rendering**
- R3. Markdown text in assistant messages renders with paragraphs, lists, bold/italic, links, and inline code formatting.
- R4. Fenced code blocks render with syntax highlighting for common languages and include a copy-to-clipboard action visible on hover.
- R5. Tool calls render as a collapsible block showing the tool name, the input arguments, and the output text (or error). The block defaults to collapsed; expanding reveals input and output.
- R6. Reasoning / thinking content renders as a collapsible block that defaults to collapsed, with a streaming-state affordance while content is still arriving.

**Message contract**
- R7. The in-app message representation carries multi-part content (text, code, tool input + output, reasoning) end to end — from the streaming endpoint and the load endpoint through to the renderer — without flattening to a single string anywhere in the pipeline.
- R8. The streaming SSE event protocol propagates tool input, tool output, and thinking content as discrete events so the client can attach them to the correct in-flight message.

**Visual identity**
- R9. Vendored components are adapted to the existing design tokens (dark background, orange accent, custom spacing scale) documented in `docs/design/ui-ux-design.md`. The rendered output reads as part of the existing app, not as a generic shadcn surface dropped into it.

**Behavior preservation**
- R10. The prompt input area in `src/client/components/ChatPanel.tsx` is unchanged in behavior and appearance.
- R11. Existing session listing, switching, creation, and deletion continue to work without modification.

---

## Acceptance Examples

- AE1. **Covers R3, R4, R9.** Given an assistant message whose content is `Here is a function:\n\n\`\`\`ts\nfunction add(a: number, b: number) { return a + b }\n\`\`\``, when the message renders, the prose appears as formatted markdown and the TypeScript code appears in a syntax-highlighted block with a visible-on-hover copy button styled with the existing dark + orange tokens.
- AE2. **Covers R5, R7, R8.** Given an assistant turn that invokes a `Read` tool with input `{ file_path: "src/index.ts" }` and receives a successful result, when the turn renders, a collapsed Tool block labeled "Read" appears in the conversation. Expanding it shows the input arguments and the output text.
- AE3. **Covers R6, R7, R8.** Given an assistant turn that emits a `thinking` block followed by a final text response, when the turn renders, a collapsed Reasoning block appears above the text response. While the thinking content is still streaming, the Reasoning block shows a streaming-state affordance.
- AE4. **Covers R10, R11.** Given a user with an existing session, when they switch sessions, send a message, and create a new session, the input textarea, session list, and session-management actions behave identically to today.

---

## Success Criteria

- A session containing markdown text, fenced code, a tool invocation, and a thinking block renders all four content types correctly and visibly belongs to the existing app's visual identity.
- The renderer carries multi-part content end to end: no flattening to string in the load path, the stream path, or the in-app message representation.
- The repo continues to build and run on its current stack (React 18, Tailwind 3, no shadcn/ui, no Vercel AI SDK installed).
- A downstream implementer can take this doc and `ce-plan` it without needing to invent which content types matter, which components to vendor, or whether the existing stack stays.

---

## Scope Boundaries

- Migrating React 18 → 19.
- Migrating Tailwind CSS 3 → 4.
- Initializing shadcn/ui (`components.json`, Radix dependencies, the `cn()` helper, CSS-variable theme).
- Installing `ai` or `@ai-sdk/react` as runtime or type-only dependencies.
- Adopting Vercel's `UIMessage.parts[]` as the persisted message contract (the in-app shape may resemble it for convenience, but conformance is not a requirement).
- Replacing or restyling the prompt input area in `ChatPanel.tsx`.
- Vendoring AI Elements components for sources / RAG citations, image content blocks, empty-state suggestions, prompt input, or loading spinners.
- Light mode theme.
- Rendering attached files, file chips, or attachments in the input.
- An upstream-sync mechanism for vendored files — once copied, the files are owned by this repo and tracked like any other source file.
- Changes to session storage (SQLite schema, JSON drafts) beyond what the renderer's content contract requires.

---

## Key Decisions

- **Vendor-in over registry install.** AI Elements components are designed to be copied into the consumer's repo. Lifting the specific files we need lets us skip the entire prerequisite stack (React 19, Tailwind 4, shadcn init, Vercel AI SDK) and own the adapted components outright. The alternative — running the registry CLI and migrating the stack — was rejected as disproportionate to the goal of "stop reinventing chat primitives."
- **Renderer-only scope.** The user's motivation is reuse of message-rendering primitives. Bringing PromptInput in the same change would widen the diff for unclear benefit; deferred until a separate need surfaces.
- **Preserve the existing design system.** The current visual identity (dark + orange tokens, custom spacing) is documented and intentional. Vendored files get adapted to those tokens rather than introducing shadcn's neutral CSS-variable palette.
- **Multi-part content end to end.** Adding tool and reasoning rendering requires that the streaming protocol, the load path, and the in-app shape all stop collapsing structured content to a string. Without that, no amount of UI work fixes the underlying loss.

---

## Dependencies / Assumptions

- The AI Elements components in scope (conversation, message, response, code block, tool, reasoning) can be adapted to a non-`UIMessage.parts[]` shape with reasonable effort — their composition is structural, not deeply coupled to the AI SDK's types.
- A markdown renderer and a syntax-highlighting library will be added as transitive runtime dependencies during planning (AI Elements' Response and CodeBlock components require them under the hood); the exact libraries are a planning decision.
- The Claude Code SDK's `SessionMessage` content blocks (`text`, `tool_use`, `tool_result`, `thinking`) are stable enough to model the in-app shape against.
- The current SSE protocol's `assistant`, `text_delta`, `tool_progress`, `result`, `system_init` event set can be extended (new event types or richer payloads) without breaking the existing client until the new client is in place.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R1, R2][Technical] Which specific files in the AI Elements GitHub source tree map to "conversation, message, response, code block, tool, reasoning" — and what transitive imports do they pull in beyond the AI SDK types we're already stripping?
- [Affects R3, R4][Technical] Which markdown renderer and syntax-highlighting library should we adopt? AI Elements uses specific libraries under the hood; we can match those or substitute.
- [Affects R7][Technical] Should the in-app message shape mirror Vercel's `UIMessage.parts[]` for forward-compatibility, or define its own structure tailored to the Claude Code SDK's content blocks?
- [Affects R8][Technical] How should the SSE protocol evolve to carry tool input, tool output, and thinking blocks as discrete typed events while keeping streaming semantics intact?
- [Affects R7][Technical] Should `chat-store.ts`'s `loadMessages` be refactored to consume the SDK's `SessionMessage` content blocks directly, or should the server normalize them into the new in-app shape before sending?
- [Affects R9][Technical] What is the concrete mapping from AI Elements' shadcn class references (e.g., `bg-background`, `text-foreground`, `border-input`, `text-muted-foreground`) to the existing Tailwind tokens in `tailwind.config.js` and `src/client/index.css`?
- [Affects R5, R6][Needs research] Does the Claude Code SDK currently emit `thinking` content blocks via the stream channel, the persisted session JSONL, or both? The current loader and stream both drop them, so observable behavior needs to be confirmed before designing the propagation path.
