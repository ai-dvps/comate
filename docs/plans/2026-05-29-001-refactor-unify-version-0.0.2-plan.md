---
title: Unify application version numbers to 0.0.2
type: refactor
status: completed
date: 2026-05-29
---

# Unify application version numbers to 0.0.2

## Summary

Unify all application version strings to 0.0.2 across the root package, Tauri manifests, lockfiles, and the wecom-cli subpackage.

## Requirements

- R1. Every canonical application version string reads 0.0.2.
- R2. Generated lockfiles remain consistent with their respective manifests.

## Scope Boundaries

- Dependency version bumps are out of scope.
- Git tags, changelog updates, and release automation are out of scope.
- Version references in planning documents are out of scope.

## Context & Research

### Relevant Code and Patterns

- Root manifest: `package.json` (version 0.0.1)
- Root lockfile: `package-lock.json` (root package `claude-code-gui` currently at 1.0.0, out of sync with manifest)
- Tauri Rust manifest: `src-tauri/Cargo.toml` (version 0.0.1)
- Tauri config: `src-tauri/tauri.conf.json` (version 0.0.1)
- Rust lockfile: `src-tauri/Cargo.lock` (app package `comate` at 0.0.1)
- Subpackage manifest: `packages/wecom-cli/package.json` (version 1.0.0)
- Subpackage lockfile: `packages/wecom-cli/package-lock.json` (package `@webank/wecom` at 1.0.0)

## Implementation Units

### U1. Unify root application version to 0.0.2

**Goal:** Update the root application and Tauri version strings to 0.0.2, keeping lockfiles consistent.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/Cargo.lock`

**Approach:**
- Update the `version` field in `package.json` from `0.0.1` to `0.0.2`.
- Update the root package `version` entries in `package-lock.json` (top-level and `packages[""]` blocks) from `1.0.0` to `0.0.2`, leaving dependency versions untouched.
- Update the `version` key in `src-tauri/Cargo.toml` from `0.0.1` to `0.0.2`.
- Update the `version` key in `src-tauri/tauri.conf.json` from `0.0.1` to `0.0.2`.
- Update the `comate` package entry in `src-tauri/Cargo.lock` from `0.0.1` to `0.0.2`.

**Test scenarios:**
- Test expectation: none — mechanical string replacement in manifests and lockfiles; verification is via file inspection.

**Verification:**
- `package.json` contains `"version": "0.0.2"`.
- `package-lock.json` root entries contain `"version": "0.0.2"`.
- `src-tauri/Cargo.toml` contains `version = "0.0.2"`.
- `src-tauri/tauri.conf.json` contains `"version": "0.0.2"`.
- `src-tauri/Cargo.lock` contains `version = "0.0.2"` for the `comate` package.
- No remaining `0.0.1` references for the app version in these files.

### U2. Unify wecom-cli package version to 0.0.2

**Goal:** Update the wecom-cli subpackage version string to 0.0.2, keeping its lockfile consistent.

**Requirements:** R1, R2

**Dependencies:** None (can be done in parallel with U1)

**Files:**
- Modify: `packages/wecom-cli/package.json`
- Modify: `packages/wecom-cli/package-lock.json`

**Approach:**
- Update the `version` field in `packages/wecom-cli/package.json` from `1.0.0` to `0.0.2`.
- Update all `@webank/wecom` package `version` entries in `packages/wecom-cli/package-lock.json` from `1.0.0` to `0.0.2`, leaving dependency versions untouched.

**Test scenarios:**
- Test expectation: none — mechanical string replacement in manifests and lockfiles; verification is via file inspection.

**Verification:**
- `packages/wecom-cli/package.json` contains `"version": "0.0.2"`.
- `packages/wecom-cli/package-lock.json` root and package entries contain `"version": "0.0.2"`.
- No remaining `1.0.0` references for the `@webank/wecom` package in these files.
