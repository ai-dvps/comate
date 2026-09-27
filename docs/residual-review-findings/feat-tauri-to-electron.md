# Known Residuals — feat/tauri-to-electron

Source review run: `/tmp/compound-engineering/ce-code-review/20260808-041220-1a833725/` (ce-code-review mode:agent, base f3cd867e, 9 reviewers + 15-finding validator wave + 2 CE agents). 12 validated findings were applied in `fix(review)` commit 008b2f1b; the pre-existing handoff-card hang was fixed separately per user decision. The items below were explicitly accepted as residuals (user chose not to fix on this branch).

## Accepted residuals (from code review)

1. **W1 — Agent screenshot/page liveness silently depends on panel layout state** (agent-native reviewer, confidence ~70). `electron/browser-view-manager.ts:176-179, 301-340`: rect reporting stops (→ `setVisible(false)`) when the user switches workspace/tab, closes the pane, or opens a modal; an unattached view has no compositor surface, so `snapshot({screenshot:true})` can return blank/stale/failed with no signal why, and hidden pages throttle rAF/timers mid-task. Suggested directions: keep an attached offscreen/default rect for agent-live sessions, or have snapshot query `GET /views/:id/state` and annotate the tool result ("panel currently hidden; screenshot unavailable"). Design call — deferred.

2. **W2 — Takeover/handback buttons live in degraded (non-shell) mode** (agent-native, ~55). `src/client/components/browser/BrowserStateBar.tsx:189-222`: under `COMATE_BROWSER_CDP_TARGET`/dev-web the panel shows "needs desktop", yet Take over still flips the state machine to `user_in_control`, suspending agent tools while the user stares at a placeholder. Suggested: gate the verbs on `isNativeBrowserView()` like the popout button, or add copy pointing at the external browser window.

3. **O1 — Asymmetric session_lost recovery messaging** (agent-native observation). The user's manual retry navigates back to `lastUrl`; the agent's implicit rebuild lands on `about:blank`, but the `browser_session_lost` resolution text doesn't say page state isn't restored. One-line copy fix when convenient.

## Advisory / residual risks carried from the review (not applied)

- Release CI signs bridge artifacts with unpinned network-fetched `@tauri-apps/cli@^2` while the updater private key is in env (security, anchor 50) — `.github/workflows/build.yml:246`. Consider pinning an exact CLI version.
- `Linux releaseReady` is unconditionally true in `electron-builder.config.ts:88-93`, contradicting the header contract "unsigned ⇒ no manifests" — by design (Linux has no signing credentials; the bridge key doubles as the release-run sentinel), but the comment/contract should be reconciled.
- SSE reconnect has no backoff/jitter (fixed 1s, loopback-cheap) and no replay — partially mitigated by the reconnect-reconciliation fix (#9); full replay remains open.
- `desktop-api.ts` `resolveApiInfoWithRetry` caches null permanently after ~10s while the sidecar ready deadline is 30s — a very slow first boot could wedge the renderer until reload.
- `build/nsis-include.nsh:123` runs `msiexec /x` WITH UI even under silent `/S` installs.
- `build.yml:201-203` nullglob: a missing dmg silently skips `stapler validate` (unlike the app-count guard).
- `scripts/test-shell-cdp.ts` derives the expected Chrome version from the binary under test (self-referential assertion).
- `lastShellError` is sticky until a successful spawn (`browser-service.ts`), so one transient cold-start failure can leave `/api/health/browser` red.
- `comate:get-api-info` resolves `token: apiToken ?? ''` — a ready line without desktopToken would cache an empty token.

## Pre-existing (present at base f3cd867e, not introduced by this branch)

- ~~Closing the browser during a handoff leaves the approval card hanging~~ — **FIXED** on this branch per user decision (`browser-control.ts` `browser_closed` subscription).
- `browser-mcp.test.ts` process does not exit after suites pass (real timer/handle left armed; reproduces at base).
- `TodoDetail.tsx:102` react-hooks/exhaustive-deps warning fails `npm run lint --max-warnings 0` at baseline.
- Orphaned sidecar after ungraceful shell death (acknowledged TODO at `electron/sidecar.ts:76-80`): the parent-PID watchdog / Windows Job Object from the plan's Risks section is still unimplemented — a relaunch can spawn a second sidecar sharing `COMATE_DATA_DIR`.
- The "allow insecure certs" app setting has no consumer in the native browser stack (was a Steel spawn flag) — needs a shell-side decision.

## Release-time hard gates (cannot run in CI-less local env; block the bridge release)

- **U6 two-OS bridge rehearsal** (docs/runbooks/bridge-rollback.md §1): macOS + Windows real install from 0.0.33 → update → data/login assertions → new-line self-update, incl. Windows UAC-refusal branch. Stop condition per plan if it fails.
- **U10 Linux smoke** (docs/runbooks/linux-smoke.md): clean Ubuntu VM AppImage install/launch/browser-tools/self-update, minimal-WM no-tray degradation, deb install.
- Signing credentials (Apple cert + App Store Connect API key, Azure Trusted Signing) must be present in CI secrets before the first signed tag build.
- `package.json` version must be bumped strictly above 0.0.33 before the bridge release tag (now CI-guarded, but the bump itself is a release action).
- First real tag drill: verify `latest-mac.yml` lists both arch assets, dual-manifest guard passes, and `builder-effective-config.yaml` contains `com.comate.app`.
- UsageLoginModal native-view hosting (occlusion exemption) has unit coverage but no shell e2e — recommend a manual QA pass or a test-electron-cdp scenario.
