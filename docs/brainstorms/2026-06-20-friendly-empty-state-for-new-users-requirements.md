---
date: 2026-06-20
topic: friendly-empty-state-for-new-users
---

## Summary

Polish the two empty states a fresh user hits after launching the app: the "no workspace selected" screen and the "no active session" screen inside a workspace. Replace terse placeholder text with welcoming, explanatory panels that include a clear primary action, and hide the chat prompt input when no session is active.

## Problem Frame

A first-time user currently lands on a bare screen with only "Select or create a workspace to get started." In observed sessions this felt too empty and left the user unsure what to do next. After creating a workspace the same pattern repeats: the user sees "Select or create a session to start chatting" while the prompt input box remains visible but disabled, which adds friction rather than guidance.

## Key Decisions

- **Keep creation explicit.** Workspace and session creation stay user-initiated actions; we will not auto-create a default session when a workspace is created.
- **Always-on friendly states.** The polished empty states appear whenever the relevant state is empty, not only on first launch.

## Requirements

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

## Scope Boundaries

- Auto-creating a default session when a workspace is created.
- A multi-step first-run onboarding wizard.
- Workspace-less "scratchpad" sessions.
- Changes to the create-workspace modal fields or flow beyond reusing it.

## Dependencies / Assumptions

- The existing `CreateWorkspaceModal` component is reused as the workspace CTA target.
- The existing session creation logic in `SessionList` / `chat-store` is reused for the session empty-state CTA.
- Translation strings land in `src/client/i18n/en/common.json`, `src/client/i18n/zh-CN/common.json`, `src/client/i18n/en/chat.json`, and `src/client/i18n/zh-CN/chat.json`.

## Sources / Research

- Current workspace empty state: `src/client/App.tsx:325-327`
- Current session empty state: `src/client/components/ChatPanel.tsx:371-374`
- Current prompt input rendering: `src/client/components/ChatPanel.tsx:378-413`
- Existing workspace creation modal: `src/client/components/CreateWorkspaceModal.tsx`
- Existing session creation UI: `src/client/components/SessionList.tsx:68-72` and `src/client/components/SessionList.tsx:235-241`
