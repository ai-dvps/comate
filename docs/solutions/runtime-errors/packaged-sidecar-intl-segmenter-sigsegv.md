---
title: Packaged sidecar SIGSEGV from Intl.Segmenter inside cli-truncate when naming New Chat sessions
date: 2026-08-16
category: runtime-errors
module: sidecar-packaging
problem_type: runtime_error
component: tooling
symptoms:
  - Sending the first prompt from the New Chat flow killed the packaged Express sidecar with SIGSEGV, taking down the entire backend
  - Creating a session with a manually typed title worked fine; only the prompt-derived fallback title path crashed
  - Crash only occurred in the @yao-pkg/pkg packaged binary; the same code ran fine under a system Node
  - The prior smoke test for the packaged binary passed because its short English prompt hit string-width's ASCII fast path and never invoked Intl.Segmenter
root_cause: wrong_api
resolution_type: code_fix
severity: critical
related_components: [testing_framework, development_workflow]
tags: [packaged-sidecar, intl-segmenter, sigsegv, cli-truncate, yao-pkg, session-title, new-chat, smoke-test]
---

# Packaged sidecar SIGSEGV from Intl.Segmenter inside cli-truncate when naming New Chat sessions

## Problem

Comate's desktop app is an Electron shell driving an Express sidecar that is packaged into a single binary with @yao-pkg/pkg. The New Chat flow — pick a workspace, type a prompt, send — crashed the entire sidecar process with SIGSEGV, taking the whole backend down. Creating a session by typing a title manually never crashed, which made the trigger path narrow and reproducible but invisible to JS-level debugging: no stack trace, no server log line, just a dead process.

The root cause was a native crash inside `Intl.Segmenter.prototype.segment()` in the packaged Node runtime. The crash was reached only through the session-title derivation path: New Chat sends `prompt` without `name`, so `src/server/routes/chat.ts:72` takes the fallback branch:

```ts
name: hasName ? name.trim() : deriveFallbackSessionTitle(prompt as string),
```

`deriveFallbackSessionTitle` ends by truncating the derived title to 48 display columns (`TITLE_COLUMNS = 48`, `src/server/utils/session-title.ts:5`). Before this fix, that truncation went through `cli-truncate@5.2.0`, whose transitive dependencies `string-width@8.2.2` and `slice-ansi@8.0.0` construct `new Intl.Segmenter()` and call `segmenter.segment(...)` for any input that is not short printable ASCII. In the @yao-pkg/pkg bundled Node runtime, `Intl.Segmenter.prototype.segment()` segfaults for every granularity — verified directly against the packaged binary on both node22 and node24 darwin-arm64 builds (exit 139). The removed cli-truncate@5.2.0 chain is no longer present in `node_modules`; this is historical context for how the crash was reached, not live code.

## Symptoms

- Electron `main.log` showed `Sidecar terminated: code=null signal=SIGSEGV`, followed by `Fatal: The Comate backend stopped unexpectedly`, followed by a stream of `Tray status fetch failed: fetch failed` as the UI kept polling a dead backend.
- The macOS crash report (`~/Library/Logs/DiagnosticReports/*.ips`) showed `EXC_BAD_ACCESS (KERN_INVALID_ADDRESS at 0x0)` on the main thread — a vtable call on a null object. Under lldb the faulting instruction was `ldr x8, [x0]` with `x0 = 0`.
- There was no JS stack and no line in the server log: a native fault bypasses all JS-level error handling, including the route's `try/catch`.
- The failure was input-dependent, not flow-dependent: the same endpoint succeeded for some prompts and killed the process for others.

## What Didn't Work

**Commit 5d5b0889 (main) — the prior partial fix from earlier the same day.** That commit removed the *direct* `Intl.Segmenter` usage in `firstSentence()` and rewrote the surrounding logic in pure JS, and it added a packaged-binary smoke test. It failed for two independent reasons:

1. **It left `cli-truncate` in the dependency tree.** Removing the direct call did not matter because the transitive closure reintroduced the same native API: `cli-truncate@5.2.0` → `string-width@8.2.2` (Segmenter at module top level, `segment()` called for non-printable-ASCII input) and `slice-ansi@8.0.0` (Segmenter with `granularity: 'grapheme'` when truncation actually slices). The direct import of `cliTruncate` pulled both carriers straight back into the server bundle. (session history) The prior session's "no remaining risk" check was a grep for `Intl.` over first-party server/electron source only — it never audited node_modules, which is exactly where the residual crash vector lived.
2. **Its smoke test input could not reach either Segmenter call site.** The single test case used the prompt `'First sentence. Second sentence.'`, which derives the title `'First sentence'` — pure printable ASCII and well under 48 columns. `string-width@8` has a fast path (`/^[ -~]*$/` → return `length`) that never constructs the segmenter for such input, and no truncation occurred, so `slice-ansi`'s segmenter path never executed either. The test went green while the packaged binary still crashed for Chinese prompts and for long prompts.

Other dead ends during diagnosis: wrapping the derivation in `try/catch` did nothing (a native SIGSEGV is not a JS exception), and the existing logs gave no location because the process died before it could write anything.

(session history) An even earlier attempt, commit e08ff164 ("pin packaged runtime to Node 22"), was an ABI-mismatch theory and ineffective: isolated pkg reproductions proved node22 runtimes segfault on `.segment()` just like node24. That session also established the precise crash boundary — constructing `new Intl.Segmenter(...)` is safe; only calling `.segment()` faults — and that `Intl.Segmenter` entered the codebase in d141ca89, the same commit that added the New Chat flow, so the feature and the crash were born together.

## Solution

Two coordinated changes:

**1. Replace the truncation chain with pure-JS helpers.** `src/server/utils/session-title.ts` now implements `displayWidth`, `sliceByColumns`, and `truncateTitle` (~40 lines) on `get-east-asian-width@1.6.0` — pure JS lookup tables with no `Intl.Segmenter` anywhere in the chain. The dependency swap is visible in `package.json`: `get-east-asian-width: ^1.6.0` added (package.json:109), `cli-truncate` removed as a first-party dependency, and the `cli-truncate@5.2.0` → `string-width@8` / `slice-ansi@8` chain is gone from `node_modules` (an unrelated nested `cli-truncate@2.1.0` with `string-width@4` survives under `iconv-corefoundation` — it contains no `Intl.Segmenter` usage, and a grep over all remaining string-width/slice-ansi copies in `node_modules` finds no Segmenter reference). The file's own header comment (`src/server/utils/session-title.ts:9-13`) documents the constraint:

```ts
// The packaged (@yao-pkg/pkg) Node runtime segfaults inside
// Intl.Segmenter.prototype.segment() for every granularity, so title
// truncation must not pull in grapheme-segmenting width helpers
// (string-width@8 / slice-ansi@8, both reached via cli-truncate). These
// helpers keep the same display-width contract with pure JS lookups.
function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    width += eastAsianWidth(character.codePointAt(0) ?? 0, { ambiguousAsWide: false });
  }
  return width;
}
```

`truncateTitle` (`src/server/utils/session-title.ts:37-46`) mirrors cli-truncate's `position: 'end'` + `preferTruncationOnSpace` behavior — cut within the column budget, step back to a nearby space when one sits within a few columns of the cut, then append `…` — so the user-facing contract is unchanged:

```ts
function truncateTitle(text: string, columns: number): string {
  if (columns < 1) return '';
  if (displayWidth(text) <= columns) return text;
  let head = sliceByColumns(text, columns - 1);
  const lastSpace = head.lastIndexOf(' ');
  if (lastSpace > 0 && displayWidth(head) - displayWidth(head.slice(0, lastSpace)) <= 3) {
    head = head.slice(0, lastSpace);
  }
  return `${head}${TRUNCATION_ELLIPSIS}`;
}
```

**2. Expand the packaged-binary smoke test to cover the input shapes that reach the crash.** `scripts/sidecar-new-chat-smoke.test.ts` grew from the single English case to four cases, each spawning the real packaged sidecar binary and POSTing a prompt-only session:

```ts
const cases: Array<{ prompt: string; expected: string }> = [
  { prompt: 'First sentence. Second sentence.', expected: 'First sentence' },
  { prompt: '今天星期几', expected: '今天星期几' },
  { prompt: '修复登录后的重定向循环。请检查路由守卫。', expected: '修复登录后的重定向循环' },
];
// plus a >48-column prompt:
const longPrompt = `New Chat ${'title-'.repeat(30)} truncation check`;
// ...asserts the derived name ends with '…'
```

The three exact-match cases cover English sentence extraction, short non-ASCII (the shape that hit `string-width@8`'s Segmenter path), and CJK sentence-boundary extraction; the fourth forces real truncation (the shape that hit `slice-ansi@8`'s Segmenter path). The test's own comment states the invariant: an English sentence alone slips past both (ASCII fast path, no truncation), which is how the packaged crash shipped once already. The smoke test runs as a gate inside `npm run build:sidecar` — `package.json:25` is `"build:sidecar": "tsx scripts/build-sidecar.ts && npm run test:sidecar-new-chat"` — so no packaged binary can ship without passing it.

## Why This Works

The fix removes the crash surface rather than defending against it. `get-east-asian-width` computes East Asian display width from static lookup tables — there is no ICU, no `Intl` object, and no native boundary in the call chain, so the packaged runtime's broken `Intl.Segmenter` is simply never executed on this path. Because `truncateTitle` reproduces cli-truncate's end-truncation-with-space-preference contract, the behavior change is invisible to users.

The fix was validated against the real packaged binary, not just unit tests, because the bug only exists in the packaged runtime. Bisection evidence gathered against a freshly built sidecar (one fresh process per case) mapped the input classes precisely: `'hello world'` → 201 OK; `'今天星期几'` → SIGSEGV; `'a'` × 200 → SIGSEGV (the slice-ansi truncation path); `'fix the bug 修复崩溃'` → SIGSEGV; and a CJK *workspace name* on a route with no title derivation → OK, proving the trigger was the derivation path, not CJK text in general. SQLite evidence bounded the crash location: no session row existed for the crash timestamp, so the process died before the INSERT — isolating the fault to title derivation. After the fix, all 4 smoke cases pass against the rebuilt packaged binary, session-title unit tests pass 15/15, and chat route tests pass 22/22.

## Prevention

1. **Never use `Intl.Segmenter` — directly or transitively — in code shipped inside a @yao-pkg/pkg binary.** Its bundled ICU segfaults in `segment()` for every granularity (constructing the segmenter is safe; only `.segment()` faults). When adding text-measurement or string-truncation helpers to the server bundle, grep the dependency closure for the known carriers: `string-width@8+` and `slice-ansi@8+` (both reached via `cli-truncate`). The guard belongs at dependency-review time, because the crash only manifests in the packaged artifact.
2. **`try/catch` around such an API is cosmetic.** A native SIGSEGV bypasses JS exception handling entirely — the pre-fix code already had a `try/catch` (the route handler's own, `src/server/routes/chat.ts:80-83`) that never fired. If a defensive `try/catch` is the only thing standing between you and a native crash, you have no defense.
3. **Removing a direct call is not enough; audit the transitive dependency closure.** Commit 5d5b0889 removed the direct `Intl.Segmenter` usage and the crash persisted because a single surviving `import cliTruncate` pulled `string-width@8` / `slice-ansi@8` back into the bundle. The unit of analysis is the whole chain from your import to the native API, not the line you deleted — and a grep over first-party source never sees node_modules (session history).
4. **Packaged-binary smoke tests must state the input shapes they cover, not just the endpoint.** ASCII-short inputs hit library fast paths that bypass the exact native API being guarded against. A meaningful smoke test for this class of bug must include at least: (a) non-ASCII text, (b) input long enough to force truncation, and (c) the ASCII baseline — each shape pinned to a different code path that could reintroduce the segmenter.
5. **Debugging a no-log native crash:** bisect input classes against the real packaged binary (not the dev runtime — the bug did not reproduce outside the package); read `~/Library/Logs/DiagnosticReports/*.ips` for the exception type and faulting address (`EXC_BAD_ACCESS` at `0x0` pointed at a null-object vtable call); run the binary under lldb to get the faulting instruction (`ldr x8, [x0]` with `x0=0`); and check the database to bound where in the request lifecycle the crash happened — no session row meant the crash occurred before the INSERT, which eliminated everything downstream of title derivation.

## Related Issues

- `docs/solutions/build-errors/cpsync-rewrites-relative-symlinks-dangling-tauri-resources.md` — same problem family: dependency trees behaving differently inside a packaged/bundled artifact than in dev node_modules.
- `docs/solutions/conventions/use-isolated-test-database-for-comate.md` — same component (the Electron-spawned packaged sidecar); useful context for how the sidecar is launched and env-configured in tests.
