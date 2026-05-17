---
date: 2026-05-17
topic: approval-and-question-surface-swap
---

# Approval & AskUserQuestion Surface Swap

## Summary

Replace the "banner above the prompt input" approval shape with a **focus-trap surface that swaps the prompt input itself** while a `canUseTool` callback is pending: tool-approval requests render buttons-only (Allow / Allow always / Deny), `AskUserQuestion` requests render the option list with an "Other" choice that reveals a rich text input supporting `/` and `@`, options carrying preview content render side-by-side with a sanitized HTML preview pane and unlock a surface-level "Chat about this" affordance, and a Stop control on the surface interrupts the pending turn. The user's typed draft is preserved across the swap so resolving the request restores the prompt exactly as it was.

---

## Problem Frame

The prior brainstorm (`2026-05-16-prompt-input-and-streaming-input-mode-requirements.md`) landed on a **banner pinned above** the still-editable prompt input as the surface for `canUseTool` approvals and `AskUserQuestion`. The implementation shipped that way: `ApprovalBanner` renders above `PromptInput`, the textarea remains live, and the user can keep typing into the next-turn draft while a decision is pending.

In practice that shape splits the user's attention. A pending tool-approval or clarifying-question is the *single thing* Claude is waiting on — Send is queued anyway (R14 of the prior doc), so the textarea being live is a distraction without a corresponding affordance: drafting and approving are mutually exclusive moves, but the UI presents them as parallel. The current preview rendering (italic text inside the option button — `<p className="mt-0.5 ml-5.5 text-text-tertiary italic">{opt.preview}</p>` in `src/client/components/ApprovalBanner.tsx`) also collapses whitespace, which destroys ASCII diagrams and any preview that depends on layout — the documented case for `previewFormat`.

The structural fix is to treat a pending request as a **modal-on-the-input**: the bottom region of the chat panel renders either the prompt input *or* the request surface, never both. The conversation continues to scroll underneath, so prior context is still visible, but the user's only available action in the input region is to resolve (or stop) the pending request. The draft is held in memory across the swap, so the user does not lose work when a request lands mid-compose.

---

## Key Flows

- **F1. Tool approval (no questions).**
  - **Trigger:** Claude attempts a tool whose permissions aren't auto-approved.
  - **Steps:** The prompt input is replaced by the approval surface, which shows the tool name, the input summary (with Show more for large payloads), and Allow / Allow always / Deny buttons. The conversation continues to scroll underneath. The user clicks Allow (or Allow always to also persist a rule, or Deny to block).
  - **Outcome:** The approval is resolved; the surface swaps back to the prompt input with the prior draft restored.
  - **Covered by:** R1, R2, R4, R5, R6

- **F2. `AskUserQuestion` without preview content.**
  - **Trigger:** Claude invokes `AskUserQuestion` and none of the options carry a `preview` field.
  - **Steps:** The prompt input is replaced by the question surface. Each question renders header, prompt, and its option list (with multi-select toggle behavior where the SDK indicates `multiSelect: true`). Each question's list ends with an "Other" choice that, when selected, reveals a rich text input below the options supporting `/` slash commands and `@` file mentions with the same keyboard contract as the main prompt input. The user makes their selections, optionally typing into "Other," and clicks Confirm.
  - **Outcome:** Answers (the chosen labels, or the typed text when "Other" was used) are returned to Claude as `updatedInput`; the surface swaps back to the prompt input with the prior draft restored.
  - **Covered by:** R1, R2, R7, R8, R9, R10

- **F3. `AskUserQuestion` with preview content.**
  - **Trigger:** Claude invokes `AskUserQuestion` and at least one option carries a `preview` field.
  - **Steps:** The surface uses a side-by-side layout: a vertical option list on the left, a preview pane on the right that renders the focused option's preview HTML in a sanitized, scoped wrapper. Hovering or arrow-keying to a different option updates the preview pane. A surface-level "Chat about this" button appears alongside Confirm; clicking it resolves the request as an allow with a fixed discussion-request string so Claude switches into clarification mode instead of acting on the selection. The user otherwise selects, optionally uses "Other," and confirms as in F2.
  - **Outcome:** Either the chosen answer is returned (Confirm path) or a discussion-request payload is returned (Chat about this path); the surface swaps back to the prompt input with the prior draft restored.
  - **Covered by:** R11, R12, R13, R14, R15

- **F4. Stop while a request is pending.**
  - **Trigger:** A request is pending on the surface and the user wants to abort the entire turn rather than answer.
  - **Steps:** The user clicks the Stop icon on the surface. An anchored confirm popover opens with Cancel / Confirm. On Confirm, the server invokes `query.interrupt()`, which causes the pending `canUseTool` AbortSignal to fire and the callback resolves as a deny.
  - **Outcome:** The pending request is dismissed by the SDK; the surface swaps back to the prompt input with the prior draft restored; the turn ends.
  - **Covered by:** R16, R17

---

## Requirements

**Surface lifecycle**

- R1. When a `canUseTool` request (tool approval or `AskUserQuestion`) is pending for the active session, the prompt input region renders the request surface instead of the textarea-plus-controls. No other layout in the chat panel changes — header, message list, and approval-queue badge continue to render as today. The conversation continues to scroll underneath the surface.
- R2. The user's in-progress draft is preserved across the swap. When the surface mounts, the draft is captured from the textarea state and held in memory; when the surface unmounts (resolve, deny, answer, "Chat about this," or Stop), the prompt input remounts and the draft is restored with the cursor at the end of the preserved text. Multi-line content, partial slash-command insertions, and unfinished `@` mentions are preserved as plain text.
- R3. When more than one request is queued, the surface shows one at a time in FIFO order with a `1 of N` indicator. Resolving the active request swaps the surface to the next queued request *without* swapping back to the prompt input in between — only the queue running dry swaps back. The queue is the existing `approvalQueue` state in `chat-store`; no parallel queue is introduced.

**Tool approval (no questions)**

- R4. The tool-approval surface renders the tool name, an optional description from the SDK, the input summary (with Show more / Show less for inputs that exceed the default truncation), and three buttons: Allow, Allow always (only when the SDK supplied `suggestions`), and Deny. There is no free-text or option-style input. The user's only way to add commentary on a denial in v1 is the hardcoded denial message.
- R5. Allow always echoes the SDK-supplied `updatedPermissions` suggestions back through the resolve callback, which writes a matching rule to the workspace's `.claude/settings.local.json` via the SDK's `localSettings` mechanism. This is unchanged from the prior brainstorm and the current implementation.
- R6. Deny returns `{ behavior: 'deny', message: 'User denied this tool call.' }`, unchanged from current implementation. The hardcoded copy is the v1 contract; per-denial typed feedback is out of scope.

**`AskUserQuestion`**

- R7. The question surface renders all questions in the request (1-4 per SDK contract) stacked vertically, each with its header, prompt text, and option list. A single Confirm button at the bottom commits all answers at once. Confirm is disabled until every question has at least one selection.
- R8. Each question's option list ends with an "Other" entry that, when selected, reveals a rich text input directly below that question's options. The "Other" entry is rendered for every question regardless of `multiSelect`. Selecting "Other" does not deselect the user's other selections in multi-select questions; deselecting "Other" hides the input and discards its typed value.
- R9. The "Other" rich input is a multi-line textarea that supports the same `/` slash command picker and `@` file mention picker as the main `PromptInput`, with the same keyboard contract (Enter inserts a newline because Confirm is a separate button; Shift+Enter is unused on this surface; Escape closes any open picker). The picker UIs (CommandPicker, FilePicker) are reused without modification.
- R10. Confirm builds the allow response as `{ behavior: 'allow', updatedInput: { questions, answers } }`. For each question, the answer is the comma-joined labels of selected non-"Other" options; if "Other" is selected and the rich input has non-empty content, the typed text is appended (or used alone when no other option is selected). Empty "Other" input with "Other" selected blocks Confirm. This shape matches the current resolve endpoint and SDK contract.

**Preview rendering**

- R11. The server sets `toolConfig.askUserQuestion.previewFormat: 'html'` (changed from `'markdown'` in `src/server/services/sdk-client.ts`). The SDK pre-filters `<script>`, `<style>`, and `<!DOCTYPE>` from the model's output; the client performs additional sanitization (see R13) before injection.
- R12. The surface switches to side-by-side layout when any option in the request carries a non-empty `preview` field. In side-by-side mode the option list takes the left half and the preview pane takes the right half; the preview pane renders the focused option's preview HTML and updates on hover, keyboard navigation, and click. Questions whose options have no previews still render their option buttons inline (label + description), but the surface layout itself is side-by-side for the whole request as soon as any option has preview content. When no option in the request has preview content, the surface uses the same stacked single-column layout as F2.
- R13. Preview HTML is sanitized client-side with DOMPurify (or equivalent) before injection via `dangerouslySetInnerHTML`. The injected content is wrapped in a CSS-isolated container (scoped class or shadow-DOM-style boundary) so SDK-emitted HTML cannot inherit or override surrounding app styles, and so layout-sensitive content (preformatted blocks, tables, diagrams) renders with intended whitespace and structure. The wrapper applies a constrained typography baseline (font family, line height, code-block styling) consistent with the rest of the chat surface.

**Chat about this**

- R14. A surface-level "Chat about this" button is rendered alongside Confirm whenever at least one option in the request carries preview content. It appears once per surface, not per question. When the request has no preview content (the F2 case), the button is not rendered.
- R15. Clicking "Chat about this" returns `{ behavior: 'allow', updatedInput: { questions, answers } }` where `answers` is a single fixed discussion-request string applied to every question (e.g., "I have questions before answering — let's discuss the options first."). The exact copy is settled during planning. Surface state (selections, "Other" input contents) is discarded; the surface swaps back to the prompt input with the preserved draft restored.

**Stop control**

- R16. The surface renders a Stop icon button in a fixed corner of the surface chrome (not inside the option list). Clicking it opens an anchored confirm popover with Cancel and Confirm, matching the existing Stop affordance on `PromptInput`. Cancel dismisses the popover; Confirm calls the existing interrupt endpoint.
- R17. Interrupt wiring on the surface uses the existing `query.interrupt()` path: the SDK's AbortSignal listener already registered in `buildCanUseToolCallback` (`src/server/services/session-runtime.ts`) resolves the pending callback as `{ behavior: 'deny', message: 'Tool approval aborted by SDK: ...' }`, the surface unmounts, the prompt input remounts with the preserved draft restored, and a system note from the existing interrupt flow appears in the conversation.

---

## Acceptance Examples

- **AE1. Covers R1, R2.** Given the user has typed a multi-line draft into the prompt input and Claude requests permission for a Bash tool call, when the request lands, the prompt input is replaced by the approval surface (tool name, input summary, Allow / Allow always / Deny). When the user clicks Allow, the surface unmounts and the prompt input remounts with the exact same multi-line draft and cursor position restored.
- **AE2. Covers R3.** Given three approval requests queue up while the user is reviewing the first, when the user clicks Allow on the active request, the surface immediately renders the second request (showing `1 of 2`) without swapping back to the prompt input. Only after the user resolves the last queued request does the prompt input reappear.
- **AE3. Covers R7, R8, R9, R10.** Given Claude invokes `AskUserQuestion` with two questions — one single-select, one multi-select — and the user selects one option for the first, clicks "Other" on the second and types `@src/server/services/sdk-client.ts also see /help`, when the user clicks Confirm, the resolve payload contains both questions and the typed text appears as the second question's answer; the `@` mention and `/` token are sent as plain text (no expansion).
- **AE4. Covers R11, R12, R13.** Given Claude invokes `AskUserQuestion` with three options where two carry HTML previews containing styled `<div>` and a `<pre>` ASCII diagram, when the surface mounts, the layout is side-by-side with the option list on the left and the focused option's preview rendered in a sanitized scoped wrapper on the right with whitespace preserved in the `<pre>` block; arrow-keying to a different option updates the preview pane.
- **AE5. Covers R14, R15.** Given the same request as AE4, when the user clicks "Chat about this," the resolve payload is an allow with the fixed discussion-request string applied to every question; the surface swaps back to the prompt input with the preserved draft restored; Claude's next message engages clarification rather than acting on a selected option.
- **AE6. Covers R16, R17, R2.** Given an `AskUserQuestion` surface is rendered and the user has typed partial text into one "Other" input, when the user clicks the surface's Stop button and confirms in the popover, `query.interrupt()` fires, the SDK callback resolves as a deny, the surface unmounts, the prompt input remounts with the *prompt-input* draft restored (the surface's "Other" input is discarded), and a system note appears in the conversation explaining the interrupt.

---

## Success Criteria

- A pending `canUseTool` request is unambiguously the user's next move: the prompt input is not editable while a request is pending, and the user does not need to look anywhere except the surface to act.
- The user's typed-but-unsent draft is never lost to a surface swap, including when multiple requests queue up back-to-back.
- Preview content with non-trivial layout (ASCII diagrams, tables, styled blocks) renders with intended structure rather than collapsed whitespace.
- "Chat about this" exists as a first-class affordance whenever previews are present, matching the official Claude Code CLI behavior; the user does not have to type "I have questions" by hand to engage clarification.
- A downstream implementer can take this doc and `ce-plan` it without inventing surface behavior, the swap-restore protocol, preview-rendering strategy, "Chat about this" semantics, or how Stop relates to the SDK abort path.

---

## Scope Boundaries

- Custom denial messages typed by the user. R6 keeps the hardcoded `'User denied this tool call.'` copy.
- Per-question rich-text input *outside* of the "Other" affordance. The non-Other option buttons remain pure selections.
- Slash-command and file-mention *expansion* inside the "Other" input. The pickers run, but the resulting tokens are sent as plain text — there is no server-side resolution of `@` paths to file content or `/` tokens to slash-command execution from within the answer payload.
- Approval surfaces for tool calls made by subagents. The SDK does not currently surface `AskUserQuestion` from subagents and this doc does not change that.
- A keyboard shortcut to swap focus *between* the surface and the underlying message list. The surface owns focus while it's mounted; scrolling the conversation underneath remains pointer-only.
- A settings UI for editing the saved `.claude/settings.local.json` rules. Users still edit by hand or via the CLI (unchanged from the prior brainstorm).
- "Approve with changes" (mutating tool input before allowing). Deny-and-retype remains the v1 workaround (unchanged from the prior brainstorm).
- Per-option "Chat about this" placement. The button is surface-level only.
- A toggle to revert to the prior banner-above-input shape. The swap surface is the v1 shape; the banner shape is replaced, not optional.
- Light-mode theming for the new surface (consistent with the prior brainstorm's scope).
- Preview rendering for tool-approval requests. Only `AskUserQuestion` options can carry preview content per the SDK.

---

## Key Decisions

- **Swap the input region (focus trap), not add another banner.** Alternatives considered: keep the banner pinned above the live input (current shape — splits attention, presents drafting and approving as parallel when they are not); render the request as an inline message card (mixes user-decision UI with assistant content); render as a modal (most disruptive). The swap pins the user to the single available action while leaving prior conversation visible underneath, and draft preservation neutralizes the historical reason to keep the textarea live during approvals.
- **`previewFormat: 'html'` over `'markdown'`.** Alternatives considered: `'markdown'` (renders through the existing AI Elements markdown pipeline with no new sanitization surface, but loses styled HTML and any preview that relies on tables or non-fenced layout). HTML is strictly more expressive, the SDK already pre-strips `<script>`, `<style>`, and `<!DOCTYPE>`, and the client already renders rich content elsewhere; the added cost is one client-side sanitization dependency plus a scoped CSS wrapper. Trade-off accepted.
- **Side-by-side preview pane, not inline preview blocks.** Alternatives considered: render the preview directly inside each option button (matches the current shape but cramps the option list and forces tiny preview viewports); render preview in a tooltip / hover popover (hides the preview until intent — wrong default when the preview *is* the content). Side-by-side matches the official Claude Code CLI's behavior and gives the preview enough room for its intended layout.
- **Tool approval is buttons-only; "Other" rich input is `AskUserQuestion`-only.** Alternatives considered: a shared "comment" input on every surface (more uniform but adds a textarea the user rarely needs on tool approvals); per-question Other-only and no surface-level affordances. The `AskUserQuestion` semantics already include a free-text path via "Other"; tool approvals have no equivalent in the SDK and adding one would invent product behavior.
- **Stop on the surface (not relying on the prompt input's Stop).** Alternatives considered: leave Stop only on the prompt input (impossible — the prompt input isn't mounted while the surface is active); put Stop in the chat header (too far from the eye line during approval review). On-surface Stop with the existing confirm-popover keeps the abort path within thumb's reach and reuses the existing UX contract.

---

## Dependencies / Assumptions

- The currently-installed Claude Agent SDK version (`^0.2.141`) supports `toolConfig.askUserQuestion.previewFormat: 'html'` and the documented pre-filter of `<script>`, `<style>`, `<!DOCTYPE>`. Verified against the official docs at https://code.claude.com/docs/en/agent-sdk/user-input during brainstorm; verify the installed version surfaces it at planning time.
- DOMPurify (or equivalent client-side sanitizer with a comparable allow-list) is acceptable to add as a runtime dependency on the client.
- The existing `query.interrupt()` + AbortSignal flow in `src/server/services/session-runtime.ts` reliably resolves a pending `canUseTool` callback as a deny without corrupting the long-lived session. Confirmed by code reading; assumption is the wiring continues to work when the surface is the trigger.
- The existing `CommandPicker` and `FilePicker` components in `src/client/components/` can be mounted inside a non-`PromptInput` textarea without modification. Confirmed by signature inspection; the components take a textarea ref and an anchor element, not a fixed parent.
- The chat panel's bottom region is the only place the prompt input renders, so the swap surface has a single mount point. Confirmed via `src/client/components/ChatPanel.tsx`.
- This work **supersedes** the prior brainstorm's R12 and R14–R16 (the banner-above-input shape) and **preserves** every other requirement from that doc: Streaming Input Mode (R11, R18, R19), Allow-always via `localSettings` (R13, R17), the FIFO queue model (carried forward as R3), SSE reconnect / replay (R20, R22), and the Send/Stop/Clear contract on the prompt input itself (R5-R9). The prior doc's R14 ("user can type a follow-up while approval is pending; Send is queued") is *removed* — draft preservation replaces queued-send semantics.
- The "Chat about this" copy is treated as a planning detail (one fixed string) and is not litigated here. Same for the exact tool-input truncation threshold inherited from `ApprovalView`.

---

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R2][Technical] Where is the preserved draft held — in `chat-store` keyed by session ID, in a ref on `ChatPanel`, or in a small piece of local state outside the swapped component tree? Cross-session draft persistence (which session's draft restores when the user switches sessions during a pending request) interacts with the choice.
- [Affects R3][Design] When the surface swaps from one queued request to the next, is there any transition treatment (fade, slide), or is it instant? Instant is the lowest-cost default; planning should pick one and stick to it.
- [Affects R12][Design] What is the exact breakpoint behavior of the side-by-side layout on narrow viewports — does it collapse to a stacked single-column layout below a width threshold, and what is that threshold? The chat panel is the chat-only column today, but the side panel can be resized.
- [Affects R12][Design] Which option drives the preview pane on initial mount — the first option, the first option whose preview is non-empty, or none-until-the-user-hovers? Suggested: the first option with non-empty preview, falling back to first option.
- [Affects R13][Technical] DOMPurify configuration: which tags and attributes are on the allow-list, and is there any post-sanitize transform (e.g., forcing `target="_blank"` + `rel="noopener noreferrer"` on `<a>`)? Tested against the SDK's documented HTML shape during planning.
- [Affects R15][Design] Exact copy of the fixed "Chat about this" discussion-request string. Suggested starting point: `"I'd like to discuss these options before answering. Walk me through the trade-offs."` — pin during planning.
- [Affects R10][Technical] How are picker tokens (e.g., `@src/file.ts`) rendered inside the resolve payload's answer string — verbatim or stripped to plain text? Verbatim is the v1 assumption; verify the SDK handles bare `@` and `/` tokens inside `updatedInput.answers` without misinterpreting them as new commands.
- [Affects R16, R17][Technical] What system-note copy appears in the conversation when the surface's Stop fires vs. when the prompt input's Stop fires? Single copy or per-trigger copy. Suggested: single shared copy.
- [Affects R4][Design] When the input region renders the swap surface, does the disabled-state styling of the surrounding chat panel chrome change (e.g., the header)? Suggested: no change — the surface itself is the only signal needed.
