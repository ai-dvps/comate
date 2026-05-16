---
title: 'feat: Render Claude Code CLI meta messages as muted system-notes'
type: feat
status: completed
date: 2026-05-16
origin: docs/brainstorms/2026-05-16-cli-meta-message-rendering-requirements.md
---

# feat: Render Claude Code CLI meta messages as muted system-notes

## Summary

Replace raw-XML rendering of Claude Code CLI wrapper tags (`<command-name>` triplet, `<local-command-stdout>`, `<local-command-stderr>`, `<system-reminder>`) in the chat transcript with a unified muted system-note primitive. Detection and rendering live entirely in the client: a pure helper module (`src/client/lib/cli-meta.ts`) classifies eligible user-role messages and pairs slash-command invocations with short adjacent outputs; a new visual primitive (`src/client/components/ai-elements/muted-system-note.tsx`) renders the four variants and a paired form; `MessageList.tsx` runs the transform before its existing render path. No server or schema changes — the byte-identical `MessagePart` duplication between client and server type files (`src/client/types/message.ts` and `src/server/types/message.ts`) is preserved.

## Problem Frame

The Claude Code Agent SDK delivers slash-command invocations, local-command output, and internal system reminders as ordinary `type: "user"` messages whose `content` is a single string holding XML wrapper tags. The server normalizer (`src/server/services/message-normalizer.ts:86`) passes string content through unchanged as a single `{ type: 'text' }` part, and `MessageList.tsx:109-112` renders user-role text parts as `<p className="whitespace-pre-wrap">{part.text}</p>`. The result is that lines like `<command-name>/clear</command-name>` and `<local-command-stdout>See ya!</local-command-stdout>` leak into the transcript verbatim, interleaved with real conversation. This is presentational noise — the SDK emits these tags by design and the server records them as-is on the session JSONL; only the client renderer needs to change.

## Requirements

Carried forward from the origin brainstorm doc unchanged. See `docs/brainstorms/2026-05-16-cli-meta-message-rendering-requirements.md` for full text.

**Detection**
- R1. Identify user-role messages whose trimmed text-part content is exactly one of the four wrapper forms: slash-command triplet, `<local-command-stdout>`, `<local-command-stderr>`, `<system-reminder>`.
- R2. Partial matches and tags embedded in prose fall through to the existing user-role text path.

**Rendering — slash-command and local-command**
- R3. Slash-command invocation renders as a muted system-note (separator/banner style, dim foreground, no chat-bubble shape).
- R4. Local-command output renders as a muted system-note in the same visual family as R3, with `<local-command-stdout>` and `<local-command-stderr>` visually differentiated (subtle tint shift, icon, or label prefix).
- R5. Adjacent slash-command + single short local-command-output (single-line, ≤80 chars) render as one combined muted system-note (e.g., `── /clear · See ya! ──`). Any intervening visible message — or long/multi-line output — forces two stacked muted system-notes.
- R6. Empty `<command-args></command-args>` is elided; redundant `<command-message>` content (the slash-stripped name) collapses so only the slash-prefixed name renders.

**Rendering — system reminders**
- R7. `<system-reminder>` collapses to a preview of the first line, capped at ~120 characters (long single-line bodies truncate mid-line with an ellipsis), with a `▾ show more` affordance that reveals the full body on click. The expand affordance is reserved for `<system-reminder>`; `<local-command-stdout>` and `<local-command-stderr>` always render in full.
- R8. Expand state is local to the component for the current view; no cross-session, cross-refresh, or cross-scroll persistence required.

**Robustness**
- R9. Detection is allowlist-only — six tag names; new families are added explicitly.
- R10. Streaming is unaffected — tags arrive as complete strings on loaded sessions, not as incremental deltas.
- R11. Development builds emit a single `console.warn` per render pass when a user-role text part's trimmed content begins with `<` and ends with `>` but does not match the R1 allowlist. Production builds suppress the warning.

**Accessibility**
- R12. Muted system-notes use `role="note"` so assistive tech announces them distinctly from chat content.
- R13. The `▾ show more` affordance follows the WAI-ARIA disclosure pattern — `aria-expanded` reflects state and `aria-controls` references the content element id.

## Context & Research

### Relevant Code and Patterns

- `src/client/components/MessageList.tsx` — sole consumer of the chat-transcript render path. The existing `isToolResultOnly` filter at lines 36-42 is the precedent for visible-messages-level meta filtering. The user-role text rendering at lines 109-112 is the leak point this plan replaces. The transform produced by the helper module slots in before the existing `messages.map(...)`.
- `src/server/services/message-normalizer.ts:86` (`partsFromSdkContent`) — emits one `{ type: 'text', text: content }` for string content. Untouched by this plan.
- `src/client/types/message.ts` + `src/server/types/message.ts` — byte-identical-duplicated `MessagePart` discriminated union. CI verifies via `diff`. This plan does not introduce a `meta` variant — detection lives one layer up in the renderer.
- `src/client/components/ai-elements/` — vendored Vercel AI Elements primitives (Apache 2.0 headers) plus locally authored `response.tsx`. The new `muted-system-note.tsx` follows the `response.tsx` precedent (locally authored, no adaptation header).
- `src/client/components/ui/collapsible.tsx` — shadcn wrapper around `@radix-ui/react-collapsible` 1.1. Radix auto-wires `aria-expanded` and `aria-controls` on the trigger, satisfying R13 without bespoke ARIA code.
- `src/client/components/ai-elements/reasoning.tsx` — existing disclosure-shaped primitive in the codebase. We use `Collapsible` directly rather than imitating `Reasoning`'s richer streaming/duration shell: a single static body with no streaming or timer doesn't need that scaffolding.
- `src/client/index.css` — global Tailwind layer; existing tokens `text-text-tertiary`, `border-border/30`, `bg-surface`, `text-text-secondary` are sufficient. No new design tokens needed.

### External References

- WAI-ARIA Authoring Practices: Disclosure (Show/Hide) pattern — `aria-expanded` on the trigger element, `aria-controls` referencing the disclosed content's id.
- Sampled JSONL session files at `~/.claude/projects/-Users-shunyun-workspace-ai-claude-code-gui/*.jsonl` confirm the four tag families arrive only as single-string user-role content. The R1 allowlist is the verified delivery shape.

### Institutional Learnings

- None — `docs/solutions/` does not exist in this repo yet.

## Key Technical Decisions

- **Client-side detection only; no schema change.** The new rendering decision lives in the client render path. `MessagePart`'s discriminated union and the byte-identical duplication between `src/client/types/message.ts` and `src/server/types/message.ts` are preserved. The existing `isToolResultOnly` filter at `MessageList.tsx:36-42` is the precedent for visible-messages-level meta filtering.
- **Helper module separate from `MessageList.tsx`.** Pure functions (detection, allowlist check, adjacency pairing) live in `src/client/lib/cli-meta.ts`. Keeps the renderer slim and makes the parse + pair logic unit-testable in isolation if a test harness is later introduced. No React import in the helper.
- **Pairing threshold: single-line AND ≤80 characters.** The brainstorm doc suggested this default; planning adopts it as-is. The combined-note form (`── /clear · See ya! ──`) is most legible when the output fits comfortably alongside the invocation. Multi-line outputs always stack.
- **Reuse the vendored Radix `Collapsible` for `<system-reminder>` disclosure.** `Reasoning` is the other shaped option but carries streaming and duration scaffolding that doesn't apply here. `Collapsible` is the smaller primitive and Radix's auto-wired `aria-expanded`/`aria-controls` cover R13 without manual ARIA code.
- **Locally authored primitive (no AI Elements adaptation header).** `muted-system-note.tsx` is not a port of an upstream AI Elements component — it follows the `response.tsx` precedent of locally authored primitives sitting beside the vendored ones in `src/client/components/ai-elements/`.
- **Dev-warning emits once per render pass, deduplicated by text content.** R11 is a fast-evolving-SDK signal, not a debugging aid for individual messages. A `Set<string>` in module scope dedupes within a session so a long transcript doesn't flood the console.
- **Manual dev-server verification only.** Per the precedent set by `docs/plans/2026-05-16-007-fix-session-message-list-scroll-plan.md`, this repo has no client-side component test harness and standing one up for a presentational feature is disproportionate. Test scenarios per unit are enumerated below.
- **Scope-outs (carried from origin):** transcript virtualization, multi-block content shape splits, assistant-role wrapper-tag emission. Each is documented as an assumption rather than handled defensively.

## Implementation Units

### U1. Detection and pairing helper

**Goal:** Provide pure functions that (a) classify a single user-text string against the R1 allowlist, (b) report whether arbitrary text has wrapper shape (for R11), and (c) transform a `ChatMessage[]` into a render-ready `ViewItem[]` with adjacent slash-command + short-output pairs combined per R5.

**Requirements:** R1, R2, R5, R6, R9, R10.

**Dependencies:** None.

**Files:**
- Create: `src/client/lib/cli-meta.ts`

**Approach:**

- Export a discriminated union `CliMetaEvent`:
  - `{ kind: 'slash-command'; name: string; message: string; args: string }`
  - `{ kind: 'local-stdout'; body: string }`
  - `{ kind: 'local-stderr'; body: string }`
  - `{ kind: 'system-reminder'; body: string }`
- Export named sub-event aliases derived from the union — `ViewItem` and `MutedSystemNote`'s discriminated props reference these aliases by name rather than re-deriving them at each call site:
  - `export type SlashCommandEvent = Extract<CliMetaEvent, { kind: 'slash-command' }>`
  - `export type LocalStdoutEvent = Extract<CliMetaEvent, { kind: 'local-stdout' }>`
  - `export type LocalStderrEvent = Extract<CliMetaEvent, { kind: 'local-stderr' }>`
  - `export type SystemReminderEvent = Extract<CliMetaEvent, { kind: 'system-reminder' }>`
- Export `detectCliMeta(text: string): CliMetaEvent | null`. Trim leading/trailing whitespace, then test the four patterns in order:
  - Slash-command triplet: one regex with optional `\s*` between the three tags, anchored start-to-end (`^…$`) on the trimmed input. Capture each tag's text content; trim each captured group's leading/trailing whitespace.
  - Single-tag forms: `^\s*<local-command-stdout>([\s\S]*)</local-command-stdout>\s*$`, same for `stderr` and `system-reminder`. The body capture preserves interior whitespace verbatim (multi-line stdout, system-reminder paragraphs).
- Export `isWrapperShape(text: string): boolean`. Returns true if `text.trim()` starts with `<` and ends with `>`. Used only by the dev-warning emitter — does not gate detection.
- Export a render-shape discriminated union `ViewItem`:
  - `{ kind: 'message'; message: ChatMessage }`
  - `{ kind: 'meta'; event: CliMetaEvent; messageId: string }`
  - `{ kind: 'meta-paired'; slash: SlashCommandEvent; output: LocalStdoutEvent | LocalStderrEvent; messageIds: [string, string] }`
- Export `pairCliMeta(messages: ChatMessage[]): ViewItem[]`. Single linear pass:
  - For each message, derive the canonical text (concatenate all `type: 'text'` parts; ignore messages with non-text parts as they fall through to `kind: 'message'`).
  - User-role messages whose canonical text matches `detectCliMeta` become candidate meta entries; everything else becomes `kind: 'message'`.
  - After the first pass, run a second pass to combine each slash-command meta entry with the very next entry when (a) the next entry is `kind: 'meta'` with `local-stdout` or `local-stderr`, (b) the output `body.trim()` is single-line (no `\n`) and ≤80 characters after trim, and (c) no `kind: 'message'` entry sits between them. The combined entry uses `kind: 'meta-paired'`.
  - Empty `local-stdout` and `local-stderr` (`body.trim() === ''`) are dropped entirely from the `ViewItem[]` — per origin doc's OQ default, the paired invocation stands alone.
- Apply R6 redundancy at parse time: in the `slash-command` event, if `message.trim()` equals `name.replace(/^\//, '')`, set `message` to the empty string. The primitive treats empty `message` as redundant and omits it.

**Patterns to follow:**

- Pure-module style: no React imports, no module-level mutable state beyond the dev-warning dedupe Set documented in U3. `src/client/lib/` is created by this plan, and `cli-meta.ts` is its first occupant.
- The `ChatMessage` import comes from `src/client/types/message.ts`. The `ViewItem` and `CliMetaEvent` types are exported from this module — no client/server duplication required (these types are not transmitted).

**Test scenarios:**
<!-- Manual verification per the repo's existing pattern (plan 007) — exercised end-to-end through U3 in the dev server. -->
- `/clear` followed by `See ya!` → `pairCliMeta` returns a single `meta-paired` ViewItem.
- `/clear` followed by an 81-character single-line stdout → returns two consecutive `meta` ViewItems, not paired.
- `/clear` followed by a multi-line stdout → two consecutive `meta` ViewItems.
- `/clear`, then a normal assistant message, then `See ya!` → three `ViewItem`s (`meta`, `message`, `meta`), not paired.
- `/help` followed by no output → single `meta` ViewItem.
- `<command-args></command-args>` in the triplet → slash-command event carries `args: ''`, primitive renders no args.
- `<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>` → `message` is normalized to `''` so the primitive shows only `/clear`.
- `<command-name>/exit</command-name><command-message>exit then save</command-message><command-args></command-args>` → `message` survives as `'exit then save'` and is rendered alongside the name.
- `<local-command-stdout></local-command-stdout>` empty → dropped from `ViewItem[]`.
- `<local-command-stdout>line 1\nline 2</local-command-stdout>` → `meta` ViewItem with multi-line body, not pair-eligible.
- `<system-reminder>Single-line short body.</system-reminder>` → `meta` ViewItem.
- A 600-character single-line `<system-reminder>` body → `meta` ViewItem with full body intact (truncation is the primitive's concern, not the helper's).
- A user message reading `How do I escape <command-name> tags in my prose?` → `kind: 'message'` (allowlist requires full-content match).
- Detection runs in O(n) over messages — no nested scans.

**Verification:**
- Manual dev-server tests in U3 exercise these paths.
- `npm run lint` passes with zero warnings (config uses `--max-warnings 0`).
- `npm run build` passes type-check.

### U2. MutedSystemNote primitive

**Goal:** Provide a single visual primitive that renders any `CliMetaEvent` (or paired form) as a muted system-note, with stdout/stderr visually differentiated and `<system-reminder>` collapsed to a first-line preview behind a Radix `Collapsible` disclosure.

**Requirements:** R3, R4, R5, R6, R7, R8, R12, R13.

**Dependencies:** U1 (imports the `CliMetaEvent` and the paired shape).

**Files:**
- Create: `src/client/components/ai-elements/muted-system-note.tsx`

**Approach:**

- Single component `MutedSystemNote` with a discriminated prop:
  - `{ kind: 'single'; event: CliMetaEvent }`
  - `{ kind: 'paired'; slash: SlashCommandEvent; output: LocalStdoutEvent | LocalStderrEvent }`
- Outer wrapper: a `<div role="note">` with separator-banner Tailwind classes (`my-2 flex items-center gap-2 text-xs text-text-tertiary`). The visual identity is a pair of `border-t border-border/30 flex-1` rules flanking the centered content — this gives the `──  ··  ──` rule-with-content shape without a chat bubble. The centered content span uses `whitespace-pre-wrap break-words min-w-0` so long slash-command messages, args, or paired stdout (which is already ≤80 chars by R5) wrap cleanly within the rule pair rather than forcing horizontal overflow. Final tokens settle during implementation; the brainstorm doc's existing palette guidance (`text-text-tertiary`, `border-border/30`) is the starting point.
- Variant rendering:
  - **slash-command:** `<span>/<name></span>`; if `event.message` is non-empty (post-R6 normalization), append ` · {message}`; if `event.args` is non-empty, append ` · {args}`.
  - **local-stdout:** prefix label `stdout` with no tint shift; body in `whitespace-pre-wrap` so multi-line content keeps its shape.
  - **local-stderr:** prefix label `stderr` with the accent color shifted toward error (`text-status-error` if available in the palette, else `text-text-secondary` with bold weight to differentiate at a glance). Final token settles during implementation.
  - **system-reminder:** see below.
  - **paired:** render as `── /name [· message] · {output-body} ──`; the trimmed single-line output sits directly after the invocation, separated by `·`. Uses the same outer wrapper (single rule pair) — visually one note, not two.
- System-reminder disclosure:
  - First-line preview: take `body.split('\n')[0]`, then if its length exceeds 120 characters truncate to `body.slice(0, 120) + '…'` regardless of line breaks (R7's "long single-line body truncates mid-line").
  - Wrap the body in `Collapsible` / `CollapsibleTrigger` / `CollapsibleContent` from `src/client/components/ui/collapsible.tsx`. The trigger element is the `▾ show more` / `▴ show less` toggle. Radix wires `aria-expanded` on the trigger and `aria-controls` referencing the content's auto-generated id — R13 is satisfied without manual ARIA.
  - The trigger element carries `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1` so keyboard users see a visible focus indicator that matches the existing accent token. The trigger is a native `<button>` (Radix default) so tab order is correct without `tabIndex` overrides.
  - The trigger and the preview text sit on the same line; when expanded, the full body renders below in `<pre className="whitespace-pre-wrap text-text-secondary">`.
  - State is held via `useState(false)` inside the component; per R8 it does not persist anywhere.
- Local component state and no internal effects — the primitive is fully presentational.
- No AI Elements adaptation header. The file leads with a brief intent comment so future readers see why it sits in `ai-elements/` alongside vendored primitives.

**Patterns to follow:**

- `src/client/components/ai-elements/response.tsx` — locally authored primitive in the same folder, no upstream adaptation header.
- `src/client/components/ai-elements/reasoning.tsx` — adjacent disclosure-shaped component; the visual treatment of its trigger affordance is a useful reference, but the streaming/duration scaffolding does not apply here and is intentionally omitted.

**Test scenarios:**
<!-- Manual verification end-to-end through U3 in the dev server. -->
- Slash-command-only note renders as `── /clear ──` with no trailing artifact (empty `command-args` elided).
- Slash-command with non-redundant `command-message` renders both name and message: `── /exit · exit then save ──`.
- Paired note renders as `── /clear · See ya! ──` — single rule pair, single line.
- Stdout note with multi-line body preserves line breaks in `whitespace-pre-wrap`.
- Stderr note is visually distinguishable from stdout at a glance (label prefix or tint).
- System-reminder note with a short first line shows the line + `▾ show more`; click toggles to the full body and `▴ show less`.
- System-reminder note with a single-line 600-character body shows a mid-line ellipsis at ~120 chars in the collapsed state.
- Disclosure trigger announces correctly in a screen-reader spot check: expanded state toggles `aria-expanded`; the content's id is referenced by `aria-controls`.
- `role="note"` is present on the wrapper.

**Verification:**
- Manual dev-server checks above pass on the development browser.
- `npm run lint` and `npm run build` pass.

### U3. MessageList integration

**Goal:** Wire the helper + primitive into the existing render path. Replace the user-role text leak with the `ViewItem[]` transform, render each `ViewItem` via the appropriate path, and emit the dev-only console warning for unknown wrapper-shape content.

**Requirements:** R1, R2, R3, R4, R5, R7, R10, R11.

**Dependencies:** U1, U2.

**Files:**
- Modify: `src/client/components/MessageList.tsx`

**Approach:**

- Import `pairCliMeta`, `detectCliMeta`, `isWrapperShape`, and `MutedSystemNote`.
- Replace the existing `visibleMessages.map(...)` body with a transform: `const viewItems = pairCliMeta(visibleMessages)`. Map each `ViewItem` to a React node by `kind`:
  - `'message'` → existing `<Message>` rendering path, unchanged (preserves the assistant markdown, tool calls, reasoning, ordinary user prose behaviors enumerated in the origin's success criteria).
  - `'meta'` → `<MutedSystemNote kind="single" event={item.event} />`; React `key` is the source `messageId`.
  - `'meta-paired'` → `<MutedSystemNote kind="paired" slash={item.slash} output={item.output} />`; React `key` is the first `messageId` from the pair.
- Add a dev-only warning emitter. The deduplication `Set<string>` lives at module scope in `MessageList.tsx` (not in `cli-meta.ts`) so the helper module stays free of mutable state and the warning iteration sits beside the render pass that produced it:
  - Declare a module-level `const warnedShapes = new Set<string>()` at the top of `MessageList.tsx` (above the component).
  - Inside the component, run the iteration in a `useEffect` keyed on `visibleMessages` so the side effect fires once per visible-messages change rather than on every render. Vite's `import.meta.env.DEV` constant gates the entire `useEffect` body so Rollup tree-shakes the block — and the `warnedShapes` constant itself — from production bundles:
    - In the effect body, iterate `visibleMessages`: for each user-role message whose canonical text passes `isWrapperShape` but fails `detectCliMeta`, and whose text is not in `warnedShapes`, call `console.warn('cli-meta: unrecognized wrapper shape', { sample: text.slice(0, 160) })` and add the text to the set.
  - The `useEffect` has no cleanup — `warnedShapes` is intentionally process-lived to suppress repeat warnings across re-renders and route changes within one page session.
- Leave the `isToolResultOnly` filter (lines 36-42) and all other existing logic untouched.

**Patterns to follow:**

- `MessageList.tsx`'s existing `isToolResultOnly` filter — the established precedent for visible-messages-level meta filtering. The new transform sits one layer above the existing filter (operates on `visibleMessages` after `isToolResultOnly` has already discarded tool-only messages).
- Vite environment-flag gating via `import.meta.env.DEV` — Vite statically replaces `import.meta.env.DEV` with `true` in `vite dev` and `false` in `vite build`, and Rollup tree-shakes the dead branch from production bundles. First usage of the pattern in this codebase.

**Test scenarios:**
<!-- Manual verification per plan 007's pattern. Open a session in the dev server and exercise the paths. -->
- Open a session containing `/clear` followed by `See ya!` → the transcript shows a single muted note `── /clear · See ya! ──` instead of two raw-XML messages.
- Open a session containing `/reload-plugins` followed by multi-line stdout → two stacked muted notes, no raw XML, no chat-bubble shape.
- Open a session containing a multi-paragraph `<system-reminder>` → muted note with first-line preview + `▾ show more`; click expands to full body, click again collapses.
- Open a session where a user message contains literal `<command-name>` inside otherwise normal prose → renders as ordinary user text, no system-note rendering, no false positive.
- Switch between sessions → expand state for `<system-reminder>` resets cleanly (per R8); no carry-over.
- Streaming a fresh assistant response in a session that already contains meta-notes → no regression in the streaming path (R10); meta notes remain stable above the streaming row.
- Scroll a long session up and down → `use-stick-to-bottom` behavior unchanged (the plan 007 fix is preserved); no double scrollbars, no layout shift from the new notes.
- Inspect the DevTools console in `npm run dev` → on a session containing an unrecognized wrapper shape (e.g., a hypothetical `<unknown-tag>...</unknown-tag>` injected into a test JSONL), a single `console.warn` fires for that shape; reloading the session does not re-warn (Set survives within the page session).
- Build a production bundle and load it (or open `npm run preview`) → no `console.warn` fires for unrecognized wrapper shapes (the `import.meta.env.DEV` block is tree-shaken).
- ARIA spot check: screen reader (VoiceOver on macOS) announces muted notes distinctly from user/assistant content (`role="note"`); the disclosure trigger reports its expanded/collapsed state.

**Verification:**
- All test scenarios pass in a manual dev-server run.
- No console errors during session load, scroll, or session switch.
- `npm run lint` passes with zero warnings.
- `npm run build` passes type-check.

## Scope Boundaries

Carried from the origin doc, plus follow-up boundaries surfaced by planning.

**Out (carried from origin):**

- No additional affordances on the muted system-note beyond the `▾ show more` for `<system-reminder>` — no copy button, no re-run command, no jump-to-source link.
- No detection or special rendering of `<bash-input>`, `<bash-stdout>`, `<bash-stderr>` — already covered by the existing `Tool` / `ToolOutput` render path for the `Bash` tool.
- No modification to `src/server/services/message-normalizer.ts` and no new `MessagePart` variant. The byte-identical duplication between `src/client/types/message.ts` and `src/server/types/message.ts` is preserved.
- No change to the SDK delivery shape, the on-disk session JSONL format, or any storage layer.
- No global toggle to show raw XML instead of muted notes.
- No keyboard shortcuts for the expand/collapse affordance.
- No search-into or scroll-to support for muted-note bodies.
- No virtualization or pagination for sessions with extreme meta-message volume.
- No i18n or alternate-language labels.

### Deferred to Follow-Up Work

- Wrapper-tag emission in *assistant-role* messages — if the SDK ever evolves to emit these tags inside assistant content, the R1 allowlist (gated on user-role only) leaves them on the existing render path. Plan: revisit only when the SDK actually emits them.
- Wrapper tags split across *multi-block* content (multiple `text` parts within one message instead of a single string) — same fallback: the allowlist's full-content match silently falls through to raw text. Plan: revisit when observed.
- Cross-mount persistence of `<system-reminder>` expand state — if a future virtualization or windowing change re-mounts message rows, the local `useState` will reset. R8 explicitly accepts this. Revisit if virtualization lands.

## Dependencies / Assumptions

- The four wrapper-tag families arrive only as user-role messages whose entire content is the single wrapper-XML string. Verified against sampled JSONL session files at `~/.claude/projects/-Users-shunyun-workspace-ai-claude-code-gui/*.jsonl`.
- The brainstorm doc's empty-content edge cases (`<command-args></command-args>`, slash commands with no `<local-command-stdout>` follow-up such as `/help`) are handled by graceful elision in U1 and U2.
- The existing rendering pipeline (`MessageList.tsx` + vendored AI Elements primitives under `src/client/components/ai-elements/`) absorbs a new primitive without structural refactor — `response.tsx` is the precedent for locally authored primitives in that folder.
- Dark + accent token palette in use (`text-text-tertiary`, `border-border/30`, `bg-surface`, `text-text-secondary`) is sufficient. No new design tokens introduced.
- `@radix-ui/react-collapsible` 1.1 (wrapped by `src/client/components/ui/collapsible.tsx`) auto-wires `aria-expanded` on the trigger and `aria-controls` referencing the content's auto-generated id, satisfying R13 without manual ARIA code.
- Vite's `import.meta.env.DEV` constant is statically replaced at build time, ensuring the R11 dev-warning block is removed from production bundles.
- Manual dev-server verification is the established verification pattern in this repo (per `docs/plans/2026-05-16-007-fix-session-message-list-scroll-plan.md`). Introducing a client-side test harness for a presentational feature is out of scope.

## Outstanding Questions

All planning-time questions from the origin brainstorm doc have been resolved during this pass. The items below are intentionally pushed to implementation — small visual/contractual choices that read better against the dev server than against the plan body.

### Deferred to Implementation

- **Exact muted color tokens and rule glyph.** Final pick between (a) two flanking `border-t border-border/30 flex-1` rules with a centered span, (b) Unicode em-dash `──` glyphs, (c) a single horizontal rule with overlaid label. Whichever reads cleanest beside the existing chat bubbles in the dev server wins. The current palette tokens (`text-text-tertiary`, `border-border/30`) are the starting point.
- **Stderr differentiation: label prefix vs tint shift vs icon.** A label prefix (`stderr:`) is the lowest-effort and most explicit. If the existing palette includes a status-error or warning accent, a tint shift can stack on top. Final pick lands during U2 visual implementation.
- **Dev-warning console payload shape.** The exact object shape passed to `console.warn` (e.g., `{ sample, length, messageId }`) is a small detail of U3. The contract is: one warn per unique text content per page session, gated on `import.meta.env.DEV`.

## Sources & References

- Origin requirements doc: `docs/brainstorms/2026-05-16-cli-meta-message-rendering-requirements.md` (R1-R13, key decisions, scope boundaries).
- Predecessor plan: `docs/plans/2026-05-16-007-fix-session-message-list-scroll-plan.md` — established manual dev-server verification as the repo's verification pattern.
- Predecessor plan: `docs/plans/2026-05-16-006-feat-ai-elements-message-rendering-plan.md` — introduced the vendored AI Elements primitives, including the locally authored `response.tsx` precedent followed by `muted-system-note.tsx`.
- Library: `@radix-ui/react-collapsible` 1.1, wrapped by `src/client/components/ui/collapsible.tsx`.
- WAI-ARIA Authoring Practices: Disclosure pattern (`aria-expanded`, `aria-controls`).
