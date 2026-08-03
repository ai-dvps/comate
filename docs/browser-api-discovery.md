# Browser API discovery

Comate can inspect the embedded browser's sanitized DOM and a bounded, explicitly bracketed window of HTTP traffic. The agent can turn a selected capture candidate into an opaque authentication binding, then replay a sanitized request through either the `authenticatedRequest` MCP tool or `comate api request`. Captured traffic is evidence of temporal association with the named browser action, not proof that the action caused a request.

## Authentication lifecycle

- Cookie authentication may be replayed only where normal cookie domain, path, expiry, Secure, SameSite, host-only, and partition rules apply, within the captured registrable domain and its subdomains.
- Bearer tokens and web-storage-derived authentication are restricted to the exact captured origin.
- Raw cookies, bearer values, and storage values are never returned through MCP, CLI output, chat history, recipes, logs, or audit rows. MCP and CLI receive only an opaque `authBinding` handle.
- Closing the browser destroys ephemeral bindings. Login survives browser close only after the user explicitly chooses **Remember this site**; close itself never remembers credentials.
- Closing, replacing, or deleting the task runtime aborts captures and requests and revokes its bindings, approvals, grants, and loopback capability. Remembered encrypted site data may remain, but a closed task cannot use it.

## Supported request shapes

The broker supports bounded HTTP(S) GET, HEAD, and approved mutation requests with sanitized headers, query parameters, JSON, GraphQL, form, or bounded text bodies. Redirects are re-authorized per hop and cannot leave the captured registrable domain. Mutations require approval; an exact successful validation may grant reuse only for the same task/runtime, binding, and operation fingerprint.

Not currently supported: WebSocket or SSE replay, streaming uploads, arbitrary binary or multipart bodies, client certificates, OAuth refresh/device flows, authentication held only in arbitrary page JavaScript memory, or bypassing CAPTCHA/MFA. With the bundled Steel version, dedicated/shared/service-worker HTTP is not captured because enabling the Network domain freezes those child sessions; worker target lifecycle is still tracked. Network capture can also miss responses evicted by Chromium, requests outside the explicit window, and opaque browser details; incomplete reasons are reported rather than guessed.

## Recovery

- `auth_binding_stale`: reopen the site, sign in if needed, capture again, and select a fresh candidate. If persistence is desired, explicitly remember the site before closing.
- `domain_not_authorized` or `destination_not_allowed`: use an endpoint inside the captured registrable domain. Bearer/storage auth additionally requires the original origin.
- `authorization_cancelled` or `authorization_expired`: the task closed, changed runtime, or approval expired. Retry from the current runtime and approve again.
- `capture_incomplete`: repeat a shorter capture window around one action and stop background polling where possible.

Example CLI input is passed over stdin so no recipe or handle needs to be written to disk:

```sh
printf '%s' "$SANITIZED_REQUEST_JSON" | comate api request --stdin --json
```

The CLI is available only inside a live Comate task with its injected loopback capability.
