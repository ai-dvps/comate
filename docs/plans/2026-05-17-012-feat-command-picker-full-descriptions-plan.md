---
status: completed
type: feat
created: 2026-05-17
origin: docs/brainstorms/2026-05-17-slash-command-discovery-requirements.md
---

# Feat: Command Picker — Show Full Descriptions in List Rows

## Problem

The slash-command picker (`CommandPicker`) currently clips each command's description to a single line using the Tailwind `truncate` utility. Commands shipped by the Claude Code SDK and user-defined commands often carry descriptions longer than one line (e.g., usage hints, scope notes). Today those tails are hidden behind an ellipsis, defeating the primary purpose of the description column — letting users scan and choose the right command without leaving the picker.

The originating requirement is unambiguous: per the slash-command-discovery requirements doc (see origin), R10 reads "Each row shows the command's name (with leading `/`), its description, and its aliases when present." No truncation contract was specified; single-line clipping was introduced as an implementation default during U5/U6 of the picker build. This plan removes that clip so the full description is visible.

## Scope

**In scope.** The description text rendered inside each row of `CommandPicker.tsx`.

**Out of scope.**
- Aliases truncation (line 237) — aliases are short slash-tokens (e.g., `/help /h`); keep as-is.
- Filter input (line 187) — not a row.
- Built-in command descriptions, server-side ingestion, frontmatter parsing — text remains the source of truth as-is.
- Popover sizing (`w-[360px] max-h-[320px]`) — keep the existing bounds; the list already scrolls.

## Key Technical Decision

**Allow the description to wrap on word boundaries, with `break-words` as a safety net for unbroken tokens (e.g., URLs).** Replace `text-[11px] text-text-tertiary truncate mt-0.5` with `text-[11px] text-text-tertiary break-words mt-0.5`. No explicit `whitespace-*` class is needed — Tailwind's default `whitespace-normal` already permits wrapping; `break-words` adds graceful handling of pathological strings.

**Why this and not a clamp?** A 2-line `line-clamp-2` would keep row heights bounded but reintroduce hidden text, which is exactly what the user is trying to remove. Full wrap honors the request directly. Variable row heights are already correctly handled by the active-row `scrollIntoView({ block: 'nearest' })` call (CommandPicker.tsx:103), and the popover's `overflow-y-auto` (line 200) keeps the surface bounded by the existing `max-h-[320px]`.

**Why `break-words` and not `break-all`?** `break-all` breaks at arbitrary character boundaries even mid-word, which is ugly for typical prose. `break-words` (`overflow-wrap: break-word`) only breaks when a single token would otherwise overflow — a strict superset of safe behavior.

## Implementation Units

### U1: Remove single-line truncation on description rows

**Goal.** The full text of each command's `description` field is visible inside the picker row. Long descriptions wrap across multiple lines without breaking row layout or keyboard navigation.

**Files.**
- Modify: `src/client/components/CommandPicker.tsx`

**Approach.** In the row rendering block at lines 242–246, swap the description div's class list from `text-[11px] text-text-tertiary truncate mt-0.5` to `text-[11px] text-text-tertiary break-words mt-0.5`. No other markup changes.

**Patterns to follow.** The textarea in `PromptInput.tsx:205` uses `whitespace-pre-wrap break-words` for similar long-content wrapping safety. We don't need `whitespace-pre-wrap` here because descriptions don't carry meaningful whitespace, but the `break-words` half of that pattern applies directly.

**Verification.**
1. Open the picker via `/` in `PromptInput`; a command with a short description (e.g., one of the always-present SDK commands) renders as before — single line, no ellipsis.
2. A command with a longer description renders the full text wrapped across multiple lines inside its row.
3. ArrowDown / ArrowUp still cycles `activeIndex` across rows, including multi-line rows; the highlighted (`bg-surface-hover`) row remains visually identifiable.
4. Keyboard navigation onto a row whose bottom is below the popover viewport scrolls it into view (`scrollIntoView({ block: 'nearest' })` continues to work for variable heights).
5. A description containing a long unbroken token (e.g., a URL pasted into a custom command's `description` frontmatter) does not overflow horizontally — `break-words` breaks the token at the right edge.
6. `npm run lint` and `npm run build` complete without new warnings or errors.

## Test Scenarios

Manual test scenarios (no automated tests are added; this is a CSS-only display change, and the existing component has no unit-test coverage to extend without scope creep).

- **TS1 — Short description renders as before.** Open the picker; pick any command whose description fits in one line at 360px width. Confirm no visible difference from before this change.
- **TS2 — Long description wraps in place.** With a custom slash command whose `description` exceeds one line at 360px (or temporarily inject one into the workspace's `.claude/commands/` directory if no live one exists), open the picker; confirm the description renders across multiple lines inside the row, all text visible.
- **TS3 — Keyboard navigation across variable heights.** With at least one multi-line row in the visible list, use ArrowDown/ArrowUp to walk through rows; confirm the active row indicator follows correctly and the row stays inside the popover viewport.
- **TS4 — Click selection still works on multi-line rows.** Click a multi-line row; confirm `handleCommandSelect` fires in `PromptInput`, the textarea fills with `/${name} `, and the picker closes.
- **TS5 — Pathological-token safety.** Construct a custom command whose description contains a long unbroken token (e.g., `https://example.com/very/long/path/that/keeps/going/and/going`); confirm the token breaks at the row's right edge rather than overflowing horizontally.

## Risks & Considerations

- **List density decreases.** With multi-line descriptions, fewer rows fit in the 320px popover at once, so scanning a long list requires more scrolling. This is the user's explicit tradeoff (favor information completeness over at-a-glance density) and matches R10's "shows the command's … description" without a truncation qualifier.
- **No layout regression for the filter input branch.** When `hideFilterInput` is false (Commands-button entry), the filter input occupies a small amount of top space; the list area still flexes (`flex-1 overflow-y-auto`) inside the remaining height. Multi-line rows don't compete with the filter input.
- **Description content is server-controlled.** Descriptions originate from the SDK init message or `.claude/commands/` frontmatter; there is no XSS risk from this change because the description is rendered as a React text child, not as HTML.

## Verification

- `npm run lint` — clean.
- `npm run build` — clean.
- Manual test scenarios TS1–TS5 above pass.

## References

- Originating requirements: `docs/brainstorms/2026-05-17-slash-command-discovery-requirements.md` (R10).
- Predecessor plan that introduced the picker: `docs/plans/2026-05-17-011-feat-slash-command-discovery-plan.md`.
- Truncation site: `src/client/components/CommandPicker.tsx:243`.
- Variable-height scroll handling already in place: `src/client/components/CommandPicker.tsx:101–104`.
