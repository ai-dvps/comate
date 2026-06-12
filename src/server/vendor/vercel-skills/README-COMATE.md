# vercel-labs/skills — Vendored Copy (Comate)

> ⚠️ **Do not edit files in this directory.** It is a git subtree pulled from
> upstream. Edits will conflict with future syncs. Our adapter code in
> `src/server/services/skills/` is where Comate-specific behavior lives.

## What this is

A git-subtree mirror of `https://github.com/vercel-labs/skills`, copied into
Comate so the Skills page can call real TypeScript functions instead of
shelling out to `npx skills`. The npm package `skills` ships only a bundled
CLI `bin`, so the source has to be vendored to get a programmable API.

## Pinned version

| Field | Value |
|---|---|
| Upstream | https://github.com/vercel-labs/skills |
| Tag | v1.5.11 |
| SHA | `be0dd25` (HEAD of `main` when last synced) |
| License | MIT (see `/LICENSES/vercel-skills-MIT.txt`) |
| Synced on | 2026-06-12 |

## Vendored subset policy

The **entire upstream tree** is mirrored here for license and sync hygiene,
but Comate's adapter (`src/server/services/skills/`) imports only the curated
subset needed for the Skills page:

**Imported as-is** (pure modules with no `@clack/prompts`, `picocolors`,
`telemetry.ts`, `detect-agent.ts`, or `agents.ts` deps):

- `src/local-lock.ts` — project-scope lock file (version 1)
- `src/skills.ts` — SKILL.md container-path discovery
- `src/source-parser.ts` — URL/source parsing
- `src/frontmatter.ts`, `src/sanitize.ts`, `src/types.ts`, `src/constants.ts`
- `src/plugin-manifest.ts` — referenced transitively by skills.ts

**Reimplemented in the adapter** (NOT imported from upstream — they pull in
clack/prompts, picocolors, telemetry, agent-detection, or `simple-git`):

- `find.ts` → `services/skills/search.ts` (searchSkillsAPI, no telemetry)
- `installer.ts` → `services/skills/installer.ts` (hardcoded Claude Code paths)
- `skill-lock.ts` → `services/skills/skill-lock-adapter.ts` (strip picocolors,
  `execSync` GitHub tree SHA, `gh auth token`, and `blob.ts` dynamic import)
- `git.ts` → `services/skills/git-adapter.ts` (uses Comate's `spawn`-based
  `runGitClone`, NOT `simple-git` which is not a Comate dependency)

**Never imported** (carried in the tree but unreachable from the adapter):

- `agents.ts`, `detect-agent.ts`, `add.ts`, `cli.ts`, `init.ts`, `install.ts`,
  `sync.ts`, `list.ts`, `remove.ts`, `telemetry.ts`, `prompts/`, `providers/`
- `bin/`, `scripts/`, `tests/` — build/test infra, not needed at runtime

## How to sync

Future updates from upstream land via git subtree pull. Run from the repo root:

```bash
git subtree pull --prefix=src/server/vendor/vercel-skills \
  https://github.com/vercel-labs/skills.git main --squash
```

After the pull:

1. **Review every upstream commit that lands.** The `--squash` flag collapses
   them into one Comate commit; use
   `git log --oneline <old-sha>..<new-upstream-sha> -- src/server/vendor/vercel-skills/`
   to enumerate them. Look for:
   - Re-introduction of telemetry calls (`add-skill.vercel.sh`, `track(`)
   - New imports of `@clack/prompts`, `picocolors`, `simple-git`, `detect-agent.ts`
   - Breaking signature changes on any imported module (local-lock, skills,
     source-parser, frontmatter, sanitize)
2. **Re-run the adapter build-time check:**
   ```bash
   npm run build:sidecar
   grep -rE 'add-skill\.vercel\.sh|@clack/prompts|picocolors' dist/sidecar/
   ```
   The grep must return zero matches.
3. **Update the pinned SHA in this file** and in `/LICENSES/vercel-skills-MIT.txt`.

If `subtree pull` produces merge conflicts, it usually means our adapter
imports have drifted from upstream's signatures. Resolve by adjusting the
adapter, NOT by editing files under this directory.

## Why subtree (not submodule, not manual copy)

- **Subtree** — the upstream source is part of Comate's working tree, so the
  sidecar build can `import` from it without any submodule-init step.
  Syncing is one command.
- **Submodule** — rejected because it requires `git submodule update --init`
  on every clone and doubles the on-disk footprint.
- **Manual copy** — rejected because it loses upstream history and makes
  future syncs a diff-and-reapply chore.

## File ownership

- Files **inside this directory**: owned by upstream, never edited by Comate.
- Files in `src/server/services/skills/`: owned by Comate, may import from
  this directory's curated subset.
- Files in `src/server/utils/skills-lock.ts`: owned by Comate; reuses atomic
  write pattern from `claude-settings.ts` but is independent code.
