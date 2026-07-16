---
title: Result-Focus Ghost Key Parameter - Plan
type: feat
date: 2026-07-16
topic: result-focus-ghost-key-param
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
---

# Result-Focus Ghost Key Parameter - Plan

## Goal Capsule

- **Objective:** Surface the latest tool's key parameter inside the collapsed result-focus process ghost, so a user sees what the agent is doing without opening the detail drawer.
- **Product authority:** A display enhancement to an existing mode. Product behavior and scope were decided in the brainstorm; this plan owns the implementation approach.
- **Open blockers:** None.
- **Execution profile:** code; small, single-component change that reuses existing summary and truncation utilities.
- **Tail ownership:** lands in one PR; no migration, no server change.

---

## Product Contract

> Product Contract mostly preserved — R1, R2, R4–R6, the rest of the Acceptance Examples, and Scope Boundaries are as the brainstorm set them. Two review-driven changes: the per-tool field-mapping question is resolved by reusing `summarizeToolInput` (Planning Contract); and R3/AE5 are weakened from live-during-streaming to parameter-on-completion, user-confirmed, because the store keeps `part.input` empty (`{}`) until a tool completes (see KTD4).

### Summary

In result-focus mode, the collapsed process ghost shows the latest tool's key parameter next to its name — `Bash ▸ npm test`, `Edit ▸ …/BashRenderer.tsx`, `Grep ▸ "useState"`. The parameter fills the available message width on one line and only smart-slices when it overflows. The `Process · N steps · 时长` prefix and the click-to-open detail drawer are unchanged.

### Problem Frame

Result-focus mode collapses an assistant turn's thinking and tool runs into one low-weight ghost so the final answer reads cleanly. The trade-off today is that the ghost shows only the bare tool name (`Bash`, `Edit`) or `Thinking`. A user scanning the turn cannot tell which file was edited or which command ran without clicking each region open. The cost is friction at the exact moment people want a quick progress read; the detail is one click away but invisible at a glance.

### Key Decisions

- **Latest-step only.** Only the most recent tool in a process region shows its key parameter; earlier steps stay collapsed. Surfacing every step would re-clutter the view the mode exists to simplify, and matches the "a bit more info" intent.
- **Fill available width over a compact cap.** The parameter may use the full available message width (roughly the column width minus the prefix) before truncating. This prioritizes seeing the whole value; the accepted cost is that a long command makes the ghost visually wider and heavier than its original low-weight intent.
- **Smart-slice is the overflow fallback, not the default.** Show the full value when it fits; only when it overflows reduce to the recognizable slice — basename for file paths, command verb for shell commands — with a trailing `…`. Common short parameters are not shortened needlessly.
- **Derive the parameter from existing data.** The key parameter comes from the tool_use `input` already carried on the part; file paths reuse the existing `basename()` helper. No new data source or server change.

### Requirements

**Display content**

- R1. The ghost shows the latest tool's key parameter inline, after the tool name (for example `Bash ▸ npm test`, `Read ▸ src/client/Foo.tsx`).
- R2. Thinking parts keep showing `Thinking`; a tool with no known key parameter falls back to the tool name only, preserving current behavior.
- R3. The parameter appears once the tool's input is complete; while the input is still streaming, the ghost shows the tool name only.
- R4. The parameter renders on one line, filling the available message width before truncating; on overflow it smart-slices to the basename for file paths and the command verb for shell commands, ending in `…`.
- R5. The `Process · N steps · 时长` prefix, the click-to-open detail drawer, and the drawer's full content stay unchanged.
- R6. The ghost's accessible label includes the key parameter, not only the tool name.

### Acceptance Examples

Today versus after, at a glance:

```text
before:  Process · 5 steps · 12s · Bash ▾
after:   Process · 5 steps · 12s · Bash ▸ npm test ▾
```

- AE1. **Covers R1, R4.** A `Read` whose `file_path` fits the available width renders the full path: `Read ▸ src/client/components/ChatPanel.tsx`.
- AE2. **Covers R4.** A deep path that overflows renders the basename with a leading ellipsis: `Edit ▸ …/BashRenderer.tsx`.
- AE3. **Covers R4.** A long command that overflows renders the verb portion and ellipsis: `Bash ▸ npm run test:client …`.
- AE4. **Covers R2.** A thinking-only region renders `Thinking`; an unrecognized tool with no known key parameter renders its tool name only.
- AE5. **Covers R3.** While a `Bash` command is still streaming, the ghost shows `Bash`; once the input completes it shows `Bash ▸ npm test`. (Live partial display during streaming is out of scope — see KTD4.)

### Scope Boundaries

- **Deferred for later:** a key parameter for every step in the region (not only the latest); result or status snippets such as "edited 3 lines", match counts, or exit codes; a hover tooltip for the full value.
- **Outside this change:** any modification to the detail drawer's content, and any server-side change (the `input` already reaches the client).

**Deferred to follow-up work**

- A todo-count summary for `TodoWrite` (its input is an array; v1 falls back to the tool name). Render-measured "fill then slice" truncation if the char-based slice proves imprecise. Live partial-parameter display during streaming (would require tolerant parsing of `inputJsonStream`).

### Dependencies and Assumptions

- The tool_use part already carries `input` on the client, so this needs no server work.
- `basename()` and a left-truncation helper already exist under `src/client/components/tool-renderers/path-utils.ts` and can be reused.
- The existing `summarizeToolInput` helper already maps tool inputs to a summary string; the plan reuses it rather than adding a parallel mapping.
- Assumption: command content shown inline is acceptable exposure, consistent with linear mode; no secret or PII redaction is in scope.

### Outstanding Questions

- **Resolved during planning:** the per-tool key-parameter field mapping is handled by reusing `summarizeToolInput`, whose key preference (`command`, `file_path`, `path`, `pattern`, `url`, `query`, `prompt`, …) and fallback chain already cover the common tools.
- **Resolved during planning (review):** the store does not populate `part.input` incrementally — it stays `{}` while a tool streams and fills only at completion — so the parameter appears on completion and the tool name is shown while streaming (KTD4). Live partial display is deferred to follow-up work.

### Sources and Research

- `src/client/components/ProcessRegionGhost.tsx` — the ghost; the current `label` is the tool name or `Thinking`, fed into both the visible text and the `ghostLabel` aria interpolation; the button is `inline-flex` with no max-width.
- `src/client/lib/summarize-tool-input.ts` — existing summary helper with the per-tool key preference and fallback chain; reused as the source of the key parameter.
- `src/client/components/tool-renderers/path-utils.ts` — `basename()` and `truncateStart()` (left-truncate, filename visible), already used by `FilePath`.
- `src/client/components/message-grouping.ts` — the `ProcessRegion` model exposes `parts` and `latest` to the ghost.
- `src/client/components/chat-message-adapter.ts` — the `tool_use` RenderablePart carries `input`, `inputJsonStream`, and `meta.displayName`.
- `src/client/components/VirtualizedMessageList.tsx` and `MessageList.tsx` — message column is `max-w-3xl` (768px); each assistant message wraps at `max-w-[95%]`.
- Prior plan `docs/plans/2026-07-16-003-feat-process-region-duration-plan.md` added the duration element to this same ghost.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Reuse `summarizeToolInput` for the key-parameter value.** It already produces a per-tool summary (preferred keys, 120-char cap, fallback chain) and is the same logic linear mode shows in `ToolHeader`. Reusing it keeps the two modes consistent and absorbs the per-tool field mapping with no new code.
- **KTD2. Two-direction truncation, both bounded to the available width.** Path-shaped summaries left-truncate via `truncateStart(value, 40)` (reusing `FilePath`'s default `maxDisplayLength`) so the filename survives; URL-shaped and other summaries right-truncate via CSS `truncate` so the leading domain or verb survives. The path heuristic excludes URL schemes (`http://`, `https://`) so domains are not cut. The ghost gains `max-w-full` and the parameter span `min-w-0` (the recipe used in `WorkflowFloatingPanel`); for the path branch the `truncateStart` cap is the primary control and CSS `truncate` is only a pixel-level safety net, so the two layers cannot both eat the filename.
- **KTD3. Accessibility by reuse.** The parameter is folded into the existing `label` string that `ghostLabel` interpolates as `{{latest}}`, so the aria-label carries it with no separate a11y path (R6).
- **KTD4. Streaming shows the tool name, not a partial parameter.** The store keeps `part.input` as `{}` while a tool streams (the live partial lives in `inputJsonStream`) and fills `input` only at completion, so the ghost derives the parameter from `part.input` once it is non-empty and shows the tool name alone while streaming. The helper must treat the streaming placeholder and the reused helper's degenerate outputs — empty object `{}`, and `summarizeToolInput`'s `'{}'` / `firstKey: value` fallback shapes — as "no value," so the name-only fallback fires instead of rendering `Bash ▸ {}`. Live partial display from `inputJsonStream` is deferred; even linear mode uses a separate streaming preview rather than a live summary.

### Assumptions

- The store fills `part.input` only at tool completion (it is `{}` while streaming); KTD4's name-only fallback covers the streaming window.
- The `▸` separator is decorative, consistent with the ghost's existing `·` separators; no new i18n keys are expected. If a localized separator is wanted, add it to both `en` and `zh-CN` `chat.json`.

---

## Implementation Units

### U1. Key-parameter label helper (pure)

- **Goal:** A pure, unit-tested function that turns the latest part of a process region into the ghost's display label: tool display name plus the summarized key parameter, with a hint for how to truncate.
- **Requirements:** R1, R2, R4.
- **Dependencies:** none.
- **Files:**
  - `src/client/components/process-region-ghost-label.ts` (new)
  - `src/client/components/process-region-ghost-label.test.ts` (new, vitest — co-located with the ghost tests)
- **Approach:** Reuse `summarizeToolInput(part.input)` to get the value. Return an object holding the tool display name (`part.meta?.displayName ?? part.toolName`), the summary string (or `undefined`), and a `truncate` hint named by which end survives: `'keep-tail'` for path-shaped values (left-truncate via `truncateStart`, filename survives) and `'keep-head'` for everything else (CSS right-truncate). Classify as `keep-tail` only for filesystem-path shapes — contains a `/` or `\` with no spaces, or begins with `./`, `/`, or `~` — and never for values beginning with an `http://`/`https://` scheme (URLs keep the head/domain). Guard the reused helper's degenerate outputs: treat `undefined`/`null` input, the empty object `{}`, and `summarizeToolInput`'s `'{}'` or `firstKey: value` fallback shapes as "no value" so the caller falls back to the tool name only. For a thinking part, signal that the caller shows the localized `Thinking` label. Keep the function side-effect free. Directional guidance, not a prescribed signature.
- **Patterns to follow:** `src/client/lib/summarize-tool-input.ts` (input shape handling and fallback style); `src/client/components/tool-renderers/path-utils.ts` `truncateStart` for the path branch; `ProcessRegionGhost.test.tsx` for the vitest setup.
- **Test scenarios:**
  - Happy path: a `Bash` part with `input.command = 'npm test'` yields name `Bash`, value `npm test`, truncation `tail`.
  - Covers AE1: a `Read` part with a short `file_path` yields the full path value, truncation `path`.
  - Covers AE2: a `Read`/`Edit` part with a deep `file_path` yields the full path with truncation `path` (the caller applies `truncateStart`); assert the helper flags `path` so the filename end is preserved.
  - Covers AE4: a thinking part signals the `Thinking` path; a tool with empty `input` yields name only and no value.
  - Covers AE4 / R2: `input` is `null`/`undefined`, the empty object `{}` (the streaming placeholder), or an object whose only output is `summarizeToolInput`'s `'{}'` / `firstKey: value` fallback → value `undefined`, name only (the guard prevents `Bash ▸ {}`).
  - Edge case: a `WebFetch`/`WebSearch` value that is a URL (`https://…`) classifies as `keep-head` (right-truncate, domain survives), not `keep-tail`.
  - Edge case: an MCP/unknown tool name with a `description`-bearing input returns the description value (exercises the `summarizeToolInput` description branch).
- **Verification:** the helper is pure; the unit test proves each branch. No rendering involved.

### U2. Render the parameter in the ghost

- **Goal:** Show the latest tool's key parameter in `ProcessRegionGhost`, truncated to one line, with thinking and fallback behavior, live streaming, and an accessible label.
- **Requirements:** R1, R2, R3, R4, R5, R6. Covers AE1–AE5.
- **Dependencies:** U1.
- **Files:**
  - `src/client/components/ProcessRegionGhost.tsx` (modify)
  - `src/client/components/ProcessRegionGhost.test.tsx` (extend)
  - `src/client/components/ChatMessageRenderer.result.test.tsx` (extend)
- **Approach:** Use U1's helper to derive the label parts from `region.latest`. Render the tool display name, a decorative `▸`, then the value in its own monospace span. Apply truncation by hint: path-shaped values pass through `truncateStart(value, maxLen)` and sit in a span with `min-w-0 truncate`; other values sit in a `min-w-0 truncate` span and rely on CSS right-truncation. Add `max-w-full` to the ghost button so the row is bounded by the message column. Keep `Thinking` for thinking parts and the bare tool name when there is no value. Fold the value into the existing `label` used by `ghostLabel` so the aria-label includes it (R6). For streaming, follow KTD4: while `part.input` is the streaming placeholder (empty object `{}`), show the tool name alone; once `input` completes and the helper returns a value, show the parameter. Leave the `Process · N steps · 时长` prefix, the click handler, and the drawer untouched (R5). The `▸` separator mirrors the existing `·` separators.
- **Patterns to follow:** `WorkflowFloatingPanel.tsx` `min-w-0 truncate` + bounded parent for the truncation recipe; `FilePath.tsx` for monospace path rendering and `truncateStart` use; the existing keyed slide-in span (keyed by `latestKey`, not by the value, so value updates do not replay the animation).
- **Test scenarios:**
  - Happy path: a region whose latest part is `Bash` with `command: 'npm test'` renders `Bash ▸ npm test` in the ghost.
  - Covers AE1: a short `file_path` renders the full path after the tool name.
  - Covers AE2: a deep `file_path` renders the left-truncated form ending in the filename.
  - Covers AE3: a long `command` right-truncates with a trailing ellipsis and keeps the leading verb.
  - Covers AE4: a thinking-only region still renders `Thinking`; a tool with no key parameter renders the tool name only.
  - Covers AE5: while the latest tool is streaming (`input` is `{}`), the ghost renders the tool name only; once `input` completes it renders `Bash ▸ npm test`.
  - Integration: in result mode via `ChatMessageRenderer`, the latest tool of a multi-part region shows its parameter; the prefix, step count, and duration remain; the drawer still opens on click.
- **Verification:** `npm run test:client` passes for both test files; a manual visual check in result mode confirms AE1–AE5 render on one line without wrapping and the drawer is unchanged.

---

## Verification Contract

- `npm run test:client` — runs the vitest jsdom suites, including `ProcessRegionGhost.test.tsx`, `ChatMessageRenderer.result.test.tsx`, and the new `process-region-ghost-label.test.ts`.
- `npm run lint` — ESLint on the changed `.ts`/`.tsx` (strict; watch `noUnusedLocals`/`noUnusedParameters`).
- Visual check — run the app in result-focus mode and confirm AE1–AE5: short param fits, deep path shows `…/filename`, long command right-truncates to the verb, streaming falls back to the name then shows the param, and the prefix/drawer are unchanged.

## Definition of Done

- Global: R1–R6 are satisfied; the ghost shows the latest tool's key parameter on one line; thinking shows `Thinking`; tools without a key parameter fall back to the name; the `Process · N steps · 时长` prefix and the detail drawer are unchanged; `npm run lint` and `npm run test:client` are clean.
- U1: the label helper is pure and its unit test covers every branch.
- U2: the ghost and result-mode tests pass and the visual check confirms AE1–AE5.
- Cleanup: no experimental or dead-end code is left in the diff.
