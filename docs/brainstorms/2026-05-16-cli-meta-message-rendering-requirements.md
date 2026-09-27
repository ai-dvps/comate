---
date: 2026-05-16
topic: cli-meta-message-rendering
---

# Render Claude Code CLI Meta Messages as Muted System-Notes

## Summary

User-role messages emitted by the Claude Code CLI sometimes carry XML-shaped wrapper tags — `<command-name>`/`<command-message>`/`<command-args>` (slash-command invocations), `<local-command-stdout>` / `<local-command-stderr>` (local command output), and `<system-reminder>` (internal injections). These currently leak through to the chat transcript as raw XML on the user-role plain-text rendering path. Replace this with a single muted system-note treatment that visually distinguishes meta events from real conversation, pairs invocation with output adaptively, and surfaces long `<system-reminder>` bodies behind an expand affordance.

---

## Problem Frame

The Claude Code Agent SDK delivers these CLI-specific events as ordinary `type: "user"` messages whose `content` is a single string holding the XML wrapper. The server normalizer at `src/server/services/message-normalizer.ts` passes string content through unchanged as a single `{ type: 'text' }` part. `src/client/components/MessageList.tsx` then renders user-role text parts via `<p className="whitespace-pre-wrap">{part.text}</p>` (line 109-112), which surfaces the raw XML verbatim.

The result is that the user sees lines like

```
<command-name>/clear</command-name>
            <command-message>clear</command-message>
            <command-args></command-args>
```

and

```
<local-command-stdout>See ya!</local-command-stdout>
```

interspersed with real conversation. The XML is presentational noise — it leaks an internal protocol surface into a transcript view that is supposed to be a chat.

The fix is purely presentational. The SDK emits these tags by design and the server stores them as-is on the session JSONL; only the client render path needs to change.

---

## Requirements

**Detection**
- R1. The client identifies user-role messages whose trimmed text-part content is exactly one of:
  - the slash-command invocation triplet (`<command-name>...</command-name>`, `<command-message>...</command-message>`, `<command-args>...</command-args>`, in that order, with any whitespace between),
  - a `<local-command-stdout>...</local-command-stdout>` block,
  - a `<local-command-stderr>...</local-command-stderr>` block, or
  - a `<system-reminder>...</system-reminder>` block.
- R2. Messages whose content does not fully match one of the patterns in R1 fall through to the existing user-role text path unchanged. Partial matches (tags embedded inside other prose) do not trigger the new treatment.

**Rendering — slash-command invocation and local-command output**
- R3. Detected slash-command invocations render as a muted system-note in the transcript, distinct in visual treatment from user and assistant chat messages (separator/banner style, dim foreground, no chat-bubble shape).
- R4. Detected local-command output renders as a muted system-note in the same visual family as R3. `<local-command-stdout>` and `<local-command-stderr>` are visually differentiated within that family (subtle tint shift, icon, or label prefix) so failure-mode output is distinguishable from success at a glance.
- R5. When a slash-command invocation is directly adjacent to a single local-command-output message in the visible message list (no intervening user, assistant, or other meta message between them) and the output is short (single-line and within a small character budget), the two render as one combined muted system-note (e.g., `── /clear · See ya! ──`). Any intervening message forces them to render as two separate stacked muted system-notes regardless of output length. When the output is long or multi-line, they also render as two stacked muted system-notes.
- R6. Empty wrapper content is elided in the rendered note: `<command-args></command-args>` does not produce a trailing artifact. `<command-message>` content is treated as redundant — and only the slash-prefixed name is shown — when the message text, trimmed of surrounding whitespace, equals the `<command-name>` payload with its leading `/` stripped (e.g., `clear` for `/clear`).

**Rendering — system reminders**
- R7. Detected `<system-reminder>` blocks render as a muted system-note with the body collapsed to a preview of the first line, capped at ~120 characters regardless of line breaks (a long single-line body truncates mid-line with an ellipsis), followed by a `▾ show more` affordance that expands to reveal the full body on click. The expand affordance is reserved for `<system-reminder>` only — `<local-command-stdout>` and `<local-command-stderr>` always render in full regardless of length.
- R8. The expand state is local to the visual component for the current session view; it does not need to persist across session switches, refreshes, or scrolling.

**Robustness**
- R9. Detection is allowlist-only — the six tag names listed in R1 and nothing else. New tag families discovered later are added to the allowlist explicitly, not inferred from generic XML-shaped content.
- R10. Streaming behavior is unaffected. These tags arrive as complete strings on already-loaded sessions, not as incremental deltas, so the renderer can pattern-match the final content.
- R11. In development builds, the client emits a `console.warn` when a user-role text part's trimmed content begins with `<` and ends with `>` but does not match the R1 allowlist. This surfaces new SDK tag families quickly during upstream evolution; production builds suppress the warning.

**Accessibility**
- R12. Muted system-notes use a non-conversation landmark role (`role="note"` or equivalent) so assistive technologies announce them distinctly from user and assistant chat content.
- R13. The `▾ show more` affordance on `<system-reminder>` notes follows the WAI-ARIA disclosure pattern: the trigger element carries `aria-expanded` reflecting current state and `aria-controls` referencing the collapsed content's element id.

---

## Success Criteria

- For a session containing `/clear` followed by `See ya!`, the transcript shows a single muted note like `── /clear · See ya! ──` instead of two raw-XML messages.
- For a session containing `/reload-plugins` followed by a multi-line output, the transcript shows two stacked muted notes: one for the invocation, one for the output — no raw XML, no chat-bubble shape.
- For a session containing a multi-paragraph `<system-reminder>`, the transcript shows a muted note with the first line of the body and a `▾ show more` affordance that reveals the rest on click.
- A real user message that incidentally contains XML-like content (e.g., a developer asking Claude how to escape `<command-name>` tags inside a longer prose message) renders as ordinary user text — no false-positive system-note rendering.
- No regression in existing message rendering: assistant markdown, tool calls, reasoning blocks, and ordinary user prose behave as before.
- No new console warnings or errors during session load or scroll.

---

## Scope Boundaries

- Not adding affordances on the muted system-note itself beyond the `▾ show more` for `<system-reminder>` — no copy button, no re-run command, no jump-to-source link.
- Not detecting or specially rendering `<bash-input>`, `<bash-stdout>`, `<bash-stderr>`. These appear inside `tool_result` content for the `Bash` tool and are already covered by the existing `Tool` / `ToolOutput` rendering path.
- Not modifying `src/server/services/message-normalizer.ts` to introduce a new `MessagePart` variant. The byte-identical duplication constraint between `src/client/types/message.ts` and `src/server/types/message.ts` is respected — neither file changes. (See Key Decisions.)
- Not changing how the SDK delivers these messages, the on-disk session JSONL format, or any storage layer.
- Not adding a global toggle to show raw XML instead of muted notes.
- Not adding keyboard shortcuts for the expand/collapse affordance.
- Not adding search-into or scroll-to support for muted-note bodies.
- Not virtualizing or paginating sessions with extreme volumes of meta messages.
- Not handling i18n or alternate-language labels.

---

## Key Decisions

- **Visual treatment: muted system-note, not tool-style block.** Chosen during the dialogue. Slash commands and their output are presentationally lighter than assistant tool calls — they are user-driven affordances, not assistant tool invocations. A separator/banner style keeps them visually distinct from chat without inviting the user to treat them as interactive.
- **Adaptive pairing of invocation and output.** Short output collapses into one combined note with the invocation; longer output stacks as a separate note. The threshold (suggested: single-line and ≤ ~80 chars) is set in planning and can be tuned during implementation, but the adaptive rule is the product call.
- **System-reminder body: first-line preview + expand.** System-reminder bodies run multi-paragraph in practice (skill availability notices, hook output, environment context). Inlining the full body would dominate the transcript; hiding it entirely would erase potentially useful information. First-line plus `show more` strikes the compromise. Slash-command and local-command-output muted system-notes have no expand affordance — they stand on their own at their natural length.
- **All four families opted in.** Slash-command invocation, `<local-command-stdout>`, `<local-command-stderr>`, and `<system-reminder>` all receive the muted-note treatment. The unified visual family makes the new primitive worth introducing.
- **Detection is allowlist-only.** No "any XML-looking content" heuristic. Reduces false positives on real user messages that quote tag names, and keeps the detection surface auditable.
- **Client-side detection, no schema change.** The new rendering decision lives in the client renderer (or a small helper module the renderer imports). `MessagePart` keeps its existing discriminated union; the server normalizer does not learn about CLI meta tags. This avoids the byte-identical-duplication migration and lets the feature ship without coordinating across the client/server type boundary. The existing `isToolResultOnly` filter at `src/client/components/MessageList.tsx:36-42` is precedent — meta-message filtering at the visible-messages level is the established pattern in this repo.

---

## Dependencies / Assumptions

- These tags arrive only as user-role messages whose entire content is the XML wrapper. Verified against sampled JSONL session files at `~/.claude/projects/-Users-shunyun-workspace-ai-claude-code-gui/*.jsonl`. If the SDK ever emits one of these tags inside multi-block content or inside assistant messages, the detection rule in R1 leaves those cases on the existing path (no system-note rendering), which is the safe default.
- The empty-content edge cases (`<command-args></command-args>`, slash commands with no `<local-command-stdout>` follow-up such as `/help`) are handled by graceful elision — the rendered note simply omits empty parts.
- The existing rendering pipeline (`MessageList.tsx` plus the vendored AI Elements primitives under `src/client/components/ai-elements/`) is mature enough to absorb a new muted-note primitive alongside `Message`, `Tool`, and `Reasoning` without a structural refactor.
- Dark + accent token palette already in use (`text-text-tertiary`, `border-border/30`, `bg-surface`, etc.) is sufficient for the muted-note visual; no new design tokens required.

---

## Outstanding Questions

### Deferred to Planning

- Where to place the detection logic: inline in `MessageList.tsx`, or factored into a small helper module (e.g., `src/client/lib/cli-meta.ts`) so the render path stays slim. Either is fine.
- The exact short-output threshold for adaptive pairing — character count, line count, or both. Suggested default: output is single-line and ≤ 80 characters. Tune during implementation if it feels off.
- Visual design specifics: exact muted color tokens, separator glyphs (em-dash, en-dash, dotted line), line weight, vertical spacing around the note, and how the note differs from the empty-state placeholder. Should match the existing dark + accent palette; planning surfaces the concrete tokens and primitives.
- Whether the `▾ show more` affordance for `<system-reminder>` uses the existing `Reasoning` component pattern (which already has a trigger/content disclosure shape) or introduces a smaller bespoke disclosure primitive. Planning decides based on coupling cost and visual fit.
- Behavior for a slash-command invocation that is followed by no local-command-output at all (e.g., async, assistant-handled, or no-op commands like `/help` when there is no local handler response). Suggested default: render the invocation alone as a muted system-note. Planning confirms.
- If the transcript ever virtualizes (windowed re-mount on scroll), component-local expand state on `<system-reminder>` notes resets when the row leaves the viewport. Decide: explicitly scope-out virtualization and document the limitation, or lift expand state to a parent store keyed by message-id so it survives re-mount.
- If a future SDK shape splits the XML wrapper across multi-block content (rather than a single string text part), the R1 allowlist would silently fall through to raw text. Decide: detect-and-stitch across blocks, render the multi-block form as raw text, or treat as out-of-scope and document the assumption.
- If the SDK ever emits one of the wrapper tags inside an assistant-role message rather than a user-role message, the R1 allowlist (which gates on user-role only) leaves them on the existing render path. Decide whether assistant-side detection is in scope, or document the user-role-only assumption explicitly.
- Specify the normalized form for the slash-command triplet detection regex: how CR/LF, tabs, and leading/trailing whitespace inside each tag's text content are handled. Suggested default: collapse all inter-tag whitespace to optional `\s*` and trim tag-content whitespace before equality checks for R6 redundancy.
- Behavior when `<local-command-stdout></local-command-stdout>` is empty (the wrapper present, body absent). Suggested default: suppress the empty-output note entirely so the paired invocation stands alone; planning confirms or chooses pair-with-no-body.

