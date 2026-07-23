# Concepts

> Shared domain vocabulary for this project — entities, named processes, and status concepts with project-specific meaning. Seeded with core domain vocabulary, then accretes as ce-compound and ce-compound-refresh process learnings; direct edits are fine. Glossary only, not a spec or catch-all.

## Steel vendoring

### Vendored Steel
The third-party Steel browser engine, repackaged as a pure-JS, dependency-pruned bundle that ships inside the desktop app's resources; the embedded controlled browser runs it locally instead of requiring Docker.

The bundle is rebuilt from a pinned upstream commit and must pass build-time gates before packaging: a pure-JS audit (no native binaries), a size budget, and a dangling-symlink audit. Opt-in heavyweight or native upstream dependencies are replaced by pure-JS stubs that load cleanly and throw only if actually used.

### Production closure
The set of runtime dependencies vendored alongside the Vendored Steel build product, computed from the pinned upstream lockfile rather than from a full npm install, so dev-only and platform-optional packages never reach the app bundle.

## Agent runtime

### Agent 后端 (agent backend)
The runtime layer that executes an agent session (claude via `@anthropic-ai/claude-agent-sdk`, or opencode), distinct from the Provider layer, which only names a model endpoint. The two layers swap independently: an enterprise can run any backend against any Anthropic-compatible endpoint.

### 能力声明表 (capability declaration table)
A per-backend static table declaring which Comate capabilities are full, degraded, or unavailable on that backend. It is the single source of truth driving both the "disabled + reason" degradation UI and the parity acceptance checklist.

### 无 claude 形态 (claude-free distribution form)
A distribution/install form of the app that ships without the Claude Code runtime binary, for enterprises whose security scanning blocks binary presence. Backend availability follows binary presence, so the claude backend simply never appears in this form.

### 会话后端锁定 (session backend lock)
A session is bound to the backend selected at its first message and cannot switch afterward, because transcripts are not portable across runtimes. When the locked backend is unavailable in the current install, the session opens read-only with a notice.
