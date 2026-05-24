---
date: 2026-05-24
topic: configurable-chat-font-size
---

# Configurable Chat and UI Font Size

## Summary

Add two independent font size preferences — one for chat message content and one for non-chat UI — each with Small/Medium/Large presets. Both controls live in Settings → Appearance, stored app-wide in localStorage. The chat default becomes Small (12px); non-chat UI defaults to its current effective size.

## Problem Frame

The chat interface currently uses a uniform 14px for all message content. Users who prefer denser information display or have specific readability needs have no way to adjust this. Reducing the default size creates more content-visible area without individual user action, while the preset system accommodates those who prefer larger text.

## Requirements

**Chat message font size**
- R1. Add a chat message font size preference with three presets: Small (12px), Medium (14px), Large (16px).
- R2. The preference default is Small.
- R3. The chosen size applies to all chat message content: user messages, assistant messages, reasoning blocks, tool output, and code blocks.
- R4. The preference is stored app-wide (not per-workspace) and persists across sessions.

**Non-chat UI font size**
- R5. Add a non-chat UI font size preference with the same three presets: Small (12px), Medium (14px), Large (16px).
- R6. The preference default is Medium (matching the current effective UI size).
- R7. The chosen size applies to non-chat UI elements: sidebar, headers, tabs, input areas, settings panels, and other non-message chrome.
- R8. The preference is stored app-wide and persists across sessions.

**Settings UI**
- R9. Both preferences are configurable from the Appearance tab in Settings.
- R10. Each preference presents as a set of mutually exclusive preset buttons (matching the existing theme selector pattern).

## Success Criteria

- A new user sees chat messages at the smaller default size immediately.
- A user can open Settings → Appearance and change either font size independently; the change applies instantly and persists after reload.
- All chat message content (including code blocks and tool output) respects the chat font size preference.
- All non-chat UI chrome respects the non-chat UI font size preference.

## Scope Boundaries

- Per-workspace font size settings
- Slider or free numeric input for font size
- Font family changes
- Line height or spacing adjustments independent of font size
- System-level accessibility auto-scaling integration

## Key Decisions

- **Preset buttons over slider:** Chosen for simplicity and alignment with the existing theme selector pattern in the Appearance tab.
- **Two independent preferences over a single global scale:** Separates chat content (where smaller text is often desirable for density) from UI chrome (where readability at a consistent size matters more).

## Dependencies / Assumptions

- The existing app-level settings localStorage pattern will be extended to hold these preferences.
- The existing Appearance tab in Settings will be extended with the new controls.
