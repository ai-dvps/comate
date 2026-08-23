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

## Native account and runtime defaults

Use Settings to sign in through Codex and choose the default model, reasoning effort, and speed for new Codex threads. The available values come from the active native Codex account's model catalog. Changing the model resets effort and speed to that model's defaults. Signing out clears all three saved preferences.

When Codex is the active Agent, the chat Provider selector shows the signed-in **Codex Account** as a native option alongside compatible third-party Providers. A session can override model, effort, and speed before its first turn. Those explicit session values remain attached to that session; Agent defaults are not reapplied when an existing Codex thread is resumed.

Comate does not copy account credentials into its Provider records or session database.

## Third-party Providers and routing modes

Provider records have one shared name and coding-plan credential, independent Anthropic and OpenAI Base URLs, per-Agent models, an OpenAI upstream format, and a separately selected OpenCode protocol. Applying a Kimi, BigModel, or Custom preset copies editable values into the draft. The saved record owns those values; a later preset catalog update never overwrites them. Preset ID/version is diagnostic provenance, not a live subscription.

Codex resolves one of two modes:

- **Direct Responses** — the OpenAI endpoint declares `openai-responses`. Codex receives the upstream URL and model directly; no conversion lease is allocated.
- **Routed Chat Completions** — the endpoint declares `openai-chat-completions` (including Kimi `https://api.kimi.com/coding/v1`). Comate creates a per-session, per-runtime-generation loopback route, gives Codex only its short-lived capability bearer, converts Responses traffic to Chat, and keeps the real Provider credential inside the sidecar.

The same saved credential may be used by Claude Code, Codex, and OpenCode, but each Agent resolves only its own endpoint, protocol, and model. Third-party Codex effort is limited by server-projected Provider/model capabilities. Native-account speed is not sent to third-party Providers.

Provider behavior is fail-closed:

- Providers remain visible when incompatible and include a server-owned reason; they cannot be selected until the required endpoint/model is complete.
- Missing URL, model, token, or converter support returns a stable configuration error before an upstream request.
- A Provider marked as default for Claude does not implicitly override native Codex.
- There is no fallback between native Account, Provider, Agent, endpoint, or protocol.
- Provider list/get/update responses never return the token; they expose only whether a token is present.
- Leaving the token blank during an edit retains the stored token.
- Provider secrets are redacted from surfaced Codex errors.

Route status is projected as `ready` or a sanitized `failed` code. During an idle-time rebuild the UI shows a pending state; an in-flight turn stays on its immutable old snapshot, and only a later turn uses the replacement generation.

## Migration, downgrade, and deletion

On first open, legacy single-protocol Provider rows migrate in place to configuration schema version 1. IDs, encrypted/shared credentials, default status, and session references remain stable. Before mutation Comate creates an owner-only `<database>.provider-v1.backup`; it retains the file through one verified close/reopen cycle, then removes it. If migration fails, stop Comate, preserve both files, and restore the backup over the database before retrying with the previous binary.

This migration is forward-only. Older binaries do not understand multi-protocol routing. Do not open the migrated database with an older Comate build; restore the pre-migration backup instead. A future or malformed Provider configuration fails closed rather than being guessed or rewritten.

Deleting a Provider never cascades or silently switches historical sessions. The UI first calls `GET /api/providers/:id/delete-impact` and displays the affected session count. After deletion, those sessions retain the unavailable Provider identity and must be explicitly reassigned in the Provider selector before another turn.

## MCP and skills boundary

Comate passes safe stdio MCP server command/argument definitions to Codex. It deliberately omits stdio environment maps and remote HTTP/SSE MCP definitions because those commonly contain bearer tokens or API keys that could otherwise enter Codex-owned configuration or thread metadata. Consequently, Comate's Authorization-bearing browser and scheduled-task MCP servers are not available to Codex.

Workspace and global `.claude/skills` directories are exposed through Codex skill roots. Skill discovery works, but Claude Code slash-command syntax is not translated.

## Recovery guide

| Symptom | Check | Recovery |
|---|---|---|
| Codex is unavailable in production | Production gate | Set `COMATE_ENABLE_EXPERIMENTAL_CODEX=1` only for an approved evaluation and restart Comate |
| App-server initialization fails | Bundled executable and startup logs | Run `npm run verify:codex-app-server`; repair the pinned Codex installation or configuration before retrying |
| Native model list or send fails | Codex account state | Sign in again from Settings, then reselect the model for future threads |
| Third-party session is rejected | Provider availability reason | Complete the Agent-specific endpoint/model or select a compatible Provider; do not switch protocol or Account silently |
| Route stays pending | Runtime rebuild | Wait for the current turn to become idle; retry the turn only after the route reports ready |
| Route reports failed | Sanitized route code and Provider endpoint | Correct the saved endpoint/credential, save, and let Comate rebuild. The failed generation is revoked; never paste route bearers into settings |
| Upstream times out/rate-limits/returns malformed SSE | Turn error code | Retry only transient failures. Converter/unsupported-event failures require a Provider or Comate compatibility update; there is no direct fallback |
| Provider was deleted | Session shows unavailable Provider | Use the session Provider selector to explicitly reassign it; historical transcripts are preserved |
| Provider migration fails | `.provider-v1.backup` beside the database | Stop Comate, preserve the failed DB, restore the owner-only backup, and reopen with the previous compatible build |
| A saved session cannot resume | Codex thread still exists in the same `CODEX_HOME` | Restore the original Codex home/thread data or start a new session; Comate has no private transcript copy |
| Browser or remote MCP tools are missing | Credential boundary | This is expected for Codex until a non-persisting credential handoff exists; use another selected backend if the task requires those tools |
| Pending approval/question disappeared after restart | Reconnect limitation | Retry the turn in a new interaction; pending-interaction recovery is not yet implemented |

## Verification

Before changing the pinned Codex version or releasing an evaluation build, run:

```sh
npm run test:codex-protocol
npm run verify:codex-app-server
npm run build:sidecar
npm run lint
npm run typecheck
npm run test:server
npm run test:client
npm run test:electron
npm run test:scripts
npm run test:packages
```

`npm run build:sidecar` is a release-blocking packaged test: it rejects the retired pass-through fixture and drives the real Codex app-server through the production Provider resolver, route registry, converter, streaming path, shutdown, and redaction checks. Deterministic upstream socket cancellation is pinned by the Provider route HTTP suite. `npm run verify:codex-release-gates` reruns the three Codex-specific gates against an already-built sidecar.

Treat a protocol drift failure as a compatibility change requiring regenerated types, fixture/converter review, and packaged app-server validation—not as a snapshot-only update.
