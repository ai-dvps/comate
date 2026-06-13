---
title: Release comate 0.0.3
type: chore
date: 2026-06-13
---

# Release comate 0.0.3

## Summary

Plan and execute the comate 0.0.3 release: bump the app and Tauri version strings from 0.0.2 to 0.0.3, repair the @webank/wecom CLI lockfile sync, add a CHANGELOG entry, fix the GitHub Actions release trigger, and push the `v0.0.3` tag to build signed desktop artifacts.

---

## Problem Frame

comate is currently at 0.0.2 across its root package and Tauri manifests, but no `v0.0.2` tag exists and the release workflow is still configured to trigger on pushes to a `release` branch. With `tagName: ${{ github.ref_name }}`, a branch-triggered run would name the release after the branch (`release`) instead of the version. The 0.0.3 release needs to coordinate version bumps, lockfile consistency, changelog documentation, and workflow mechanics so the signed desktop build produces correctly-named artifacts.

---

## Requirements

- **R1.** The root application version reads `0.0.3` in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.lock`.
- **R2.** The `@webank/wecom` CLI manifest and lockfile agree at `0.1.0`.
- **R3.** `CHANGELOG.md` exists at the repository root and documents the `0.0.3` release.
- **R4.** The release workflow triggers on `v*` tags and passes the tag name to the Tauri action.
- **R5.** Git tag `v0.0.3` points to the release commit and is pushed to origin.
- **R6.** CI produces `.dmg` and `.msi` artifacts and the draft release is published.

---

## Scope Boundaries

### In scope

- Bumping app and Tauri version strings to `0.0.3`.
- Repairing the `@webank/wecom` CLI lockfile mismatch.
- Creating `CHANGELOG.md` with a `0.0.3` entry.
- Fixing the GitHub Actions release trigger.
- Creating and pushing the `v0.0.3` tag.
- Verifying the draft release and publishing it.

### Out of scope

- Dependency version bumps.
- macOS/Windows code signing or notarization setup.
- New feature work.
- Publishing the `@webank/wecom` CLI to an npm registry.

### Deferred to follow-up work

- Automated release-notes generation from commit history.
- A long-term release branch strategy.
- Code-signing and notarization for macOS and Windows.

---

## Key Technical Decisions

- **KTD1. Manual version string replacement.** Bump the npm and Rust manifests together by editing the version entries directly, rather than using `npm version` or `cargo bump`, so the coordinated edits stay atomic and predictable.
- **KTD2. Keep @webank/wecom CLI on its own semver line.** The CLI already diverged to `0.1.0`; do not force it back to the app version. Only repair its lockfile so it agrees with the manifest.
- **KTD3. Switch the workflow trigger to `v*` tags.** Replace the `release` branch trigger with a tag trigger so `github.ref_name` resolves to the version tag (e.g., `v0.0.3`).
- **KTD4. Seed CHANGELOG.md from commit history.** Build the first changelog entry by grouping changes since the `v0.0.1` tag rather than relying solely on GitHub's auto-generated release notes.

---

## Risks & Dependencies

- **CI signing secrets.** The workflow requires `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Missing or expired secrets will fail the build late in the pipeline.
- **Workflow trigger change is a process break.** After this change, pushes to the `release` branch will no longer trigger builds. Any automation or team habit that depends on the `release` branch must be updated.
- **Draft release requires manual publish.** `releaseDraft: true` means a human must open the GitHub release and click **Publish** after artifacts upload.
- **Native module packaging.** `scripts/build-sidecar.ts` copies the host-platform `better_sqlite3.node` into the bundle. Cross-platform builds rely on the CI runners building the correct sidecar triple; the macOS x86_64 artifact should be smoke-tested because the arm64 native module may not run under Rosetta for all code paths.

---

## Implementation Units

### U1. Fix @webank/wecom CLI lockfile sync

**Goal:** Make `packages/wecom-cli/package-lock.json` agree with its manifest at `0.1.0`.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `packages/wecom-cli/package-lock.json`

**Approach:**
Run `npm install -w packages/wecom-cli` from the repository root to regenerate the workspace lockfile entry, or manually update the root and `packages[""]` `version` entries from `0.0.2` to `0.1.0`. Leave dependency versions untouched.

**Patterns to follow:**
- `docs/plans/2026-05-29-001-refactor-unify-version-0.0.2-plan.md` updated lockfile root/package entries only.

**Test scenarios:**
- Verify the root `version` field in `packages/wecom-cli/package-lock.json` reads `0.1.0`.
- Verify the `packages[""].version` field reads `0.1.0`.
- Verify no `@webank/wecom` `0.0.2` entries remain in that lockfile.

**Verification:**
`grep '"version": "0.1.0"' packages/wecom-cli/package-lock.json` returns the expected entries and no `0.0.2` package entries remain.

---

### U2. Bump application version to 0.0.3

**Goal:** Update every canonical app version string from `0.0.2` to `0.0.3`.

**Requirements:** R1

**Dependencies:** None (can land in the same commit as U1)

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.lock`

**Approach:**
Follow the 0.0.2 unification pattern:
- Update the `version` field in `package.json` from `0.0.2` to `0.0.3`.
- Update the root package `version` entries in `package-lock.json` (top-level and `packages[""]` blocks) from `0.0.2` to `0.0.3`, leaving dependency versions untouched.
- Update the `version` key in `src-tauri/Cargo.toml` from `0.0.2` to `0.0.3`.
- Update the `version` key in `src-tauri/tauri.conf.json` from `0.0.2` to `0.0.3`.
- Update the `comate` package entry in `src-tauri/Cargo.lock` by running `cargo update -p comate` inside `src-tauri/`, or by editing the entry manually.

**Patterns to follow:**
- `docs/plans/2026-05-29-001-refactor-unify-version-0.0.2-plan.md`

**Test scenarios:**
- Verify `package.json` contains `"version": "0.0.3"`.
- Verify `package-lock.json` root entries contain `"version": "0.0.3"`.
- Verify `src-tauri/Cargo.toml` contains `version = "0.0.3"`.
- Verify `src-tauri/tauri.conf.json` contains `"version": "0.0.3"`.
- Verify `src-tauri/Cargo.lock` contains `version = "0.0.3"` for the `comate` package.
- Verify no stale `0.0.2` app-version references remain in these files.

**Verification:**
Run targeted `grep` checks on each file; `cargo check` inside `src-tauri/` passes without lockfile complaints.

---

### U3. Add CHANGELOG.md entry for 0.0.3

**Goal:** Document the changes shipped in the 0.0.3 release.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Create: `CHANGELOG.md`

**Approach:**
Create a `CHANGELOG.md` at the repository root using the Keep a Changelog format. Group changes under `Added`, `Changed`, and `Fixed` based on the commits since the `v0.0.1` tag. Keep entries concise and user-facing; collapse vendor/subtree and planning-only commits into a single `### Internal` or `### Maintenance` section where appropriate.

**Test scenarios:**
- Verify `CHANGELOG.md` exists at the repository root.
- Verify it contains a `[0.0.3]` section with today's date.
- Verify categories (`Added`, `Changed`, `Fixed`) are used correctly.

**Verification:**
Read `CHANGELOG.md` and confirm the `0.0.3` section is present and formatted consistently.

---

### U4. Fix GitHub Actions release workflow trigger

**Goal:** Make the release workflow trigger on version tags so the tag name reaches the Tauri action.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `.github/workflows/build.yml`

**Approach:**
Replace the branch trigger with a tag trigger:

```yaml
on:
  push:
    tags:
      - 'v*'
```

Leave the matrix, permissions, environment variables, and Tauri action configuration unchanged. The existing `tagName: ${{ github.ref_name }}` will now correctly resolve to `v0.0.3`.

**Test scenarios:**
- Verify the workflow YAML is syntactically valid.
- Verify the trigger pattern matches `v0.0.3` and rejects unexpected tag shapes.
- Verify `tagName` and `releaseName` still reference `github.ref_name`.

**Verification:**
Run a YAML syntax check or open the file in GitHub's workflow editor; confirm no errors.

---

### U5. Commit, tag, and push release

**Goal:** Land the release changes and trigger the CI pipeline.

**Requirements:** R5

**Dependencies:** U1, U2, U3, U4

**Files:**
- (Git operations; no new files beyond U1–U4)

**Approach:**
1. Confirm the working tree is clean except for the release changes (`git status`).
2. Stage all modified files and the new `CHANGELOG.md`.
3. Commit with a conventional commit message such as `chore(release): bump version to 0.0.3`.
4. Create an annotated tag `v0.0.3` pointing to the release commit.
5. Push the current branch (e.g., `main`) and the tag to origin.

**Execution note:** Verify that `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` are configured in the repository settings before pushing the tag. If they are missing, do not push until they are set.

**Test scenarios:**
- Verify `git diff` is clean after the commit.
- Verify `git tag -l v0.0.3` shows the tag.
- Verify `git log --oneline --decorate` shows the tag on the release commit.

**Verification:**
The GitHub Actions workflow starts automatically after the tag push, and the release commit contains the version bumps, CHANGELOG, and workflow fix.

---

### U6. Verify and publish release artifacts

**Goal:** Confirm the CI builds succeed and publish the draft release.

**Requirements:** R6

**Dependencies:** U5

**Files:**
- (GitHub UI; no repository file changes)

**Approach:**
1. Monitor the GitHub Actions workflow for the three matrix jobs (macOS aarch64, macOS x86_64, Windows x86_64).
2. Once all jobs succeed, open the draft release created by the workflow.
3. Verify the expected artifacts are attached: DMG for each macOS target and MSI for Windows.
4. Edit the release body if needed, then click **Publish release**.

**Test scenarios:**
- Verify three successful workflow runs.
- Verify artifacts exist for `aarch64-apple-darwin`, `x86_64-apple-darwin`, and `x86_64-pc-windows-msvc`.
- Verify the release is no longer in draft state after publishing.

**Verification:**
The GitHub releases page shows a published `v0.0.3` release with the expected assets.

---

## Sources & Research

- `docs/plans/2026-05-29-001-refactor-unify-version-0.0.2-plan.md` — precedent for manually unifying version strings across npm and Rust manifests and lockfiles.
- `.github/workflows/build.yml` — current release workflow; trigger fix is required because `github.ref_name` resolves to the branch name on branch pushes.
- `scripts/build-sidecar.ts` — sidecar build script; bundles the Express server and copies platform-specific native modules and the built-in marketplace into the Tauri resources.
- `src-tauri/tauri.conf.json` — Tauri bundle configuration defining targets (`dmg`, `msi`), external sidecar binary, and resources.
