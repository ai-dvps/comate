---
date: 2026-06-14
topic: prompt-input-enhancements
---

# Prompt Input Enhancements

## Summary

Four enhancements to the prompt input in `src/client/components/PromptInput.tsx`: flexible trigger and matching for the slash/file pickers, per-session prompt history with arrow-key recall and a searchable popup, live markdown source highlighting via a mirror-div overlay behind the existing textarea, and ghost-text sentence completion powered by a local n-gram model. All four preserve the existing textarea and its integrations so the features compose with each other and with the pickers, approval surface, and provider/approval toolbar.

---

## Problem Frame

Today's prompt input is a plain `<textarea>` with two pickers (`CommandPicker`, `FilePicker`) that fire only on narrow triggers and match by strict prefix or fuzzy subsequence, no history recall, and no live syntax feedback. Four frictions surface repeatedly:

- `/` opens the command picker only when typed as the first character of an empty input; once the picker closes (Escape, backspace past the trigger), it does not reopen until the input is empty again.
- `CommandPicker` filter is strict prefix only, so `cmt` does not match `/commit`. `FilePicker` already uses fuzzysort server-side, but neither picker accepts glob patterns like `*.ts`.
- Once a prompt is sent, recalling it requires scrolling the chat transcript and copy-pasting; there is no shell-style history.
- Prompts containing markdown are typed blind — formatting only appears after sending, so users editing `**bold**` or fenced code blocks cannot visually verify structure mid-compose.

The remedy is four scoped behavior upgrades that share a single architectural constraint: preserve the textarea's existing hooks (`onChange`, `onKeyDown`, draft state, picker anchoring, send-on-Enter) so the four features compose with each other and with the existing pickers, approval surface, and provider/approval toolbar.

---

## Key Decisions

- **Mirror-div overlay over CodeMirror swap (markdown highlighting).** A native `<textarea>` cannot render styled spans inline; the alternatives were a mirror-div overlay (keep the textarea, render a styled div behind it, sync scroll and font metrics) or swapping to CodeMirror 6 / TipTap / Lexical. The mirror overlay preserves every existing textarea integration — pickers, draft state, send-on-Enter, IME, accessibility — at the cost of more fragile scroll and caret sync. CodeMirror's robustness was not worth re-implementing the picker triggers, history navigation, completion ghost text, and approval-surface anchoring in its API.
- **Per-session history scope over per-workspace or global.** Sessions are task-focused; prompts within a session share context that prompts across sessions do not. Per-session also means history can be derived from the SDK's existing session JSONL storage rather than requiring a new persistence layer — no migration, no parallel store, dies naturally if the session is deleted.
- **Local n-gram completion over Claude API completion.** Local n-gram from session history avoids token cost, network latency, and new provider wiring. The trade-off is that suggestions are bounded by what the user has already typed — no novel completions. This bound is acceptable for v1; the architecture should make it possible to swap in API-backed completion later without rewriting the UX layer.
- **Glob on top of fuzzy, not instead of.** When the filter contains `*` or `?`, the picker uses glob matching; otherwise it uses fuzzy subsequence matching (already in place for `FilePicker` via fuzzysort, extended to `CommandPicker`). Glob without fuzzy loses the typo-tolerance and partial-typing benefits users expect from modern editors.
- **Behavior-only picker changes, no visual row overhaul.** Visual enhancements (icons per command, source attribution badges, file metadata, color coding) were considered and explicitly deferred. The actual pains are trigger flexibility and matching — visual styling is orthogonal and can ship independently if pursued later.
- **Both pickers remain mutually exclusive.** Only one of `CommandPicker` or `FilePicker` is open at a time; opening one closes the other. This rule is preserved with the new anywhere-after-whitespace triggers.
- **Argument-hint ghost text priority over completion ghost text.** The existing slash-command argument-hint ghost text (e.g., `<file>` after `/commit`) takes priority over the new completion ghost text. When the argument hint is showing, completion does not fire.

---

## Requirements

**Triggers and matching**

- R1. Both `/` and `@` open their respective picker when typed at the start of an empty input OR when typed after a whitespace character (space, newline) mid-text. Mid-word `@` (e.g., inside `email@domain.com`) does not trigger.
- R2. After a picker has been dismissed (Escape, click outside, backspace past the trigger character), typing the trigger character again reopens the picker without requiring the input to be empty.
- R3. Only one picker is open at a time. Opening `CommandPicker` closes `FilePicker` if open, and vice versa. The picker follows the most recently typed trigger.
- R4. While a picker is open, continued typing after the trigger updates the picker's filter. Typing a whitespace character after the trigger segment, pressing Escape, or pressing Tab dismisses the picker.
- R5. `CommandPicker` uses fuzzy subsequence matching against command names (e.g., `cmt` matches `/commit`), matching the behavior `FilePicker` already has via fuzzysort.
- R6. When a picker filter contains `*` or `?`, the picker switches to glob-style wildcard matching for that filter. `*` matches zero or more characters; `?` matches exactly one character. Glob applies to the full filter string, not character-by-character.
- R7. When the glob filter matches zero results, the picker shows an empty state consistent with today's "no match" message.

**Prompt history**

- R8. The prompt input maintains a per-session history of every successfully sent prompt in the current session. Failed sends, cancelled prompts, and prompts typed but not sent are not recorded.
- R9. Adjacent duplicate prompts are skipped (bash-style `ignoredups`). Non-adjacent duplicates are preserved in their original positions.
- R10. When the input is empty and no picker is open, pressing ArrowUp replaces the draft with the most recently sent prompt. Subsequent ArrowUp presses walk backward through history; ArrowDown walks forward. Navigation past either end is a no-op.
- R11. Recalled prompts become the editable draft. The user can edit, then send or recall further. Sending a recalled (edited or not) prompt appends it to history per R8–R9.
- R12. When the user navigates back to the present (ArrowDown past the most recent entry) and the original draft was non-empty before navigation began, the original draft is restored.
- R13. A searchable history popup is opened by a keyboard shortcut (exact key deferred to planning — Ctrl+R conflicts with browser reload) and by a History button mounted in the input toolbar alongside Commands and Files.
- R14. The history popup lists all sent prompts in the current session in reverse-chronological order, with a type-to-filter search input that uses the same fuzzy+glob matching rules as R5–R6.
- R15. The history popup supports keyboard navigation identical to `CommandPicker`: ArrowDown/ArrowUp to cycle, Enter to commit the highlighted row to the draft (replacing current draft contents), Escape to close without committing, Tab to dismiss.
- R16. Multi-line prompts are displayed in the popup with a visual indicator (e.g., truncated first line with a `…` marker or a line-count badge); the full prompt is shown on hover or via a tooltip.
- R17. While a stream is in progress, history navigation (ArrowUp/ArrowDown and popup) is disabled. The History button is disabled. The shortcut is a no-op.
- R18. The history source is derived from the existing session message storage (the SDK's session JSONL via the existing chat-store) rather than a separate history table. No new persistence layer; no migration.

**Markdown source highlighting**

- R19. A mirror-div overlay renders behind the textarea, displaying the same content with markdown source highlighting applied. The textarea's text is made transparent (caret remains visible); only the overlay's styled rendering shows.
- R20. The overlay highlights inline markdown: bold (`**text**`, `__text__`), italic (`*text*`, `_text_`), bold-italic (`***text***`), inline code (`` `code` ``), strikethrough (`~~text~~`), and links (`[label](url)`). Punctuation markers (`**`, `*`, `` ` ``, `~~`, `[]()`) are dimmed; content is rendered in the corresponding style (bold weight, italic slant, monospace, strikethrough, link color).
- R21. The overlay highlights block markdown: ATX headings (`#` through `######`), bullet lists (`-`, `*`, `+`), numbered lists (`1.`, `2.`, etc.), blockquotes (`>`), fenced code blocks (triple-backtick with optional language tag), and horizontal rules (`---`, `***`). Heading text is rendered in heading style; list markers are dimmed; blockquote markers are dimmed with the quote styled; fenced code blocks get a distinct background and monospace font.
- R22. The overlay re-parses and re-renders on every change to the draft (including picker insertions, history recalls, and completion accepts). Re-parse latency for typical prompt sizes (under ~5KB) is imperceptible.
- R23. The overlay's font metrics (family, size, line-height, letter-spacing, padding) match the textarea exactly. Caret position in the textarea aligns visually with the corresponding character in the overlay.
- R24. Scroll position of the overlay tracks the textarea's scroll position synchronously. There is no visible parallax or drift during typing or scrolling.
- R25. The overlay respects the active theme (dark/light) and uses the existing design tokens (`text-primary`, `text-secondary`, `text-tertiary`, `accent`, `surface`) for its styling.
- R26. The overlay does not interfere with the textarea's focus, selection, IME composition, accessibility semantics, or auto-grow height behavior. Picker popovers anchored to the textarea continue to position correctly.

**Sentence completion**

- R27. The prompt input produces ghost-text completion suggestions based on a local n-gram model built from the current session's sent-prompt history (same source as R8).
- R28. The completion fires after the user stops typing for a debounce interval (exact duration deferred to planning; ~300ms suggested). Continued typing, ArrowLeft/ArrowRight, Escape, or any non-text input dismisses the current suggestion.
- R29. A suggestion renders as faded ghost text immediately after the caret position. Tab accepts the suggestion (appends the suggestion to the draft at the caret); Escape dismisses. If the user continues typing and the new text still matches the suggestion prefix, the suggestion may update; otherwise it dismisses.
- R30. When the existing slash-command argument-hint ghost text is showing (per the existing logic in `PromptInput.tsx`), completion does not fire. Argument-hint ghost text takes priority.
- R31. When a picker is open, completion does not fire. Picker input takes priority.
- R32. When the markdown overlay is rendering, completion ghost text overlays cleanly on top of the overlay's rendering at the caret position. The visual stacking order is: markdown overlay (back) → textarea transparent text → argument-hint ghost text or completion ghost text (front).
- R33. If the n-gram model has no candidates for the current caret-forward text (e.g., cold-start session, novel text), no ghost text appears. There is no loading state or fallback to API.
- R34. The n-gram model updates incrementally as new prompts are sent in the current session. The first sent prompt seeds the model; subsequent prompts extend it.

**Cross-feature integration**

- R35. The four features compose: a user can recall a past prompt via history (which becomes the draft), see it markdown-highlighted by the overlay, and have completion suggest an extension based on what they've typed in this session — without any of the four interfering incompatibly with the others.
- R36. While a stream is in progress, all four features pause naturally: pickers do not open, history navigation is disabled, completion does not fire. The markdown overlay continues to render the current draft (read-only) but receives no input.
- R37. Send-on-Enter behavior (modifier-to-submit setting, Shift+Enter for newline) is unchanged.

---

## Key Flows

- F1. **Mid-text slash command (new trigger behavior)**
  - **Trigger:** User types `fix the bug in ` then `/`.
  - **Actors:** User
  - **Steps:** Picker opens anchored to the textarea with filter empty; user types `comm`; filter narrows to commands matching `comm` via fuzzy; user ArrowDowns to `/commit` and presses Enter.
  - **Outcome:** Input becomes `fix the bug in /commit ` with argument-hint ghost text `<file>` showing after the inserted name. Caret is positioned after the trailing space.
  - **Covered by:** R1, R3, R4, R5

- F2. **Glob match in file picker**
  - **Trigger:** User types `@*.ts` in the input.
  - **Actors:** User
  - **Steps:** File picker opens after `@` (whitespace precedes); filter becomes `*.ts`; glob matching returns all paths ending in `.ts`; list renders in picker.
  - **Outcome:** User selects a row; input becomes `@<selected-path>` with caret after the trailing space.
  - **Covered by:** R1, R6

- F3. **Re-trigger after Escape**
  - **Trigger:** User types `/commit`, presses Escape, then types `/` again.
  - **Actors:** User
  - **Steps:** Picker closes on Escape; on the next `/` typed after whitespace (or at start of empty input), the picker reopens with filter empty.
  - **Outcome:** User can browse commands again without manually clearing the input.
  - **Covered by:** R2

- F4. **History recall via arrow keys**
  - **Trigger:** User has sent three prompts in this session; input is empty; user presses ArrowUp.
  - **Actors:** User
  - **Steps:** Draft becomes the third (most recent) sent prompt; ArrowUp again replaces draft with the second; ArrowUp again replaces with the first; ArrowUp again is a no-op; ArrowDown walks forward; ArrowDown past the most recent restores the original empty draft.
  - **Outcome:** User can quickly recall any past prompt in the session without scrolling the transcript.
  - **Covered by:** R8, R10, R11, R12

- F5. **History search via popup**
  - **Trigger:** User clicks the History button (or presses the shortcut).
  - **Actors:** User
  - **Steps:** Popup opens listing all sent prompts in reverse-chronological order; user types a fuzzy or glob filter; list narrows; user ArrowDowns to a row and presses Enter.
  - **Outcome:** Draft becomes the selected prompt; popup closes; caret is at the end of the draft. User can edit before sending.
  - **Covered by:** R13, R14, R15, R16

- F6. **Markdown overlay during compose**
  - **Trigger:** User types `**fix** the bug in \`auth.ts\`` in the input.
  - **Actors:** User
  - **Steps:** As the user types, the mirror overlay re-parses and renders the markdown source: `**` dimmed, `fix` in bold weight, `**` dimmed, `` ` `` dimmed, `auth.ts` in monospace, `` ` `` dimmed. Caret in the textarea aligns with the corresponding character in the overlay.
  - **Outcome:** User sees the formatting cues live without sending.
  - **Covered by:** R19, R20, R22, R23, R24

- F7. **Completion suggestion accepts**
  - **Trigger:** User types `explain ` (after sending several prompts starting with `explain ` earlier in the session) and pauses.
  - **Actors:** User
  - **Steps:** After the debounce, the n-gram model produces a candidate continuation (e.g., `the function`) based on observed prompts; ghost text `the function` appears after the caret; user presses Tab.
  - **Outcome:** Draft becomes `explain the function`; ghost text dismissed; caret positioned after `function`.
  - **Covered by:** R27, R28, R29, R34

- F8. **Completion defers to argument-hint ghost text**
  - **Trigger:** User has just selected `/commit` from the command picker (argument-hint `<file>` is showing as ghost text), pauses typing.
  - **Actors:** User
  - **Steps:** Completion does not fire; only the argument-hint ghost text is visible. User types `package.json`; argument hint fades as the user types real characters.
  - **Outcome:** No visual conflict between argument hint and completion.
  - **Covered by:** R30

- F9. **All four features compose**
  - **Trigger:** User recalls a past multi-line prompt via history ArrowUp; the draft contains markdown formatting; user pauses mid-line.
  - **Actors:** User
  - **Steps:** History recall replaces the draft; markdown overlay highlights the draft's formatting; completion suggests an extension if the n-gram has a candidate. User edits, accepts a completion suggestion via Tab, sends.
  - **Outcome:** All four features fire in sequence without interfering.
  - **Covered by:** R35

---

## Acceptance Examples

- AE1. **Covers R1.** Given an empty input, when the user types `@`, then `FilePicker` opens. Given the input contains `fix ` (trailing space), when the user types `@`, then `FilePicker` opens. Given the input contains `email`, when the user types `@`, then no picker opens.

- AE2. **Covers R1.** Given the input contains `fix ` (trailing space), when the user types `/`, then `CommandPicker` opens. (Today this does not happen — slash only triggers at the start of an empty input.)

- AE3. **Covers R2.** Given `CommandPicker` is open after typing `/commit`, when the user presses Escape, then the picker closes. When the user types `/` again (at start of empty input or after whitespace), then the picker reopens with filter empty, without requiring the input to be cleared.

- AE4. **Covers R3.** Given `FilePicker` is open, when the user types `/` (preceded by whitespace), then `FilePicker` closes and `CommandPicker` opens.

- AE5. **Covers R5.** Given `CommandPicker` is open with filter empty, when the user types `cmt`, then the list narrows to commands whose names contain `c`, `m`, `t` as a subsequence (e.g., `/commit`, `/compact`). Strict prefix matching would have shown zero results.

- AE6. **Covers R6.** Given `FilePicker` is open, when the user types `*.ts` as the filter, then only paths ending in `.ts` are shown. When the user types `*spec*`, then paths containing `spec` anywhere are shown.

- AE7. **Covers R10, R11, R12.** Given three prompts have been sent in this session and the input is empty, when the user presses ArrowUp three times then ArrowDown three times, then the draft cycles through the three prompts in reverse-chronological order, then back to empty. When the user ArrowUps to a recalled prompt, edits it, and presses ArrowUp again, then the next prompt in history replaces the edited draft.

- AE8. **Covers R13, R14, R15.** Given three prompts have been sent, when the user clicks the History button, then a popup opens listing the three prompts in reverse-chronological order. When the user types a filter and presses ArrowDown + Enter on a row, then the popup closes and the draft becomes the selected prompt with the caret at the end.

- AE9. **Covers R19, R20, R21, R23, R24.** Given the input is empty, when the user types `# Heading` then a newline then `**bold** and \`code\`` then a newline then `- item`, then the overlay renders: `#` dimmed, `Heading` in heading style, `**` dimmed, `bold` in bold weight, `**` dimmed, `` ` `` dimmed, `code` in monospace, `` ` `` dimmed, `-` dimmed, `item` plain. Caret in the textarea aligns with the corresponding character in the overlay; scroll positions track synchronously.

- AE10. **Covers R27, R28, R29.** Given the user has sent a prompt `explain the function` earlier in this session, when the user types `explain ` and pauses for the debounce interval, then ghost text `the function` appears after the caret. When the user presses Tab, then the draft becomes `explain the function`. When the user presses Escape instead, then the ghost text dismisses and the draft remains `explain `.

- AE11. **Covers R30.** Given the user has just inserted `/commit ` from the command picker (argument-hint `<file>` showing as ghost text) and pauses, then no completion ghost text appears. When the user types `package.json`, then the argument-hint ghost text fades as the user types real characters.

- AE12. **Covers R33.** Given a fresh session with no prompts sent yet, when the user types anything and pauses, then no completion ghost text appears.

- AE13. **Covers R35.** Given a session with several prompts sent, when the user ArrowUps to recall a past multi-line markdown-formatted prompt, then the overlay highlights the markdown; if the user pauses mid-line, then completion suggests a continuation based on prior prompts in the session.

- AE14. **Covers R36.** Given a turn is streaming, when the user types `/`, then no picker opens. When the user presses ArrowUp, then history does not navigate. When the user pauses mid-typing, then no completion appears. The markdown overlay continues to render the current draft.

---

## Success Criteria

- Users can trigger both `/` and `@` pickers anywhere after whitespace in the input, with no behavioral asymmetry between the two trigger characters.
- Users can recall any past prompt from the current session within two seconds without scrolling the transcript.
- Users see live markdown formatting cues while composing, with no perceptible lag for typical prompt sizes.
- Users get useful sentence-completion suggestions for repetitive prompt patterns within a session, without ever incurring API cost or latency.
- The four features compose without visual conflicts (ghost-text priority rules are clear) and without breaking any existing prompt-input behavior (pickers, draft state, send-on-Enter, approval surface, provider/approval toolbar).
- A downstream planner can take this doc and produce implementation plans for any subset of the four features (or all four) without needing to invent trigger rules, history semantics, completion source, or overlay architecture.

---

## Scope Boundaries

**Deferred for later**

- Visual row enhancements for `CommandPicker` and `FilePicker` — icons per command source, source attribution badges, file metadata (size/modified/git status), color coding. Explicitly out of v1; can ship independently.
- GFM tables and task lists in markdown highlighting. Inline + block coverage is v1; tables and task lists can extend the parser later.
- Recently-used and most-used ranking in pickers and history popup. v1 is reverse-chronological.
- Editing prompts inline before resending (a "send as new prompt" affordance from the history popup). v1: selecting a row commits to the draft, where the user edits before sending.
- Provider-powered completion (Claude Haiku via the configured provider). v1 is local n-gram only; the architecture should not preclude API completion later.

**Outside this brainstorm's identity**

- WYSIWYG markdown rendering (Notion/Slack-style). Source highlighting was chosen; WYSIWYG is a different product shape.
- CodeMirror 6 / TipTap / Lexical editor swap. Mirror-div overlay was chosen; an editor swap is a different architectural commitment.
- Cursor-aware picker reopening (picker follows the cursor into existing `/xxx` or `@xxx` segments). The user chose the simpler "re-trigger on type" rule.
- Cross-workspace prompt history and n-gram corpus. Per-session scope was chosen.
- Inline popup for sentence completion with multiple suggestions. Ghost text was chosen.

---

## Dependencies / Assumptions

- The SDK's session JSONL is accessible from the client (via the existing chat-store) and contains the user's sent prompts in chronological order. The store already exposes per-session message lists — `useChatStore` in `src/client/stores/chat-store.ts`.
- `fuzzysort` (already in dependencies, used in `src/server/services/file-search.ts`) can be reused client-side for `CommandPicker` matching and history popup matching.
- The existing `Popover` + `PopoverAnchor` pattern from `src/client/components/ui/popover.tsx` continues to anchor picker popups to the textarea reliably when the mirror overlay is present behind it.
- The existing `SlashSquare` / `Paperclip` button pattern in `PromptInput.tsx` extends cleanly to a third History button.
- A markdown parser suitable for incremental re-parse on every keystroke (e.g., `markdown-it`, `remark`, or a simpler hand-rolled inline+block parser) is acceptable to add as a dependency. `shiki` is already in the stack but is async and not ideal for synchronous per-keystroke highlighting.
- The n-gram model can be built and queried in-memory on the client without measurable impact on typing latency for typical session sizes (under ~1000 sent prompts).
- The existing per-session draft storage in `chat-store` (keyed by `sessionId`) is the right place to hold the "current draft" and the "history navigation cursor" state during ArrowUp/ArrowDown navigation.

---

## Outstanding Questions

### Resolve Before Planning

- None. All scope-level decisions are settled.

### Deferred to Planning

- [Affects R6][Technical] **Glob implementation library.** Use `minimatch`, `picomatch`, a hand-rolled matcher, or extend the existing fuzzysort call? The choice interacts with case sensitivity, path separators, and special-character handling.
- [Affects R13][Design] **History popup keyboard shortcut.** `Ctrl+R` / `Cmd+R` conflicts with browser reload. Candidates: `Ctrl+H` (conflicts with browser history in some browsers), `Ctrl+Shift+P` (conflicts with command palette conventions), `Alt+H`, or a custom binding. Survey existing shortcuts in the app first.
- [Affects R19, R23, R24][Technical] **Mirror overlay implementation.** Build the overlay from scratch (synced scroll, font metrics, transparent text, styled div behind) or use `react-simple-code-editor` (which implements this pattern with prismjs / highlight.js under the hood). The from-scratch path gives more control; the library path is faster to ship.
- [Affects R20, R21][Technical] **Markdown parser library.** `markdown-it` (battle-tested, sync token stream), `remark` (AST-based, heavier), or a hand-rolled parser tuned for prompt-scale inputs? The parser must produce a token stream the overlay can render as styled spans.
- [Affects R28][Design] **Completion debounce duration.** 300ms is a starting point; the right value depends on observed typing speed vs. latency tolerance. May be configurable.
- [Affects R29][Design] **Completion suggestion length.** Should the n-gram suggest the rest of the current word, the rest of the current sentence, or the rest of the current line? Longer suggestions are more useful when correct, more annoying when wrong.
- [Affects R27, R34][Technical] **N-gram model shape.** N value (2-gram vs. 3-gram vs. 4-gram), tokenization (word-level vs. character-level), and update strategy (real-time as user types, or batch on send). Affects memory footprint and suggestion quality.
- [Affects R16][Design] **Multi-line prompt display in history popup.** Truncate to first line with `…`, show line-count badge, expand on hover, or render full prompt in a fixed-height row with scroll? Trades information density against scannability.
- [Affects R9][Design] **History dedup strictness.** Adjacent-only dedup (bash `ignoredups`) or full-session dedup (zsh `HIST_FIND_NO_DUPS`)? R9 specifies adjacent; planning may revisit.
- [Affects R32][Design] **Visual stacking of overlay vs. textarea vs. ghost text.** Z-index and pointer-events configuration so the textarea remains interactive while the overlay renders behind and ghost text renders in front.

---

## Sources & Research

- **Existing prompt input**: `src/client/components/PromptInput.tsx` (580 LOC) — current plain textarea, slash/file picker integration, argument-hint ghost text, send/clear/stop, approval surface, provider/approval toolbar.
- **Existing pickers**: `src/client/components/CommandPicker.tsx`, `src/client/components/FilePicker.tsx` — current strict-prefix (Command) and fuzzysort-backed (File) matching; current first-char-only (`/`) and mid-text-after-whitespace (`@`) trigger logic.
- **Existing slash-command discovery**: `docs/brainstorms/2026-05-17-slash-command-discovery-requirements.md` — established the SDK warm-up pattern; command source (built-in / project / skill / plugin / personal) is already exposed via the SDK and available for future visual attribution.
- **Existing file-path autocomplete**: `docs/brainstorms/2026-05-17-file-path-autocomplete-requirements.md` — established the `@` mid-text trigger and recursive-fetch strategy.
- **Existing prompt-input base**: `docs/brainstorms/2026-05-16-prompt-input-and-streaming-input-mode-requirements.md` — established the auto-grow textarea, send/clear/stop, draft state, and streaming-input-mode architecture.
- **Existing markdown rendering for chat output**: `MarkdownPreview.tsx`, `streamdown`, `shiki`, `dompurify` — output-side rendering, not directly reusable for input-side source highlighting but establishes theme and styling conventions.
- **Existing fuzzy file search**: `src/server/services/file-search.ts:133` — `fuzzysort.go` for subsequence matching; same library can be reused client-side for `CommandPicker` and history popup.
