---
date: 2026-05-25
topic: readme-and-development-docs
---

# README and Development Documentation

## Summary

Create a user-focused `README.md` at repo root and a companion `development.md` for technical contributors. The README introduces Comate, showcases its features, and guides end users through installation and usage — self-contained with no links to internal `/docs`. The development.md covers architecture, dev setup, and contributing guidelines.

---

## Problem Frame

The project has grown from an experimental GUI wrapper into a full-featured desktop AI workspace with 25+ documented features, but it currently ships without any top-level documentation. New visitors to the repository have no way to understand what Comate does, how to install it, or how to contribute. Internal planning documents in `/docs` are extensive but not surfaced to external audiences. A proper README is needed to establish project identity, build credibility, and lower the barrier for both users and contributors.

---

## Actors

- A1. **End user**: Someone who wants to install and use Comate as a desktop AI workspace. They need to understand features, system requirements, and installation steps.
- A2. **Contributor**: A developer who wants to build from source, understand the architecture, or submit changes. They need setup instructions, stack overview, and contribution guidelines.

---

## Key Flows

- F1. **End user discovers and installs Comate**
  - **Trigger:** Visitor lands on the GitHub repository
  - **Actors:** A1
  - **Steps:**
    1. Skim README headline and feature list
    2. Check system requirements
    3. Download prebuilt release or build from source
    4. Launch the application
    5. Create a workspace and start a chat session
  - **Outcome:** User has a running Comate instance with at least one workspace
  - **Covered by:** R1, R2, R3, R4, R5

- F2. **Contributor sets up dev environment**
  - **Trigger:** Developer clones the repository to contribute
  - **Actors:** A2
  - **Steps:**
    1. Read development.md prerequisites and architecture overview
    2. Install dependencies and tooling
    3. Run dev servers (client + server + Tauri)
    4. Make changes and verify
  - **Outcome:** Developer has a working local development environment
  - **Covered by:** R6, R7, R8, R9

---

## Requirements

**README — Identity and Introduction**

- R1. README opens with a clear one-line description of Comate, followed by the tagline "Your friendly AI workspace companion."
- R2. README includes relevant badges: version, license, platform (macOS/Windows), and build status if available.
- R3. README contains a concise feature highlights section covering: workspace management, chat with streaming, file explorer, slash commands, task tracking, desktop app, and themes/i18n.
- R4. README includes a screenshot or demo GIF placeholder (with a note that it should be replaced with actual media).

**README — Installation and Usage**

- R5. README provides download/install instructions: prebuilt releases (`.dmg`/`.msi`) from GitHub Releases, plus a brief note that building from source is documented in development.md.
- R6. README includes a "Quick Start" section covering: creating a workspace, starting a chat session, and basic interaction (send a message, approve a tool call).
- R7. README lists system requirements: macOS 11+ or Windows 10+, and notes that an Anthropic API key is required.

**README — Closing**

- R8. README ends with a license section (MIT or as declared in package.json) and a brief pointer to development.md for contributors.
- R9. README does not reference the old project name ("claude-code-gui") anywhere.
- R10. README does not contain links to `/docs` or internal planning documents.

**development.md — Technical Documentation**

- R11. development.md opens with an architecture overview: Tauri desktop shell + React frontend + Express backend, with a brief rationale for the hybrid approach.
- R12. development.md lists prerequisites: Node.js, Rust, Tauri CLI, and any platform-specific dependencies.
- R13. development.md provides step-by-step dev setup: clone, install, run `npm run dev` and `npm run tauri:dev`.
- R14. development.md describes the key directories: `src/client/`, `src/server/`, `src-tauri/`, `packages/wecom-cli/`.
- R15. development.md includes a "Contributing" subsection with: code style (linting via ESLint), commit message conventions, and PR workflow.
- R16. development.md includes a "Building for Production" subsection covering: `npm run build`, `npm run build:sidecar`, and `npm run tauri:build`.

---

## Acceptance Examples

- AE1. **Covers R3, R9.** Given a visitor reads the README, when they scan the feature section, they see "Comate" named consistently and no mention of the former project name.
- AE2. **Covers R5, R8.** Given an end user wants to try Comate, when they read the README, they find a direct download link to GitHub Releases and a one-line pointer to development.md for source builds.
- AE3. **Covers R10.** Given a reader scans the entire README, when they look for links, they find no references to `/docs/plans` or any internal brainstorming documents.
- AE4. **Covers R13.** Given a new contributor clones the repo, when they follow development.md setup steps, they can run the full stack locally within 10 minutes.

---

## Success Criteria

- A first-time visitor can understand what Comate does and how to install it within 60 seconds of landing on the repository.
- A new contributor can set up a working dev environment by following development.md without asking for help.
- Neither document contains references to the old project name or links to internal `/docs`.

---

## Scope Boundaries

- No separate `CONTRIBUTING.md` — contributing guidelines live inside `development.md` for now.
- No detailed API documentation or endpoint reference — development.md covers architecture at overview level only.
- No deployment or CI/CD documentation beyond local production builds.
- No WeCom CLI package documentation beyond a brief mention in development.md architecture.
- No changelog or release notes — these are out of scope.

---

## Key Decisions

- **Two-file split over single README:** A lean README keeps the first impression clean for end users; technical details move to development.md where they don't overwhelm.
- **Self-contained README over linking to internal docs:** Functionality is described directly rather than referencing `/docs`, making the README portable and self-sufficient.
- **No mention of old project name:** The rebrand to Comate is treated as the only identity — no migration note or historical reference.
- **Badges included:** Version, license, and platform badges add credibility and quick-scan info without cluttering prose.

---

## Dependencies / Assumptions

- The project uses an MIT or similarly permissive license (to be verified against package.json or LICENSE file).
- Prebuilt releases are published to GitHub Releases under the current repository.
- The repository URL in package.json is current and accurate for badge generation.
