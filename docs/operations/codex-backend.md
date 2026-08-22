# Codex Backend Operations

## Ownership model

Comate talks to the pinned Codex app-server instead of importing Codex session data into Comate. Codex remains the source of truth for login state, model catalog, configuration, threads, transcript history, and child-agent threads in its own `CODEX_HOME`. Comate persists the selected backend and Codex thread ID so the same thread can be resumed.

A session locks its backend when the first runtime starts. Changing the default agent affects only new sessions. Chat, bot, and scheduler entry points resolve the configured default agent exactly; an unhealthy selection returns an error and does not fall back to another agent.

## Enablement

Codex is available in development and test environments. Production builds require an explicit evaluation gate:

```sh
COMATE_ENABLE_EXPERIMENTAL_CODEX=1
```

The gate only enables selection. It does not remove the known capability gaps documented in the [acceptance matrix](../acceptance/agent-backend-parity-checklist.md#capability-matrix-codex-backend).

On startup, the health check resolves the bundled Codex executable and initializes the real app-server. A failed initialization leaves Codex unavailable.

## Native account and model

Use Settings to sign in through Codex and choose the default model. The model list comes from the active native Codex account. The preference is applied only when a new Codex thread is created; resumed threads retain their Codex-owned model. Signing out clears the saved preference.

Comate does not copy account credentials into its Provider records or session database.

## Enterprise Provider

To route one Codex session through an enterprise endpoint, explicitly assign a Provider whose protocol is `openai-responses`. It must include a base URL, model, and authentication token. Comate supplies that Provider to the app-server in memory for the selected thread and re-applies it when resuming.

Provider behavior is fail-closed:

- An Anthropic-protocol Provider cannot be used by Codex.
- Missing URL, model, or token returns a configuration error.
- A Provider marked as default for Claude does not implicitly override native Codex.
- Provider list/get/update responses never return the token; they expose only whether a token is present.
- Leaving the token blank during an edit retains the stored token.
- Provider secrets are redacted from surfaced Codex errors.

## MCP and skills boundary

Comate passes safe stdio MCP server command/argument definitions to Codex. It deliberately omits stdio environment maps and remote HTTP/SSE MCP definitions because those commonly contain bearer tokens or API keys that could otherwise enter Codex-owned configuration or thread metadata. Consequently, Comate's Authorization-bearing browser and scheduled-task MCP servers are not available to Codex.

Workspace and global `.claude/skills` directories are exposed through Codex skill roots. Skill discovery works, but Claude Code slash-command syntax is not translated.

## Recovery guide

| Symptom | Check | Recovery |
|---|---|---|
| Codex is unavailable in production | Production gate | Set `COMATE_ENABLE_EXPERIMENTAL_CODEX=1` only for an approved evaluation and restart Comate |
| App-server initialization fails | Bundled executable and startup logs | Run `npm run verify:codex-app-server`; repair the pinned Codex installation or configuration before retrying |
| Native model list or send fails | Codex account state | Sign in again from Settings, then reselect the model for future threads |
| Enterprise session is rejected | Provider protocol and required fields | Select `openai-responses` and provide URL, model, and token; do not switch to native silently |
| A saved session cannot resume | Codex thread still exists in the same `CODEX_HOME` | Restore the original Codex home/thread data or start a new session; Comate has no private transcript copy |
| Browser or remote MCP tools are missing | Credential boundary | This is expected for Codex until a non-persisting credential handoff exists; use another selected backend if the task requires those tools |
| Pending approval/question disappeared after restart | Reconnect limitation | Retry the turn in a new interaction; pending-interaction recovery is not yet implemented |

## Verification

Before changing the pinned Codex version or releasing an evaluation build, run:

```sh
npm run test:codex-protocol
npm run verify:codex-app-server
npm run lint
npm run typecheck
npm run test:server
npm run test:client
npm run test:electron
npm run test:scripts
npm run test:packages
```

Treat a protocol drift failure as a compatibility change requiring regenerated types, adapter review, and app-server smoke validation—not as a snapshot-only update.
