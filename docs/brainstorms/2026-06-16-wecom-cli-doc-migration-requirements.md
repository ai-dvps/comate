---
date: 2026-06-16
topic: wecom-cli-doc-migration
---

# WeCom CLI Doc Migration

## Summary

Migrate the `wecom-cli doc` feature from the Rust implementation to TypeScript inside `packages/wecom-cli`. The new CLI will proxy doc tool calls through the Comate server, exposing one explicit oclif subcommand per tool with typed flags. The server will provide matching endpoints under `/api/workspaces/{id}/wecom/doc/{tool}` and will handle the file-reading/uploading helpers server-side.

---

## Problem Frame

The existing Rust `wecom-cli` provides a `doc` category for managing WeCom documents, smartpages, and smartsheets. The newer TypeScript `packages/wecom-cli` currently only supports sending messages. To retire the Rust CLI and consolidate on the TypeScript stack, the `doc` capabilities need to be reimplemented in the TypeScript CLI. The current TypeScript package already loads workspace context and proxies message sending to the Comate server, so extending it to proxy doc operations keeps auth and networking centralized.

---

## Actors

- A1. CLI user / skill: invokes `wecom doc <tool>` from a workspace directory.
- A2. `wecom` CLI: parses flags, loads context, and calls the server endpoint.
- A3. Comate server: authenticates with WeCom, executes the requested doc tool, and returns JSON.
- A4. WeCom doc APIs: the underlying document, smartpage, and smartsheet APIs.

---

## Key Flows

- F1. Invoke a doc tool
  - **Trigger:** A1 runs `wecom doc <tool> --flag1 value1 ...` from a workspace.
  - **Actors:** A1, A2, A3, A4
  - **Steps:**
    1. The CLI discovers `.claude/wecom-context.json` upward from the current working directory.
    2. The CLI validates required context fields (`botId`, `serverUrl`, `workspaceId`).
    3. The CLI maps the tool name to a server endpoint path.
    4. The CLI builds the request body from typed flags.
    5. The CLI POSTs to `${serverUrl}/api/workspaces/${workspaceId}/wecom/doc/${tool-kebab-case}`.
    6. The server authenticates with WeCom using stored bot credentials.
    7. The server calls the corresponding WeCom doc API.
    8. The server returns the JSON response.
    9. The CLI prints the response JSON to stdout and exits 0.
  - **Outcome:** A1 sees the WeCom API response as JSON.
  - **Covered by:** R1–R4, R6, R8–R11

- F2. Invoke a helper-backed tool with local files
  - **Trigger:** A1 runs a helper subcommand such as `wecom doc smartpage-create --page-filepath ./page.md ...`.
  - **Actors:** A1, A2, A3, A4
  - **Steps:**
    1. The CLI parses typed flags, including local file paths.
    2. The CLI POSTs to the helper's server endpoint with file paths in the body.
    3. The server reads the local files and uploads images/files to WeCom as needed.
    4. The server calls the underlying WeCom tool with the processed params.
    5. The server returns the JSON response.
    6. The CLI prints the response JSON to stdout.
  - **Outcome:** A1 gets a WeCom API response without manually base64-encoding or uploading files.
  - **Covered by:** R7, R12–R14

---

## Requirements

**CLI structure and commands**

- R1. Add a `doc` topic to `packages/wecom-cli` with one explicit subcommand for every tool in the Rust `doc` category.
- R2. Each subcommand declares typed oclif flags matching the tool's input schema.
- R3. Each subcommand maps to a server endpoint under `/api/workspaces/{workspaceId}/wecom/doc/{tool-kebab-case}`.
- R4. Each subcommand prints the server's JSON response to stdout on success and exits 0.
- R5. CLI help (`wecom doc --help` and `wecom doc <tool> --help`) lists available tools and their flags.

**Context and auth**

- R6. The CLI continues to use the existing `.claude/wecom-context.json` format (`botId`, `serverUrl`, `workspaceId`) without adding `botSecret`.
- R7. Missing context file exits 2; invalid context file or missing `workspaceId` exits 1, consistent with the existing `send` command.

**Server endpoints**

- R8. The server exposes one POST endpoint per doc tool under `/api/workspaces/{workspaceId}/wecom/doc/{tool-kebab-case}`.
- R9. Each endpoint accepts the tool-specific params as JSON, calls the corresponding WeCom API using server-stored bot credentials, and returns the raw WeCom JSON response.
- R10. Server returns HTTP 200 with JSON body for successful WeCom calls, even when the WeCom `errcode` is non-zero.
- R11. Server endpoints reuse existing workspace bot configuration; no new per-workspace setup is required beyond the existing WeCom context.

**Helper tools**

- R12. Server endpoints exist for the three helper workflows: `smartpage-create`, `smartsheet-add-records-auto-file`, and `smartsheet-update-records-auto-file`.
- R13. Helper endpoints accept local file paths in their params, read the files from the workspace, upload images/files to WeCom, and substitute the results before calling the underlying tool.
- R14. Helper endpoints enforce the same file-size limits as the Rust helpers: images up to 30 MB, files up to 10 MB.

**Response and error handling**

- R15. The CLI forwards server error responses to stderr and exits with a non-zero code.
- R16. Network failures between CLI and server exit with the same code used by the existing `send` command.

---

## Acceptance Examples

- AE1. **Covers R1–R6, R8–R11.** Given a workspace with `.claude/wecom-context.json` containing `botId`, `serverUrl`, and `workspaceId`, when the user runs `wecom doc get-doc-content --docid DOCID --type 2`, then the CLI POSTs `{ docid: "DOCID", type: 2 }` to `${serverUrl}/api/workspaces/${workspaceId}/wecom/doc/get-doc-content` and prints the server's JSON response to stdout.

- AE2. **Covers R7.** Given no context file in the current working directory tree, when the user runs any `wecom doc` command, then the CLI exits 2 with a message about the missing context file.

- AE3. **Covers R12–R14.** Given a workspace with a local image at `./screenshot.png`, when the user runs `wecom doc smartsheet-add-records-auto-file` with a record containing `image_path: "./screenshot.png"`, then the server reads the image, uploads it to WeCom, replaces `image_path` with `image_url`, calls `smartsheet_add_records`, and returns the response.

---

## Success Criteria

- All Rust `doc` category tools are callable through the TypeScript CLI.
- Help text and flag validation work for every tool.
- Server endpoints authenticate and proxy requests correctly.
- Helper workflows handle local files without requiring users to base64-encode them.
- Existing CLI context file format and exit codes are preserved.

---

## Scope Boundaries

**Deferred for later**

- Auto-discovery of new WeCom tools without CLI updates.
- Dynamic `--schema` output for tools.
- Client-side caching of tool lists or responses.
- Non-doc categories (`contact`, `meeting`, `msg`, `schedule`, `todo`).

**Outside this product's identity**

- Reimplementing the full Rust MCP client with local credential encryption.

---

## Key Decisions

- **Proxy through Comate server:** Keeps bot secrets server-side and matches the existing `send` command architecture.
- **One endpoint per tool:** Clearer per-tool contracts than a single generic endpoint.
- **Explicit typed-flag subcommands:** Better CLI help and validation than dynamic `--method`/`--json`.
- **Server-side helpers:** Avoids adding file-reading and base64/upload logic to the CLI.
- **No context file changes:** `botSecret` remains server-side; `.claude/wecom-context.json` keeps its current shape.

---

## Dependencies / Assumptions

- The Comate server can authenticate with WeCom using workspace-stored bot credentials.
- The server will implement the new `/wecom/doc/*` endpoints.
- Tool names and input schemas from the Rust `doc` category are stable enough to port.
- Workspace file paths referenced by helper endpoints are readable by the server process.

---

## Outstanding Questions

### Resolve Before Planning

- None

### Deferred to Planning

- Exact list of tools in the `doc` category to prioritize for the first implementation pass.
- How to represent complex nested params (e.g., smartsheet record arrays) with typed flags; whether to allow a `--json` override for helpers.
- Server-side endpoint implementation details and error response shape.
- Whether helper endpoints accept absolute paths, relative paths, or both.
