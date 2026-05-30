# Bot Session Footer Polish

**Status:** active  
**Created:** 2026-05-30  
**Scope:** UI-only polish of the WeCom bot session read-only footer in the chat input area.

## Problem Frame

The WeCom bot session footer currently renders as two stacked rows with excessive vertical padding. It also fails to correctly truncate and display the username and last-message timestamp, causing layout breakage or clipped text. The panel also visually resembles an input box due to its border and background, which is misleading since bot sessions are read-only.

## Requirements Traceability

| # | Requirement | Origin |
|---|-------------|--------|
| R1 | Compact all footer information into a single horizontal line | User request |
| R2 | Reduce overall panel height / vertical footprint | User request |
| R3 | Username and last-seen timestamp display correctly without truncation bugs | User request |
| R4 | Keep existing i18n keys and `refreshMeta` behavior | Existing code constraint |

## Decisions

### Layout: Single-line flex row with space-between
- **Rationale:** The footer must display bot identity (icon + name), user identity (icon + name + timestamp), refresh status, and refresh button. A single flex row with `justify-between` groups left-side identity and right-side action, which is the most space-efficient pattern.
- **Trade-off:** Very long bot names or user IDs may truncate aggressively. This is acceptable because the primary action (refresh) must remain visible and tappable.

### Remove input-like styling for bot sessions
- **Rationale:** The current `bg-surface border border-border rounded-xl` styling makes the read-only footer look like an active input box, which is confusing.
- **Approach:** For bot sessions, render the footer without the input-box background/border. Use transparent background or a subtle top border separator instead.

### Truncation strategy: nested flex with `min-w-0`
- **Rationale:** Previous display bugs stem from missing `min-w-0` on flex containers that contain `truncate` children. Flex items default to `min-width: auto`, which prevents truncation from working.
- **Approach:** Every flex container that wraps a `truncate` text node must have `min-w-0`. Icons and buttons must have `flex-shrink-0`.

## Implementation Units

### IU-1: Redesign bot session footer JSX (`src/client/components/PromptInput.tsx`)

**Changes:**
1. Restructure the `isBotSession ? (...)` branch from a two-row `flex-col` to a single-row `flex items-center justify-between gap-2`.
2. Left group: WeCom icon (`flex-shrink-0`) + bot name span (`truncate`) inside a `min-w-0` container.
3. Center group (or middle-left): User icon (`flex-shrink-0`) + user ID span (`truncate`) + optional timestamp (`flex-shrink-0`). Wrap in `min-w-0` container.
4. Right group: Refresh status text (`truncate`) + refresh button (`flex-shrink-0`).
5. Remove the outer `bg-surface border border-border rounded-xl` container styling for bot sessions, or replace with a minimal `border-t border-border/30 bg-bg` to match the non-bot footer separator.
6. Reduce vertical padding: change outer container from `py-4` to `py-2` or `py-3` for bot sessions.
7. Ensure the refresh button uses compact padding (`px-2 py-1` or icon-only) to save horizontal space.

**Test Scenarios:**
- [ ] Bot name is set: shows name, truncated if long.
- [ ] Bot name is empty/null: shows "not set" in `text-text-tertiary`.
- [ ] User ID is long: truncates with ellipsis, does not push refresh button off-screen.
- [ ] `lastSeenAt` is present: timestamp appears after `·` separator.
- [ ] `lastSeenAt` is null: no timestamp shown, no stray `·`.
- [ ] `refreshMeta.isRefreshing` true: shows spinner + "refreshing" text, button disabled.
- [ ] `refreshMeta.lastError` true: shows relative time + "refresh failed".
- [ ] `refreshMeta.lastNewCount > 0`: shows relative time + "N new messages".
- [ ] Responsive: at narrow widths, left-side identity truncates before right-side button is hidden.

### IU-2: Verify no server or i18n changes needed

**Check:**
- `src/server/routes/chat.ts` `/wecom-user` endpoint already returns `userId` and `lastSeenAt`.
- i18n keys `notSet`, `refresh`, `refreshing`, `neverRefreshed`, `noNewMessages`, `refreshFailed`, `newMessages_one`, `newMessages_other`, `time.*` already exist in both `en/chat.json` and `zh-CN/chat.json`.

**No file changes expected.**

## Dependencies & Sequencing

1. **IU-1** is independent and can be implemented directly. No server changes or data model changes are required.
2. Manual UI testing in browser for truncation behavior at various viewport widths.

## Risks

| Risk | Mitigation |
|------|------------|
| Horizontal overflow on small screens | Use `min-w-0` + `truncate` everywhere; test at 320px width |
| Refresh button text too wide in Chinese | Allow button to shrink to icon-only on very narrow viewports if needed |
| Losing visual separation between footer and messages | Keep a subtle `border-t` or `bg-bg` |
