---
date: 2026-06-19
topic: chat-message-search
---

## Summary

Add a floating search bar to the chat panel that lets users find keywords inside the active session's loaded messages. Matches are highlighted in place, the full conversation remains scrollable, and users can jump between matches with previous/next controls.

## Problem Frame

Long chat sessions accumulate many messages. When a user needs to refer back to an earlier prompt, response, tool result, or system notice, scrolling manually is slow and unreliable. There is no way to quickly locate specific text inside the current conversation.

## Requirements

**Search UI and activation**

- R1. A floating search bar appears inside the chat panel when the user presses `Cmd/Ctrl+F`.
- R2. The search bar contains a text input, a match counter showing the current match index and total (e.g., `2/12`), previous/next buttons, and a clear/close control.
- R3. The search bar can also be closed by pressing `Esc`.

**Matching behavior**

- R4. Typing in the search input performs substring, case-insensitive matching against all rendered text content of the loaded messages in the active session.
- R5. Matching covers user prompts, assistant responses, tool results, thinking blocks, and system messages.
- R6. Matching messages are visually highlighted in the message list without hiding non-matching messages.

**Navigation and interaction**

- R7. The user can navigate between highlighted matches using the previous/next buttons.
- R8. Navigation scrolls the selected match into view.
- R9. When no matches are found, the search bar shows an empty state indicating zero matches.

**Lifecycle and reset**

- R10. The search query resets to empty and the search bar closes when the user switches to a different session.
- R11. Closing the search bar clears highlights and removes the match counter.

## Key Decisions

- **Highlight matches in place rather than filtering the list.** This keeps conversational context visible and avoids the disorientation of a filtered view. The trade-off is more scrolling when matches are sparse.
- **Client-side search over loaded messages only.** This avoids new server endpoints or storage changes and is sufficient for the current need. The trade-off is that unloaded older messages cannot be searched until they are fetched.
- **Substring, case-insensitive matching.** This is predictable and fast, matching the existing session-list search pattern in `src/client/lib/session-filter.ts`.
- **Intercept `Cmd/Ctrl+F` for the custom search bar.** Because Comate runs as a Tauri desktop app, the webview does not provide a reliable native find experience, so a custom shortcut is appropriate.

## Scope Boundaries

- Server-side message search, indexing, or full-text storage changes.
- Searching across sessions or workspaces.
- Searching messages that have not yet been loaded from the server.
- Fuzzy matching, regular expressions, whole-word matching, or a case-sensitive mode.
- Search-and-replace or persistent search history.
- Keyboard shortcuts other than `Cmd/Ctrl+F` to open search.

## Acceptance Examples

- AE1. **Open search and find matches**
  - **Given:** the active session contains the word "config" in an assistant message.
  - **When:** the user presses `Cmd/Ctrl+F` and types `config`.
  - **Then:** the search bar appears, all occurrences of "config" are highlighted, and the match counter shows the total number of matches.

- AE2. **Navigate between matches**
  - **Given:** the search query has five matches.
  - **When:** the user clicks the next button twice.
  - **Then:** the third match is scrolled into view and the counter shows `3/5`.

- AE3. **Close search clears highlights**
  - **Given:** the search bar is open and matches are highlighted.
  - **When:** the user presses `Esc`.
  - **Then:** the search bar closes and all highlights are removed.

- AE4. **Switch session resets search**
  - **Given:** the user has typed a query in the active session's search bar.
  - **When:** the user switches to another session.
  - **Then:** the search bar closes, the query is cleared, and no highlights remain.

- AE5. **No matches empty state**
  - **Given:** the active session contains no occurrence of "xyz".
  - **When:** the user types `xyz` into the search input.
  - **Then:** the match counter shows `0/0` and an empty state indicates no matches.

## Dependencies / Assumptions

- Messages must already be loaded into the client store before they can be searched.
- The app runs as a Tauri desktop app, so intercepting `Cmd/Ctrl+F` does not conflict with a reliable browser-native find experience.
- Message rendering components can be extended or wrapped to support inline highlight rendering.
- The virtualized message list used when a session exceeds 50 messages can be made to highlight and scroll to matches that are not currently rendered.

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- Exact visual highlight style and color token to use.
- Whether to persist search query per session in UI state or treat it as ephemeral.
- Strategy for highlighting and scrolling to matches inside the virtualized message list when they are outside the current render window.
