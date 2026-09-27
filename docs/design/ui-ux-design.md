# Claude Code GUI — UI/UX Design Document

---

date: 2026-05-15
status: active
version: 1.0
---

## 1. Design Philosophy

### Chat-First, AI-Native Interface

The interface is modeled after modern AI chat applications (ChatGPT, Claude.ai), not traditional IDEs. The primary user interaction is conversation with Claude. File exploration, session management, and workspace navigation are secondary, supporting flows that orbit the chat experience.

### Core Principles

| Principle | Application |
|-----------|-------------|
| **Content-first** | Minimal chrome. The chat message area dominates the screen. |
| **Progressive disclosure** | Advanced features (file content, settings) are one click away, not in the default view. |
| **Spatial consistency** | UI elements always appear in the same place. Tabs are top, navigation is left, chat is center-right. |
| **Keyboard-driven** | All common actions have keyboard shortcuts. The user should rarely need the mouse. |
| **Dark mode default** | The interface ships dark-first. Light mode is a future consideration. |

### Design Evolution

The layout went through four iterations to arrive at the current design:

| Iteration | Problem | Solution |
|-----------|---------|----------|
| 1. IDE-style three-pane | Too rigid, felt like a code editor, not a chat app | Stripped down to chat-first layout |
| 2. Chat-first minimal | Sessions were not easily accessible | Moved session list to left sidebar |
| 3. Session sidebar | File explorer needed its own space, sidebar felt crowded | Added tabbed sidebar (Sessions / Files) |
| 4. Tabbed sidebar + drawer | File preview needed more room without losing chat context | Added slide-out drawer + side-by-side pin |

---

## 2. Layout Architecture

### 2.1 Overall Structure

```
┌─────────────────────────────────────────────────────────────┐
│  Top Bar (workspace tabs, settings)                        │  48px
├──────────┬────────────────────────────────────────────────┤
│          │  Chat Header (session title / model)            │  48px
│  Left    ├────────────────────────────────────────────────┤
│  Sidebar │                                                │
│ (64px    │              Chat Messages                      │
│  tabs +  │         (centered, max-width: 768px)           │
│  content)│                                                │
│          │                                                │
│  [Sessions│                                               │
│   Files]  │              Input Area                        │
│          │         (auto-expanding textarea)              │
├──────────┴────────────────────────────────────────────────┤
```

### 2.2 Regions

#### Top Bar
- **Height**: 48px (`h-12`)
- **Content**: App logo + workspace tabs (left), settings + sidebar toggle (right)
- **Behavior**: Fixed, always visible
- **Border**: Bottom border at `border-border/50`

#### Left Sidebar
- **Default width**: 256px (`w-64`)
- **Collapsible**: Yes, via keyboard shortcut (`Cmd + [`) or mobile toggle button
- **Tab switcher**: Two tabs at the top — "Sessions" and "Files"
- **Footer**: User profile avatar + name

#### File Drawer (Slide-out)
- **Origin**: Slides from the right edge of the left sidebar
- **Width**: 50% of the main panel (calculated dynamically, min 320px)
- **Overlay**: Semi-transparent overlay covers main area only (sidebar stays interactive)
- **Content**: File name header + copy/attach/pin/close actions + syntax-highlighted content with line numbers
- **Animation**: `transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)`

#### File Panel (Side-by-side, pinned)
- **Position**: Between sidebar and chat area
- **Width**: 384px (`w-96`)
- **Trigger**: Pin button on file drawer
- **Behavior**: Persistent until unpinned. Does not overlay chat — chat area shrinks to accommodate.

#### Chat Area
- **Message container**: Max-width 768px, centered (`mx-auto`)
- **Header**: Session title + model name, centered
- **Messages**: Scrollable area with bottom padding for input
- **Input**: Fixed at bottom, auto-expanding textarea

---

## 3. Design System

### 3.1 Color Tokens

```css
--color-bg:           #0d0d0d;   /* Main background */
--color-surface:      #141414;   /* Cards, sidebar, panels */
--color-surface-hover: #1a1a1a;  /* Hover states */
--color-surface-active: #1f1f1f; /* Active/selected states */
--color-border:       #262626;   /* Borders, dividers */
--color-border-hover: #333333;   /* Border hover */
--color-accent:       #e57035;   /* Primary accent (orange) */
--color-accent-hover: #f08045;   /* Accent hover */
--color-text-primary:   #f5f5f5; /* Headings, primary text */
--color-text-secondary: #a3a3a3; /* Body text, labels */
--color-text-tertiary:  #737373; /* Muted text, placeholders */
--color-msg-user:       #1a1a1a; /* User message bubble bg */
--color-msg-assistant:  #0d0d0d; /* Assistant message area bg */
```

### 3.2 Typography

| Role | Size | Weight | Color | Notes |
|------|------|--------|-------|-------|
| App title | 14px | 500 | text-primary | Hidden on small screens |
| Tab label | 12px | 500 | text-secondary | Uppercase feel via size |
| Session title | 14px | 500 | text-primary | Chat header |
| Session list item | 12px | 400 | text-secondary | Title + preview + date |
| Message body | 14px | 400 | text-primary | Line-height: relaxed |
| Code block | 13px | 400 | — | Monospace, leading-relaxed |
| Line numbers | 11px | 400 | text-tertiary | Select-none |
| File name | 14px | 400 | text-primary | Monospace in headers |
| Button/Label | 11-12px | 400-500 | varies | Context-dependent |

**Font stack**: System sans-serif default. Code blocks use monospace via `font-mono`.

### 3.3 Spacing Scale

Base unit: 4px

| Token | Value | Usage |
|-------|-------|-------|
| xs | 4px | Tight gaps, icon padding |
| sm | 8px | Standard gaps, section padding |
| md | 12px | Button padding, list item padding |
| lg | 16px | Container padding |
| xl | 24px | Section separation |

### 3.4 Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| sm | 6px | Buttons, small elements |
| md | 8px | Inputs, cards |
| lg | 12px | Message bubbles, modals |
| xl | 16px | Large containers |

### 3.5 Shadows & Elevation

| Level | Value | Usage |
|-------|-------|-------|
| Drawer | `shadow-2xl` | File drawer |
| Modal | `shadow-2xl` | Keyboard shortcuts modal |
| Toast | `shadow-xl` | Notification toasts |
| Card | `shadow-sm` | Code blocks |

### 3.6 Z-Index Scale

| Level | Value | Element |
|-------|-------|---------|
| Base | 0 | Main content |
| Overlay | 40 | Drawer overlay |
| Drawer | 50 | File drawer |
| Modal | 50 | Shortcuts modal |
| Toast | 50 | Notification toasts |

### 3.7 Scrollbars

```css
scrollbar-width: thin;
scrollbar-color: #333 transparent;

/* WebKit */
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: #444; }
```

---

## 4. Component Specifications

### 4.1 Workspace Tabs (Top Bar)

```
[Icon] Workspace Name  [x]
```

- **Style**: Pill-shaped (`rounded-lg`), horizontal flex row
- **Active state**: Background `surface-hover`, text `text-primary`
- **Inactive state**: Text `text-tertiary`, hover → `text-secondary` + `surface-hover`
- **Close button**: Hidden by default, visible on hover or when active
- **Icon**: Folder icon, 12px, accent color when active

### 4.2 Sidebar Tab Switcher

```
┌─────────────┬─────────────┐
│  Sessions   │    Files    │
└─────────────┴─────────────┘
```

- **Style**: Full-width buttons, text-xs, font-medium
- **Active indicator**: Bottom border 2px accent color (`#e57035`)
- **Text**: `text-secondary` inactive, `text-primary` active
- **Height**: ~48px (`py-3`)

### 4.3 Session List Item

```
[Chat Icon]  Session Title
             Preview text...
             2 min ago
```

- **Container**: `mx-2 px-3 py-2.5 rounded-lg`
- **Hover**: Background `surface-hover`
- **Active**: Background `surface-active`, title gets `text-primary font-medium`
- **Active indicator**: Small orange dot (`w-1 h-1 rounded-full bg-accent`)
- **Preview**: 11px, `text-tertiary`, truncated
- **Date**: 10px, `text-tertiary/60`

### 4.4 File Tree Item

**Folder:**
```
[Chevron] [Folder Icon] folder-name
```
- Chevron rotates 90deg when expanded
- Folder icon: Yellow (`text-yellow-600`), 14px
- Children indented with left border (`border-l border-border`)

**File:**
```
[File Icon] filename.ts
```
- Icon color by extension: `.ts` = blue, `.json` = yellow, `.md` = neutral
- Single click → open drawer (preview)
- Double click → attach to chat

### 4.5 Message Bubbles

**User Message:**
- Alignment: Right (`justify-end`)
- Container: `max-w-[85%]`
- Bubble: `bg-msg-user border border-border/50 rounded-2xl rounded-tr-md`
- Padding: `px-4 py-3`
- Text: 14px, `text-primary`, `leading-relaxed`

**Assistant Message:**
- Alignment: Left
- Container: `max-w-[95%]`
- Avatar: 24px gradient square (orange→red), "C" letter
- Name: "Claude" + "Sonnet 4.6" label
- Content: 14px, `text-primary`, `leading-relaxed`

### 4.6 Code Blocks

```
┌────────────────────────────────────┐
│ typescript              [Copy]     │
├────────────────────────────────────┤
│ 1  import { ... }                  │
│ 2  const x = ...                   │
└────────────────────────────────────┘
```

- **Container**: `rounded-lg overflow-hidden bg-[#0d1117] border border-border`
- **Header**: Flex row, `px-3 py-1.5 bg-bg border-b border-border`
- **Language label**: 11px, `text-text-tertiary font-mono`
- **Copy button**: Hidden by default, visible on hover
- **Line numbers**: Right-aligned, 11px, `text-text-tertiary`, select-none
- **Code**: 13px monospace, `leading-relaxed`

### 4.7 Input Area

```
┌──────────────────────────────────────────────┐
│ [file-chip] [file-chip]                      │
│ ┌──────────────────────────────────────────┐ │
│ │ Ask Claude anything about your code...   │ │
│ │                                    [📎][➤]│ │
│ └──────────────────────────────────────────┘ │
│ Cmd + Enter to send    [Shortcuts] [New]     │
└──────────────────────────────────────────────┘
```

- **Container**: `chat-container px-4 py-4`
- **Attached files**: Flex wrap, hidden when empty
- **File chip**: `flex items-center gap-1.5 px-2.5 py-1.5 bg-surface border border-border rounded-lg text-xs`
- **Textarea**: Full width, transparent bg, `focus:outline-none focus:ring-0`
- **Auto-expand**: `rows=1`, grows up to 200px on input
- **Focus ring**: `input-ring` — border + box-shadow on focus
- **Send button**: Arrow icon, hover → accent color
- **Attach button**: Paperclip icon

### 4.8 File Drawer

- **Position**: Fixed, top at 48px (below header), left at sidebar right edge
- **Width**: 50% of main panel (dynamic JS calculation)
- **Height**: `calc(100% - 3rem)`
- **Border**: Right border `border-border`
- **Shadow**: `shadow-2xl`
- **Header**: File icon + filename (monospace) + Copy/Attach/Pin/Close buttons
- **Content**: Syntax-highlighted code with line numbers
- **Animation**: `transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)`
- **Closed state**: `translateX(-100%)`

### 4.9 File Panel (Pinned)

- **Position**: Between sidebar and chat (in flex row)
- **Width**: 384px (`w-96`)
- **Border**: Right border `border-border`
- **Header**: Same as drawer but with Unpin (close) instead of Pin
- **Animation**: Width + opacity transition, 0.25s
- **Closed state**: `width: 0; opacity: 0; overflow: hidden`

### 4.10 Toast Notifications

- **Position**: Fixed, bottom-20, centered (`left-1/2 -translate-x-1/2`)
- **Style**: `bg-surface text-text-secondary px-4 py-2 rounded-lg shadow-xl border border-border text-xs`
- **Duration**: 2 seconds
- **Animation**: None (instant appear, fade-out not implemented in prototype)

### 4.11 Keyboard Shortcuts Modal

- **Overlay**: `bg-black/60`, covers full screen
- **Modal**: `bg-surface border border-border rounded-xl max-w-md`
- **Content**: Two-column layout (action name | key combo)
- **Key styling**: `px-2 py-1 bg-bg border border-border rounded text-xs font-mono`

---

## 5. Interaction Patterns

### 5.1 File Interactions

| Action | Trigger | Result |
|--------|---------|--------|
| Preview file | Single click on file | Drawer slides from sidebar edge |
| Attach file | Double click on file | File chip added to input area |
| Pin file | Pin button in drawer | Drawer closes, file panel opens |
| Unpin file | Close button in panel | Panel collapses |
| Copy content | Copy button | Content copied to clipboard |

### 5.2 Session Interactions

| Action | Trigger | Result |
|--------|---------|--------|
| Switch session | Click session item | Active state updates, chat header changes |
| New session | "New Session" button or `Cmd+Shift+N` | New session added to top of list |

### 5.3 Sidebar Interactions

| Action | Trigger | Result |
|--------|---------|--------|
| Toggle sidebar | `Cmd+[` or mobile hamburger | Sidebar collapses/expands (width animation) |
| Switch tab | Click tab or `Cmd+Shift+T` | Sessions ↔ Files content swap |
| Expand folder | Click folder row | Chevron rotates, children appear |

### 5.4 Chat Interactions

| Action | Trigger | Result |
|--------|---------|--------|
| Send message | `Cmd+Enter` or send button | Message appears, assistant responds |
| Auto-expand input | Type in textarea | Height grows up to 200px |
| Copy message | Copy button on message | Message text copied |
| Edit message | Edit button on user message | Content loaded into input |
| Regenerate | Regenerate button on assistant | Trigger regeneration |

### 5.5 Message Action Bar

- **Visibility**: Hidden by default, visible on hover (`opacity` transition, 0.15s)
- **User messages**: Copy, Edit
- **Assistant messages**: Copy, Regenerate, Thumbs Up, Thumbs Down

---

## 6. Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd + Enter` | Send message |
| `Shift + Enter` | New line in textarea |
| `Cmd + [` | Toggle sidebar |
| `Cmd + Shift + T` | Switch sidebar tab (Sessions ↔ Files) |
| `Cmd + Shift + N` | New session |
| `/` | Focus chat input |
| `Esc` | Close drawer / close modal |

---

## 7. Animation & Motion

### 7.1 Timing Tokens

| Animation | Duration | Easing |
|-----------|----------|--------|
| Drawer slide | 250ms | `cubic-bezier(0.4, 0, 0.2, 1)` |
| Sidebar collapse | 250ms | `cubic-bezier(0.4, 0, 0.2, 1)` |
| File panel open/close | 250ms | `cubic-bezier(0.4, 0, 0.2, 1)` |
| Message enter | 250ms | `ease-out` |
| Hover transitions | 120-150ms | `ease` |
| Action bar fade | 150ms | `ease` |
| Overlay fade | 200ms | `ease` |

### 7.2 Keyframe Animations

**Message enter:**
```css
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

**Streaming indicator:**
```css
@keyframes pulse-dot {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
```

---

## 8. Responsive Behavior

### 8.1 Breakpoints

| Breakpoint | Behavior |
|------------|----------|
| < 1024px (lg) | Sidebar auto-collapses, toggle button appears in top bar |
| ≥ 1024px | Sidebar visible by default |

### 8.2 Mobile Considerations

- Sidebar collapses to hidden by default
- Toggle button visible in top bar
- File panel likely hidden or full-width on mobile
- Touch targets minimum 44×44px

---

## 9. Accessibility

- **Focus rings**: Visible on all interactive elements (`focus:outline-none` replaced with custom focus states)
- **ARIA labels**: All icon-only buttons have `aria-label`
- **Role attributes**: Session items have `role="button"`, tabs have `role="tab"`
- **Keyboard navigation**: Full keyboard support for all actions
- **Color contrast**: All text meets 4.5:1 ratio against backgrounds
- **Reduced motion**: Respect `prefers-reduced-motion` (to be implemented)

---

## 10. Asset Guidelines

### 10.1 Icons

- **Source**: Inline SVG (Lucide-style, stroke-width 1.5)
- **Size**: 12-16px for UI, 20-24px for empty states
- **Color**: Inherit from text color (`currentColor`)
- **Style**: Outline only, no fill (except folder icons)

### 10.2 Logo

- **App icon**: 24px square, gradient from orange-400 to red-500, white "C" letter
- **Workspace icon**: Folder icon, 12px, accent color when active

---

## 11. State Definitions

### 11.1 Sidebar States

| State | Width | Opacity | Content |
|-------|-------|---------|---------|
| Expanded | 256px | 1 | Full content visible |
| Collapsed | 0 | 0 | Hidden, overflow hidden |

### 11.2 Drawer States

| State | Transform | Overlay | Description |
|-------|-----------|---------|-------------|
| Closed | `translateX(-100%)` | Hidden | Off-screen left |
| Open | `translateX(0)` | Visible | Slid in from sidebar edge |

### 11.3 File Panel States

| State | Width | Opacity | Description |
|-------|-------|---------|-------------|
| Closed | 0 | 0 | Collapsed, overflow hidden |
| Open | 384px | 1 | Full panel visible |

---

## 12. Empty States

| Location | Message | Action |
|----------|---------|--------|
| Session list (no sessions) | "No sessions yet" | "New Session" button |
| Files tab (no workspace) | "Open a workspace to browse files" | — |
| Chat (no messages) | Welcome message + suggested prompts | — |
| File drawer (no file selected) | N/A — drawer only opens with a file | — |

---

## 13. Prototype Reference

The current interactive prototype is at:
```
prototype.html
```

This prototype is a single-file HTML document using Tailwind CSS CDN and contains all the layout, styling, and interaction patterns documented above. It uses sample data for workspaces, sessions, and file contents.

### 13.1 Key State Variables (from prototype)

| Variable | Type | Description |
|----------|------|-------------|
| `leftTab` | string | Current sidebar tab: `'sessions'` or `'files'` |
| `sidebarCollapsed` | boolean | Whether sidebar is hidden |
| `fileDrawerOpen` | boolean | Whether file drawer is visible |
| `drawerFile` | object \| null | Currently previewed file in drawer |
| `sideBySideFile` | object \| null | Currently pinned file in side panel |
| `attachedFiles` | array | Files attached to current message |

---

## 14. Implementation Notes

### 14.1 Tech Stack for Implementation

- **Framework**: React + Vite (recommended)
- **Styling**: Tailwind CSS
- **Icons**: Lucide React (to replace inline SVGs)
- **Syntax Highlighting**: highlight.js or Prism
- **State Management**: React Context or Zustand

### 14.2 Key Implementation Decisions

1. **Drawer positioning**: Use JS to calculate `left` and `width` based on sidebar's `getBoundingClientRect()` to handle sidebar collapse and responsive changes.

2. **Auto-expanding textarea**: Use `scrollHeight` measurement with `max-height` constraint.

3. **Message rendering**: Parse markdown on the fly; use `dangerouslySetInnerHTML` with sanitized input, or a markdown library like `react-markdown`.

4. **File tree**: Render recursively. Track expanded folders in component state.

5. **Session switching**: Update active state in array, re-render list.

### 14.3 Performance Considerations

- Virtualize message list if conversation exceeds 100 messages
- Lazy-load syntax highlighting for large files
- Debounce textarea auto-expand
- Use `transform` and `opacity` for all animations (GPU-accelerated)

---

## 15. Deferred / Future Work

- Light mode theme
- Drag-and-drop file attachments
- Resizable sidebar and file panel (drag handles)
- Message search within conversation
- Customizable keyboard shortcuts
- Accessibility audit (screen reader testing)
- Mobile-optimized layout (bottom sheet for drawer)
