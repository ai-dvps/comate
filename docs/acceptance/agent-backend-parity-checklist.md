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
| imageInput | full on declared image-capable models | automated verified; live provider walkthrough remaining | Client normalization/admission suites; Claude native image-block tests; OpenCode `file` part and transcript fixture round trips; shared history renderer tests |
| subagents | full | verified | `opencode-transcript.test.ts`: history translation + task/child pairing |
| analytics | unavailable (declared) | verified | KTD-10: opencode sessions not counted in v1; noted in the analytics UI |
| hooks | unavailable (both backends) | verified | Ground truth: hook scripts have no consumer on either backend; execution is its own work item |

## Capability matrix (Codex backend)

This matrix covers the bundled `@openai/codex` 0.149.0 app-server integration added on 2026-08-22. Codex owns its account, configuration, threads, and transcript data under its own `CODEX_HOME`; Comate stores only the backend selection and Codex thread identifier needed to reconnect the UI.

| Capability | State | Evidence | Conformance path / boundary |
|---|---|---|---|
| streaming | full | verified | `codex-adapter.test.ts`, `codex-event-mapper.test.ts`: text, reasoning, result, error, and token-usage notifications map into the shared stream |
| toolRendering | degraded | verified | Command execution and file changes render through the shared tool surface; not every Codex item type has a dedicated Claude-equivalent renderer |
| approvals | degraded | verified | Command/file approval requests round-trip through `requestApproval`; Codex owns the approval policy, while reconnecting an already-pending request is not yet supported |
| askUserQuestion | degraded | verified | `tool/requestUserInput` maps into the shared question flow; reconnecting an already-pending question is not yet supported |
| imageInput | full | verified | Ordered local and data-URL image inputs map to native Codex user-input items in `codex-adapter.test.ts` |
| sessionManagement | degraded | verified | New/resumed threads and history reload use Codex `thread/start`, `thread/resume`, and `thread/read`; fork/delete/rename do not yet have full UI parity |
| subagents | degraded | verified | `codex-session-service.test.ts` and chat-service tests reconstruct child threads and histories; live child activity and per-child stop controls are limited |
| model selection | full for new sessions | verified | Native Account exposes model/effort/speed defaults; third-party Providers expose server-filtered model/effort and intentionally hide speed |
| third-party Provider routing | full for declared contract | packaged verified | Native Responses is direct; Chat Completions uses the authenticated production route/converter. `npm run build:sidecar` proves Unicode, reasoning, usage, cleanup, and credential redaction with the real app-server; route HTTP tests pin socket cancellation |
| skills | degraded | verified | Workspace/global `.claude/skills` roots are registered through `skills/extraRoots/set`; Claude slash-command invocation semantics are not emulated |
| MCP status | degraded | verified | Safe stdio MCP definitions and native `mcpServerStatus` are supported; remote bearer-token MCP definitions are intentionally excluded |
| context usage | full | verified | `thread/tokenUsage/updated` feeds the shared context meter with input, cached, output, reasoning, window, and model values |
| browser | unavailable | verified | Built-in browser MCP requires an Authorization-bearing remote server; credentials are not copied into Codex configuration or thread metadata |
| slashCommands | unavailable | verified | Codex skills are discoverable, but Claude slash-command syntax and execution routing are not equivalent |
| todos | unavailable | verified | Codex plan notifications are not yet projected into Comate's Claude task/todo UI |
| analytics | unavailable | verified | The persistent Analytics dashboard currently reads Claude JSONL only; live Codex context usage remains available |
| hooks | unavailable | verified | No cross-backend hook execution surface is wired for Codex |
| scheduledGoalWrap | unavailable | verified | Scheduled goals use the selected default backend, but Codex-specific wrap-up/tool parity is not implemented |

### Codex release gate

- Production selection is blocked unless `COMATE_ENABLE_EXPERIMENTAL_CODEX=1`; development and tests may exercise Codex directly.
- Enabling the flag is for controlled evaluation, not a declaration of Claude Code capability parity. The unavailable and degraded rows above remain release blockers for general availability.
- Backend selection is exact and session-locked. If the selected Codex backend, account, thread, or explicit enterprise Provider is unavailable, the operation fails visibly; it never falls back to Claude Code or OpenCode.
- Native Codex login and thread data remain Codex-owned. Third-party Providers may use direct Responses or the declared routed Chat subset; incompatible or incomplete Providers remain visible with a reason and fail closed.
- Provider API responses expose only `authTokenPresent`, never the stored token. Leaving the secret blank while editing retains the previous value.
- Protocol drift is checked by `npm run test:codex-protocol`; real app-server initialization is checked by `npm run verify:codex-app-server`.
- Packaged production routing is checked by `npm run build:sidecar`; a development-Node-only pass is not release evidence.

### Multi-protocol Provider acceptance

| Flow / example | Status | Automated proof |
|---|---|---|
| F1 / AE1 direct Responses | verified | resolver and ChatService tests prove no route lease is allocated |
| F2 / AE2 Kimi Chat route | packaged verified | packaged sidecar creates the Provider/session and drives real Codex through registry + converter; converter fixtures cover tools/history and malformed upstreams |
| F3 / AE3 one credential, per-Agent endpoints/models | verified | Provider migration/resolver/API/client suites |
| F4 / AE8 legacy upgrade | verified | storage migration reopen/idempotency and stable reference tests |
| F5 / AE5 incompatible selection | verified | resolver, session API, and accessible Provider selector tests assert no upstream request |
| AE4 OpenCode protocol isolation | verified | resolver and OpenCode adapter/runtime rebuild tests |
| AE6 effort filtering | verified | server validation and Provider selector tests; third-party speed hidden |
| AE7 preset ownership | verified | preset API and editable dirty-draft confirmation tests |
| AE9 safe route failure | packaged + unit verified | packaged cancellation/shutdown/redaction plus registry/HTTP malformed/error/capacity suites |

Provider deletion uses a count preflight and preserves dangling historical identity until explicit reassignment. Migration recovery and forward-only downgrade boundaries are documented in the operations runbook and covered by storage/API tests.

Operational setup and recovery details are in [`docs/operations/codex-backend.md`](../operations/codex-backend.md).

## Acceptance Examples status

| AE | Status | Proof |
|---|---|---|
| AE1 claude-free install | **artifact proof in-session; device walkthrough remaining** | `COMATE_BUNDLE_BACKENDS=opencode npx tsx scripts/build-sidecar.ts` (exit 0) — resources contain the opencode executable and NO claude binary; build assertion (isFile) fails if any claude binary slips in. Full install-and-run walkthrough on a target device is the remaining manual step. |
| AE2 legacy claude session read-only | logic verified; UI walkthrough remaining | `agent-backends` availability rules + U5 read-only banner/send gate implemented and unit-tested; artifact walkthrough on the claude-free build is manual. |
| AE3 draft select → lock | verified | U5 selector (draft pre-select, locked badge) + U2 persistence/lock at first runtime + guard tests (409 on change) |
| AE4 approval flow on opencode | verified | Adapter E2E: approval UI payload → approve once → tool executes → file written; "always" maps to opencode's persisted rules |
| AE5 question stepper on opencode | verified | Surface probes on the pinned binary: question.asked → reply → session continues; bridge mapping unit-tested |

## Prompt image input boundaries

- Supported input is PNG, JPEG, WebP, and GIF, with at most 10 images and 20 MiB of normalized base64 data per turn. Static images are proportionally constrained to 2000×2000 and targeted below 4.5 MiB of base64 data per image; GIF is passed through unchanged and must already fit. Raw inputs above 20 MiB or 40 megapixels are rejected before normalization.
- Image intake is enabled only for a declared image-capable backend/model profile. Unknown, custom, and known text-only models remain disabled with an explanation; there is no silent text or file-reference fallback.
- Comate owns image bytes only while a draft is unsent or awaiting admission. After admission, Claude Code or OpenCode owns the transcript copy used for reload and resume. Missing or compacted historical media renders as unavailable rather than being recovered from a private Comate archive.
- Automated tests verify composition, normalization, atomic rejection and restoration, Claude/OpenCode provider translation, transcript normalization, optimistic reconciliation, and history rendering. A credentialed live-provider send/reload walkthrough remains an explicit release check and is not self-certified by these fixtures.

### Prompt image acceptance status

| Scenario | Status | Automated proof |
|---|---|---|
| Paste, drop, chooser, reorder, remove, preview, and image-only composition | verified | `PromptInput.browser.test.tsx`; `PromptImageRail.test.tsx`; `image-input.test.ts` |
| Oversized static normalization and atomic invalid/oversized rejection | verified | client `image-input.test.ts`; server `image-input-validation.test.ts` |
| Claude Code receives ordered native image blocks | verified with SDK boundary fixtures | `chat-service.test.ts`; `session-runtime.test.ts`; `server.test.ts` |
| OpenCode receives ordered file parts and replays transcript images | verified with pinned 1.18.4 adapter fixtures | `opencode-adapter.test.ts`; `opencode-transcript.test.ts` |
| Failed admission restores the full draft; accepted turns release draft bytes | verified | `chat-store.test.ts`; WebSocket admission tests |
| Reloaded history is backend-owned and optimistic replay is idempotent | verified with transcript fixtures | normalizer, chat-store, adapter, and renderer suites |
| Unsupported or unknown model disables image intake with a reason | verified | image profile, backend-store, and PromptInput suites |

## Distribution flavors

| Flavor | Command | Contents |
|---|---|---|
| default (dual backend) | `npm run release` | claude + opencode binaries |
| claude-free (enterprise) | `COMATE_BUNDLE_BACKENDS=opencode npm run release` | opencode only; build assertion fails if any claude binary slips in |

## Known declarations to revisit

- WeCom bot on opencode: out of scope for v1 (R14); isolation-gate equivalence is a separate evaluation.
- analytics parity path: adapter-provided session enumeration for analytics (KTD-10 follow-up).
- Hook execution engine: data-model exists on both backends; execution unwired everywhere.
