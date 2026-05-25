---
title: Add README and development.md
type: feat
status: completed
date: 2026-05-25
origin: docs/brainstorms/2026-05-25-readme-and-development-docs-requirements.md
---

# Add README and development.md

## Summary

Create a user-facing `README.md` at repo root and a companion `development.md` for technical contributors. The README introduces Comate, lists features, and covers installation and quick-start — self-contained with no links to internal `/docs`. The development.md covers architecture, dev setup, and contributing guidelines. Both documents exclude the old project name.

---

## Requirements

**README — Identity and Introduction**
- R1. README opens with a clear one-line description + tagline.
- R2. README includes relevant badges (version, platform, license if known).
- R3. README contains a concise feature highlights section.
- R4. README includes a screenshot/GIF placeholder.

**README — Installation and Usage**
- R5. README provides download/install instructions and a pointer to development.md for source builds.
- R6. README includes a Quick Start section.
- R7. README lists system requirements and notes the Anthropic API key requirement.

**README — Closing**
- R8. README ends with license section and pointer to development.md.
- R9. README does not reference the old project name anywhere.
- R10. README does not link to `/docs` or internal planning documents.

**development.md — Technical Documentation**
- R11. development.md opens with architecture overview (Tauri + React + Express).
- R12. development.md lists prerequisites.
- R13. development.md provides step-by-step dev setup.
- R14. development.md describes key directories.
- R15. development.md includes a Contributing subsection.
- R16. development.md includes a Building for Production subsection.

**Origin actors:** A1 (End user), A2 (Contributor)
**Origin flows:** F1 (End user discovers and installs), F2 (Contributor sets up dev environment)
**Origin acceptance examples:** AE1 (covers R3, R9), AE2 (covers R5, R8), AE3 (covers R10), AE4 (covers R13)

*Note:* The origin document maps F2 coverage to R6-R9 (README requirements), but F2 should logically map to R11-R16 (development.md requirements). This appears to be an error in the origin document; the plan preserves the origin's mapping for traceability.

---

## Scope Boundaries

- No reference to the old project name ("claude-code-gui") in either document.
- No separate `CONTRIBUTING.md` — contributing guidelines live inside `development.md`.
- No detailed API documentation or endpoint reference.
- No deployment or CI/CD documentation beyond local production builds.
- No WeCom CLI package documentation beyond a brief architecture mention.
- No changelog or release notes.

---

## Context & Research

### Relevant Code and Patterns

- `package.json` — version `1.0.0`, description "Your friendly AI workspace companion", no `license` field set.
- `src-tauri/tauri.conf.json` — `productName: "Comate"`, `identifier: "com.comate.app"`.
- Git remote: `git@github.com:ai-dvps/claude-code-gui.git` (used for badge URLs).
- No existing `README.md` or `LICENSE` file at repo root.
- Project uses npm workspaces with `packages/*`.

### Institutional Learnings

- None relevant — this is net-new documentation.

### External References

- None required — standard Markdown documentation patterns.

---

## Key Technical Decisions

- **No LICENSE file present:** Omit explicit license badge. Include a placeholder license section in README stating no license is currently declared. Do not guess a license.
- **Badge set:** Include version badge and platform badges (macOS, Windows). Omit license badge because no LICENSE file exists and package.json has no license field. Omit build-status badge since no CI workflow files were found.
- **GitHub Releases URL:** The git remote still uses the old repository name (`claude-code-gui`). Use a placeholder release URL in README and note that it must be updated if/when the repository is renamed. Do not embed the old project name in the final README.

---

## Implementation Units

### U1. README.md

**Goal:** Create the end-user-facing README at repo root.

**Requirements:** R1, R2, R3, R4, R5, R6, R7, R8, R9, R10

**Dependencies:** None

**Files:**
- Create: `README.md`

**Approach:**
- Write a concise, scannable README with clear section hierarchy.
- Lead with description + tagline, then badges, then a screenshot placeholder.
- Feature highlights should be bullet-based for scanability — group related capabilities (e.g., "Chat & Sessions", "Workspace & Files").
- Quick Start should be 3-4 numbered steps: create workspace → start session → send message → approve tool.
- System requirements: macOS 13+ or Windows 10+, Anthropic API key.
- End with a license section noting no license is currently declared, plus a single-line link to `development.md`.

**Patterns to follow:**
- Standard GitHub README conventions (badges near top, TOC optional but helpful for length).

**Test scenarios:**
- Happy path: A visitor skims the README and understands what Comate does and how to install it within 60 seconds.
- Edge case: README renders correctly on GitHub (no broken badge URLs, no relative-path issues).

**Verification:**
- `README.md` exists at repo root.
- No mention of "claude-code-gui" in the file.
- No links to `/docs` or `docs/brainstorms`.
- Version and platform badges (macOS, Windows) are present and render correctly. License badge is omitted per technical decision.

### U2. development.md

**Goal:** Create the contributor-facing technical documentation.

**Requirements:** R11, R12, R13, R14, R15, R16

**Dependencies:** None (technically independent of U1, though README should land first for workflow cohesion)

**Files:**
- Create: `development.md`

**Approach:**
- Start with a one-paragraph architecture overview: Tauri v2 desktop shell wrapping a React 18 frontend and an Express backend, with a sidecar Node.js process.
- Prerequisites: Node.js (latest LTS), Rust (1.77+). Tauri CLI is installed automatically via `npm install` as a devDependency.
- Dev setup: clone → `npm install` → `npm run dev:server` (in one terminal, starts Express backend) → `npm run tauri:dev` (in another, starts Vite client + Tauri desktop shell). Note: `tauri:dev` auto-starts the client via `beforeDevCommand`; do not run `npm run dev` (client + server concurrently) alongside `tauri:dev` to avoid port conflicts.
- Key directories: brief one-liner for each of `src/client/` (React frontend), `src/client/lib/` (Tauri API bridge), `src/client/i18n/` (localization), `src/server/` (Express API), `src-tauri/` (Rust desktop shell), `packages/wecom-cli/` (WeCom CLI tool), `scripts/` (build and generation scripts).
- Contributing: run `npm run lint`, follow existing commit message style (conventional commits inferred from git history), open PRs against `main`.
- Production build: `npm run release` (shorthand for `npm run build:sidecar && npm run tauri:build`, which triggers the full pipeline via `beforeBuildCommand`).

**Patterns to follow:**
- Keep prose concise; this is a dev quick-start, not an architecture RFC.

**Test scenarios:**
- Happy path: A new contributor follows the setup steps and has a running dev environment.
- Edge case: Commands listed exist in `package.json` scripts.

**Verification:**
- `development.md` exists at repo root.
- Every `npm run` command referenced matches a script in `package.json`.
- Dev setup instructions correctly describe running `dev:server` and `tauri:dev` separately (not `dev` + `tauri:dev` together).
- No mention of "claude-code-gui" in the file.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-25-readme-and-development-docs-requirements.md](docs/brainstorms/2026-05-25-readme-and-development-docs-requirements.md)
- Related code: `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
