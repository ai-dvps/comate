---
date: 2026-05-31
topic: provider-save-anyway-on-health-check-failure
---

# Provider Save-Anyway on Health Check Failure

## Summary

When saving a provider, if the endpoint health check fails, the user can choose to save anyway or cancel, instead of being blocked outright.

---

## Problem Frame

Currently, creating or updating a provider runs a health check against the endpoint before persisting. If the endpoint is unreachable or credentials are invalid, the save is rejected with no recourse. This is frustrating when the endpoint is temporarily down, behind a firewall, or when the user knows the configuration is correct and wants to save it for later use.

---

## Requirements

**Backend**
- R1. The create-provider endpoint accepts a flag to skip the health check.
- R2. The update-provider endpoint accepts a flag to skip the health check.
- R3. When the flag is absent or false, health check behavior remains unchanged.

**Frontend**
- R4. When a save request fails due to health check, the UI shows a confirmation dialog.
- R5. The dialog offers "Save anyway" and "Cancel" actions.
- R6. "Save anyway" re-submits the save request with the skip flag set.
- R7. "Cancel" closes the dialog and leaves the form open with existing data intact.

---

## Acceptance Examples

- AE1. **Covers R1, R4, R5, R6.** Given a user filling the new-provider form with an unreachable endpoint, when they click Save and the health check fails, then a dialog appears asking "Save anyway?" and clicking it persists the provider.
- AE2. **Covers R2, R4, R5, R7.** Given a user editing a provider's auth token to an invalid value, when they click Save and the health check fails, then a dialog appears and clicking Cancel keeps the form open without saving.

---

## Success Criteria

- Users can persist providers even when the endpoint is temporarily unreachable.
- The common case (healthy endpoint) requires no extra clicks.
- The UI clearly distinguishes a failed health check from other validation errors.

---

## Scope Boundaries

- Health check criteria and timeout remain unchanged.
- No automatic retry or background health polling.
- No offline-mode or queue-for-later behavior.

---

## Key Decisions

- **Bypass flag on existing endpoints rather than dedicated force-save endpoints** — keeps the API surface smaller.
- **Dialog on failure rather than always-visible "skip check" toggle** — avoids cluttering the common case where endpoints work.

---

## Dependencies / Assumptions

- The existing health check endpoint (`POST /api/providers/:id/health`) continues to work independently for on-demand checks.
