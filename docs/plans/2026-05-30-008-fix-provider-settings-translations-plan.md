---
type: fix
origin: none
status: active
---

# Fix: Add Missing Provider Settings Translations

## Problem Frame

The ProviderSection UI component references many `providers.*` translation keys under the `settings` namespace, but the corresponding keys are missing from both English and Chinese i18n files. This results in raw key names being displayed to users instead of human-readable text.

## Scope

Add all missing `providers.*` translation keys to:
- `src/client/i18n/en/settings.json`
- `src/client/i18n/zh-CN/settings.json`

## Key Technical Decisions

- **Namespace**: All provider UI strings live under the `settings` namespace, consistent with the rest of the settings page.
- **Translation strategy**: English keys are added verbatim; Chinese keys are translated naturally for a Chinese-speaking developer audience.

## Implementation Units

### U1. Add Missing Provider Translation Keys

**Goal:** Populate `providers.*` keys in both `en/settings.json` and `zh-CN/settings.json` so the ProviderSection renders human-readable text.

**Files:**
- `src/client/i18n/en/settings.json`
- `src/client/i18n/zh-CN/settings.json`

**Approach:**
Audit `src/client/components/ProviderSection.tsx` for every `t('providers.XXX')` call and add the corresponding key to both locale files.

Missing keys (derived from component audit):
- `providers.title`
- `providers.add`
- `providers.edit`
- `providers.emptyTitle`
- `providers.emptyHint`
- `providers.createFirst`
- `providers.name`
- `providers.namePlaceholder`
- `providers.nameRequired`
- `providers.baseUrl`
- `providers.baseUrlPlaceholder`
- `providers.baseUrlRequired`
- `providers.authToken`
- `providers.authTokenPlaceholder`
- `providers.authTokenRequired`
- `providers.model`
- `providers.modelPlaceholder`
- `providers.advanced`
- `providers.defaultOpusModel`
- `providers.defaultSonnetModel`
- `providers.defaultHaikuModel`
- `providers.subagentModel`
- `providers.effortLevel`
- `providers.customEnvVars`
- `providers.envVarKey`
- `providers.envVarValue`
- `providers.addEnvVar`
- `providers.save`
- `providers.cancel`
- `providers.deleteConfirmTitle`
- `providers.deleteConfirmMessage`
- `providers.delete`
- `providers.defaultBadge`
- `providers.healthy`
- `providers.unhealthy`
- `providers.setDefault`
- `providers.healthCheck`
- `providers.fetchFailed`
- `providers.detectFailed`
- `providers.createFailed`
- `providers.updateFailed`
- `providers.setDefaultFailed`

**Test expectation:** none — pure translation data change with no behavioral logic.

**Verification:**
- Open Settings → Providers in the app
- Confirm all labels, placeholders, buttons, and empty-state text render correctly in English
- Switch app language to Chinese and confirm the same
