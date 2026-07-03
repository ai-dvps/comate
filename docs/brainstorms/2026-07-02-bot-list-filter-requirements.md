---
date: 2026-07-02
topic: bot-list-filter
---

## Summary

Add a name search filter to the top of the bot list on the bot settings page. The filter narrows the list after the user presses Enter, uses fuzzy matching on bot names, and keeps the right pane in sync by falling back to the first visible bot when the current selection is filtered out.

---

## Problem Frame

The bot settings page shows every bot in a single left-hand list. Once an organization has more than a handful of bots, scanning the list to find the right one becomes slow and error-prone. A lightweight search lets users jump directly to a bot by name without restructuring the page or adding heavy filtering machinery.

---

## Key Decisions

- **Fuzzy name matching over substring matching** — tolerates minor typos and partial matches, which fits the "I know roughly what it's called" retrieval scenario.
- **Enter-to-filter over instant filtering** — avoids list flicker and reduces re-renders while the user is still typing.
- **Switch to first visible match when the current bot is filtered out** — keeps the left list and right pane consistent. This reuses the existing dirty-change guard if the user has unsaved edits.
- **No query persistence** — the search box starts empty each time the user opens bot settings, keeping the feature simple and side-effect-free.
- **No keyboard shortcut** — the search input is reachable by mouse/Tab only; avoids shortcut collisions with the session list or global bindings.

---

## Requirements

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

---

## Acceptance Examples

- AE1. **Filter by name**
  - **Covers:** R1, R2, R3.
  - **Given:** the bot list contains bots named "Dev Helper", "Sales Bot", and "Support Bot".
  - **When:** the user types "dev" and presses Enter.
  - **Then:** only "Dev Helper" remains visible; the match count shows "1".

- AE2. **Fuzzy match**
  - **Covers:** R3.
  - **Given:** the bot list contains "Development Bot".
  - **When:** the user types "develpment" and presses Enter.
  - **Then:** "Development Bot" remains visible because the fuzzy match tolerates the missing letter.

- AE3. **Clear restores the list**
  - **Covers:** R4, R7.
  - **Given:** the user has filtered the list to one bot.
  - **When:** the user clicks the clear button.
  - **Then:** the full bot list reappears; the bot that was selected while filtered stays selected.

- AE4. **Current selection filtered out**
  - **Covers:** R5.
  - **Given:** "Sales Bot" is selected and the user searches for "support".
  - **When:** the filter is applied.
  - **Then:** "Sales Bot" disappears from the list, "Support Bot" becomes selected, and the right pane shows Support Bot's settings.

- AE5. **Unsaved changes guard**
  - **Covers:** R5.
  - **Given:** the user has edited the selected bot's settings but not saved.
  - **When:** a filter is applied that removes the edited bot from the list.
  - **Then:** a Save/Discard dialog appears; choosing Save persists the changes and switches to the first visible bot, while choosing Discard discards the changes and switches.

- AE6. **No matches**
  - **Covers:** R6.
  - **Given:** the user searches for a name that matches no bot.
  - **When:** the filter is applied.
  - **Then:** the list shows an empty state such as "No bots found" and the match count shows "0".

---

## Scope Boundaries

- Channel, workspace, and status filters are out of scope for this change.
- Query persistence, search history, and saved filters are out of scope.
- Server-side search or pagination is out of scope; filtering is client-side against the already-loaded bot list.

---

## Dependencies / Assumptions

- The bot list is already available in client state via `useBotStore`; no new backend endpoint is needed.
- Each bot has a `name` field suitable for matching.
- The existing dirty-change detection and confirmation dialog in `BotManagementPage` will handle selection switches caused by filtering.

---

## Outstanding Questions

- **Deferred to planning:** Which fuzzy matching implementation should be used? Options range from a simple tolerance function to a small string-similarity library.

---

## Sources / Research

- `src/client/components/BotTabShell.tsx` — renders the left bot list and is the natural place for the search input.
- `src/client/components/BotManagementPage.tsx` — manages selected-bot state and dirty-change guarding.
- `src/client/stores/bot-store.ts` — defines the `Bot` type and holds the bot list in client state.
- `src/client/components/SessionList.tsx` and `src/client/components/SessionStatusFilterControl.tsx` — existing search and filter patterns in the same codebase.
