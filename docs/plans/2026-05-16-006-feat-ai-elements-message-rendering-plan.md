---
title: AI Elements Message Rendering (Vendored)
type: feat
status: active
date: 2026-05-16
deepened: 2026-05-16
origin: docs/brainstorms/2026-05-16-ai-elements-message-rendering-requirements.md
---

# AI Elements Message Rendering (Vendored)

## Summary

Vendor a minimal subset of Vercel's AI Elements components into the repo and rewire the chat data path so structured Claude Code content — markdown text, fenced code, tool calls (input + output), and reasoning/thinking blocks — renders end to end without adopting React 19, Tailwind 4, shadcn/ui, or the Vercel AI SDK. The renderer is replaced; the prompt input area is untouched.

---

## Problem Frame

Today the chat renderer flattens every assistant turn to plain text at two distinct points — `formatMessage` on the SSE server (`src/server/routes/chat.ts:84`) and the `loadMessages` mapping in the client store (`src/client/stores/chat-store.ts:166`) — so tool calls collapse to a "Using X…" placeholder, thinking blocks disappear, and fenced code renders as raw prose. Rebuilding the missing primitives by hand duplicates work that AI Elements has already shipped under Apache 2.0. (see origin: `docs/brainstorms/2026-05-16-ai-elements-message-rendering-requirements.md`)

---

## Assumptions

*This plan was authored without synchronous user confirmation on the deferred-to-planning questions in the origin document. The items below are agent inferences that fill those gaps and should be reviewed before implementation proceeds.*

- **In-app message shape is Claude-Code-tailored, not a `UIMessage.parts[]` mirror.** A typed `MessagePart` union (text, tool_use, tool_result, thinking) carries multi-part content end-to-end. The structural shape (array of typed parts on each message) is similar enough to `UIMessage.parts[]` that vendored AI Elements components adapt — but AI Elements' `ToolUIPart` carries a four-state lifecycle (`input-streaming` | `input-available` | `output-available` | `output-error`), wider than our `tool_use.state: 'streaming' | 'complete'` plus a separate `tool_result.isError`. U1 includes an explicit state-mapping shim in `tool.tsx` (see U1 Approach). Trade-off accepted: future AI Elements upgrades may need this shim re-checked.
- **Server normalizes both load and stream paths.** `chatService.loadMessages` and the SSE handler both convert `SessionMessage`/`SDKMessage` content blocks into the new `ChatMessage` shape on the server. The client store consumes ready-to-render objects on both paths. Centralizes the SDK→app mapping in one helper.
- **`includePartialMessages: true` is enabled on the SDK query.** Without this option (default off), the SDK only emits whole-turn `assistant` messages — the existing `stream_event` branch in `src/server/routes/chat.ts:99` is dead code today. U4 turns it on in `buildSdkOptions` so `stream_event` content blocks (text deltas, tool input deltas, thinking deltas) actually fire. Trade-off: paying for the partial-message stream surface even when the user is offline-tolerant; acceptable because every assistant turn benefits.
- **Streamdown + Shiki are adopted as runtime deps.** Matching AI Elements' underlying choices keeps the vendored files un-shimmed at the markdown/highlight layer. `streamdown` is one package on npm (no `@streamdown/*` sub-packages were verified to exist — confirm during U1; if true sub-packages exist for cjk/math/mermaid they remain deferred). For Shiki, U1 imports from `shiki/bundle/web` (not `shiki/bundle/full`) for bundle reasons. Honest trade-off: this commits to ~200–500KB of markdown + highlighter weight when a hand-rolled minimal renderer covering R3's enumerated features (paragraphs, lists, bold/italic, links, inline code) plus Prism or `highlight.js` would be lighter; if bundle becomes a real issue, the retreat path is local — swap `<Streamdown>` and `<CodeBlock>` internals for `react-markdown` + `highlight.js` without touching anything outside `src/client/components/ai-elements/`.
- **`motion` is replaced with a CSS keyframe in `shimmer.tsx`.** The animation library is not adopted; AI Elements uses it only in `shimmer.tsx`, and a 6-line CSS keyframe equivalent avoids the dependency.
- **Tool blocks default-collapse on both streaming and completion, with a shimmer header while streaming** (resolves origin ambiguity A1 from the spec-flow analysis; aligned with R5's unconditional "defaults to collapsed"). The shimmer signals progress without moving content.
- **Reasoning blocks auto-collapse on stream completion only if the user has not manually expanded them** (resolves A3). The block respects user intent over the default.
- **Tool output renders as monospace plain text, not markdown** (resolves A4). Tool outputs are attacker-controlled (when MCP servers are involved) and double-parsing them as markdown widens the surface for spoofing rendered chat. JSON outputs may be pretty-printed but not interpreted.

These bets can be revised if the user disagrees; the items that touch architecture (message shape, server normalization, `includePartialMessages`) are the highest-leverage to flag for review.

---

## Requirements

- R1. The minimum set of AI Elements components needed to render the in-scope content types is copied into the repo as source files the project owns and maintains. Set: conversation, message, response, code-block, tool, reasoning, shimmer.
- R2. Vendored files are adapted at copy time to consume the in-app message shape directly — they do not import from `ai` or `@ai-sdk/react`.
- R3. Markdown text in assistant messages renders with paragraphs, lists, bold/italic, links, and inline code formatting.
- R4. Fenced code blocks render with syntax highlighting for common languages and include a copy-to-clipboard action visible on hover.
- R5. Tool calls render as a collapsible block showing the tool name, the input arguments, and the output text (or error). The block defaults to collapsed; expanding reveals input and output.
- R6. Reasoning / thinking content renders as a collapsible block that defaults to collapsed, with a streaming-state affordance while content is still arriving.
- R7. The in-app message representation carries multi-part content (text, tool input + output, reasoning) end to end — from the streaming endpoint and the load endpoint through to the renderer — without flattening to a single string anywhere in the pipeline.
- R8. The streaming SSE event protocol propagates tool input, tool output, and thinking content as discrete events so the client can attach them to the correct in-flight message.
- R9. Vendored components are adapted to the existing design tokens (dark background, orange accent, custom spacing scale). The rendered output reads as part of the existing app.
- R10. The prompt input area in `src/client/components/ChatPanel.tsx` is unchanged in behavior and appearance.
- R11. Existing session listing, switching, creation, and deletion continue to work without modification.

**Origin acceptance examples:** AE1 (covers R3, R4, R9), AE2 (covers R5, R7, R8), AE3 (covers R6, R7, R8), AE4 (covers R10, R11).

---

## Scope Boundaries

- Migrating React 18 → 19.
- Migrating Tailwind CSS 3 → 4.
- Initializing shadcn/ui (`components.json`, full Radix dependency surface, CSS-variable theme). Only the specific shadcn primitives that AI Elements imports (button, collapsible, badge) are vendored as bare components — no shadcn init.
- Installing `ai` or `@ai-sdk/react` as runtime dependencies. `ai` may be added as a transitive type-only `devDependency` if removing all `UIMessage`/`ToolUIPart` references from vendored files turns out cheaper to do with local equivalents; the plan defaults to local equivalents (no `ai` import) — see U1.
- Adopting Vercel's `UIMessage.parts[]` as the persisted message contract.
- Replacing or restyling the prompt input area in `ChatPanel.tsx`.
- Vendoring AI Elements components for sources / RAG citations, image content blocks, empty-state suggestions, prompt input, or loading spinners.
- Light mode theme.
- Rendering attached files, file chips, or attachments in the input.
- An upstream-sync mechanism for vendored files — once copied, the files are owned by this repo and tracked like any other source file.
- Changes to SQLite session storage or JSON drafts beyond what the renderer's content contract requires.

### Deferred to Follow-Up Work

- Adopting a JavaScript test framework (no test infra exists today: no `vitest`, `jest`, or `playwright`). Test scenarios in each unit are written as if a framework existed; until one lands, they double as the manual-verification checklist. See **Documentation / Operational Notes**.
- A `docs/solutions/` learning capture for the SSE protocol evolution (worth writing post-merge via `/ce-compound`).
- `@streamdown/cjk`, `@streamdown/math`, `@streamdown/mermaid` plugins — add when a session actually requires them.
- Touch-device-specific UX polish beyond always-visible copy buttons.

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/MessageList.tsx` — current renderer (80 lines). Renders each message as a Tailwind bubble with `{msg.content}` as plain text. The file is replaced wholesale in U6.
- `src/client/stores/chat-store.ts` — Zustand store with fine-grained selectors and keyed-per-session state maps. The current `ChatMessage` interface (lines 17–23) is replaced in U2; `loadMessages` (166–205) is rewritten in U3; `sendMessage` SSE consumer (207–351) is rewritten in U5.
- `src/server/routes/chat.ts` — Express SSE handler. `formatMessage` (84–143) currently keeps only `text` blocks and emits a name-only `tool_progress`. Rewritten in U4.
- `src/server/services/chat-service.ts:117` — `loadMessages` returns raw `SessionMessage[]` from the SDK; refactored in U3 to return the new normalized `ChatMessage[]`.
- `src/server/services/sdk-client.ts` — thin SDK wrapper. Unchanged.
- `tailwind.config.js` — custom dark + orange tokens (`bg-bg`, `bg-surface`, `border-border`, `text-text-primary/secondary/tertiary`, `bg-accent`, `bg-msg-user`, `bg-msg-assistant`). Drives the shadcn→local class mapping in U1.
- `src/client/index.css` — only `@tailwind` directives plus scrollbar styling. No CSS variables; nothing to migrate.
- Repo convention: types are defined in parallel inside `src/client/...` and `src/server/...` (e.g., `ChatSession` interface in both `src/client/stores/chat-store.ts` and `src/server/models/session.ts`). U2 attempts a lighter variant: define once in `src/client/types/message.ts` and import from server code via a relative path. If the server `tsconfig.json`'s `rootDir: "./src/server"` (with `composite: true`) blocks that, fall back to byte-identical duplicate files in both trees. The decision is reached during U2 implementation, not pre-committed here.

### Institutional Learnings

- `docs/solutions/` does not exist in this repo. No prior captured learnings apply. The SSE protocol evolution in U4 is a natural candidate for post-merge capture.

### External References

- AI Elements upstream: <https://github.com/vercel/ai-elements> (Apache 2.0).
- Streamdown: <https://github.com/vercel-labs/streamdown> — markdown renderer used by AI Elements.
- Shiki: <https://shiki.style/> — syntax highlighter used by AI Elements' `code-block`.
- Claude Agent SDK TypeScript reference for `SessionMessage` content blocks: <https://code.claude.com/docs/en/agent-sdk/typescript>.

---

## Key Technical Decisions

- **Vendor-in over registry install.** AI Elements is shipped to be copied; the registry CLI requires shadcn init + React 19 + Tailwind 4 + Vercel AI SDK. Lifting the seven specific files and three shadcn primitives we actually use skips the entire prerequisite stack and is legally clean under Apache 2.0 with attribution.
- **Multi-part content end to end (server-normalized).** A `ChatMessage` now carries an ordered `MessagePart[]` (text | tool_use | tool_result | thinking). Both the load path and the stream path produce this shape on the server. The client store and the renderer are pure consumers.
- **Streamdown + Shiki, matching upstream.** Adopting the same markdown/highlighter stack AI Elements uses keeps the vendored files un-shimmed. Cost: Shiki ships grammar files lazily but its initial highlight is a few hundred KB; acceptable for a desktop-class developer GUI.
- **Drop the synthetic `role: 'tool'` sibling message.** Today's store appends a separate `role: 'tool'` message ("Using Read…") to the array, which loses intra-turn ordering of text/tool/thinking content. Tool calls become parts of the assistant turn, not siblings.
- **Stable `tool_use_id` keying on tool blocks.** Pair `tool_use` parts with their `tool_result` parts by ID, not by name or array position. Required for repeated calls to the same tool within one turn.
- **In-stream tool/reasoning state on each part.** Each `tool_use` and `thinking` part carries a `state: 'streaming' | 'complete'` field so the renderer can attach shimmer affordances per-block instead of inferring from a turn-level `isStreaming` flag.
- **Adapt vendored files to local Tailwind tokens at copy time.** Apply the explicit mapping table below; no class survives that depends on a shadcn CSS variable.
- **`tsx` vendor format, `.tsx` filenames.** Match AI Elements' source. Files land in `src/client/components/ai-elements/` and `src/client/components/ui/` to keep "vendored, do not edit lightly" visually separated from app code.
- **Single-file types when possible, parallel-type when blocked.** U2 first attempts a single `src/client/types/message.ts` imported from server code via relative path. If the server `tsconfig.json` (`rootDir: "./src/server"`, `composite: true`) rejects this, fall back to duplicate files. Either way, do not preemptively restructure the project to add a `src/shared/` tree — that's larger scope than the SSE union types justify.

### Shadcn → Local Token Mapping

Applied during U1 to every vendored file. The U1 grep gate is **structural, not enumerated**: it matches any shadcn-derived utility on a shadcn-derived token, not a hand-listed set:

```text
\b(bg|text|ring|border|outline|fill|stroke|from|to|via|hover:bg|hover:text|focus:bg|focus-visible:ring|data-\[state=open\]:bg|data-\[highlighted\]:bg|aria-selected:bg|placeholder:text)-(background|foreground|primary|secondary|muted|accent|destructive|popover|card|input|ring)(-foreground)?\b
```

Any remaining match after token-mapping is a missed rewrite. Common mappings (apply these, then re-run the gate):

| shadcn class | local class |
|---|---|
| `bg-background` | `bg-bg` |
| `text-foreground` | `text-text-primary` |
| `text-muted-foreground` | `text-text-tertiary` |
| `bg-secondary` | `bg-surface` |
| `bg-muted` | `bg-surface-hover` |
| `bg-primary` | `bg-accent` |
| `text-primary-foreground` | `text-text-primary` |
| `bg-accent` (shadcn "accent" = neutral hover surface, not orange) | `bg-surface-hover` |
| `text-accent-foreground` (text on shadcn's neutral hover) | `text-text-primary` |
| `text-secondary-foreground` | `text-text-primary` |
| `bg-destructive` | (no token — add `bg-red-900` or define `bg-danger` in `tailwind.config.js`) |
| `text-destructive` / `text-destructive-foreground` | (no token — add `text-red-400` or define `text-danger`) |
| `bg-popover` / `bg-card` | `bg-surface` |
| `border`, `border-input` | `border-border` |
| `hover:bg-accent` | `hover:bg-surface-hover` |
| `ring`, `ring-offset-background` | `ring-accent`, `ring-offset-bg` |
| `data-[state=open]:bg-accent` | `data-[state=open]:bg-surface-hover` |
| `outline-ring/50` (Tailwind 4 only — would crash this Tailwind 3 build) | rewrite to `outline-accent/50` or remove |

---

## Open Questions

### Resolved During Planning

- **Which files in AI Elements GitHub source map to our content set?** `packages/elements/src/conversation.tsx`, `message.tsx`, `code-block.tsx`, `tool.tsx`, `reasoning.tsx`, `shimmer.tsx`. There is no `response.tsx` upstream — markdown is rendered inline via `<Streamdown>` inside `message.tsx` and `reasoning.tsx`. We add a 5-line `response.tsx` wrapper around `<Streamdown>` for naming ergonomics in our renderer.
- **Markdown library?** Streamdown — published as a single `streamdown` npm package (not multiple `@streamdown/*` sub-packages). Optional plugins for cjk, math, mermaid exist in the AI Elements source but are deferred until a session needs them. U1 pins a minimum version (`^X.Y.Z` chosen at install time) and runs an import-smoke against partial markdown.
- **Syntax highlighter?** Shiki, imported from `shiki/bundle/web` (not `shiki/bundle/full`) for bundle weight. Grammars and themes are loaded on demand by Shiki's internal dynamic-import resolution; Vite handles the chunking.
- **Shadcn primitives needed?** `button`, `collapsible`, `badge`, plus a `utils.ts` with the `cn = (...args) => twMerge(clsx(args))` helper. All four land under `src/client/components/ui/` (canonical: `src/client/components/ui/utils.ts` — not `lib/utils.ts`). `button-group`, `tooltip`, `select` are imported by AI Elements features we do not vendor (message action bars, model picker) and are skipped.
- **`@ai-sdk/react` runtime dep?** Not needed — none of the target files import from it.
- **`ai` runtime dep?** Not needed at runtime. The type imports (`UIMessage`, `ToolUIPart`, `DynamicToolUIPart`) are replaced with local equivalents from `src/client/types/message.ts`. AI Elements' `ToolUIPart` carries a four-state `state` field (`input-streaming` | `input-available` | `output-available` | `output-error`); the local equivalent uses our two-state `tool_use.state` plus `tool_result.isError`. The vendored `tool.tsx` includes an inline mapping (see U1 Approach).
- **`@anthropic-ai/sdk` beta types?** Not added as an explicit dep. The SDK's `stream_event` payloads (`BetaRawMessageStreamEvent`) are treated as `unknown` and discriminated by string field — matching the existing pattern at `src/server/routes/chat.ts:100`. Trade-off: less type safety on the event-discrimination switch, but no new dep on a fast-moving beta type tree.
- **License attribution path?** Add `LICENSES/ai-elements-apache-2.0.txt` with the full Apache 2.0 license text plus an "Original source: github.com/vercel/ai-elements" attribution line. Each vendored file gets a top comment naming the upstream path and license.
- **Token mapping?** Settled via the **structural regex gate** in Key Technical Decisions, not an enumerated allow-list. The table is guidance; the regex is the enforcement.

### Deferred to Implementation

- **Does the Claude Agent SDK 0.2.141 surface thinking blocks via the stream channel, the persisted JSONL, or both?** Origin Q at line 113 flagged this; the existing loader and stream both drop them. With `includePartialMessages: true` (see Assumptions), the SDK should emit `thinking_delta` content blocks via `stream_event`; U4 includes a verification step that logs the raw `SDKMessage` stream for a session exercising reasoning. **Recovery path if streaming is unavailable:** U4 still emits `thinking_start` / `thinking_delta(fullText)` / `thinking_done` from the whole-turn `assistant` content block path, but they fire together at the end of the turn — the Reasoning block lands fully populated with no shimmer phase. Clean degradation, not a code path to maintain separately.
- **Whether to expose tool execution duration in the collapsed header.** The SDK emits `tool_progress` with `elapsed_time_seconds`; the AI Elements `tool.tsx` does not surface duration by default. Decide during U6 if showing it (e.g., "Read · 2.4s") helps users without crowding the header.
- **Exact `bg-msg-user` / `bg-msg-assistant` application.** AI Elements' `Message` component picks a background by role; the existing tokens are dedicated to that purpose. Confirm at U6 implementation whether the role-bubble pattern still fits with the new multi-part content (tool/thinking blocks may push us toward a flatter, accent-bordered card).

---

## High-Level Technical Design

> *Illustrates the intended approach and is directional guidance for review, not implementation specification.*

### Message Shape (used in `src/client/types/message.ts` and `src/server/types/message.ts`)

```ts
export type MessageRole = 'user' | 'assistant' | 'system'

export type MessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use'
      toolUseId: string
      toolName: string
      input: unknown
      state: 'streaming' | 'complete'
    }
  | {
      type: 'tool_result'
      toolUseId: string
      output: string
      isError: boolean
    }
  | { type: 'thinking'; text: string; state: 'streaming' | 'complete' }

export interface ChatMessage {
  id: string                 // server-issued or client-generated for drafts
  role: MessageRole
  parts: MessagePart[]
  timestamp: number          // ms since epoch
  isStreaming?: boolean      // turn-level streaming flag (separate from per-part state)
}
```

### SSE Event Protocol (U4)

```text
event: system_init        data: { model, tools, sessionId }
event: assistant_start    data: { messageId }
event: text_delta         data: { messageId, partIndex, text }
event: tool_use_start     data: { messageId, partIndex, toolUseId, toolName }
event: tool_use_done      data: { toolUseId, input }              // full input emitted at once
event: tool_result        data: { toolUseId, output, isError }
event: thinking_start     data: { messageId, partIndex }
event: thinking_delta     data: { messageId, partIndex, text }
event: thinking_done      data: { messageId, partIndex }
event: assistant_done     data: { messageId }
event: result             data: { subtype, isError, result?, errors? }
event: error              data: { message }
event: done               data: {}
```

`partIndex` is the index into the in-flight `ChatMessage.parts[]` array; new parts are appended on `*_start` events. The client maintains a `toolUseId → partIndex` map so `tool_result` and `tool_use_done` can locate their target without scanning. Streaming tool input deltas (`input_json_delta` in the SDK stream) are intentionally not surfaced — input arrives fully formed at `tool_use_done`, matching AI Elements' `ToolUIPart` lifecycle.

### Sequencing Graph

```text
        U1 (vendor files + deps)        U2 (shared types)
                 │                              ▲
                 ▼                              │  (U2 depends on U1 for the local types
        U2 (shared types) ◄───── U1 placeholders   the vendored files reference)
                 │
                 ├─────────────┐
                 ▼             ▼
             U3 (load path)  U4 (stream path)
                 │             │
                 └─────┬───────┘
                       ▼
                 U5 (client store)
                       │
                       ▼  ◄── atomic landing with U5 to avoid half-state
                 U6 (renderer)
                       │
                       ▼
                 U7 (validation + theme polish)
```

U2 is on U1's critical path because U1's vendored files import the local `MessagePart` / `ChatMessage` types defined in U2. U5 and U6 land atomically (in one PR or one commit pair) so the store and renderer never see each other in mismatched-shape states.

---

## Implementation Units

### U1. Vendor AI Elements components, shadcn primitives, and runtime dependencies

**Goal:** Land the seven AI Elements source files plus three shadcn primitives in the repo as locally-owned source, with token mapping applied and `ai`-package imports replaced by local types. Add the runtime deps Streamdown and Shiki.

**Requirements:** R1, R2, R9.

**Dependencies:** None.

**Files:**
- Modify: `package.json` (add `clsx`, `tailwind-merge`, `streamdown`, `shiki`, `use-stick-to-bottom`, `@radix-ui/react-collapsible`). Pin minimum versions at install time.
- Create: `src/client/components/ui/utils.ts` (the `cn` helper)
- Create: `src/client/components/ui/button.tsx`
- Create: `src/client/components/ui/collapsible.tsx`
- Create: `src/client/components/ui/badge.tsx`
- Create: `src/client/components/ai-elements/conversation.tsx`
- Create: `src/client/components/ai-elements/message.tsx`
- Create: `src/client/components/ai-elements/response.tsx` (5-line wrapper around `<Streamdown>`)
- Create: `src/client/components/ai-elements/code-block.tsx`
- Create: `src/client/components/ai-elements/tool.tsx`
- Create: `src/client/components/ai-elements/reasoning.tsx`
- Create: `src/client/components/ai-elements/shimmer.tsx`
- Create: `LICENSES/ai-elements-apache-2.0.txt`
- Test: deferred (no framework yet). Verification is the build pass plus the U1 grep gate below.

**Approach:**
- For each vendored file, replace `import { ... } from 'ai'` with imports from `@/types/message` (added in U2; until U2 lands, leave a `// TODO(U2): local types` annotation against a temporary local interface co-located in the file).
- For each vendored file, rewrite shadcn-derived tokens. Apply the suggestions in the **Shadcn → Local Token Mapping** table, then run the **structural regex gate** (same section) over `src/client/components/ai-elements` and `src/client/components/ui`. Any match is a missed rewrite — the build is not "done" until the gate returns zero.
- In `tool.tsx` specifically, add a `mapToolState` helper that translates AI Elements' four-state `ToolUIPart.state` (`input-streaming`, `input-available`, `output-available`, `output-error`) into the local two-state `tool_use.state` + `tool_result.isError`. Apply at the prop boundary so the rest of the component's logic is unchanged.
- Replace `motion/react` in `shimmer.tsx` with a CSS keyframe defined in `src/client/index.css` (e.g., `@keyframes ai-shimmer { ... }` and a `.ai-shimmer { animation: ai-shimmer 1.4s infinite; }` class). Delete the `motion` import.
- For Shiki, import from `shiki/bundle/web` (Vite handles the dynamic chunking) — not `shiki/bundle/full`.
- Each vendored file gets a top comment naming the upstream path and the license:
  ```
  /*
   * Vendored from github.com/vercel/ai-elements (packages/elements/src/<file>.tsx).
   * Licensed under Apache License 2.0. See LICENSES/ai-elements-apache-2.0.txt.
   * Locally adapted: shadcn tokens → repo tokens; `ai` types → local types.
   */
  ```
- `LICENSES/ai-elements-apache-2.0.txt` contains the verbatim Apache 2.0 license text plus an "Original source: github.com/vercel/ai-elements" line.

**Patterns to follow:**
- `src/client/components/*` files use default exports and flat function components — preserve that style on vendored files.
- `src/client/components/Toolbar.tsx` for how local components compose Lucide icons + Tailwind tokens.

**Test scenarios:**
- *Happy path:* `npm run build:client` succeeds with the vendored files present.
- *Edge case:* the U1 structural regex gate (see Key Technical Decisions) returns no hits across `src/client/components/ai-elements` and `src/client/components/ui`.
- *Edge case:* `grep -rE "from 'ai'|from '@ai-sdk/react'|from 'motion'" src/client/components/ai-elements src/client/components/ui` returns no hits.
- *Edge case:* `grep -rE "lib/utils" src/client/components` returns no hits (canonical path is `src/client/components/ui/utils.ts`).

**Verification:**
- All seven AI Elements files and three shadcn primitives compile, build, and pass the grep gates. The runtime deps are installed and lockfile updated. License attribution is in place. `tool.tsx` carries the state-mapping shim.

---

### U2. Multi-part `ChatMessage` shape and SSE event union (types only)

**Goal:** Define the new message and SSE event types in both client and server type trees. No behavior change; existing call sites adopt the new types where they previously used the old `ChatMessage` interface (still rendering plain `parts[0].text`-equivalent strings — full rendering lands in U6).

**Requirements:** R7, R8.

**Dependencies:** U1 (so vendored files can have their `TODO(U2)` placeholders replaced with real imports).

**Files:**
- Create: `src/client/types/message.ts` (exports `MessageRole`, `MessagePart`, `ChatMessage`, `SseEvent` union)
- Create: `src/server/types/message.ts` (identical content — parallel-type pattern matching `ChatSession`)
- Modify: `src/client/stores/chat-store.ts` — replace inline `ChatMessage` interface (lines 17–23) with re-export from `../types/message`. In the load and stream paths, construct `parts: [{ type: 'text', text: '...' }]` instead of `content: '...'`. The store no longer carries a `content` string field.
- Modify: `src/client/components/MessageList.tsx` — patch the render expression from `{msg.content}` to `{msg.parts[0]?.type === 'text' ? msg.parts[0].text : ''}` as a minimal inline adapter so U2 alone does not break the page. U6 deletes this patch when it rewrites the renderer.
- Modify: `src/server/routes/chat.ts` — import `SseEvent` types where `ClientMessage` is defined; the union becomes the source of truth for `event:` strings.
- Modify: each vendored file from U1 — replace local TODO interfaces with imports from `@/types/message` (path alias from `tsconfig.json` line 20).

**Approach:**
- Define the unions in `MessagePart` and `SseEvent` exactly as in **High-Level Technical Design**.
- Maintain the parallel-type convention: the file content in `src/client/types/message.ts` and `src/server/types/message.ts` is byte-identical (modulo path-alias adjustments). Document the convention with a one-line header comment.
- The `chat-store.ts` change at this stage is type-only at the interface boundary. The `ChatMessage` interface in `chat-store.ts` is replaced by re-export from `../types/message` (no `content` string field — `parts[]` is the only carrier). To keep `MessageList.tsx` rendering today's behavior between U2 and U6, the current `MessageList.tsx` is patched to read `parts[0].text` (cast to text) inline. This is the **only** consumer-side adaptation; U6 then deletes the inline cast when it rewrites the renderer wholesale.
- **U5 and U6 land atomically** (single PR or commit pair). The store's new event-vocabulary handler (U5) and the new renderer (U6) must ship together — between them, intermediate states exist where `parts[]` carries `tool_use`/`thinking` content that the old renderer cannot display. U2 enables the type change; U5+U6 deliver the behavior change in one motion.

**Patterns to follow:**
- Existing `ChatSession` parallel definitions in `src/client/stores/chat-store.ts:3` and `src/server/models/session.ts`.
- `@/*` path alias for client-side imports (`tsconfig.json` line 20).

**Test scenarios:**
- *Happy path:* `npm run build` (both `build:client` and `build:server`) succeeds.
- *Happy path:* `npm run dev`, open the app, send a message, see today's plain-text rendering still work — the inline `MessageList.tsx` `parts[0].text` cast keeps the page functional.
- *Edge case:* the two `types/message.ts` files are textually identical except for path-alias-related imports — confirm with `diff src/client/types/message.ts src/server/types/message.ts` (expected: no semantic diff).
- *Edge case:* `grep -rE "\\.content\\b" src/client/stores/chat-store.ts` returns no hits (the `content` string field is fully removed from store-side code).

**Verification:**
- Both type trees compile. The renderer still shows plain text. Vendored AI Elements files no longer carry `TODO(U2)` comments.

---

### U3. Server-side normalization for the load path

**Goal:** Convert `SessionMessage[]` (raw SDK content blocks) to `ChatMessage[]` (with `parts[]`) on the server. The load endpoint and the client `loadMessages` consume the new shape.

**Requirements:** R7.

**Dependencies:** U2.

**Files:**
- Create: `src/server/services/message-normalizer.ts` — exports `normalizeSessionMessage(sessionMessage: SessionMessage): ChatMessage` and `partsFromSdkContent(content: unknown[]): MessagePart[]`.
- Modify: `src/server/services/chat-service.ts:117` — `loadMessages` returns `ChatMessage[]` (apply the normalizer to each `SessionMessage`).
- Modify: `src/server/routes/chat.ts` GET `/sessions/:sessionId/messages` — type the response as `{ messages: ChatMessage[] }`.
- Modify: `src/client/stores/chat-store.ts:166` `loadMessages` — drop the SDK-content flatten loop; consume the server's normalized shape directly.
- Test: deferred (no framework). Manual verification via DevTools — load a session that contains a tool call and confirm the network response includes `parts: [...]` entries with `type: 'tool_use'` and `type: 'tool_result'`.

**Approach:**
- `partsFromSdkContent` iterates `content[]` blocks emitted by `@anthropic-ai/claude-agent-sdk`. Map by block `type`:
  - `text` → `{ type: 'text', text }`
  - `tool_use` → `{ type: 'tool_use', toolUseId, toolName, input, state: 'complete' }` (load-path values are always complete)
  - `tool_result` → `{ type: 'tool_result', toolUseId, output: stringifyOutput(...), isError }`
  - `thinking` → `{ type: 'thinking', text, state: 'complete' }`
  - unknown block types → skip with a single `console.warn` per block type per process lifetime (avoid log floods).
- `stringifyOutput` flattens SDK `tool_result.content` blocks: each `text` block's text is concatenated; non-text result blocks (images, etc.) become a `[Non-text tool output]` placeholder. Comment with `// Tool outputs render as plain monospace — see Assumptions in plan 2026-05-16-006`.
- `normalizeSessionMessage` decides the message `role` from `SessionMessage.type` and copies `uuid → id`. `timestamp` falls back to the SDK's timestamp if present, otherwise `Date.now()`.

**Patterns to follow:**
- `src/server/services/chat-service.ts` `mapSdkSessionInfo` (line 210) for the SDK-info-to-app-shape mapping pattern.

**Test scenarios:**
- *Happy path:* a session with a single text-only assistant message normalizes to one `ChatMessage` with one `text` part.
- *Happy path:* a session with `[text, tool_use, tool_result, text]` content blocks normalizes to a four-part assistant `ChatMessage` in that order.
- *Edge case:* a session with a `thinking` block in history is preserved as a `thinking` part with `state: 'complete'` (verifies origin Q at line 113 for the load path).
- *Edge case:* an unknown block type is skipped without throwing.
- *Edge case:* a `tool_result` whose `content` is a string (not an array) is normalized to `output: <string>`.
- *Integration:* `GET /sessions/:sessionId/messages` returns the new shape end-to-end; client store's `messages[sessionId]` populates with `parts[]`.

**Verification:**
- A loaded session that contains a tool call shows the tool input + output in the new shape (visible via DevTools or, after U6, in the UI). Thinking blocks present in JSONL appear as collapsed parts on first paint.

---

### U4. SSE protocol evolution: emit discrete events for tool input/output and thinking

**Goal:** Server emits the new SSE event vocabulary (defined in U2). `formatMessage` in `routes/chat.ts` is rewritten to track in-flight parts and emit `*_start`/`*_delta`/`*_done` events as `SDKMessage` chunks arrive.

**Requirements:** R8.

**Dependencies:** U2.

**Files:**
- Modify: `src/server/services/chat-service.ts` — `buildSdkOptions` (lines 168–200) adds `includePartialMessages: true` to the SDK query options. Without this, the SDK only emits whole-turn `assistant` messages; the existing `stream_event` branch in `routes/chat.ts:99` is dead code today. This is the **most consequential single change** in U4.
- Modify: `src/server/routes/chat.ts` — rewrite `formatMessage` and the streaming loop (lines 84–210). Replace the single `formatMessage(SDKMessage): ClientMessage | null` with a stateful emitter that consumes `SDKMessage` events from the SDK stream and writes typed `SseEvent` values via `sendSSE`. State includes the current in-flight `messageId`, the running `parts[]` length (for `partIndex`), the `toolUseId → partIndex` map, AND a `seenStreamParts: Set<partIndex>` for the dedup logic below.
- Create (optional, recommended): `src/server/services/sse-emitter.ts` — a `SseEmitter` class encapsulating the per-stream state so the route handler stays slim.
- Test: deferred (no framework). Verification is a manual scripted run: send a message that exercises a tool call and observe the SSE stream via `curl -N` or browser DevTools.

**Approach:**
- Enable `includePartialMessages: true` in `buildSdkOptions` (see Files). Verify the existing `stream_event` discrimination at `routes/chat.ts:100` actually fires — it does not today.
- The SDK's `stream_event` payload is typed as `BetaRawMessageStreamEvent` upstream but treated locally as `unknown` and discriminated by a string `type` field (matching the existing pattern at `routes/chat.ts:100`). Trade-off: less type safety on the switch, but no new dep on a fast-moving beta type tree. Resolved decision; do not re-litigate during implementation.
- Map `SDKMessage` types to events:
  - `system` (subtype `init`) → `system_init` (preserved from today).
  - `stream_event` with `content_block_start` for a `text` block → emit `assistant_start` (if not yet emitted) then prepare for `text_delta`s. Record `partIndex` in `seenStreamParts`.
  - `stream_event` with `content_block_delta` and `text_delta` → emit `text_delta` carrying `messageId`, `partIndex`, and the delta text.
  - `stream_event` with `content_block_start` for a `tool_use` block → emit `tool_use_start` eagerly so the client can show a streaming affordance before the input arrives. Buffer `input_json_delta`s on the server.
  - `stream_event` with `content_block_delta` and `input_json_delta` → buffer on the server; emit no event (input lands at `tool_use_done`, per Key Decision).
  - `stream_event` with `content_block_stop` for a `tool_use` block → emit `tool_use_done` with the buffered, parsed input.
  - `stream_event` with `content_block_start` for a `thinking` block → emit `thinking_start`.
  - `stream_event` with `content_block_delta` and `thinking_delta` (if the SDK exposes it — verified below) → emit `thinking_delta`.
  - `stream_event` with `content_block_stop` for a `thinking` block → emit `thinking_done`.
  - `assistant` event (whole-turn, arrives after `stream_event`s for the same turn): **dedup logic.** For each block in `content[]`, if its corresponding `partIndex` is already in `seenStreamParts`, do NOT re-emit. The `assistant` event is then a finalizer — emit `assistant_done` once, then clear per-turn state. If a block was NOT seen in streaming (the SDK can emit content blocks via `assistant` that never streamed — e.g., when `includePartialMessages` is on but a particular block type is not streamed), fall through to emit the appropriate `*_start`/`*_done` pair with full content, then `assistant_done`. This is the recovery path mentioned in Open Questions for thinking blocks.
  - `tool_progress` → **dropped entirely.** The new client (U5) ignores it, and `tool_use_start` + `tool_use_done` cover the affordance. Removing it avoids a parallel event vocabulary.
  - `result` → `result` (preserved).
- **Thinking verification step (resolves origin Q at line 113):** before finalizing this unit's emitter, run a workspace session with extended thinking enabled (e.g., `claude-sonnet-4-6` with a prompt that elicits reasoning). Log raw `SDKMessage` to a scratch file. Confirm whether `thinking` content arrives via `stream_event` content blocks, via the whole-turn `assistant` event, or both. The emitter handles all three cases via the dedup logic above; the verification is to ensure the code does the right thing in practice. If thinking arrives only via `assistant`, the Reasoning block lands fully populated with no shimmer phase (acceptable degradation, no separate code path).

**Patterns to follow:**
- Existing `sendSSE` helper (lines 145–148) for event shape.
- Existing `req.on('close')` + `stream.rawQuery.interrupt()` for cancellation (line 168). Unchanged.

**Test scenarios:**
- *Happy path:* a text-only turn produces `assistant_start → text_delta(×N) → assistant_done → result → done`.
- *Happy path:* a turn with one tool call produces `assistant_start → text_delta? → tool_use_start → tool_use_done → tool_result → text_delta? → assistant_done → result → done`.
- *Happy path:* a turn with a thinking block produces `assistant_start → thinking_start → thinking_delta(×N) → thinking_done → text_delta(×N) → assistant_done → result → done` *if* the SDK surfaces thinking via stream; otherwise the protocol cleanly omits in-stream thinking events and emits the populated block at the `assistant` finalizer.
- *Edge case (dedup):* a turn where the same text block arrives first via `stream_event` content_block_delta(s) and then again in the whole-turn `assistant` event produces text_deltas only from the streaming pass — the `assistant` event finalizes (`assistant_done`) but does not re-emit text. Verify by inspecting the wire: total text length equals the assistant's final text exactly (not 2×).
- *Edge case:* `tool_use_id` is preserved exactly as the SDK emits it; downstream `tool_result` arrives with the matching ID.
- *Edge case:* client disconnect mid-stream — `req.on('close')` interrupts the SDK query; no further SSE events are written; the connection closes cleanly.
- *Error path:* SDK throws → `error` event emitted, then `res.end()`. No half-written event lines.
- *Edge case (`includePartialMessages` smoke):* with the option enabled, `stream_event` events arrive on the server stream — log one sample to confirm. Without the option, the `stream_event` branch never fires (the failure mode this unit fixes).
- *Integration:* with U5 wired up, an assistant turn that mixes text + tool + thinking renders all three blocks in the order they appeared.

**Verification:**
- A `curl -N` against `/api/workspaces/:id/sessions/:sid/chat` shows the new event vocabulary for a tool-using prompt. The thinking-emission decision is captured in a one-line comment near the emitter.

---

### U5. Client SSE consumer and in-flight message assembly

**Goal:** `chat-store.ts` consumes the new SSE event vocabulary. The in-flight `ChatMessage` mutates by appending or updating `parts[]` entries; the synthetic `role: 'tool'` sibling is removed. Per-part `state` flips to `'complete'` on `*_done` events.

**Requirements:** R5, R6, R7, R8, R11.

**Dependencies:** U2, U4.

**Files:**
- Modify: `src/client/stores/chat-store.ts` — rewrite `sendMessage` (lines 207–351). Replace string-concatenation with a part-aware state machine that maintains a `toolUseId → partIndex` map for the current in-flight message and handles each event:
  - `assistant_start` → push a new `ChatMessage` with `parts: []`, `isStreaming: true`.
  - `text_delta` → append text to the last text part, or push a new text part if the previous part is not text.
  - `tool_use_start` → push a `tool_use` part with `state: 'streaming'`, empty `input`. Record `toolUseId → partIndex`.
  - `tool_use_done` → set `input` on the matching part, flip `state` to `'complete'`.
  - `tool_result` → push a `tool_result` part with `output`/`isError`.
  - `thinking_start` → push a `thinking` part with `state: 'streaming'`.
  - `thinking_delta` → append text to that part.
  - `thinking_done` → flip `state` to `'complete'`.
  - `assistant_done` → set `isStreaming: false` on the message.
  - `result` → no UI append; consumed for the existing `isStreaming[sessionId]` flag and (new) propagation of `result.isError` as a turn-level failure marker on the assistant message.
  - `tool_progress` (legacy) → ignored.
  - `error` → set `isStreaming: false`; append an error footer (system message or assistant message terminal-error field).
- Modify: drop the `parseSSEStream` data type that assumed string parsing; preserve the SSE parsing loop itself (lines 46–80). It is already event-typed.

**Approach:**
- Introduce a small helper inside the store, `applyServerEvent(state, event)`, that returns the next state. Pure-ish; easier to test if a framework lands.
- The `toolUseId → partIndex` map is per-message (lives on a transient field on the in-flight message), so concurrent streams for different sessions do not collide.
- For session-switch-mid-stream (spec-flow §6): the in-flight write continues to mutate `messages[sessionId]` even after the user navigates away. This is correct behavior (the user sees the resumed stream when switching back). No new code needed.
- **Blast-radius audit before deleting synthetic `role: 'tool'` messages.** Run `grep -rnE "role['\"]?\\s*[:=]\\s*['\"]tool['\"]|\\.role === ['\"]tool['\"]|role:\\s*['\"]tool['\"]" src/` and inspect each hit. Today only `chat-store.ts` writes them (line 314) and `MessageList.tsx` reads them (renders them as a `tool` bubble). Any non-trivial consumer found by the grep gets its own line in this Approach before deletion proceeds — silent deletion of a role used downstream would regress display in a way no test catches.
- **U5 and U6 land atomically** (single PR or commit pair). Between U5 (`chat-store` writes `parts: [tool_use, tool_result, thinking]` parts) and U6 (renderer that displays them), the old `MessageList.tsx` would only see the leading `text` part of a multi-part message — tool calls and thinking content would silently disappear from the UI. The two units must ship together; do not merge U5 alone.

**Patterns to follow:**
- Existing Zustand `set(state => ...)` mutation style with shallow per-key updates (lines 241–303).
- Fine-grained selectors (`useChatStore((s) => s.isStreaming[id])` in `ChatPanel.tsx:17`) — keep selector shapes stable.

**Test scenarios:**
- *Happy path:* event sequence `assistant_start → text_delta('Hello ') → text_delta('world') → assistant_done → result` produces a message with one text part containing `'Hello world'` and `isStreaming: false`.
- *Happy path:* event sequence `assistant_start → tool_use_start(toolUseId=X) → tool_use_done(input={path:'a'}) → tool_result(output='ok', isError=false) → assistant_done` produces a message with `[tool_use(X, complete, {path:'a'}), tool_result(X, 'ok', false)]`.
- *Happy path:* sequence `assistant_start → thinking_start → thinking_delta('considering...') → thinking_done → text_delta('Done') → assistant_done` produces `[thinking(complete, 'considering...'), text('Done')]`.
- *Edge case:* `text_delta` arrives with no preceding `assistant_start` → drop the event with a single dev-mode `console.warn`; do not throw.
- *Edge case:* `tool_result` arrives for an unknown `toolUseId` → append the part anyway with a warning (preserves data, surfaces server bugs).
- *Edge case:* user switches sessions mid-stream → in-flight assembly continues for the original session; new session loads from `messages[newId]` cleanly.
- *Error path:* SSE `error` event → in-flight message gets a terminal error footer; `isStreaming` flips false; subsequent events are ignored.
- *Edge case:* `result.isError === true` → the assistant message is marked as failed (UI surface decided in U6).

**Verification:**
- Send a real message that exercises text + tool + thinking. Verify in DevTools that `messages[sessionId]` contains parts in arrival order with correct `state` transitions.

---

### U6. Replace `MessageList.tsx` with the vendored renderer

**Goal:** New `MessageList.tsx` renders `ChatMessage[]` through `<Conversation>`, `<Message>`, and per-part children: `<Response>` for text, `<Tool>` for tool_use+tool_result pairs, `<Reasoning>` for thinking. Load-state and empty-state are handled per the spec-flow analysis.

**Requirements:** R3, R4, R5, R6, R9, R10, R11.

**Dependencies:** U1, U2, U3, U5.

**Files:**
- Modify: `src/client/components/MessageList.tsx` — full rewrite.
- Modify (minor, if needed): `src/client/components/ChatPanel.tsx` — only if the load-state component needs to move out of `ChatPanel` and into `MessageList` per the spec-flow analysis (§1a). The prompt input area (lines 86–115) MUST NOT change. R10 verification depends on this.
- Test: deferred. Manual verification per AE1, AE2, AE3, AE4.

**Approach:**
- Iterate `messages[sessionId]`. For each message:
  - Wrap in `<Message role={msg.role}>` (vendored component).
  - For each `MessagePart` in order:
    - `text` → `<Response>{part.text}</Response>` (which renders via Streamdown).
    - `tool_use` → look ahead/aside for the paired `tool_result` (same `toolUseId`); render `<Tool>` with both. If unpaired (streaming), render `<Tool>` with the streaming-state affordance and no output yet.
    - `tool_result` → skip (consumed by the matching `tool_use`'s render).
    - `thinking` → `<Reasoning state={part.state}>{part.text}</Reasoning>`.
- Pair tool parts by walking once: build a `toolUseId → resultPart` map upfront, then iterate.
- Load state (`isLoadingMessages`): render a skeleton (e.g., 2–3 dimmed message rows) inside the conversation container, not a centered three-dot pulse — the three dots are reserved for `isStreaming` per spec-flow §1a. The current three-dot block in `ChatPanel.tsx:68–75` is for `isLoadingMessages`; move it into `MessageList` as a list-skeleton or keep it but acknowledge the spec-flow gap. **Default decision:** keep the existing three-dot UI for load (it's familiar) and add per-message skeleton later if needed.
- Empty session: keep today's "Start a conversation" empty-state.
- Streaming dots: when `isStreaming[sessionId]` is true and the latest message has no `parts` yet (S0/S1), show the bouncing-dots affordance under the user message. Once parts arrive, the per-part `state: 'streaming'` shimmers handle the visual progress.

**Patterns to follow:**
- `src/client/components/SessionList.tsx` for list-rendering composition with Tailwind tokens.
- Existing `MessageList.tsx` for the `useChatStore((s) => s.messages[sessionId])` selector shape.

**Test scenarios (manual until test infra lands):**
- *Happy path (AE1):* assistant message with markdown + fenced TypeScript block renders prose and a syntax-highlighted code block with a hover-visible copy button styled in dark + orange tokens.
- *Happy path (AE2):* assistant turn with a `Read` tool call renders a collapsed Tool block labeled "Read"; expanding shows `{ file_path: ... }` and the file contents.
- *Happy path (AE3):* assistant turn with a thinking block followed by a final text answer renders a collapsed Reasoning block above the text; while streaming, the Reasoning block shows a shimmer.
- *Happy path (AE4):* user with an existing session can switch sessions, send a message, and create a new session — the input textarea, session list, and session-management actions behave identically to today.
- *Edge case:* a long assistant turn with `[text, thinking, tool_use, tool_result, text]` parts renders in that order.
- *Edge case:* an unpaired streaming `tool_use` shows the streaming affordance on the Tool block, with no output slot yet.
- *Edge case:* a `tool_result` with `isError: true` renders the Tool block with an error visual.
- *Edge case:* a tool output containing markdown does NOT render as markdown (Assumption: plain text rendering).
- *Edge case:* a fenced code block with an unknown language renders as plain monospace, not crashing the highlighter (spec-flow §5).
- *Edge case:* a partial fenced code block during streaming (unclosed ` ``` `) does not crash the markdown renderer (spec-flow §2 S2).

**Verification:**
- All four AEs pass manually. Devtools confirms no class on the rendered output starts with `bg-background`, `text-foreground`, `text-muted-foreground`, `bg-primary` etc. (per the U1 grep gate, but as a runtime sanity check). The prompt input area is visually pixel-identical to today (compare screenshot before vs after).

---

### U7. End-to-end validation and theming polish

**Goal:** Drive a real Claude Code session through the new renderer; confirm AE1–AE4; resolve any token-mapping or layout drift; capture the verified state of the thinking-block emission path.

**Requirements:** R9 (visual identity), R10, R11, and a full pass of AE1–AE4.

**Dependencies:** U6.

**Files:**
- Modify (if needed): vendored AI Elements files in `src/client/components/ai-elements/` — small theme tweaks (border radius, spacing, message-bubble background) to make the rendered output read as part of the existing app.
- Modify (if needed): `src/client/index.css` — refine the `@keyframes ai-shimmer` to feel consistent with the existing three-dot bounce timing.
- Test: deferred. Verification is a manual checklist below.

**Approach:**
- Open a workspace, create a session, send three prompts:
  1. "Write a TypeScript function that returns the sum of two numbers, with an explanation." → expect markdown + fenced TS block (AE1).
  2. "Read the file `src/client/components/ChatPanel.tsx`." → expect a `Read` tool call with input + output (AE2).
  3. "Think carefully about why this app does X, then answer." → expect a thinking block then a text answer (AE3) — if and only if the SDK exposes thinking via stream (validated in U4).
- Verify AE4 by switching sessions, sending a message in the new one, creating another session, deleting a session.
- Note any visual drift (over-rounded corners, wrong border color, unreadable contrast on `bg-msg-user`) and adjust the vendored Tailwind classes — these are now in the repo, so edits are local and tracked.
- Capture the final state of the thinking-block emission decision in a one-paragraph note appended to this plan's `## Open Questions → Deferred to Implementation`, marking it Resolved with the observed behavior.

**Patterns to follow:** None new — this is verification.

**Test scenarios (manual checklist):**
- AE1 passes.
- AE2 passes; tool input/output expand and collapse smoothly.
- AE3 passes if thinking is exposed via stream; otherwise the load-path equivalent (reload the session and confirm thinking is visible in history) is verified instead.
- AE4 passes; prompt input area is visually identical to pre-U6.
- Session listing, switching, creation, deletion all work.
- No console errors during typical interactions.
- Spec-flow edge cases reviewed: code-block unknown language (no crash), partial fenced code during streaming (no crash), session switch mid-stream (resumes cleanly), `tool_result.isError` (visible error state).

**Verification:**
- All four AEs documented as passing or with explicit, accepted deviations. The thinking-emission Open Question is Resolved.

---

## System-Wide Impact

- **Interaction graph:** The chat data path now flows: `SDK stream → SseEmitter (U4) → SSE wire → chat-store applyServerEvent (U5) → ChatMessage.parts → MessageList renderer (U6)`. The load path: `SDK getSessionMessages → message-normalizer (U3) → REST wire → chat-store.messages → MessageList renderer`. Both paths converge on the same `ChatMessage` shape — that is the load-bearing invariant.
- **Error propagation:** SDK errors surface as SSE `error` events. The renderer attaches them to the in-flight assistant message rather than appending sibling system messages (spec-flow §8a). Network drops without a `done` event surface as a non-terminal stream end; today's behavior of silently stopping is preserved unless a follow-up issue addresses it.
- **State lifecycle risks:** A session deleted mid-stream still has the server writing into an orphaned `messages[sessionId]` entry (spec-flow §6). This is preserved behavior, not new, and is not exposed to the user since the deleted session is no longer addressable in the UI.
- **API surface parity:** The `GET /sessions/:sessionId/messages` response shape changes from `{ messages: SessionMessage[] }` to `{ messages: ChatMessage[] }`. There are no third-party clients of this endpoint — only the web UI consumes it. No versioning required.
- **Integration coverage:** Unit-level coverage on `message-normalizer.ts` (when test infra lands) is insufficient on its own; U7's manual checklist closes the gap.
- **Unchanged invariants:** Session storage (SQLite + JSON drafts), the `/api/workspaces/...` route surface, the SDK options assembly in `chat-service.buildSdkOptions`, the `ChatPanel.tsx` prompt input area, and the workspace-switching, session listing, session creation, and session deletion behaviors are all unchanged. The U1 grep gate plus AE4 verify this.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Streamdown or Shiki bundle weight exceeds expectations for a desktop GUI. | Lazy-load Shiki grammars (Shiki's default behavior); defer optional Streamdown plugins until a session demands them. Validate bundle size in U7 with `npm run build:client` and the resulting dist sizes. If the budget is breached, swap to `react-markdown` + `highlight.js` behind the same vendored file surface (retreat path documented in Assumptions). |
| The Claude Agent SDK 0.2.141 does not emit thinking blocks via the stream channel. | Resolved during U4 by running a real session and observing raw `SDKMessage`. If stream-only is unavailable, thinking arrives via the whole-turn `assistant` event and the emitter's dedup logic handles both cases — the Reasoning block lands fully populated, just without an in-flight shimmer phase. No separate code path. |
| Vendored AI Elements files import a shadcn primitive we didn't anticipate (e.g., transitive `tooltip`). | U1 build-and-render smoke catches this immediately. If found, vendor the missing primitive with the same token-mapping treatment. |
| Token mapping table misses a shadcn class that AI Elements introduced after our research cutoff. | The structural regex gate in U1 fails the build on any unmigrated shadcn class (matches on the utility-prefix × token-name product, not a hand-listed set); update the mapping and re-grep. |
| Parallel-type drift between `src/client/types/message.ts` and `src/server/types/message.ts` (if the single-file path turns out to be blocked by `tsconfig.server.json`'s `rootDir`). | Co-located review (both files always change together) plus an optional pre-commit `diff` check. The single-file path is attempted first per U2's Approach. |
| The U6 visual identity does not feel "ours" even after the token mapping. | U7 reserves time for theme polish; the vendored files are local source and freely editable. |

---

## Documentation / Operational Notes

- No production rollout concern — this is a local-first developer GUI; the only "deployment" is `npm run build`.
- **Test framework decision is deferred** (see Scope Boundaries). The test scenarios in each unit serve as a manual-verification checklist until a framework lands. When one does (Vitest is the natural fit for this Vite/React stack), the scenarios should be ported wholesale.
- **AGENTS.md / CLAUDE.md / STRATEGY.md do not exist** in this repo. No project-instruction constraints apply.
- **Capture institutional learning post-merge** via `/ce-compound` on the SSE protocol design (U4) and on the vendor-in pattern. `docs/solutions/` does not exist yet; this work creates a natural reason to start it.
- **Apache 2.0 obligations:** include the full license text at `LICENSES/ai-elements-apache-2.0.txt`; per-file headers naming the upstream path and the license; no patent grants are imported (Apache 2.0 grants are inbound from Vercel to us as recipients). No NOTICE file from Vercel needs to be reproduced (none ships in the upstream repo at the time of vendoring); confirm during U1 by checking <https://github.com/vercel/ai-elements> for a `NOTICE` file at HEAD.

---

## Sources & References

- **Origin document:** `docs/brainstorms/2026-05-16-ai-elements-message-rendering-requirements.md`
- Reference plan in same repo (for tone/structure): `docs/plans/2026-05-16-005-feat-sdk-session-delegation-plan.md`
- Existing renderer being replaced: `src/client/components/MessageList.tsx`
- Existing flatten points being rewritten: `src/client/stores/chat-store.ts` (lines 166–205, 207–351), `src/server/routes/chat.ts` (lines 84–143)
- AI Elements upstream: <https://github.com/vercel/ai-elements> (Apache 2.0)
- Streamdown: <https://github.com/vercel-labs/streamdown>
- Shiki: <https://shiki.style/>
- Claude Agent SDK reference: <https://code.claude.com/docs/en/agent-sdk/typescript>
