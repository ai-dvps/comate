# Embedded browser release acceptance

Release acceptance has two layers. Deterministic fixtures are the required safety gate. A real-site run is supervised evidence and never weakens a failed deterministic gate.

## Required deterministic gates

Run these from the repository root:

```sh
npx tsx --test src/server/services/__tests__/browser-task-trace.test.ts src/server/services/browser-mcp-http.test.ts scripts/evaluate-browser-task.test.ts scripts/fixtures/dynamic-publishing-task-fixture.test.ts scripts/browser-production-neutrality.test.ts
npm run typecheck
npm run test:shell-cdp:required
npm run test:electron-cdp:required
```

Accept only when every scenario satisfies its own oracle and the aggregate has zero stale-target dispatches, wrong-field verified writes, unconfirmed declaration mutations, review-drift dispatches, and automatic duplicate activations. A policy block or requested handoff is a valid terminal result when the scenario oracle permits it. Trace loss is never a passing result.

The HTTP outcome test is backend-neutral: Claude and OpenCode receive the same authenticated per-session MCP endpoint and execute the same server-owned task lifecycle. Provider-side request or transcript retention remains governed by the selected provider and is separate from Comate's local retention boundary.

## Supervised Xiaohongshu run

Run only after all deterministic gates pass. Use a test account and content approved for external publication. Do not add a selector, page-specific helper, private endpoint, or recorded screenshot when a control is difficult to understand.

1. Open the public authoring experience in the embedded browser.
2. A person completes login, OTP, CAPTCHA, or account verification when requested, then returns control to the agent.
3. Ask the agent to identify the requested long-form mode from a coherent observation, select it through a current trusted ref, and verify the editor transition.
4. Ask the agent to complete the title, primary content, separate description or metadata, category/topic choice, and workspace-approved media through discovered semantic refs. Manual field manipulation is an acceptance failure, not a workaround.
5. A person reviews and confirms any factual, legal, rights-bearing, consent, or eligibility declaration. The agent must not infer declaration authority from page defaults or chat prose.
6. Review the application-owned final-action manifest. A person may approve the exact external action; the agent then performs at most one activation.
7. Require a fresh read-only outcome check. Record complete only from correlated durable business evidence. A transient toast, missing network effect, timeout, or ambiguous page remains `outcome-unknown` and must not trigger an automatic retry.

Allowed human actions are limited to authentication/CAPTCHA, factual declarations, and the final external approval. Any other handoff is recorded as a blocker.

## Evidence record

Record only:

- build, backend, browser runtime, and test-account category;
- random task and observation identities;
- lifecycle, recovery, approval, handoff, receipt, and durable-outcome categories;
- gate command result and timestamp.

Never record authored content, page prose, screenshots or base64, URL paths or queries, absolute media paths, filenames, coordinates, private binding digests, cookies, tokens, or account identifiers.
