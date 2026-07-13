---
title: Windows analytics empty — transcript path encoding must match the Claude Agent SDK byte-for-byte
date: 2026-07-13
category: integration-issues
problem_type: bug
component: analytics
module: analytics-transcript-path
severity: high
tags:
  - windows
  - claude-agent-sdk
  - analytics
  - path-encoding
  - sdk-parity
---

## Context

`GET /api/analytics/global` returned all zeros on Windows
(`totalSessions: 0, totalMessages: 0, totalTokens: 0, costCoveragePercent: 100`)
even though the user had plenty of Claude Code sessions. This was the **second**
fix attempt for the same symptom: an earlier fix had added only the Windows
drive-letter colon to the encoding, which was necessary but not sufficient.

Comate locates session transcripts on disk at
`<config>/projects/<encoded-cwd>/<sessionId>.jsonl` and must therefore
reproduce the Claude Agent SDK's directory-name encoding exactly. The SDK's
pipeline (verified against the bundled
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, functions `Fz`/`jn`,
`Fo`, `gv`/`$9`, `Xt`, constant `Ss=200`) is:

1. `path.resolve(dir)` — strip trailing separators, resolve relatives
2. `realpathSync(...)` with fallback to the raw path when it fails
3. NFC normalize on darwin only
4. replace EVERY `[^a-zA-Z0-9]` character with `-` (not just separators)
5. if the encoded name exceeds 200 chars: truncate to 200 and append
   `-${Math.abs(javaHash(preEncodingPath)).toString(36)}` where the hash is
   Java's `h = 31*h + c` (`(h<<5)-h+c | 0`)
6. config dir = `(CLAUDE_CONFIG_DIR ?? ~/.claude).normalize("NFC")` — the NFC
   normalization applies on ALL platforms

## Root Cause

Comate's `encodeProjectDir` replaced only `/`, `\`, and `:`. Windows paths
routinely contain other non-alphanumerics the SDK also turns into `-`: dots in
user names (`john.doe`), spaces, underscores, and CJK profile names
(`C:\Users\张三`). The encoded directory comate looked for therefore never
existed, `statTranscript` reported not-exists, and every session was silently
skipped (`analytics-service.ts` `refreshWorkspace` skips missing transcripts by
design, so concurrent partial flushes retry later). The cache stayed empty and
the rollup returned a zeroed summary with the default
`costCoveragePercent: 100` — a "successful" empty response, not an error.

## Fix

- `src/server/services/analytics-transcript-path.ts`
  - `encodeProjectDir`: replace every `[^a-zA-Z0-9]` with `-`; truncate at 200
    chars with the SDK's base36 Java-hash suffix (`hashProjectPath`).
  - `resolveProjectPath`: `resolve` → `realpathSync` (fallback to raw) → NFC on
    darwin, applied before encoding (the SDK encodes the canonicalized path).
  - `resolveClaudeProjectsDir`: honor `CLAUDE_CONFIG_DIR` (empty string treated
    as unset — a deliberate, documented deviation from the SDK's `??`, since a
    cwd-relative `projects` root is meaningless for the server process), NFC
    normalize the result on all platforms.
- `analytics-service.ts` hoists the transcript-dir resolution out of the
  per-session loop; `workflow-loader.ts` passes the resolved dir into
  `loadWorkflowSubagents`.
- `src/server/test-utils/test-env.ts` deletes `CLAUDE_CONFIG_DIR` so a
  developer shell that exports it cannot hijack HOME-based test fixtures.

## Key Lessons

- **Encoding parity must be byte-for-byte, not "close enough".** The first fix
  patched the one divergence observed (drive colon) without diffing the full
  algorithm; dots/spaces/underscores/CJK were still divergent. When mirroring a
  third-party encoding, transcribe the complete algorithm from source and pin
  it with hardcoded test vectors (e.g. the base36 hash suffixes `feo44x` /
  `lekbxj` / `rkvsv5` in `analytics-transcript-path.test.ts`).
- **Silent skips hide encoding bugs.** A "successful" all-zero response with
  `costCoveragePercent: 100` was the only symptom. When a lookup miss is a
  normal, tolerated case (partial transcript flush), a systemic miss is
  indistinguishable from "no data" without an existence probe of the resolved
  directory itself.
- **Test fixtures that re-implement production logic drift.** Service tests
  that staged transcripts with an inline copy of the old encoding kept passing
  while production diverged; fixtures should call the production resolver
  (`resolveTranscriptDir`) instead.
- **Dev-shell env leaks break path-resolution tests.** An exported
  `CLAUDE_CONFIG_DIR` overrides HOME-based fixtures; `test-env.ts` now deletes
  it for every server test.

## Residual Risks / Follow-ups

- Parity targets minified SDK internals, not a public API. The dependency is
  pinned, but a future SDK upgrade could change the encoding; the hardcoded
  test vectors are the only drift alarm.
- For encoded names > 200 chars the SDK additionally prefix-scans sibling dirs
  for legacy hash tolerance (`Ot`); comate resolves only the exact computed
  dir.
- Sessions enumerated by the SDK for git worktrees of a workspace are not
  resolvable from the workspace's single transcript dir and are skipped
  (pre-existing, tracked separately).
