---
title: Tauri v2 signed auto-updater setup and CI release pipeline
date: 2026-06-20
category: workflow-issues
module: desktop-release
problem_type: workflow_issue
component: tooling
severity: high
applies_when:
  - Releasing a new version of the Tauri desktop app
  - Enabling or debugging signed auto-updates
  - latest.json is missing from GitHub release assets
root_cause: incomplete_setup
resolution_type: workflow_improvement
tags: [tauri-updater, signed-releases, ci-cd, github-actions, auto-update]
---

# Tauri v2 signed auto-updater setup and CI release pipeline

## Context

Comate is a Tauri v2 desktop app (Rust backend + React/Vite frontend + Node.js sidecar). When setting up signed auto-updates for the v0.0.10 release, the CI build did not produce `latest.json` updater artifacts, the updater endpoint returned no update, and the release download URL was unreachable. The fix required aligning `tauri.conf.json`, the GitHub Actions workflow, signing secrets, and the GitHub release state.

## Guidance

Use this checklist when enabling auto-updates or cutting a new release:

1. **Fix the updater endpoint and public key in `src-tauri/tauri.conf.json`.**
   - Point `plugins.updater.endpoints` to the correct GitHub repository.
   - Set `bundle.createUpdaterArtifacts` to `false` locally; CI will override it.
   - Include `"app"` in `bundle.targets` so macOS produces the `.app.tar.gz` archives the updater downloads.

2. **Generate an Ed25519 signing keypair and store it in GitHub secrets.**
   - Run `tauri signer generate` locally.
   - Add the private key as `TAURI_SIGNING_PRIVATE_KEY` and its password as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in the repository's GitHub Actions secrets.

3. **Create a CI-only updater config that enables artifacts when the signing secret is present.**
   - `src-tauri/updater-ci.json` sets `bundle.createUpdaterArtifacts: true`.
   - In `.github/workflows/build.yml`, conditionally pass `--config src-tauri/updater-ci.json` only when `TAURI_SIGNING_PRIVATE_KEY` is set.

4. **Make the CI verify step resilient to cross-compilation target directories.**
   - Use `find src-tauri/target -name latest.json` instead of a hardcoded path.

5. **Publish the release.**
   - GitHub's `/releases/latest/download/latest.json` endpoint only resolves for published (non-draft) releases. Either set `releaseDraft: false` in the workflow or manually publish the draft release after CI finishes.

## Why This Matters

- Tauri's updater only generates signed archives when `createUpdaterArtifacts: true` **and** a valid signing key is available. Without both, `latest.json` is silently omitted.
- The macOS updater specifically needs the `"app"` bundle target. `"dmg"` is for manual installation, not auto-update.
- The `/releases/latest/download/latest.json` URL is a GitHub convenience endpoint that redirects to the latest **published** release. Draft releases are invisible to it.
- The conditional `--config` approach keeps local builds fast (no signing needed) while ensuring CI produces updater artifacts only when secrets are available.

## When to Apply

- Before the first release that ships auto-updates.
- When `latest.json` is missing from release assets.
- When the app reports "no update available" despite a newer published release.
- After renaming or forking the repository (the endpoint URL must match the new repo).

## Examples

### Base config in `src-tauri/tauri.conf.json`

```json
{
  "bundle": {
    "active": true,
    "targets": ["dmg", "msi", "app"],
    "createUpdaterArtifacts": false
  },
  "plugins": {
    "updater": {
      "pubkey": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDk5QUU3MTM0MEQ5MDM1NzYKUldSMk5aQU5OSEd1bVZlNGZuaGx1c0NKZHB4SG9EWTlzaTlLeXdndm13bEZ5QXhHclpZYUhSQ2wK",
      "endpoints": [
        "https://github.com/ai-dvps/comate/releases/latest/download/latest.json"
      ],
      "checkOnStartup": false
    }
  }
}
```

### CI-only updater config in `src-tauri/updater-ci.json`

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

### CI workflow snippet in `.github/workflows/build.yml`

```yaml
- name: Build Tauri app
  uses: tauri-apps/tauri-action@v0
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  with:
    tagName: ${{ github.ref_name }}
    releaseName: 'Comate ${{ github.ref_name }}'
    releaseBody: 'See the assets to download and install this version.'
    releaseDraft: true
    prerelease: false
    args: ${{ matrix.args }} ${{ env.TAURI_SIGNING_PRIVATE_KEY != '' && '--config src-tauri/updater-ci.json' || '' }}

- name: Verify updater artifacts
  if: env.TAURI_SIGNING_PRIVATE_KEY != ''
  shell: bash
  run: |
    set -e
    if ! find src-tauri/target -name latest.json | grep -q .; then
      echo "Missing latest.json updater manifest"
      exit 1
    fi
    echo "Updater artifacts present"
```

### Common pitfalls

- **Wrong repo name in endpoint:** The endpoint must match the repository that owns the releases.
- **Missing `"app"` target:** macOS `.app.tar.gz` updater archives are only produced when `"app"` is in `bundle.targets`.
- **Draft releases:** `/releases/latest/download/latest.json` returns 404 until the release is published.
- **Hardcoded verify path:** Cross-compiled macOS builds place `latest.json` under `target/<arch>-apple-darwin/release/bundle/macos/`, not `target/release/bundle/`.

## Related

- Original implementation plan: `docs/plans/2026-06-19-003-feat-desktop-auto-updater-plan.md`
