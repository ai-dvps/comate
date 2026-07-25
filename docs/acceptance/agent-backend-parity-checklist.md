# Agent Backend Parity — Acceptance Checklist

Generated from the capability declaration table (`src/server/services/agent-backends.ts`) on 2026-07-23, branch `feat/pluggable-agent-backend`. Each capability carries an evidence level so the table cannot self-certify: **verified** = an executable conformance path has exercised it; **declared** = built but not yet exercised end-to-end.

## Capability matrix (opencode backend)

| Capability | State | Evidence | Conformance path |
|---|---|---|---|
| streaming | full | verified | Adapter E2E (`scripts/verify-opencode-adapter.ts`): text/thinking events streamed to result |
| toolRendering | full | verified | Adapter E2E: tool_use/tool_result events; `opencode-event-mapper.test.ts` |
| approvals | full | verified | Adapter E2E: permission.asked → core pending_approval → reply → file written; surface probes (`scripts/verify-opencode-surface.ts`) |
| askUserQuestion | full | verified | Surface probes: question.asked → /question/{id}/reply → session continues (+85 events) on the pinned 1.18.4 binary |
| todos | full | verified | `opencode-event-mapper.test.ts`: todo.updated → task_started/task_updated |
| sessionManagement | full | verified | backend_session_id persisted + reattach (Adapter E2E); fork/children covered by driver ops |
| modelSwitching | full | verified | Provider→opencode mapping exercised in every E2E run (Kimi endpoint); `setModel` on the query handle |
| browser | full | verified | `browser-mcp-http.test.ts`: auth, initialize, tools/list; GUI/bot injection assertions (`__tests__/browser-mcp.test.ts`) |
| slashCommands | full | verified | Driver command endpoint routing + `getSessionBackendCommands`; discovery route is backend-aware |
| subagents | full | verified | `opencode-transcript.test.ts`: history translation + task/child pairing |
| analytics | unavailable (declared) | verified | KTD-10: opencode sessions not counted in v1; noted in the analytics UI |
| hooks | unavailable (both backends) | verified | Ground truth: hook scripts have no consumer on either backend; execution is its own work item |

## Acceptance Examples status

| AE | Status | Proof |
|---|---|---|
| AE1 claude-free install | **artifact proof in-session; device walkthrough remaining** | `COMATE_BUNDLE_BACKENDS=opencode npx tsx scripts/build-sidecar.ts` (exit 0) — resources contain the opencode executable and NO claude binary; build assertion (isFile) fails if any claude binary slips in. Full install-and-run walkthrough on a target device is the remaining manual step. |
| AE2 legacy claude session read-only | logic verified; UI walkthrough remaining | `agent-backends` availability rules + U5 read-only banner/send gate implemented and unit-tested; artifact walkthrough on the claude-free build is manual. |
| AE3 draft select → lock | verified | U5 selector (draft pre-select, locked badge) + U2 persistence/lock at first runtime + guard tests (409 on change) |
| AE4 approval flow on opencode | verified | Adapter E2E: approval UI payload → approve once → tool executes → file written; "always" maps to opencode's persisted rules |
| AE5 question stepper on opencode | verified | Surface probes on the pinned binary: question.asked → reply → session continues; bridge mapping unit-tested |

## Distribution flavors

| Flavor | Command | Contents |
|---|---|---|
| default (dual backend) | `npm run release` | claude + opencode binaries |
| claude-free (enterprise) | `COMATE_BUNDLE_BACKENDS=opencode npm run release` | opencode only; build assertion fails if any claude binary slips in |

## Known declarations to revisit

- WeCom bot on opencode: out of scope for v1 (R14); isolation-gate equivalence is a separate evaluation.
- analytics parity path: adapter-provided session enumeration for analytics (KTD-10 follow-up).
- Hook execution engine: data-model exists on both backends; execution unwired everywhere.
