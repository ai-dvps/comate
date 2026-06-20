---
title: Friendly empty states for new users
type: feat
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-friendly-empty-state-for-new-users-requirements.md
---

# Friendly empty states for new users

## Summary

Polish the two empty states a fresh user sees after launch: the "no workspace selected" screen and the "no active session" screen inside a workspace. Replace terse placeholder text with welcoming, explanatory panels that include a primary action, and hide the chat prompt input (but not the approval surface) when no session is active.

## Problem Frame

A first-time user currently lands on a bare screen with only "Select or create a workspace to get started." After creating a workspace they see "Select or create a session to start chatting" while the prompt input box remains visible but disabled. The goal is to make each step feel guided and intentional.

## Requirements

Carried forward from the origin doc.

### Workspace empty state

- R1. When no workspace is active, the main area shows a centered empty-state panel instead of a single line of text.
- R2. The panel includes a warm headline that welcomes the user to the app.
- R3. The panel includes one sentence explaining what a workspace is and why the app needs one.
- R4. The panel includes a primary button that opens the existing "Create workspace" modal.
- R5. The panel uses the current visual style and does not add new illustration assets beyond an existing app icon or simple icon from the project's icon library.

### Session empty state

- R6. When a workspace is active but no session is active, the chat area shows a centered empty-state panel instead of the current "Select or create a session to start chatting" text.
- R7. The panel includes a headline that acknowledges the workspace is open and prompts the user to start a conversation.
- R8. The panel includes a primary button that creates a new session in the current workspace.
- R9. The new session is created with a sensible default name and becomes the active session so the prompt input appears.

### Prompt input visibility

- R10. The chat prompt input box is hidden when no session is active; it appears only after a session is selected or created.

### Internationalization

- R11. All new copy is added to the English and Chinese (zh-CN) translation files under the existing namespaces.

## Key Technical Decisions

- **Small presentational components.** Create `WorkspaceEmptyState` and `ChatEmptyState` components rather than inlining the markup, keeping `App.tsx` and `ChatPanel.tsx` readable and testable.
- **Reuse existing actions.** The workspace CTA opens the existing `CreateWorkspaceModal`; the session CTA calls `chat-store.createSession`, which already sets the new session as active.
- **Hide prompt input via conditional rendering.** Instead of disabling the input when no session is active, remove it from the DOM to reduce visual clutter and avoid implying the user can type.
- **No custom illustrations.** Use a Lucide icon and the existing `Button` component to stay consistent with the current UI kit.

## Implementation Units

### U1. Workspace empty-state panel

- **Goal:** Replace the bare workspace placeholder in `App.tsx` with a friendly, actionable empty-state panel.
- **Requirements:** R1–R5, R11.
- **Dependencies:** None.
- **Files:**
  - Create `src/client/components/WorkspaceEmptyState.tsx`
  - Modify `src/client/App.tsx`
  - Modify `src/client/i18n/en/common.json`
  - Modify `src/client/i18n/zh-CN/common.json`
  - Create `src/client/components/WorkspaceEmptyState.test.tsx`
- **Approach:** Build a centered card with an icon, headline, explanatory sentence, and a primary button. The button calls the existing `setShowCreateModal(true)` handler from `App.tsx`. Use the `Button` component and Tailwind color/spacing tokens already in use.
- **Patterns to follow:** `src/client/components/analytics/AnalyticsEmptyState.tsx` for icon + message layout; `src/client/components/ui/button.tsx` for the CTA button.
- **Test scenarios:**
  - Renders the headline, explanation, and create-workspace button when mounted.
  - Clicking the button invokes the `onCreateWorkspace` callback.
- **Verification:** The panel is visible on a fresh launch and after closing the last workspace; the button opens the create-workspace modal.

### U2. Session empty-state panel

- **Goal:** Replace the bare session placeholder in `ChatPanel.tsx` with a friendly, actionable empty-state panel.
- **Requirements:** R6–R9, R11.
- **Dependencies:** U1 (pattern established).
- **Files:**
  - Create `src/client/components/ChatEmptyState.tsx`
  - Modify `src/client/components/ChatPanel.tsx`
  - Modify `src/client/i18n/en/chat.json`
  - Modify `src/client/i18n/zh-CN/chat.json`
  - Create `src/client/components/ChatEmptyState.test.tsx`
- **Approach:** Build a `ChatEmptyState` component as a centered card that shows a headline, a sentence explaining the next step, and a primary button. The button calls `chat-store.createSession(workspaceId, defaultName)`, relying on the store to set the new session active automatically.
- **Patterns to follow:** Follow the same card/icon/button tokens established by U1 (`WorkspaceEmptyState`); session default name follows `SessionList`'s `newSessionDefaultName` pattern.
- **Test scenarios:**
  - Renders the headline, explanation, and start-chatting button when no active session.
  - Clicking the button calls `createSession` with the workspace ID and a default name.
- **Verification:** After clicking the button, the chat store creates a session and sets it active, causing the prompt input to appear.

### U3. Hide prompt input when no session is active

- **Goal:** Remove the prompt input from the chat layout when there is no active session.
- **Requirements:** R10.
- **Dependencies:** U2.
- **Files:**
  - Modify `src/client/components/ChatPanel.tsx`
  - Create or extend `src/client/components/ChatPanel.test.tsx`
- **Approach:** Wrap the existing `PromptInput` rendering in `ChatPanel.tsx` with `{activeSessionId && <PromptInput ... />}` so the input is absent until a session exists. Keep the approval surface behavior unchanged. Because U2 and U3 both modify `ChatPanel.tsx`, apply U2's changes before U3's (or combine both in a single commit).
- **Patterns to follow:** Conditional rendering already used elsewhere in `ChatPanel.tsx` for `TaskPanel`, `SubagentDrawer`, and `StatusBar`.
- **Test scenarios:**
  - When `activeSessionId` is undefined, `PromptInput` is not rendered.
  - When `activeSessionId` is defined, `PromptInput` is rendered.
  - When an approval is pending, the `ApprovalSurface` still renders regardless of session state.
- **Verification:** The empty-state panel is not competing with a disabled prompt box.

### U4. Translation strings and cross-language parity

- **Goal:** Add all new user-facing copy to both English and Chinese translation files.
- **Requirements:** R11.
- **Dependencies:** U1, U2.
- **Files:**
  - Modify `src/client/i18n/en/common.json`
  - Modify `src/client/i18n/zh-CN/common.json`
  - Modify `src/client/i18n/en/chat.json`
  - Modify `src/client/i18n/zh-CN/chat.json`
- **Approach:** Add keys under `common` for workspace empty-state copy and under `chat` for session empty-state copy. Keep translations concise and consistent with the existing voice.
- **Test scenarios:**
  - Component tests render with `I18nextProvider` and assert translated text appears.
  - zh-CN translations are present for every new English key.
- **Verification:** Running the client test suite shows no missing i18n keys.

## Scope Boundaries

- Auto-creating a default session when a workspace is created.
- A multi-step first-run onboarding wizard.
- Workspace-less "scratchpad" sessions.
- Changes to the create-workspace modal fields or flow beyond reusing it.

## Risks & Dependencies

- Low risk. The change is localized to presentational components and one conditional wrapper.
- `chat-store.createSession` must continue to set the new session active automatically; if that behavior changes, R9 would need to be updated.

## Sources / Research

- Origin requirements: `docs/brainstorms/2026-06-20-friendly-empty-state-for-new-users-requirements.md`
- Current workspace empty state: `src/client/App.tsx:325-327`
- Current session empty state: `src/client/components/ChatPanel.tsx:371-374`
- Current prompt input rendering: `src/client/components/ChatPanel.tsx:378-413`
- Existing workspace creation modal: `src/client/components/CreateWorkspaceModal.tsx`
- Existing session creation UI: `src/client/components/SessionList.tsx:68-72` and `src/client/components/SessionList.tsx:235-241`
- Existing empty-state pattern: `src/client/components/analytics/AnalyticsEmptyState.tsx`
- Button component: `src/client/components/ui/button.tsx`
