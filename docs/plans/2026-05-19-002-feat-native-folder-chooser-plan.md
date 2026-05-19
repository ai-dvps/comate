---
title: "feat: Native folder chooser in create workspace form"
type: feat
status: completed
date: 2026-05-19
---

# feat: Native folder chooser in create workspace form

## Summary

Replace the folder path text input in the create workspace form with a native OS folder picker via Tauri's dialog plugin, while keeping the text field editable for manual entry and browser-dev fallback.

---

## Requirements

- R1. Users running the Tauri desktop app can open a native OS folder chooser from the create workspace form.
- R2. The selected folder path populates the folder path field in the modal.
- R3. The folder path field remains editable so users can paste or type paths manually.
- R4. When running outside Tauri (e.g. browser dev mode), the form continues to work with manual text entry.
- R5. If the workspace name field is empty when a folder is selected, auto-fill the name with the selected folder's basename.

---

## Scope Boundaries

- Only the create workspace modal is in scope; other forms or settings panels are not.
- No changes to workspace creation API, storage, or folder validation logic.
- No file picker (this is specifically a folder picker).

---

## Context & Research

### Relevant Code and Patterns

- `src/client/components/CreateWorkspaceModal.tsx` — the modal to modify.
- `src/client/lib/tauri-api.ts` — already defines a local `isTauri()` check using `window.__TAURI_INTERNALS__`, but it is not exported.
- `src-tauri/src/lib.rs` — plugins registered via `.plugin(tauri_plugin_*.init())` on the Tauri Builder.
- `src-tauri/Cargo.toml` — existing `tauri-plugin-shell` and `tauri-plugin-log` dependencies.
- `src-tauri/capabilities/default.json` — permissions granted to the main window.

### External References

- [Tauri v2 Dialog Plugin docs](https://github.com/tauri-apps/tauri-plugin-dialog/tree/v2) — `open({ directory: true })` API.
- `@tauri-apps/api/core` exports `isTauri()` for runtime detection.

---

## Key Technical Decisions

- **Use `@tauri-apps/api/core`'s `isTauri()` for runtime detection.** The project already depends on `@tauri-apps/api`, and the official export is the preferred pattern over exporting the local helper in `tauri-api.ts`.
- **Keep the text input editable alongside the Browse button.** This gives users the freedom to paste paths and provides an automatic fallback when `isTauri()` is false, eliminating the need for conditional UI switching.

---

## Implementation Units

### U1. Add Tauri dialog plugin dependencies

**Goal:** Add the dialog plugin to both the Rust and JS dependency trees.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `package.json`

**Approach:**
- Add `tauri-plugin-dialog = "2"` to `[dependencies]` in `Cargo.toml`.
- Add `@tauri-apps/plugin-dialog` to `dependencies` in `package.json`.

**Patterns to follow:**
- Match existing `tauri-plugin-shell = "2"` and `tauri-plugin-log = "2"` entries.

**Test expectation:** none — dependency addition only.

**Verification:**
- `tauri-plugin-dialog` appears in `Cargo.toml` dependencies.
- `@tauri-apps/plugin-dialog` appears in `package.json` dependencies.

---

### U2. Register plugin and grant capabilities

**Goal:** Wire the dialog plugin into the Tauri runtime and allow the main window to use it.

**Requirements:** R1

**Dependencies:** U1

**Files:**
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`

**Approach:**
- In `lib.rs`, chain `.plugin(tauri_plugin_dialog::init())` on the Builder, following the existing `tauri_plugin_shell::init()` pattern.
- In `capabilities/default.json`, add `"dialog:default"` to the permissions array.

**Patterns to follow:**
- `lib.rs` builder chain for plugin registration.
- Capability JSON format for permission grants.

**Test expectation:** none — configuration change only.

**Verification:**
- Desktop app builds successfully (`cargo check` in `src-tauri` or `npm run tauri:dev`).
- No permission-denied errors when invoking the dialog.

---

### U3. Wire folder chooser into CreateWorkspaceModal

**Goal:** Add a Browse button that opens the native folder picker and populates the folder path field.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** U2

**Files:**
- Modify: `src/client/components/CreateWorkspaceModal.tsx`

**Approach:**
- Import `open` from `@tauri-apps/plugin-dialog` and `isTauri` from `@tauri-apps/api/core`.
- Add a "Browse" button next to the folder path input field.
- On click, if `isTauri()` is true, call `open({ directory: true, multiple: false })`.
- If a path is returned (non-null):
  - Set it as the `folderPath` state.
  - If the workspace `name` state is empty, extract the folder basename and set it as the name.
- If `isTauri()` is false or the user cancels, leave the input unchanged.
- Keep the existing text input editable so manual entry still works.

**Patterns to follow:**
- Use existing Tailwind button/input styling from the modal.
- Use `lucide-react` for the browse button icon (e.g. `FolderOpen`).

**Test scenarios:**
- **Happy path:** Click Browse in Tauri app, select a folder, folder path updates to the selected path and workspace name auto-fills with the folder basename.
- **Happy path:** Click Browse with a workspace name already typed; only the folder path updates, name stays unchanged.
- **Edge case:** Click Browse and cancel the dialog, input values remain unchanged.
- **Edge case:** Run in browser dev mode (`isTauri() === false`), text input accepts manual typing as before.
- **Error path:** Dialog API throws unexpectedly, caught gracefully without crashing the modal.

**Verification:**
- In Tauri app: Browse button opens native folder picker and selected path appears in the field.
- In browser dev: Browse button either is hidden (if conditional) or no-ops gracefully, and text input still works.
- Form submission still validates and creates the workspace correctly.

---

## System-Wide Impact

- **Unchanged invariants:** The workspace creation API (`/api/workspaces`) and store logic remain untouched. Only the client-side input mechanism changes.
- **API surface parity:** Not applicable — this is a UI-only change with no exported API.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `@tauri-apps/plugin-dialog` version mismatch with Tauri 2.11.2 | Pin to the same major version line (`"2"`) as other Tauri plugins in the repo. |
| Browser dev mode breaks if dialog import is eagerly evaluated | Only import or invoke dialog APIs after checking `isTauri()`. |

---

## Sources & References

- Related code: `src/client/components/CreateWorkspaceModal.tsx`
- Related code: `src/client/lib/tauri-api.ts`
- External docs: [Tauri v2 Dialog Plugin](https://github.com/tauri-apps/tauri-plugin-dialog/tree/v2)
