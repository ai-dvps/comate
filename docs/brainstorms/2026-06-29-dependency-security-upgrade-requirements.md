---
date: 2026-06-29
topic: dependency-security-upgrade
---

# Dependency Security Upgrade

## Summary

Upgrade all dependencies flagged by `npm audit` (18 vulnerabilities: 1 critical, 9 high, 6 moderate, 2 low) to patched versions. Use the smallest safe version bumps that resolve the advisories, and use npm `overrides` to force patched transitive versions where the direct dependency has no upstream fix. Verify the changes with lint, client/server/browser tests, and the full Tauri release build.

---

## Problem Frame

`npm audit --registry=https://registry.npmjs.org/` reports 18 vulnerabilities across the root package and its workspace. Some advisories hit direct dependencies such as `dompurify`, `ws`, `vite`, and `playwright`; others are transitive, including `axios` pulled in by `@larksuiteoapi/node-sdk`, `shell-quote`, and `tar`. Several direct dependencies (`@larksuiteoapi/node-sdk`, `@larksuite/vercel-chat-adapter`) have no upstream fix available yet, so remediation must force safe transitive versions through overrides.

Because Comate bundles a Tauri desktop shell and a Node sidecar, dependency changes must be validated end-to-end. A broken build step or native binding mismatch would show up only after install, so the verification bar includes the full `npm run release` pipeline.

---

## Key Decisions

- **Minimal bumps over latest majors.** Prefer patch or minor updates that remove the advisory. Major-version upgrades are acceptable only when no safer path exists.
- **npm `overrides` for transitive vulnerabilities.** Force patched transitive versions in root `package.json` rather than promoting transitive packages to direct dependencies.
- **Full verification bar.** Require lint, client/server/browser tests, and the full release build to pass before considering the upgrade complete.
- **No proactive upgrades.** Only packages flagged by `npm audit` are in scope; unaffected dependencies stay at their current versions.

---

## Requirements

### Vulnerability remediation

R1. Resolve all 18 vulnerabilities reported by `npm audit --registry=https://registry.npmjs.org/` across `package.json`, `package-lock.json`, and `packages/wecom-cli/package.json`.

R2. Upgrade direct dependencies to the smallest patched version that removes the advisory, avoiding major-version jumps where possible.

R3. Use npm `overrides` in root `package.json` to force safe transitive versions for packages whose direct parent has no upstream fix, such as `axios` under `@larksuiteoapi/node-sdk`, `shell-quote`, and `tar`.

R4. For `exceljs`, which is flagged only because it depends on a vulnerable `uuid`, resolve the advisory by updating `uuid` or via overrides rather than downgrading `exceljs`.

R5. For `@yao-pkg/pkg`, which is flagged via `esbuild`, resolve the advisory by updating `esbuild` to a patched version rather than downgrading `pkg`.

R6. After all changes, `npm audit --registry=https://registry.npmjs.org/` must report zero vulnerabilities.

### Verification

R7. `npm run lint` must pass with zero warnings.

R8. `npm run test:client` must pass.

R9. `npm run test:server` must pass.

R10. `npm run test:browser` must pass.

R11. `npm run build` must complete successfully.

R12. `npm run release` (sidecar build plus Tauri production build) must complete successfully.

### Documentation

R13. Update `CHANGELOG.md` with the upgraded packages and a brief security note.

R14. If any advisory cannot be fully resolved, document the override rationale and residual risk in the PR description.

---

## Scope Boundaries

- **Deferred for later:** proactive upgrades of non-vulnerable dependencies, automated dependency monitoring or audit CI, and replacing or removing `@larksuite*` packages if overrides successfully resolve their advisories.
- **Outside this work:** manual runtime testing beyond the automated verification bar, changes to application behavior or features, and dependency policy changes such as switching from npm to pnpm or yarn.

---

## Dependencies / Assumptions

- Official npm registry advisories are current and accurate at the time of the upgrade.
- `@larksuiteoapi/node-sdk` and `@larksuite/vercel-chat-adapter` remain API-compatible with a patched `axios` forced by overrides.
- The development environment can run the full Tauri release build, including native resources.
- `better-sqlite3` native bindings continue to work after the upgrade cycle.

---

## Sources / Research

- `package.json` — dependency declarations, scripts, and workspace configuration.
- `packages/wecom-cli/package.json` — workspace dependency declarations.
- `npm audit --registry=https://registry.npmjs.org/` output for this repository.
- `npm outdated --registry=https://registry.npmjs.org/` output for available patched versions.
