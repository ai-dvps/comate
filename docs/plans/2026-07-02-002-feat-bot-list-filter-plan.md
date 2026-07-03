---
title: feat: Add bot list name search filter
type: feat
date: 2026-07-02
origin: docs/brainstorms/2026-07-02-bot-list-filter-requirements.md
---

## Summary

Add a name search filter to the top of the bot list on the bot settings page. The filter uses Enter-to-trigger, order-preserving fuzzy matching, shows a clear button and match count, and falls back to the first visible bot when the current selection is filtered out.

---

## Problem Frame

The bot settings page (`src/client/components/BotManagementPage.tsx`) lists every bot in a single left sidebar. Once an organization has more than a few bots, scrolling to find the right one is slow. A lightweight local search lets users jump to a bot by name without changing page structure or adding backend work.

---

## Requirements

These requirements are carried from `docs/brainstorms/2026-07-02-bot-list-filter-requirements.md`.

### Search input

- R1. A search input is placed at the top of the left bot list, above the bot names.
- R2. Filtering happens when the user presses Enter; typing alone does not change the list.
- R3. The filter performs case-insensitive fuzzy matching against each bot's `name`.
- R4. A clear button appears inside the input when a query is present; clicking it clears the query and restores the full list.

### Selection and visibility

- R5. If the currently selected bot no longer matches the filter, the selection moves to the first visible bot and the right pane updates accordingly.
- R6. If no bots match the filter, the list shows an empty state explaining that no bots were found.
- R7. When the filter is cleared, the full list is restored and the current selection remains on the bot that was selected while filtered.

### Feedback

- R8. The UI displays the count of matching bots while a filter is active.
- R9. The search query is not persisted when the user leaves the bot settings page or reloads the app.

### Acceptance examples carried forward

- AE1. Typing "dev" and pressing Enter filters a list of "Dev Helper", "Sales Bot", "Support Bot" to only "Dev Helper"; match count shows "1".
- AE2. Typing "develpment" still matches "Development Bot" because fuzzy matching tolerates the missing letter.
- AE3. Clicking clear restores the full list; the bot selected while filtered stays selected.
- AE4. Searching "support" while "Sales Bot" is selected switches selection to "Support Bot" and updates the right pane.
- AE5. If the selected bot has unsaved edits when a filter removes it, a Save/Discard dialog appears; Save persists changes and switches, Discard discards changes and switches.
- AE6. A query matching no bot shows a "No bots found" empty state and a "0" count.

---

## Key Technical Decisions

- **Order-preserving fuzzy matching with fuzzysort.** The project already depends on `fuzzysort` and uses it in `src/client/lib/picker-filter.ts`. The bot filter will score each bot against the query and return only the matching items in their original array order, rather than the relevance-sorted order returned by `filterItems`.
- **Filter state stays local to the bot settings page.** `useBotStore` already exposes the full bot list; no store changes are needed. The query and filtered list live as local state/memo in `BotManagementPage.tsx`, alongside `selectedBotId`.
- **Save/Discard-only dialog for filter-induced selection switches.** The existing unsaved-changes dialog has Save, Discard, and Keep Editing. When filtering forces a selection change, only Save and Discard are offered because Keep Editing would leave the right pane showing a bot that is hidden from the left list.

---

## Implementation Units

### U1. Create order-preserving bot name filter utility and tests

**Goal:** Provide a reusable, tested function that filters bots by name with fuzzy matching while preserving the input order.

**Requirements:** R3, AE2, AE6.

**Dependencies:** None.

**Files:**
- `src/client/lib/bot-filter.ts` (new)
- `src/client/lib/bot-filter.test.ts` (new)

**Approach:**
- Export `matchesBotName(bot, query)` returning a boolean, and `filterBotsByName(bots, query)` returning `Bot[]`.
- Use `fuzzysort.go(query, bots, { key: 'name', limit: bots.length, threshold: -10000 })` or equivalent to determine matches.
- Preserve original order by collecting matched ids into a `Set` and then filtering the original array.
- Trim and lowercase the query; return all bots for empty or whitespace-only queries.

**Patterns to follow:** `src/client/lib/picker-filter.ts` and `src/client/hooks/picker-filter.test.ts` for fuzzysort usage and test style.

**Test scenarios:**
- Empty/whitespace query returns all bots unchanged.
- Case-insensitive substring match ("dev" matches "Dev Helper").
- Fuzzy match tolerates missing letters ("develpment" matches "Development Bot").
- Results preserve the original array order regardless of match quality.
- No matches returns an empty array.

**Verification:** `npm run test:client -- src/client/lib/bot-filter.test.ts` passes.

---

### U2. Add search input and filtered list UI to BotTabShell

**Goal:** Render the search input, clear button, match count, empty state, and filtered bot list in the left sidebar.

**Requirements:** R1, R2, R4, R6, R8, AE1, AE3, AE6.

**Dependencies:** U1.

**Files:**
- `src/client/components/BotTabShell.tsx`
- `src/client/components/BotTabShell.test.tsx` (new)
- `src/client/i18n/en/settings.json`
- `src/client/i18n/zh-CN/settings.json`

**Approach:**
- Extend `BotTabShellProps` with `searchQuery`, `onSearchQueryChange`, and `matchCount`.
- Add a search input at the top of the left column, following the layout pattern in `src/client/components/SessionList.tsx` (absolute `Search` and `X` icons, `pl-8 pr-7` input).
- Trigger `onSearchQueryChange` on Enter; Escape clears and focuses the input.
- Show the clear `X` button only when the query is non-empty.
- Display the match count while a filter is active.
- Show a "No bots found" empty state when `bots.length === 0 && query.trim() !== ''`.
- Keep the existing "Create Bot" button accessible below the list.
- Add i18n keys under `bots`: `searchPlaceholder`, `clearSearch`, `noMatchingBots`, `matchingBotCount_one`, `matchingBotCount_other`.

**Patterns to follow:** `src/client/components/SessionList.tsx` for search input structure and keyboard handling; existing `BotTabShell.tsx` structure and styling.

**Test scenarios:**
- Renders the search input with the placeholder.
- Typing and pressing Enter calls `onSearchQueryChange` with the query.
- Pressing Escape clears the query.
- Clear button appears when query is present and clicking it clears the query.
- Empty state renders when no bots match and a query exists.
- Match count renders while a filter is active.
- Create-bot button remains visible.

**Verification:** `npm run test:client -- src/client/components/BotTabShell.test.tsx` passes; linter passes.

---

### U3. Wire filter state and Save/Discard selection fallback in BotManagementPage

**Goal:** Manage the query state, compute the filtered list, and keep the selected bot in sync with the filtered results.

**Requirements:** R5, R7, R8, R9, AE1, AE3, AE4, AE5.

**Dependencies:** U2.

**Files:**
- `src/client/components/BotManagementPage.tsx`
- `src/client/components/BotManagementPage.test.tsx`

**Approach:**
- Add local state `searchQuery` and a trimmed copy.
- Compute `filteredBots` with `useMemo(() => filterBotsByName(displayBots, trimmedQuery), [displayBots, trimmedQuery])`.
- Compute `matchCount = filteredBots.length` and pass it to `BotTabShell`.
- Add a `useEffect` on `[filteredBots, selectedBotId]`: if the selected bot is not in `filteredBots` and `filteredBots` is non-empty, prompt for Save/Discard when dirty, then set `selectedBotId` to `filteredBots[0].id`. If `filteredBots` is empty, leave the current selection in place until the filter is cleared or a match appears.
- Reuse the existing unsaved-changes dialog logic but suppress the "Keep editing" option when the switch is filter-induced.
- Track whether the pending selection change is user-initiated or filter-initiated so the dialog options can differ.
- Clearing the query restores the full `displayBots` list; the current selection remains unchanged.

**Patterns to follow:** Existing `handleSelectBot` dirty guard in `BotManagementPage.tsx`; existing deletion fallback `useEffect` that picks `displayBots[0]`.

**Test scenarios:**
- Typing a query and pressing Enter updates the passed `bots` prop and the match count.
- Filtering out the selected bot switches selection to the first visible match.
- Filtering out a dirty bot opens a Save/Discard dialog; Save persists then switches, Discard discards then switches.
- The Save/Discard dialog does not offer Keep Editing.
- Clearing the search restores the full list and preserves the current selection.
- No matches shows the empty state and does not crash the right pane.

**Verification:** `npm run test:client -- src/client/components/BotManagementPage.test.tsx` passes; `npm run lint` passes.

---

## Scope Boundaries

- Channel, workspace, and status filters are out of scope.
- Query persistence, search history, and saved filters are out of scope.
- Server-side search, pagination, or API changes are out of scope.
- Keyboard shortcuts to focus the search input are out of scope.

---

## Open Questions

None. The deferred fuzzy-matching implementation question is resolved by reusing `fuzzysort` with order-preserving filtering.

---

## Sources / Research

- `docs/brainstorms/2026-07-02-bot-list-filter-requirements.md` — origin requirements and acceptance examples.
- `src/client/components/BotTabShell.tsx` — left sidebar bot list.
- `src/client/components/BotManagementPage.tsx` — selected-bot state and dirty-change guard.
- `src/client/components/SessionList.tsx` — existing search input pattern.
- `src/client/lib/picker-filter.ts` and `src/client/hooks/picker-filter.test.ts` — existing fuzzysort usage.
- `src/client/stores/bot-store.ts` — `Bot` shape and client state.
- `src/client/i18n/en/settings.json` and `src/client/i18n/zh-CN/settings.json` — settings namespace translations.
