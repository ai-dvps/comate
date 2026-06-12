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
but Comate's adapter (`src/server/services/skills/`) imports **nothing** from
this directory at runtime. All needed functions are reimplemented in the
adapter, with this directory serving as a **spec reference only**.

**Why not import as-is?** Even pure upstream modules use `.ts` extension
imports (`'./types.ts'`) that require `allowImportingTsExtensions: true` —
incompatible with our tsc emit config. Adding that flag would break the
existing build, so the boundary is "vendor = spec reference, never import."

**Adapter reimplementations** (in `src/server/services/skills/`):

- `find.ts` → `search.ts` (`searchSkillsAPI`, no telemetry, no readline)
- `source-parser.ts` → `source-resolver.ts` (`parseSource` + path sandboxing)
- `local-lock.ts` + `skill-lock.ts` → `skill-lock-adapter.ts` (schema parse
  + path resolution; atomic write lives in `utils/skills-lock.ts`)
- `installer.ts` → `installer.ts` (`sanitizeName`, copy-only install,
  `lstat`-before-write to detect legacy symlinks)
- `skills.ts` → `skills-discovery.ts` (SKILL.md container-path discovery)
- `frontmatter.ts` → `frontmatter.ts` (uses our root-level `yaml` dep)
- `sanitize.ts` → `sanitize.ts` (verbatim port)
- `git.ts` → `git-adapter.ts` (uses Comate's `spawn`-based pattern from
  `utils/plugin-downloader.ts`, NOT `simple-git`)
- `agents.ts` + `detect-agent.ts` → `claude-code-paths.ts` (hardcoded
  `.claude/skills/` and `~/.claude/skills/` — drops 70+ agent definitions)
- `types.ts` → `types.ts` (Comate-owned type definitions)

**Never reached** (carried in the tree but unreachable from the adapter):

- `add.ts`, `cli.ts`, `init.ts`, `install.ts`, `sync.ts`, `list.ts`,
  `remove.ts`, `use.ts`, `telemetry.ts`, `prompts/`, `providers/`
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
   grep -rE 'add-skill\.vercel\.sh|@clack/prompts|picocolors|simple-git' dist/sidecar/
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
