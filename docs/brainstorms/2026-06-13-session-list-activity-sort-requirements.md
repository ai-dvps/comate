---
date: 2026-06-13
topic: session-list-activity-sort
---

## Summary

Sort the session list by recency of activity, with sessions that have current activity (streaming, unread completions, pending approvals) at the top. When activity clears, sessions settle into their last-active position instead of returning to a fixed original order.

## Problem Frame

In `src/client/components/SessionList.tsx`, sessions are rendered in the order returned by the server. Sessions with live activity can fall below inactive ones, forcing the user to scan the list for the session that needs attention. The user wants recent activity to determine list order so the most relevant sessions are always at the top.

## Requirements

- R1. The session list is sorted by most-recent activity first.
- R2. Activity includes streaming/processing, unread completions, and pending approvals.
- R3. Inactive sessions are ordered by the time of their last activity, not by a fixed original position.
- R4. The selected session receives no special placement unless it also has activity.
- R5. Search filters the sorted list without changing the sort order.
- R6. Sorting does not add a separate pinned header or visual section; rows keep their existing styling.

## Key Decisions

- **Full recency sort instead of a pinned header.** The user rejected pinning; the list itself is reordered by activity.
- **Activity defines recency, not selection.** Selection state remains independent of list order.
- **No visual grouping.** Active and inactive sessions are not separated by headers, borders, or distinct styles; existing status indicators already communicate activity.

## Scope Boundaries

- Pinning sessions above the list.
- Manual reordering by the user.
- Sorting by name, creation date, or other non-activity criteria.
- Adding new visual highlights or badges beyond what already exists.

## Acceptance Examples

- AE1. **Streaming session rises to the top.**
  - **Given:** session A is inactive and session B starts streaming.
  - **When:** the streaming state updates.
  - **Then:** session B appears above session A in the list.

- AE2. **Newer activity wins.**
  - **Given:** session B was streaming and then stopped; session C receives a new unread completion.
  - **When:** the unread state updates.
  - **Then:** session C appears above session B.

- AE3. **Search preserves sort.**
  - **Given:** the list is sorted by recency and the user types a query.
  - **When:** the filtered list renders.
  - **Then:** matching sessions remain in recency order.

- AE4. **Inactive session stays in last-active order.**
  - **Given:** session D had activity five minutes ago and is now inactive, while session E had activity one minute ago and is now inactive.
  - **When:** the list renders.
  - **Then:** session E appears above session D.
