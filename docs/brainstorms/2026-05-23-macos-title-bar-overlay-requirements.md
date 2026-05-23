---
date: 2026-05-23
topic: macos-title-bar-overlay
---

# macOS Title Bar Overlay Integration

## Summary

Integrate the app's top bar elements into the macOS title bar area using Tauri's native overlay title bar support. On macOS, the logo, workspace switcher, tabs, and toolbar render alongside the traffic lights with no visible seam between OS chrome and webview content. Windows and Linux retain standard native decorations with the top bar unchanged.

---

## Problem Frame

The current layout renders a custom top bar inside the webview below the native macOS title bar. This creates two visually distinct horizontal bands at the top of the window — the OS title bar with just the traffic lights and window title, then the app's top bar with actual functionality. The result wastes ~40px of vertical space and feels less native compared to modern macOS apps like VS Code, Slack, or Figma that draw their header content directly into the title bar area.

---

## Requirements

**macOS title bar integration**

- R1. On macOS, the webview content extends to the top edge of the window with native traffic lights floating above the content.
- R2. On macOS, the logo, workspace switcher, workspace tabs, and header toolbar render within the title bar area.
- R3. On macOS, no interactive element overlaps or comes within unsafe proximity of the native traffic lights.
- R4. On macOS, the logo area and gaps between top bar elements function as window drag regions.
- R5. The title bar area uses the app's theme colors consistently with the rest of the UI, with no visible seam between OS chrome and webview content.

**Cross-platform behavior**

- R6. On Windows and Linux, the window uses standard native decorations and the current top bar continues to render inside the webview unchanged.

---

## Success Criteria

- macOS users see the logo, workspace switcher, tabs, and toolbar in the title bar area with native traffic lights clearly visible and unobstructed.
- Users can drag the macOS window by grabbing the logo area or the spaces between top bar elements.
- The macOS title bar area matches the app's dark/light theme without visual discontinuity.
- Windows and Linux users observe no change to window decorations or top bar layout.
- At the minimum window width (800px), no critical top bar elements are hidden or obscured on macOS.

---

## Scope Boundaries

- Custom HTML-drawn window controls (traffic lights, minimize, maximize, close) on any platform.
- Title bar integration on Windows or Linux.
- Changes to which UI elements appear in the top bar — only repositioning existing elements.
- Moving sidebar, chat panel, or other non-top-bar layout elements into the title bar area.
- Window transparency, blur, or acrylic effects beyond what the overlay mode provides natively.

---

## Key Decisions

- **macOS-only integration:** Tauri's overlay title bar API is natively supported on macOS. Achieving equivalent behavior on Windows would require custom HTML controls with significantly higher implementation and maintenance cost.
- **Drag regions on gaps and logo rather than a dedicated strip:** This maximizes usable space in the title bar area. The trade-off is that draggable space is distributed rather than contiguous, which matches the pattern used by VS Code and other modern macOS apps.

---

## Dependencies / Assumptions

- Tauri v2's macOS title bar overlay mode supports drawing webview content underneath the traffic lights without additional native code.
- The current top bar height (~48px) provides adequate vertical clearance for macOS traffic lights, which typically occupy the top ~40px of the window.
