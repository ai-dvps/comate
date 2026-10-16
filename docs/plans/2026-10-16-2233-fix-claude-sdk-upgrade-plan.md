---
title: Claude SDK Upgrade - Plan
type: fix
date: 2026-10-16
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Claude SDK Upgrade - Plan

## Goal Capsule

- Objective: Users can run Comate on the latest stable Claude runtime while approvals, tool results, and background-task completion remain reliable.
- Means: Upgrade the SDK and its version-matched native executable, then adapt the existing session boundary (KTD1–KTD4).
- Authority: The user authorized the first upgrade batch and related regression testing, followed by implementation in this session.
- Stop conditions: Do not declare compatibility if approvals bypass Comate policy, Stop leaves work running, or live and restored tool results disagree.
- Delivery: Implement and verify locally; publishing a release is outside this request.

## Product Contract

### Summary

Upgrade Comate from SDK 0.3.237 / CLI 2.1.237 to the latest stable pair verified at execution time (0.3.301 / 2.1.301 at planning time).
Preserve the current user-facing approval modes, whole-session Stop behavior, and existing cross-backend message contract.

### Problem Frame

Comate uses its bundled SDK executable rather than the system Claude installation.
Newer SDK releases changed default permission-mode selection and task-event delivery, while current result decoders read a legacy camelCase field even though the SDK declares `tool_use_result`.

### Requirements

**Runtime and permissions**

- R1. The installed SDK, lockfile platform packages, and staged Claude executable must agree on the upgraded version.
- R2. GUI, scheduled, and Bot Claude sessions must retain Comate-owned approval decisions regardless of upstream defaults or ambient settings.

**Results and activity**

- R3. Live and restored messages must preserve canonical SDK tool-result metadata and legacy adapter metadata through the existing Comate `toolUseResult` output contract.
- R4. Foreground results, subagent messages, background completion ordering, and Stop must preserve the authoritative Session Activity contract, including queued and late work.

**Verification**

- R5. Related approval, Bot sandbox, history, multi-backend, task-lifecycle, and packaging regressions must pass against the new SDK, with unavailable live-environment checks identified explicitly.

### Scope Boundaries

No plugin hot reload, MCP Apps UI, process prewarming, side questions, new scheduling system, or new task UI is included.
Do not enable foreground-only interrupt semantics or change the current serialized input policy.
Do not change the system Claude installation or application version.

## Planning Contract

### Key Technical Decisions

- KTD1. Upgrade the existing SDK dependency and platform optional dependencies together using npm; continue resolving the executable through `resolveSdkBinary()` and staging it through `scripts/build-sidecar.ts` (R1).
- KTD2. Explicitly use upstream `permissionMode: 'default'` for Comate Claude entry points so the existing callbacks retain ownership (R2). Upstream 0.3.286 now delegates omitted modes to Claude settings and can select auto mode on third-party providers.
- KTD3. Normalize `tool_use_result` at the SDK ingress, falling back to `toolUseResult` for legacy Comate adapters (R3). Canonical values win when both exist; do not rename the client contract or mechanically rewrite adapter output.
- KTD4. Keep `background_tasks_changed` authoritative and preserve the existing Stop fence (R4). Only top-level foreground responses may finish the foreground phase; a child response cannot make the parent idle. Adapt actual new SDK shapes discovered during implementation rather than adding speculative lifecycle machinery.
- KTD5. Prove behavioral changes with focused regressions before broad checks (R5). SDK source/binary parity probes must be updated only after reviewing the actual semantic change; do not weaken them merely to accept new minified output.

### Existing Evidence

- `src/server/services/chat-service.ts`: Claude options, Bot settings isolation, permissions, and runtime creation.
- `src/server/services/commands-service.ts`: separate Claude initialization entry point.
- `src/server/services/sse-emitter.ts`, `src/server/services/message-normalizer.ts`: live/history tool-result decoding.
- `src/server/services/session-runtime.ts`: foreground ownership, background snapshots, Stop fencing, and idle eligibility.
- `docs/plans/2026-07-30-003-fix-claude-sdk-session-activity-plan.md`: established whole-session Stop and Session Activity behavior.
- `docs/solutions/conventions/use-isolated-test-database-for-comate.md`: test database isolation is mandatory.
- `docs/solutions/integration-issues/sdk-sandbox-loopback-requires-proxy-egress.md`: Bot sandbox/loopback tests must preserve proxy-based egress.
- Official SDK releases: [0.3.301](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.301), [0.3.286](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.286), [0.3.292](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.292), [0.3.275](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.275).

## Implementation Units

### U1. Upgrade the matched runtime

**Goal:** Deliver R1.
**Dependencies:** None.
**Files:** `package.json`, `package-lock.json`, `scripts/build-sidecar.ts` if staging compatibility requires it, `src/server/services/sdk-parity.test.ts`.
**Approach:** Apply KTD1 and review the installed API/type changes before updating parity assertions.
**Test scenarios:** The installed SDK metadata and native `--version` identify the same CLI; platform package versions match the lockfile; the sidecar build stages that executable.
**Verification:** Dependency inspection, SDK parity tests, typecheck, and staged executable smoke check succeed.

### U2. Preserve approval ownership

**Goal:** Deliver R2.
**Dependencies:** U1.
**Files:** `src/server/services/chat-service.ts`, `src/server/services/commands-service.ts`, their co-located tests, and SDK permission contract tests as needed.
**Approach:** Apply KTD2 at the Claude option boundaries and exercise manual, readonly, auto, scheduled, and isolated Bot paths through existing policy.
**Test scenarios:** A configured upstream auto default cannot replace Comate's manual approval; Bot deny/ask rules and browser restrictions hold; scheduled approval behavior remains Comate-owned.
**Verification:** Chat, command, runtime approval, SDK rule, and Bot policy regressions pass.

### U3. Normalize tool-result metadata

**Goal:** Deliver R3.
**Dependencies:** U1.
**Files:** `src/server/services/sse-emitter.ts`, `src/server/services/message-normalizer.ts`, a small shared decoder if needed, and co-located tests.
**Approach:** Apply KTD3 for both realtime events and transcript restoration, retaining the current normalized event shape.
**Test scenarios:** Canonical and legacy fields preserve structured results; canonical wins when both are present; async subagents and workflows remain active after launch; ordinary/error results retain current behavior; Codex/OpenCode adapter results still normalize.
**Verification:** Live/history, workflow/subagent, and multi-backend mapper regressions pass.

### U4. Verify background lifecycle compatibility

**Goal:** Deliver R4.
**Dependencies:** U1, U3.
**Files:** `src/server/services/session-runtime.ts`, `src/server/services/session-runtime.test.ts`, related emitter tests.
**Approach:** Apply KTD4 using SDK-shaped event sequences and the existing runtime harness.
**Test scenarios:** Child results do not clear foreground ownership; foreground completion with background tasks remains active; completion events preceding an empty snapshot do not release activity early; reused task IDs and late task snapshots remain stoppable; Stop cancels queued work or closes the process; reconnect and stream failure preserve truthful activity.
**Verification:** New targeted regressions and the existing full Stop/activity suite pass.

### U5. Complete upgrade regression evidence

**Goal:** Deliver R5.
**Dependencies:** U1–U4.
**Files:** `CHANGELOG.md`, affected compatibility tests and build fixtures only when required by the SDK change.
**Approach:** Apply KTD5, record commands and their results in the implementation handoff, and remove abandoned experimental changes.
**Test scenarios:** SDK callbacks, sandbox/loopback, history, commands, multi-backend adapters, and sidecar build continue working on the upgraded pair.
**Verification:** Focused tests, `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build:sidecar` pass; staged `resources/claude --version` matches R1.

## Verification Contract

Run focused server tests with `tsx --test` after building `packages/comate-api-contracts`, including `sdk-parity`, `sdk-rule-contract`, `chat-service`, `commands-service`, `session-runtime`, `sse-emitter`, `message-normalizer`, subagent/workflow loaders, backend adapters/mappers, and sandbox/loopback contract tests.
Every server test must import `test-utils/test-env` first and use isolated data.
Then run the U5 repository checks and sidecar staging verification.
Runtime/API smoke tests must use isolated local fixtures when possible; do not send user prompts to a paid Provider merely to validate this upgrade.
Failures caused by the upgrade must be resolved; unrelated baseline failures must be named with concrete evidence.

## Definition of Done

R1–R5 are demonstrated by the recorded checks.
Existing Comate output contracts and backend capability boundaries remain compatible.
The user can inspect the complete local diff, plan, and verification results.
No abandoned probes, generated source noise, or unrelated dependency updates remain in the change set.
