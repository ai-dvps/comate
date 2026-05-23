---
title: "feat: macOS Title Bar Overlay"
type: feat
status: active
date: 2026-05-23
origin: docs/brainstorms/2026-05-23-macos-title-bar-overlay-requirements.md
---

# feat: macOS Title Bar Overlay

## Summary

Enable Tauri's native macOS title bar overlay mode so the app's top bar content renders within the title bar area alongside the traffic lights. Add runtime platform detection and conditional layout adjustments so macOS gets the integrated title bar experience while Windows and Linux remain unchanged.

---

## Problem Frame

The current layout renders a custom top bar inside the webview below the native macOS title bar. This creates two visually distinct horizontal bands at the top of the window — the OS title bar with just the traffic lights and window title, then the app's top bar with actual functionality. The result wastes ~40px of vertical space and feels less native compared to modern macOS apps that draw their header content directly into the title bar area.

---

## Requirements

**macOS title bar integration**

- R1. On macOS, the webview content extends to the top edge of the window with native traffic lights floating above the content. (see origin)
- R2. On macOS, the logo, workspace switcher, workspace tabs, and header toolbar render within the title bar area. (see origin)
- R3. On macOS, no interactive element overlaps or comes within unsafe proximity of the native traffic lights. (see origin)
- R4. On macOS, the logo area and gaps between top bar elements function as window drag regions. (see origin)
- R5. The title bar area uses the app's theme colors consistently with the rest of the UI, with no visible seam between OS chrome and webview content. (see origin)

**Cross-platform behavior**

- R6. On Windows and Linux, the window uses standard native decorations and the current top bar continues to render inside the webview unchanged. (see origin)

---

## Implementation Units

### U1. Configure macOS window for overlay title bar

**Goal:** Enable macOS title bar overlay mode and position traffic lights to align with the UI layout.

**Requirements:** R1, R3

**Files:**
- `src-tauri/tauri.macos.conf.json`

**Approach:**
Update the macOS-specific Tauri configuration to use `titleBarStyle: "Overlay"`, which renders the title bar as a transparent overlay on top of the webview content. Hide the window title text with `hiddenTitle: true`. Position the traffic lights with `trafficLightPosition` to match where the top bar content begins, ensuring they don't collide with interactive elements.

**Test scenarios:**
- **Happy path:** On macOS, the window launches with traffic lights floating over the webview content at the configured position.
- **Edge case:** The window title text is not visible, avoiding overlap with custom top bar content.

**Verification:**
- macOS window shows traffic lights in the top-left at the configured position.
- No window title text is rendered in the title bar area.

---

### U2. Add runtime platform detection

**Goal:** Enable the frontend to conditionally apply macOS-specific layout behavior.

**Requirements:** R2, R6

**Files:**
- Create: `src/client/lib/platform.ts`

**Approach:**
Create a small platform detection utility using Tauri's `@tauri-apps/api/os` module. Expose an `isMacOS` async helper that returns `true` when `platform()` returns `'darwin'`. Cache the result to avoid repeated async calls. Provide a safe fallback for non-Tauri environments (e.g., browser dev mode) that returns `false`.

**Patterns to follow:**
- Match the pattern in `src/client/lib/tauri-api.ts` for Tauri environment detection (`isTauri()` check).
- Keep the utility minimal — it only needs to answer "is this macOS?" for layout purposes.

**Test scenarios:**
- **Happy path:** In a Tauri macOS build, `isMacOS()` returns `true`.
- **Happy path:** In a Tauri Windows/Linux build, `isMacOS()` returns `false`.
- **Edge case:** In a non-Tauri environment (browser dev server), `isMacOS()` returns `false` without errors.

**Verification:**
- The utility correctly identifies macOS in Tauri and returns `false` elsewhere.

---

### U3. Integrate top bar into macOS title bar area

**Goal:** Adjust the top bar layout on macOS to clear traffic lights and support drag-to-move.

**Requirements:** R2, R3, R4, R5

**Dependencies:** U1, U2

**Files:**
- `src/client/App.tsx`

**Approach:**
Use the platform detection utility from U2 to conditionally apply macOS-specific styling to the existing top bar:
- Add left padding on macOS to clear the traffic lights (~80px).
- Add `data-tauri-drag-region` attribute to the logo container and to spacer/gap elements between the left and right top bar sections, making those areas draggable.
- Ensure the top bar background (`bg-bg`) and border styling extend cleanly to the top of the window with no visible seam.

Keep the current top bar structure intact — this is a layout adjustment, not a component refactor. Windows and non-macOS platforms see no change.

**Test scenarios:**
- **Happy path (macOS):** The top bar renders with adequate left padding; traffic lights are fully visible and unobstructed.
- **Happy path (macOS):** Dragging the window from the logo area or the central gap moves the window.
- **Happy path (Windows/Linux):** The top bar renders exactly as it does today with no macOS-specific padding or drag regions.
- **Edge case:** At the minimum window width (800px), no critical top bar elements are hidden or obscured on macOS.
- **Edge case:** Theme toggling (dark/light) updates the title bar area appearance correctly since it shares the webview background.

**Verification:**
- macOS: top bar content sits to the right of traffic lights with no overlap.
- macOS: window is draggable from logo and gap areas.
- Windows/Linux: layout is pixel-identical to before this change.

---

## Key Technical Decisions

- **Native `titleBarStyle: "Overlay"` instead of `tauri-plugin-decorum`:** Tauri v2.11 natively supports overlay title bars and traffic light positioning. A community plugin adds dependency surface without material benefit for this scope.
- **Extend existing App.tsx top bar rather than extract a new component:** The change is purely additive (padding + drag regions) and conditional. Extracting a dedicated title bar component would create unnecessary indirection for a layout-only adjustment.
- **Async platform detection with caching:** `@tauri-apps/api/os` `platform()` is async. Caching the result prevents waterfall async calls during React render and avoids layout shift after hydration.

---

## Scope Boundaries

- Custom HTML-drawn window controls on any platform.
- Title bar integration on Windows or Linux.
- Changes to which UI elements appear in the top bar — only repositioning existing elements.
- Moving sidebar, chat panel, or other non-top-bar layout elements into the title bar area.
- Window transparency, blur, or acrylic effects beyond what the overlay mode provides natively.
- Adding automated client-side tests — no existing test infrastructure; verification is manual.

---

## Dependencies / Assumptions

- Tauri v2.11's macOS `titleBarStyle: "Overlay"` works without `macOSPrivateApi: true` for this use case (webview extends to top, traffic lights float over solid top bar background).
- The current top bar height (~48px) provides adequate vertical clearance for macOS traffic lights.
- `@tauri-apps/api/os` is available and its `platform()` API works as documented.
