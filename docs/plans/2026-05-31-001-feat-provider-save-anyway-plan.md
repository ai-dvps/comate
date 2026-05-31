---
title: Provider Save-Anyway on Health Check Failure
type: feat
status: active
date: 2026-05-31
origin: docs/brainstorms/2026-05-31-provider-save-anyway-requirements.md
---

# Provider Save-Anyway on Health Check Failure

## Summary

Add a backend bypass flag and frontend confirmation dialog so users can save a provider even when the endpoint health check fails. The common case (healthy endpoint) requires no extra interaction.

---

## Problem Frame

Currently, creating or updating a provider runs a health check against the endpoint before persisting. If the endpoint is unreachable or credentials are invalid, the save is rejected with no recourse. This is frustrating when the endpoint is temporarily down, behind a firewall, or when the user knows the configuration is correct and wants to save it for later use.

---

## Requirements

- R1. The create-provider endpoint accepts a flag to skip the health check.
- R2. The update-provider endpoint accepts a flag to skip the health check.
- R3. When the flag is absent or false, health check behavior remains unchanged.
- R4. When a save request fails due to health check, the UI shows a confirmation dialog.
- R5. The dialog offers "Save anyway" and "Cancel" actions.
- R6. "Save anyway" re-submits the save request with the skip flag set.
- R7. "Cancel" closes the dialog and leaves the form open with existing data intact.

**Origin acceptance examples:** AE1 (covers R1, R4, R5, R6), AE2 (covers R2, R4, R5, R7)

---

## Scope Boundaries

- Health check criteria and timeout remain unchanged.
- No automatic retry or background health polling.
- No offline-mode or queue-for-later behavior.
- No new automated tests — the codebase has no existing provider route or component test infrastructure.

---

## Context & Research

### Relevant Code and Patterns

- `src/server/routes/providers.ts` — Express router with `POST /` and `PUT /:id` endpoints that run `runHealthCheck()` and return `422` on failure.
- `src/client/stores/provider-store.ts` — Zustand store with `createProvider` and `updateProvider` methods that POST/PUT to the backend and return `null` on failure.
- `src/client/components/ProviderSection.tsx` — Provider settings UI with form validation, inline delete confirmation modal, and `handleSave` logic.
- `src/client/components/ConfirmDialog.tsx` — Reusable confirmation dialog component used elsewhere in the app (e.g., `WorkspaceTabs.tsx`).
- `src/client/i18n/en/settings.json` and `src/client/i18n/zh-CN/settings.json` — `settings` namespace with existing `providers.*` keys.

### Institutional Learnings

- No relevant learnings in `docs/solutions/` for this area.

---

## Key Technical Decisions

- **Pass `skipHealthCheck` in the request body** — Simplest contract, no query-param parsing needed, and it travels with the provider data naturally.
- **Use `ConfirmDialog` for the confirmation** — Already used across the app; cleaner than adding another inline modal to `ProviderSection`.
- **Detect health-check failure by `422` status** — The backend currently returns `422` exclusively for health-check failures, so this is a reliable signal without needing a special error code.

---

## Implementation Units

### U1. Backend: Accept skipHealthCheck Flag

**Goal:** Allow the create and update endpoints to bypass the health check when a flag is provided.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/server/routes/providers.ts`

**Approach:**
- In `POST /`, read `skipHealthCheck` from the request body. If true, skip `runHealthCheck()`.
- In `PUT /:id`, do the same when `baseUrl` or `authToken` changed.

**Patterns to follow:**
- Existing body parsing pattern in the same file.

**Test scenarios:**
- Happy path: `skipHealthCheck: true` with an unreachable endpoint creates/updates the provider successfully.
- Edge case: `skipHealthCheck: false` or absent still runs the health check as before.

**Verification:**
- Creating a provider with `skipHealthCheck: true` succeeds even when the endpoint is unreachable.
- Updating a provider's `baseUrl` with `skipHealthCheck: true` succeeds even when the endpoint is unreachable.
- Normal create/update without the flag still rejects on health-check failure.

---

### U2. Client Store: Pass skipHealthCheck Option

**Goal:** Extend `createProvider` and `updateProvider` to accept an optional `skipHealthCheck` flag and include it in the request body.

**Requirements:** R1, R2, R6

**Dependencies:** U1

**Files:**
- Modify: `src/client/stores/provider-store.ts`

**Approach:**
- Add an optional `options?: { skipHealthCheck?: boolean }` parameter to `createProvider` and `updateProvider`.
- Include `skipHealthCheck` in the JSON body sent to the backend.

**Patterns to follow:**
- Existing `formToInput` helper already builds the request body; extend it or add the flag alongside it.

**Test scenarios:**
- Happy path: calling `createProvider(data, { skipHealthCheck: true })` sends the flag in the body.
- Edge case: calling without options omits the flag entirely.

**Verification:**
- Network panel shows `skipHealthCheck: true` in the request body when the option is passed.
- Network panel shows no `skipHealthCheck` field when the option is omitted.

---

### U3. UI: Show Save-Anyway Dialog on 422

**Goal:** When a save fails with `422`, present a confirmation dialog that lets the user retry with `skipHealthCheck: true`.

**Requirements:** R4, R5, R6, R7

**Dependencies:** U2

**Files:**
- Modify: `src/client/components/ProviderSection.tsx`

**Approach:**
- Track a new piece of state (e.g., `showSaveAnywayConfirm`) similar to `showDeleteConfirm`.
- In `handleSave`, if `createProvider`/`updateProvider` returns `null` and the store's `error` looks like a health-check failure, set the confirm state instead of showing the generic error banner.
- On confirm, re-call the same save method with `skipHealthCheck: true`.
- On cancel, clear the confirm state and leave the form as-is.
- Render `ConfirmDialog` with `providers.saveAnywayTitle`, `providers.saveAnywayMessage`, and action labels from `actions.save` / `actions.cancel`.

**Patterns to follow:**
- `ConfirmDialog` usage in `WorkspaceTabs.tsx`.
- Existing `showDeleteConfirm` state pattern in `ProviderSection`.

**Test scenarios:**
- Happy path: user clicks Save, health check fails (422), dialog appears, user clicks Save anyway, provider is saved.
- Happy path: user clicks Save, health check fails (422), dialog appears, user clicks Cancel, form remains open.
- Edge case: a non-422 error (e.g., 409 name conflict) shows the normal error banner, not the save-anyway dialog.

**Verification:**
- Saving with an unreachable endpoint shows the confirmation dialog.
- Clicking Save anyway persists the provider and closes the form.
- Clicking Cancel dismisses the dialog and keeps the form data.
- Name-conflict errors still show the normal red banner without triggering the dialog.

---

### U4. i18n: Add Save-Anyway Dialog Translations

**Goal:** Add translation keys for the save-anyway confirmation dialog in both English and Chinese.

**Requirements:** R4, R5

**Dependencies:** None (can ship in parallel with U2/U3)

**Files:**
- Modify: `src/client/i18n/en/settings.json`
- Modify: `src/client/i18n/zh-CN/settings.json`

**Approach:**
- Add keys under `providers`:
  - `saveAnywayTitle`
  - `saveAnywayMessage`
  - `saveAnywayConfirm`

**Patterns to follow:**
- Existing `providers.deleteConfirmTitle` / `providers.deleteConfirmMessage` pattern.
- Existing `actions.save` / `actions.cancel` for button labels (reuse rather than duplicate).

**Test scenarios:**
- Test expectation: none — pure translation data change.

**Verification:**
- Dialog renders in English when the app is in English.
- Dialog renders in Chinese when the app is in Chinese.

---

## System-Wide Impact

- **Interaction graph:** No callbacks, middleware, or observers affected.
- **Error propagation:** The store's `error` state is still set on genuine failures; the dialog only intercepts the 422 health-check case.
- **State lifecycle risks:** None — the provider is either saved or not; partial writes are handled by the existing SQLite transaction in the store.
- **API surface parity:** The health-check endpoint `POST /api/providers/:id/health` is unchanged.
- **Unchanged invariants:** Provider list rendering, provider selector, and session runtime provider resolution are untouched.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| 422 status may be reused for other validation errors in the future, causing false dialog triggers. | The backend currently uses 422 only for health checks; if that changes, the dialog detection should be tightened (e.g., by a specific error code or string). Document this coupling in the code. |
| User saves an invalid provider and later forgets it is broken. | The existing provider list already shows health status per provider, and the manual health-check button remains available. |

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-31-provider-save-anyway-requirements.md](docs/brainstorms/2026-05-31-provider-save-anyway-requirements.md)
- Related code: `src/server/routes/providers.ts`, `src/client/stores/provider-store.ts`, `src/client/components/ProviderSection.tsx`, `src/client/components/ConfirmDialog.tsx`
