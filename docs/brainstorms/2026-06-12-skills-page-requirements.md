---
date: 2026-06-12
topic: skills-page
---

# Skills Page — Direct Skill Install via vercel-labs/skills

## Summary

A top-level Skills page in Comate, opened from a new toolbar button next to the Plugins button, that lets users search skills by keyword via skills.sh, install individual SKILL.md bundles from a URL or `owner/repo` through a multi-select picker, and manage installed skills (list, remove, update). Backed by vendored vercel-labs/skills source for a real TS API. Claude Code paths only; fully separate from the Plugin Manager.

---

## Problem Frame

Comate's current extension story is the Plugin Manager, which models Claude Code plugins — heavyweight packages that bundle skills, commands, hooks, MCP servers, and agents, distributed via marketplaces. The plugin format is the right abstraction when teams want a shareable bundle that rolls multiple component types into one install.

But many users want a lighter operation: install a single SKILL.md bundle from a URL or a known skills repo without registering a marketplace, without pulling commands or hooks they didn't ask for, and without the plugin cache/settings machinery. The vercel-labs/skills ecosystem has become the de facto standard for this — `SKILL.md` files with YAML frontmatter, hosted in ordinary git repos, installable via `npx skills add owner/repo`. Comate already consumes this format: three such skills are installed in `.claude/skills/` and `.agents/skills/` today, tracked by `skills-lock.json` at the repo root.

Today, doing this from inside Comate requires dropping to a terminal, running `npx skills` against the workspace folder, then returning to Comate. There is no in-app way to discover, install, or manage standalone skills. The Skills tab in workspace settings is currently a "coming soon" placeholder.

---

## Actors

- A1. **End user**: Searches for, installs, lists, removes, and updates skills in their workspace.
- A2. **skills.sh registry**: Hosted service that the vendored `findSkills` queries for keyword search results.
- A3. **Source repository**: Any git repo (GitHub shorthand, GitHub URL, GitHub tree URL, git SSH/HTTPS URL) or local filesystem path that contains one or more SKILL.md bundles in known container paths.
- A4. **Vendored vercel-labs/skills source**: The TS modules Comate copies from upstream and calls directly for URL resolution, SKILL.md discovery, copy-install, lock-file management, and skills.sh search.

---

## Key Flows

- F1. **Search and install**
  - **Trigger:** User opens the Skills page and types a keyword into the search input.
  - **Actors:** A1, A2, A3, A4
  - **Steps:**
    1. User types a keyword; the page calls the vendored `findSkills` against skills.sh.
    2. Results render as cards (name, description, source repo).
    3. User clicks Install on a result.
    4. The page resolves the source, walks SKILL.md container paths, and shows the discovered skills as a multi-select picker (none pre-checked).
    5. User picks one or more skills, chooses a scope (Project or Global), and clicks Install.
    6. Skills are copied into the chosen scope's directory; `skills-lock.json` is updated.
  - **Outcome:** Selected skills are installed and visible in the Installed list.
  - **Covered by:** R1, R3, R4, R5, R7, R10, R12

- F2. **Install from URL**
  - **Trigger:** User clicks "Add from URL" and pastes a source.
  - **Actors:** A1, A3, A4
  - **Steps:**
    1. User pastes a source string (GitHub shorthand, full URL, git URL, or local path) and submits.
    2. The page resolves the source, walks SKILL.md container paths, and shows the multi-select picker.
    3. User picks skills, chooses scope, clicks Install.
    4. Skills are copied; `skills-lock.json` is updated.
  - **Outcome:** Skills installed and visible.
  - **Covered by:** R2, R4, R5, R7, R10, R12

- F3. **Remove an installed skill**
  - **Trigger:** User clicks Remove on an installed skill.
  - **Actors:** A1, A4
  - **Steps:**
    1. User confirms removal.
    2. The page deletes the skill directory from the scope's path and updates `skills-lock.json`.
  - **Outcome:** Skill files gone; entry removed from Installed list.
  - **Covered by:** R10, R12

- F4. **Update an installed skill**
  - **Trigger:** User clicks Update on an installed skill.
  - **Actors:** A1, A3, A4
  - **Steps:**
    1. The page re-fetches the source repo's latest state on its default branch.
    2. The page walks SKILL.md container paths and re-installs the matching skill, replacing local files.
    3. `skills-lock.json` entry is refreshed with the new commit hash.
  - **Outcome:** Skill files reflect latest upstream commit.
  - **Covered by:** R10, R11, R12

- F5. **Update all installed skills**
  - **Trigger:** User clicks "Update all" on the Installed list.
  - **Actors:** A1, A3, A4
  - **Steps:** Same as F4, repeated for every installed skill.
  - **Outcome:** All installed skills reflect latest upstream.
  - **Covered by:** R11

---

## Requirements

**Page and entry point**
- R1. A top-level Skills page is accessible from a new toolbar button placed alongside the existing Plugins button.
- R2. The Skills page provides a URL/source input that accepts GitHub shorthand (`owner/repo`), full GitHub URLs, GitHub tree URLs that point at a specific skill, git URLs (`git@host:owner/repo.git` or `https://host/owner/repo.git`), GitLab URLs, and local filesystem paths.

**Search**
- R3. The Skills page provides a keyword search input that queries skills.sh via the vendored `findSkills` function and renders matching skills as result cards with name, description, and source repo.

**Install flow**
- R4. After resolving a source (via URL input or by clicking Install on a search result), the page walks the source's known SKILL.md container paths and shows every discovered skill as a multi-select picker, with no skill pre-checked.
- R5. The install modal presents a scope picker with two options: Project (`<workspace>/.claude/skills/`) and Global (`~/.claude/skills/`). No option is pre-selected; the Install button is disabled until the user selects one.
- R6. The only supported install method in v1 is copy. Symlinks are not exposed.
- R7. When the user has selected one or more skills and a scope and clicks Install, the modal transitions to an Installing state (spinner, disabled inputs). On success, it shows a success summary and closes. On failure (network error, disk write error, missing SKILL.md, invalid frontmatter), the modal shows the failure reason and offers Retry and Cancel; Cancel leaves no partial install state.
- R8. If a skill being installed is already present in the chosen scope, the install modal shows an "Already installed" notice and replaces the Install action with Reinstall (overwrite) and Cancel.

**Manage installed**
- R9. The Installed list shows every skill tracked in `skills-lock.json` for the current workspace's project scope plus the user's global scope, with badges distinguishing scope.
- R10. Each installed skill entry exposes a Remove action (with confirmation) and an Update action that re-fetches the source and re-installs.
- R11. The Installed list exposes an "Update all" action that runs the update flow for every installed skill.

**Source of truth**
- R12. Installed skills are recorded in `skills-lock.json` (project scope: `<workspace>/skills-lock.json`; global scope: the path the vendored code uses) in the same format vercel-labs/skills produces. Comate reads existing entries on page load so skills installed via the upstream CLI appear in the Installed list.

**Vendored source**
- R13. Comate vendors a minimal subset of vercel-labs/skills source from the GitHub repo (not the bundled npm package, which ships no importable functions), exposing TS functions for URL parsing, source resolution, SKILL.md discovery, copy-install, lock-file read/write, and `findSkills` queries.
- R14. Telemetry hooks in the vendored source are stripped or disabled; no calls to `add-skill.vercel.sh` originate from Comate.
- R15. The vendored source carries MIT license attribution in the existing `LICENSES/` directory.

---

## Acceptance Examples

- AE1. **Covers R2, R4, R5, R7.** Given a user on the Skills page, when they paste `vercel-labs/agent-skills` into the URL input and submit, then the page resolves the repo, shows discovered skills as unchecked checkboxes (web-design-guidelines, vercel-react-best-practices, vercel-react-view-transitions), and disables Install until the user picks at least one skill and a scope.
- AE2. **Covers R7.** Given a user in the Installing state for `web-design-guidelines` to Project scope, when the network connection drops mid-fetch, then the modal shows "Failed to download: network error" with Retry and Cancel. Clicking Cancel leaves `.claude/skills/` untouched and `skills-lock.json` unchanged.
- AE3. **Covers R8.** Given `web-design-guidelines` is already installed in Project scope, when the user re-pastes `vercel-labs/agent-skills`, selects `web-design-guidelines`, and selects Project scope, then the modal shows "Already installed" with Reinstall and Cancel instead of Install.
- AE4. **Covers R9, R10, R12.** Given the workspace has an existing `skills-lock.json` from prior CLI use with `vercel-react-best-practices` at project scope, when the user opens the Skills page, then that skill appears in the Installed list with a "Project" scope badge, and its Remove and Update actions are active.
- AE5. **Covers R3.** Given a user typing "typescript" into the search input, when results return from skills.sh, then the page renders result cards with name, description, and source repo for each match.
- AE6. **Covers R6.** Given any install in progress, when files are written to `.claude/skills/<name>/`, then they are real file copies, not symlinks.

---

## Success Criteria

- Users can discover, install, list, remove, and update individual SKILL.md bundles from inside Comate without dropping to a terminal.
- Skills installed via the Skills page are visible and usable by Claude Code sessions in the same workspace (and via CLI for global-scope installs).
- The Skills page and the Plugin Manager operate independently — installing a skill via one does not require or affect the other.
- Vendored source stays minimal (no telemetry, no interactive-prompt deps, no 70+ agent detection) and is small enough that future upstream syncs are tractable.
- A downstream planner can implement this doc without inventing user-facing behavior, scope boundaries, or the vendoring boundary.

---

## Scope Boundaries

- Multi-agent targeting (Cursor, Codex, etc.) — Claude Code paths only in v1.
- Symlink as an install method — copy only in v1.
- Browse or scroll the entire skills.sh catalog (full directory view) — keyword search only.
- Cross-visibility between Skills page and Plugin Manager Installed list — each surface shows only its own entries.
- Skills carrying Claude Code plugin manifests (`.claude-plugin/marketplace.json` with skill entries) — those are plugins and stay in the Plugin Manager.
- Per-skill version pinning to a tag or branch — installs always track latest commit on default branch.
- A "Run `skills use`" prompt generator (use-without-installing) — out of scope; users get install/manage only.
- Pushing fixes upstream to vercel-labs/skills — Comate maintains a private vendored copy.
- File-collision detection between Skills-page installs and Plugin-Manager installs in the same `.claude/skills/` directory — v1 ships without it.

---

## Key Decisions

- **Top-level page, not a workspace-settings tab:** Sibling to Plugins, opened from the toolbar. Matches the Plugin Manager's access pattern and signals that skills are a first-class concept, not a settings sub-screen.
- **Vendor source, not shell out:** Calling TS functions directly gives Comate a real API and avoids a runtime npm/npx dependency. The cost is owning spec-compatibility sync; we accept that for v1 because the integration surface is small and the spec moves slowly.
- **Vendoring subset, not whole tree:** Strip telemetry, drop `@clack/prompts`, drop the 70+ agent detection. Keep only: URL parsing, source resolution, SKILL.md container-path discovery, copy-install, `findSkills`/skills.sh client, `skills-lock.json` read/write. Reduces carrying cost and avoids shipping code paths Comate never exercises.
- **Copy, not symlink:** Symlinks break when the cache moves, behave oddly on Windows, and surprise users who track their workspace in Git. Copy trades disk space for predictability.
- **Fully separate from Plugin Manager:** No shared Installed list, no cross-references. Each surface manages its own data (`skills-lock.json` vs `~/.claude/settings.json` + plugin cache). Accepts that both can write into the same physical `.claude/skills/` directory; v1 ships without de-dup detection.
- **Update via commit hash, not semver:** `skills-lock.json` records the upstream commit at install time. "Update" means re-fetch the source's latest commit and re-install. No version-comparison logic.
- **Search via skills.sh:** No Comate-hosted registry. The vendored `findSkills` queries skills.sh directly. Locks us to its API contract; mitigated by the `SKILLS_API_URL` env var that upstream already supports.

---

## Dependencies / Assumptions

- The vendored vercel-labs/skills source is cloned from GitHub at a pinned commit; future updates require manual sync.
- skills.sh is publicly reachable from the user's machine; no auth required for keyword search.
- The workspace's filesystem path is accessible to the Express sidecar for reading/writing `<workspace>/skills-lock.json` and `<workspace>/.claude/skills/`.
- The user's home directory is accessible for reading/writing `~/.claude/skills/` and the global-scope lock file.
- The `SKILL.md` discovery rules in vercel-labs/skills (known container paths, depth limits, plugin-manifest discovery) remain stable enough to vendor.
- The Express sidecar already bundles a Node runtime capable of executing the vendored TS.
- The existing `skills-lock.json` at the repo root is the canonical project-scope lock file in the format upstream produces.

---

## Outstanding Questions

### Resolve Before Planning

_Resolved during brainstorm:_
- ~~Where does the Skills surface live?~~ → Top-level page, sibling to Plugins.
- ~~What's the install flow for multi-skill sources?~~ → Multi-select picker, none pre-checked.
- ~~How does the Skills surface relate to the Plugin Manager?~~ → Fully separate.
- ~~How does Comate integrate with vercel-labs/skills?~~ → Vendor the source (npm package has no importable API).
- ~~What's the discovery model?~~ → Keyword search via skills.sh, plus paste-URL.

### Deferred to Planning

- [Affects R1][Technical] The existing workspace-settings Skills tab (currently a "coming soon" placeholder per `docs/brainstorms/2026-05-28-placeholder-for-skills-mcp-hooks-requirements.md`) — should it be removed, redirected to the new top-level page, or kept as a separate surface?
- [Affects R13][Technical] Which exact modules from `vercel-labs/skills/src/` does Comate need to copy, and how do they compile once detached from the upstream build? Requires cloning the repo and inspecting `src/` structure.
- [Affects R12][Technical] Where does the vendored code write the global-scope lock file (`~/.skills-lock.json` vs other)? Verify by reading upstream source.
- [Affects R3][Technical] Does `findSkills` support a non-interactive call that returns structured results, or does it print to stdout and require parsing? Need to verify the function signature in source.
- [Affects R7][Technical] Should the install endpoint stream progress events to the frontend for real-time modal updates, or is a simple spinner sufficient?
- [Affects R10][Technical] When the user clicks Update, should the page preserve any local edits the user made to an installed skill, or always overwrite cleanly from upstream?
- [Affects R13][Needs research] How frequently does vercel-labs/skills ship breaking changes to its source modules, and what is the lowest-effort sync workflow (subtree pull, patch re-application, etc.)?
- [Affects R14][Technical] Are there non-obvious telemetry hooks beyond `add-skill.vercel.sh` (e.g., env-var-based opt-ins, GitHub API referrer headers) that need stripping?
