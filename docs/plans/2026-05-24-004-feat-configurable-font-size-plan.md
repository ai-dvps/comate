---
title: "feat: Add configurable chat and UI font size preferences"
type: feat
status: active
date: 2026-05-24
origin: docs/brainstorms/2026-05-24-configurable-chat-font-size-requirements.md
---

# feat: Add configurable chat and UI font size preferences

## Summary

Add two independent font size preferences (Small/Medium/Large) stored in `useAppSettings`. Chat font size applies at the message list container level; message components inherit after removing hardcoded `text-sm` classes. UI font size applies at the App root with targeted adjustments to key chrome components.

## Problem Frame

Chat messages currently render at a fixed 14px (`text-sm`) with no user control. Reducing the default creates more content density, while a preset system lets users who need larger text adjust easily.

## Requirements

- R1. Chat message font size preference with Small (12px), Medium (14px), Large (16px) presets; default Small.
- R2. Chat font size applies to all message content: user text, assistant text, reasoning blocks, tool output, and code blocks.
- R3. Non-chat UI font size preference with same presets; default Medium.
- R4. UI font size applies to sidebar, headers, tabs, input areas, and settings panels.
- R5. Both preferences stored app-wide in localStorage and persisted across sessions.
- R6. Controls live in Settings → Appearance as mutually exclusive preset buttons.

## Scope Boundaries

- Per-workspace font size settings
- Slider or free numeric input
- Font family changes
- Line height or spacing adjustments independent of font size
- System-level accessibility auto-scaling integration

## Context & Research

### Relevant Code and Patterns

- `src/client/hooks/use-app-settings.ts` — Existing app settings stored in localStorage (`defaultModel`, `reopenLastWorkspace`, `language`). Pattern: read on init, save on update, wrapped in try/catch.
- `src/client/components/SettingsPanel.tsx` — `AppearanceTab` renders theme and language selectors using preset buttons. Dirty-tracking via snapshot ref.
- `src/client/components/ai-elements/message.tsx` — `MessageContent` hardcodes `text-sm`.
- `src/client/components/ai-elements/reasoning.tsx` — `ReasoningTrigger` and `ReasoningContent` hardcode `text-sm`.
- `src/client/components/ai-elements/tool.tsx` — `ToolHeader` uses `text-sm`; `ToolOutput` uses `text-xs`.
- `src/client/components/ai-elements/conversation.tsx` — `ConversationEmptyState` hardcodes `text-sm`.
- `src/client/App.tsx` — Root div has `text-sm`, serving as the UI base font size.
- `src/client/components/Sidebar.tsx` — Tab buttons use `text-xs`.
- `src/client/components/ChatPanel.tsx` — Header uses `text-sm` for session name, `text-xs` for model.
- `src/client/components/PromptInput.tsx` — Textarea uses `text-sm`.
- No test infrastructure exists in the repo.

## Key Technical Decisions

- **Container-level inheritance for chat**: Apply a Tailwind font-size class on the message list container and remove hardcoded `text-sm` from child message components. This scales all message content without plumbing a setting prop through every component.
- **App root inheritance for UI**: Change the root App div's base text class dynamically. Targeted adjustments in Sidebar, ChatPanel header, and PromptInput remove their explicit text classes so they inherit the root size.
- **Preset-to-class mapping**: `small → text-xs (12px)`, `medium → text-sm (14px)`, `large → text-base (16px)`. This maps cleanly to existing Tailwind defaults.

## Implementation Units

### U1. Extend app settings with font size preferences

**Goal:** Add `chatFontSize` and `uiFontSize` to the app settings hook with defaults and setters.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Modify: `src/client/hooks/use-app-settings.ts`

**Approach:**
- Extend `AppSettings` interface with `chatFontSize: 'small' | 'medium' | 'large'` (default `'small'`) and `uiFontSize: 'small' | 'medium' | 'large'` (default `'medium'`).
- Add validation in `getInitialSettings` that falls back to defaults for invalid stored values.
- Add `setChatFontSize` and `setUiFontSize` callbacks following the existing setter pattern (spread prev, save to localStorage, return next).
- Export the new values and setters.

**Test expectation:** none — no test infrastructure exists in this repo.

**Verification:**
- `useAppSettings()` returns `chatFontSize: 'small'` and `uiFontSize: 'medium'` on first load.
- Changing a font size persists after page reload.
- Invalid stored values fall back to defaults gracefully.

### U2. Add font size controls to SettingsPanel and i18n labels

**Goal:** Add two preset button groups to the Appearance tab for chat and UI font size.

**Requirements:** R6

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/SettingsPanel.tsx`
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:**
- Read `chatFontSize` and `uiFontSize` from `useAppSettings` in `AppearanceTab`.
- Add two new sections in the Appearance tab, each with three preset buttons (Small / Medium / Large) styled like the existing theme selector.
- Add i18n keys under `appearance.chatFontSize`, `appearance.uiFontSize`, and `appearance.fontSizeSmall/Medium/Large` in both locale files.
- Wire button onClick to the respective setters; selected state highlights the active preset.

**Patterns to follow:**
- Existing theme selector buttons in `AppearanceTab` (light/dark buttons).
- Existing language selector buttons in `AppearanceTab`.

**Test expectation:** none — no test infrastructure exists in this repo.

**Verification:**
- Settings → Appearance shows two new font size sections.
- Clicking a preset updates the active highlight immediately.
- Both locale files contain the new labels.

### U3. Apply chat font size to message rendering

**Goal:** Wire the chat font size setting into the message list and remove hardcoded text classes from message components so they inherit the container size.

**Requirements:** R1, R2

**Dependencies:** U1

**Files:**
- Modify: `src/client/components/MessageList.tsx`
- Modify: `src/client/components/VirtualizedMessageList.tsx`
- Modify: `src/client/components/ai-elements/message.tsx`
- Modify: `src/client/components/ai-elements/reasoning.tsx`
- Modify: `src/client/components/ai-elements/conversation.tsx`
- Modify: `src/client/components/ai-elements/tool.tsx`

**Approach:**
- Create a small helper mapping size values to Tailwind classes: `sizeMap = { small: 'text-xs', medium: 'text-sm', large: 'text-base' }`.
- In `MessageList`, read `chatFontSize` from `useAppSettings` and append the mapped class to `ConversationContent`'s `className`.
- In `VirtualizedMessageList`, read `chatFontSize` and append the mapped class to the inner content container div.
- Remove `text-sm` from `MessageContent` in `message.tsx` so it inherits from the container.
- Remove `text-sm` from `ReasoningTrigger` and `ReasoningContent` in `reasoning.tsx`.
- Remove `text-sm` from `ConversationEmptyState` title and description in `conversation.tsx`.
- In `tool.tsx`: remove `text-sm` from `ToolHeader` title and summary spans; remove `text-xs` from `ToolOutput`'s content container so tool output inherits the chat size.
- System error messages in `MessageList` and `VirtualizedMessageList` (the `text-[13px]` div) should also be adjusted to inherit or map to the chat size.

**Patterns to follow:**
- `useAppSettings` consumption pattern seen in `SettingsPanel.tsx`.

**Test expectation:** none — no test infrastructure exists in this repo.

**Verification:**
- Opening a chat with default settings shows messages at 12px (Small).
- Changing chat font size to Medium or Large immediately updates all message text.
- Reasoning blocks, tool headers, tool output, and empty state text all scale together.
- User and assistant messages both scale.

### U4. Apply UI font size to non-chat chrome

**Goal:** Wire the UI font size setting into the app root and key chrome components.

**Requirements:** R3, R4

**Dependencies:** U1

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/components/Sidebar.tsx`
- Modify: `src/client/components/ChatPanel.tsx`
- Modify: `src/client/components/PromptInput.tsx`

**Approach:**
- In `App.tsx`, read `uiFontSize` from `useAppSettings` and replace the root div's hardcoded `text-sm` with the mapped class.
- In `Sidebar.tsx`, remove `text-xs` from the tab buttons so they inherit the root size.
- In `ChatPanel.tsx`, remove `text-sm` from the session name span and `text-xs` from the model span in the header so they inherit.
- In `PromptInput.tsx`, remove `text-sm` from the textarea and ghost div so they inherit.
- SettingsPanel will inherit from the App root since it has no hardcoded base text size.

**Test expectation:** none — no test infrastructure exists in this repo.

**Verification:**
- Default UI font size (Medium) keeps the UI at the current effective size.
- Changing UI font size to Small or Large updates sidebar tabs, header text, and input text.
- Chat message text remains independently controllable (not affected by UI font size changes).
- Settings panel text respects the UI font size.

## System-Wide Impact

- **Unchanged invariants:** The theme system (`useTheme`) is untouched. Workspace settings, model preferences, and all other app settings remain independent. The `Streamdown` markdown renderer does not receive font-size changes directly; it inherits from its parent container.
- **Visual hierarchy note:** UI elements with explicit fixed-size classes (`text-[10px]`, `text-[11px]`, `text-xs` in badges/labels) will not scale with the UI font size preference. This preserves relative hierarchy but means some labels may appear proportionally larger or smaller than body text at extreme presets. This is accepted as a lightweight trade-off.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Removing `text-sm` from message components causes unexpected layout shifts | Verify each component after removal; the `cn()` helper preserves other layout classes |
| Virtualized message list font-size changes cause row height estimation drift | `estimateSize` is a rough estimate; `measureElement` corrects after render |
| UI root font-size change affects unintended areas | Scoped to App root; any issues can be fixed by re-adding explicit text classes to specific components |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-24-configurable-chat-font-size-requirements.md](docs/brainstorms/2026-05-24-configurable-chat-font-size-requirements.md)
- Related code: `src/client/hooks/use-app-settings.ts`, `src/client/components/SettingsPanel.tsx`, `src/client/components/ai-elements/message.tsx`
