---
date: 2026-06-13
topic: global-and-workspace-analytics
---

# Global and Workspace Analytics Dashboards

## Summary

Two analytics dashboards — a Global overview and a per-Workspace view — added to comate as a header modal (like Settings), drawing all metrics from the Claude Agent SDK session transcripts that back comate's sessions. Session-level statistics are deferred.

---

## Problem Frame

Comate surfaces token usage only as a live, in-memory, per-session indicator that resets on restart and shows no aggregate or cost view. Users cannot see usage across sessions or workspaces, model or provider mix, tool usage, or estimated spend. The `claude-code-history-viewer` reference app provides exactly this kind of overview from Claude Code transcripts; comate wants the same analytics experience for its own sessions.

---

## Actors

- A1. User: opens the analytics modal, switches tabs, and selects a workspace.
- A2. System: reads session transcripts, aggregates metrics across workspaces and WeCom sessions, and computes estimated cost.

---

## Key Decisions

- **Modal, not a navigation view.** Comate has no top-level view-tabs today; the dashboards open from the header as a modal, matching the existing Settings pattern.
- **Comate-only data scope.** Aggregation covers comate workspaces plus WeCom bot sessions. It does not scan the Claude Code CLI's own transcripts.
- **Transcripts as the data source.** Comate sessions are backed by Claude Agent SDK JSONL transcripts that already carry per-turn token, cost, and duration data, so no new persistence layer is required and full history is available.
- **Workspace is the project equivalent.** The reference app's "project" (a Claude Code directory) maps to comate's "workspace" as the mid-tier aggregation unit.
- **Cost is an estimate.** Comate has no billing data; cost is derived from token counts and model pricing, labeled as estimated, with a coverage indicator for models whose pricing is unknown.
- **Session statistics are deferred.** Per-session detail (rank, efficiency, percentile, timeline) is out of v1 and added later on user demand.

---

## Key Flows

- F1. Opening analytics
  - **Trigger:** User clicks the analytics action in the header toolbar.
  - **Actors:** A1
  - **Steps:**
    1. Modal opens at the last-used tab, defaulting to Global.
  - **Outcome:** The analytics modal is visible.
  - **Covered by:** R1, R2

- F2. Switching scope
  - **Trigger:** User selects the Global or Workspace tab.
  - **Actors:** A1
  - **Steps:**
    1. The selected tab renders its scoped metrics and charts.
  - **Outcome:** The chosen scope's view is shown.
  - **Covered by:** R2, R3, R6

- F3. Selecting a workspace
  - **Trigger:** On the Workspace tab, the user picks a workspace from the selector.
  - **Actors:** A1, A2
  - **Steps:**
    1. System aggregates transcript data for the selected workspace.
    2. Headline metrics and charts populate for that workspace.
  - **Outcome:** Workspace-scoped statistics are displayed.
  - **Covered by:** R6, R7, R8

---

## Requirements

**Entry and navigation**

- R1. Analytics opens as a modal from the header toolbar, following the existing Settings modal pattern.
- R2. The modal exposes two sub-tabs: Global and Workspace.

**Global statistics**

- R3. The Global tab aggregates across all comate workspaces and WeCom bot sessions.
- R4. The Global tab shows headline metric cards: total tokens with estimated cost, total messages with session count, total session duration, and distinct tools used.
- R5. The Global tab shows provider distribution, model distribution, most-used tools, a daily activity heatmap, and a top-workspaces ranking by tokens.

**Workspace statistics**

- R6. The Workspace tab provides a selector for choosing among the user's workspaces.
- R7. The Workspace tab shows headline metric cards scoped to the selected workspace: total messages, total tokens with session count, total and average session duration, and tools used, each with a recent growth trend.
- R8. The Workspace tab shows an activity heatmap, most-used tools, a daily activity trend, and a token-type distribution.

**Data sourcing**

- R9. Statistics are derived from the Claude Agent SDK session transcripts that back comate sessions, without building a new persistence layer.
- R10. Aggregation covers all comate workspaces plus WeCom bot sessions, and excludes the Claude Code CLI's own transcripts under `~/.claude/projects`.
- R11. Cost is computed from token counts and model pricing, labeled as estimated, with a pricing-coverage indicator.

**Presentation and quality**

- R12. The dashboards follow the app's light and dark themes and the existing en and zh-CN localizations.
- R13. Each view renders an empty state when no transcript data exists for its scope.

---

## Acceptance Examples

- AE1. **Empty state**
  - **Covers R13.**
  - **Given** a workspace has no sessions,
  - **When** the user opens the Workspace tab and selects that workspace,
  - **Then** headline metrics show zero and charts show an empty-state message.

- AE2. **WeCom data included globally**
  - **Covers R3, R10.**
  - **Given** WeCom bot sessions exist,
  - **When** the user opens the Global tab,
  - **Then** those sessions' tokens, messages, and duration are included in the aggregates and in the top-workspaces ranking.

- AE3. **Unknown pricing excluded from cost**
  - **Covers R11.**
  - **Given** a session used a model whose pricing is unknown,
  - **When** cost is computed,
  - **Then** that session's tokens are excluded from cost and the pricing-coverage indicator reflects the gap.

---

## Success Criteria

- The Global and Workspace tabs present the same metric and chart families as the reference app's global and project views.
- Numbers reflect real comate session data drawn from transcripts, including sessions created before the feature shipped.
- The experience opens from the header like Settings and feels native to comate's existing UI.

---

## Scope Boundaries

**Deferred for later**

- Session statistics — per-session rank, tokens per message, duration rank, percentile, and timeline (the reference app's session view).
- Real-time cost accrual during active streaming; v1 refreshes on open.
- Exporting or sharing analytics reports.

**Outside this product's identity**

- Reading or scanning the Claude Code CLI's own transcripts under `~/.claude/projects` — comate sessions only.

---

## Dependencies / Assumptions

- Comate sessions are backed by Claude Agent SDK JSONL transcripts that contain per-turn usage, cost, and duration fields. Verified in `src/server/services/chat-service.ts`, which uses the SDK's `query` and `GetSessionMessages` and references JSONL transcript order.
- The transcript file for a session can be resolved from its session id and workspace working directory. To be confirmed during planning.
- Model pricing is available or derivable for the estimate; models without known pricing are excluded from cost and reflected in coverage.

---

## Outstanding Questions

*Deferred to planning*

- Workspace picker UX (dropdown versus searchable list) for users with many workspaces.
- Refresh model: recompute on modal open, cache with manual refresh, or background refresh.
- Time window definition for the "recent growth trend" on the Workspace tab.
- Whether the in-memory live per-session usage in `src/client/stores/chat-store.ts` feeds a live current-session indicator, or whether analytics is strictly transcript-derived.

---

## Sources / Research

- Reference app (sibling project `claude-code-history-viewer`): global, project, and session views under `src/components/AnalyticsDashboard/views/`; calculation utilities under `src/components/AnalyticsDashboard/utils/`; types `src/types/analytics.ts` and `src/types/stats.types.ts`; copy strings `src/i18n/locales/en/analytics.json`.
- Comate data model: `src/client/stores/chat-store.ts` (in-memory `SessionUsage`), `src/client/components/SessionTokenUsage.tsx` (existing live token display), `src/server/services/chat-service.ts` (SDK query and transcript usage), `src/server/storage/sqlite-store.ts` (`sessions` schema).
- Existing modal pattern to follow: `src/client/App.tsx` (`showSettings`) and `src/client/components/SettingsPanel.tsx`.
