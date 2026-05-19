---
title: Tauri Desktop Wrap v1
type: feat
status: active
date: 2026-05-19
origin: docs/brainstorms/2026-05-19-tauri-desktop-wrap-v1-requirements.md
---

# Tauri Desktop Wrap v1

## Summary

Initialize a Tauri v2 desktop shell around the existing React/Vite frontend and Node.js/Express backend. The frontend loads via Tauri's asset protocol; the backend runs as a `pkg`-bundled Node sidecar with dynamic port discovery. Target macOS + Windows, unsigned, for the user and a small circle of trusted people. Tray, notifications, and Keychain deferred to v1.1.

---

## Problem Frame

The existing Claude Code GUI is a dev-only web app launched with `npm run dev`. Sharing it requires recipients to install Node, run a terminal, and keep a browser tab open. This blocks distribution to non-developers and creates friction even for technical users. A self-contained desktop installer removes all of that.

(See origin for full context.)

---

## Requirements

- R1. Tauri app bundles the built React frontend assets into the WebView.
- R2. Tauri app bundles the Node.js/Express backend as a sidecar process that starts on launch and terminates on quit.
- R3. Sidecar runs on a dynamically assigned localhost port to avoid conflicts.
- R4. Native modules (`better-sqlite3`) ship with prebuilt binaries for darwin-arm64, darwin-x64, and win-x64.
- R5. Distribution produces unsigned `.dmg` (macOS) and `.msi`/`.exe` (Windows) for manual sharing.
- R6. App targets macOS (Apple Silicon + Intel) and Windows (x64) in v1.
- R7. WebView loads the app at startup, with API calls routed to the sidecar's localhost port.
- R8. Closing the window terminates both the WebView and the sidecar process.
- R9. App detects missing Claude CLI configuration and surfaces a friendly error.
- R10. Per-user application data lives in the platform-standard per-user directory.
- R11. Secrets remain in the user's existing Claude CLI configuration directory.
- R12. SQLite schema unchanged; no migration needed.

**Origin actors:** A1 (Dev/maintainer), A2 (Trusted user)
**Origin flows:** F1 (Install and first launch), F2 (Day-to-day use)
**Origin acceptance examples:** AE1, AE2, AE3, AE4

---

## Scope Boundaries

- Tray-resident background mode and native notifications — deferred to v1.1
- OS Keychain / Windows Credential Manager integration — deferred to v1.1
- Code signing and notarization — not needed for this audience
- Auto-update mechanism — not needed for manual distribution
- Linux support — deferred indefinitely
- Porting the backend to Rust — deferred indefinitely
- Reimplementing Claude Agent SDK in Rust — deferred indefinitely
- Multiple workspace windows, global hotkey, deep links, URL schemes — not in v1
- Polished first-run onboarding wizard — not in v1
- Changes to React frontend UI/UX beyond what Tauri window chrome requires — not in scope

### Deferred to Follow-Up Work

- v1.1: Tray + notifications + Keychain (tracked separately when v1 ships)

---

## Context & Research

### Relevant Code and Patterns

- `src/server/index.ts` — Express entry point with wide-open CORS and static file serving in production mode
- `src/server/storage/sqlite-store.ts` — SQLite storage using `better-sqlite3`, currently hardcoded to `~/.claude-code-gui`
- `src/server/storage/json-store.ts` — Draft session storage, also uses `~/.claude-code-gui`
- `src/server/services/sdk-client.ts` — Thin wrapper around `@anthropic-ai/claude-agent-sdk`; SDK spawns the native `claude` binary
- `src/server/services/chat-service.ts` and `src/server/services/session-runtime.ts` — Orchestrate SSE streaming
- `src/client/stores/chat-store.ts` — Client-side SSE consumption via `fetch` + `ReadableStream`
- `vite.config.ts` — Build outputs to `dist/client`; dev proxy forwards `/api` to `localhost:3000`
- `tsconfig.server.json` — Compiles backend to `dist/server` with ESM output
- `package.json` — ESM project with separate dev:server/dev:client scripts

### External References

- Tauri v2 sidecar docs and shell plugin — sidecar spawn, stdout capture, process lifecycle
- `@yao-pkg/pkg` — actively maintained fork of `pkg` for bundling Node.js into standalone executables
- `better-sqlite3` `nativeBinding` option — for loading native `.node` binaries from a non-standard path at runtime

---

## Key Technical Decisions

- **Asset protocol for frontend, sidecar for API only:** Tauri bundles and serves the Vite-built frontend via its built-in asset protocol (`tauri://localhost`). The Express sidecar serves only API routes on a dynamic localhost port. This avoids CORS complexity, keeps the WebView on a controlled origin, and is the idiomatic Tauri pattern. (see origin: R7)
- **`pkg` (via `@yao-pkg/pkg`) for sidecar bundling:** The actively maintained `pkg` fork bundles the Node runtime + compiled server into a standalone executable (~40-70MB). The project uses ESM, so the server is first bundled into a single CommonJS file via `esbuild` before `pkg` consumes it. Native modules (`better-sqlite3`) ship alongside as Tauri resources and are loaded via the `nativeBinding` option. (see origin: R2, R4)
- **Stdout JSON discovery for dynamic port:** The sidecar binds to port 0, then prints `{"type":"ready","port":<n>}` to stdout. The Rust runtime reads this line, extracts the port, and passes it to the frontend via a Tauri command. This avoids hardcoded ports and race conditions. (see origin: R3)
- **Per-user data directory via environment variable:** The server checks `CLAUDE_CODE_GUI_DATA_DIR` at startup. The Tauri app sets this to the platform-standard per-user directory before spawning the sidecar. Dev workflow (`npm run dev`) omits the variable and continues using `~/.claude-code-gui`. This keeps dev and desktop installs completely isolated. (see origin: R10, resolved during brainstorm)
- **Standard `fetch`-based SSE in WebView:** The existing client already consumes SSE via `fetch` + `ReadableStream`, not `EventSource`. Tauri WebViews support this natively. No plugin needed — only CSP `connect-src` must allow `http://localhost:*`. (see origin: R7)

---

## Open Questions

### Resolved During Planning

- **Native module packaging strategy:** Bundle server to CJS with `esbuild`, then `pkg` the result. Ship `better_sqlite3.node` as a Tauri resource per platform. Load via `nativeBinding: path.join(process.resourcesPath, 'better_sqlite3.node')`.
- **Frontend connection mode:** Asset protocol for static files, sidecar for API. The frontend fetches API calls to `http://localhost:<port>/api/*` after receiving the port from Rust.
- **ESM compatibility with `pkg`:** Pre-bundle the compiled server into a single CommonJS file using `esbuild`. This sidesteps `pkg`'s ESM limitations entirely.

### Deferred to Implementation

- **Exact `esbuild` bundling config for the server:** The server has dynamic imports and native module loading that may need special handling. Verify during implementation.
- **CORS tightening:** The current `app.use(cors())` works but is overly permissive. Whether to tighten to specific origins in production mode can be decided during implementation.
- **Claude CLI detection mechanism:** Whether to check PATH, call `claude --version`, or rely on SDK initialization failure is a runtime detail best decided when touching the code.

---

## Output Structure

```
.
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── tauri.macos.conf.json
│   ├── tauri.windows.conf.json
│   ├── capabilities/
│   │   └── default.json
│   ├── src/
│   │   └── main.rs
│   ├── binaries/
│   │   └── .gitkeep
│   └── resources/
│       └── .gitkeep
├── src/client/lib/
│   └── tauri-api.ts            (new)
├── src/server/
│   └── storage/
│       └── data-dir.ts         (new, env-based directory resolution)
├── scripts/
│   └── build-sidecar.ts        (new, esbuild + pkg orchestration)
└── package.json                (modify, add Tauri scripts)
```

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
┌─────────────────────────────────────────────────────────────┐
│                    Tauri Desktop App                         │
│  ┌──────────────┐         ┌──────────────────────────────┐  │
│  │   WebView    │         │         Rust Runtime          │  │
│  │  (React UI)  │◄────────┤  spawn sidecar ──► capture    │  │
│  │              │  port   │  stdout ──► extract port      │  │
│  └──────┬───────┘         └──────────────────────────────┘  │
│         │                                                    │
│         │ fetch /api/*                                       │
│         ▼                                                    │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Node.js Sidecar (pkg binary)               │  │
│  │  ┌──────────────┐  ┌─────────────┐  ┌───────────────┐  │  │
│  │  │   Express    │──┤    SDK      │──┤  claude CLI   │  │  │
│  │  │   Server     │  │   Wrapper   │  │   (external)  │  │  │
│  │  └──────┬───────┘  └─────────────┘  └───────────────┘  │  │
│  │         │                                               │  │
│  │         │ read/write                                    │  │
│  │         ▼                                               │  │
│  │  ┌──────────────┐        ┌──────────────────────────┐   │  │
│  │  │  SQLite DB   │        │  better_sqlite3.node     │   │  │
│  │  │ (per-user)   │        │  (Tauri resource)        │   │  │
│  │  └──────────────┘        └──────────────────────────┘   │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Startup flow:**
1. Tauri app launches, Rust runtime spawns the sidecar binary
2. Sidecar starts Express server on a random port, prints `{"type":"ready","port":N}` to stdout
3. Rust captures the port and stores it in app state
4. Frontend loads via asset protocol, calls `invoke('get_api_port')` to receive the port
5. Frontend initializes its API client with `http://localhost:<port>` as base URL
6. All subsequent `/api/*` calls route to the sidecar

**Shutdown flow:**
1. User closes the window
2. Rust receives `WindowEvent::Destroyed`
3. Rust kills the sidecar child process and calls `app_handle.exit(0)`
4. Sidecar receives SIGTERM, closes HTTP server and SQLite connections

---

## Implementation Units

### U1. Initialize Tauri v2 project and build configuration

**Goal:** Scaffold the Tauri v2 Rust project, configure the app for sidecar + asset protocol, and add build scripts to `package.json`.

**Requirements:** R1, R2, R6

**Dependencies:** None

**Files:**
- Create: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.macos.conf.json`, `src-tauri/tauri.windows.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/main.rs`, `src-tauri/binaries/.gitkeep`, `src-tauri/resources/.gitkeep`
- Modify: `package.json`

**Approach:**
- Install `@tauri-apps/cli` as a dev dependency and `cargo` tools
- Initialize the Tauri project in `src-tauri/`
- Configure `tauri.conf.json` with:
  - `bundle.externalBin` pointing to the sidecar binary
  - `bundle.resources` for the `better_sqlite3.node` native module
  - `app.security.csp` allowing `connect-src` to `http://localhost:*`
  - Window config: native decorations, reasonable min size, center on launch
- Configure `capabilities/default.json` with permissions for `shell:allow-spawn` (sidecar) and `http:default` (localhost fetch)
- Add platform-specific config files for macOS and Windows bundling (unsigned)
- Add `tauri` scripts to `package.json`: `tauri dev`, `tauri build`

**Patterns to follow:**
- Tauri v2 project structure conventions
- Use `cargo tauri` CLI for consistency with the ecosystem

**Test scenarios:**
- Happy path: `npm run tauri dev` builds successfully and opens a Tauri window
- Edge case: Verify the window has the correct title and minimum dimensions
- Error path: Missing Rust toolchain produces a clear error message

**Verification:**
- `cargo tauri dev` launches without errors
- A Tauri window opens showing the default Tauri placeholder or the React app (once U4 is in place)

---

### U2. Create Node sidecar bundle with esbuild + pkg

**Goal:** Produce a standalone executable from the Express server that includes the Node runtime and can be spawned by Tauri.

**Requirements:** R2, R4

**Dependencies:** U1

**Files:**
- Create: `scripts/build-sidecar.ts`
- Modify: `package.json` (add build-sidecar script)

**Approach:**
- Add `esbuild` and `@yao-pkg/pkg` as dev dependencies
- Create a build script that:
  1. Compiles the server with `tsc -p tsconfig.server.json` (existing step)
  2. Bundles `dist/server/index.js` into a single CommonJS file with `esbuild` (handles ESM → CJS, tree-shakes)
  3. Runs `pkg` on the bundled CJS file to produce a platform-specific binary
  4. Copies the resulting binary to `src-tauri/binaries/` with the correct target-triple naming
  5. Copies the appropriate `better_sqlite3.node` prebuilt binary from `node_modules/better-sqlite3/build/Release/` to `src-tauri/resources/`
- The binary name must match `tauri.conf.json`'s `externalBin` entry (e.g., `binaries/sidecar-node`)

**Technical design:** *(directional guidance)*
```
Build pipeline:
tsc -p tsconfig.server.json
  └─► dist/server/index.js (ESM)
      └─► esbuild bundle → dist/sidecar/bundle.cjs (CJS, single file)
          └─► pkg --targets node20-darwin-arm64,node20-darwin-x64,node20-win-x64
              ├─► src-tauri/binaries/sidecar-node-aarch64-apple-darwin
              ├─► src-tauri/binaries/sidecar-node-x86_64-apple-darwin
              └─► src-tauri/binaries/sidecar-node-x86_64-pc-windows-msvc.exe
```

**Patterns to follow:**
- `package.json` already has `build:server` — extend rather than replace

**Test scenarios:**
- Happy path: Build script produces a runnable binary for the current platform
- Happy path: Binary starts and responds to `GET /api/health`
- Edge case: Binary size is under 80MB
- Error path: Missing `better_sqlite3.node` for the target platform fails the build with a clear message
- Integration: Binary can create and query a SQLite database using the bundled native module

**Verification:**
- Running the sidecar binary directly starts an Express server on a random port
- `curl http://localhost:<port>/api/health` returns `{"status":"ok"}`
- Binary is present in `src-tauri/binaries/` with the correct target-triple suffix

---

### U3. Implement sidecar spawn, port discovery, and lifecycle in Rust

**Goal:** Tauri spawns the sidecar on app launch, reads the port from stdout, exposes it to the frontend, and cleanly terminates the sidecar on window close.

**Requirements:** R2, R3, R8

**Dependencies:** U1

**Files:**
- Modify: `src-tauri/src/main.rs`

**Approach:**
- In the Tauri `setup` hook, spawn the sidecar binary using the shell plugin
- Read stdout lines from the spawned process, parse JSON for `{"type":"ready","port":N}`
- Store the port and child process handle in Tauri app state
- Expose a Tauri command (`get_api_port`) that returns the discovered port to the frontend
- On `RunEvent::WindowEvent` with `WindowEvent::Destroyed`, kill the sidecar child and call `app_handle.exit(0)`

**Technical design:** *(directional guidance)*
- The sidecar stdout line protocol is: `{"type":"ready","port":<number>}` followed by newline
- The Rust side reads stdout via the shell plugin's event stream
- The child handle is stored in a `Mutex<Option<CommandChild>>` in app state for cleanup

**Patterns to follow:**
- Tauri v2 Shell plugin patterns for sidecar spawning
- Tauri v2 state management (`tauri::State`)

**Test scenarios:**
- Happy path: App launches, sidecar spawns, port is discovered within 5 seconds
- Happy path: Frontend can call `invoke('get_api_port')` and receives a valid port number
- Happy path: Closing the window kills the sidecar process (verify with `ps` or Activity Monitor)
- Edge case: If stdout does not contain a ready message within a timeout, surface an error to the frontend
- Edge case: If the sidecar exits unexpectedly, the app shows an error and does not crash

**Verification:**
- Launch the app, check that a Node sidecar process is running
- Verify the port returned by `get_api_port` responds to HTTP requests
- Close the window, verify the sidecar process is gone

---

### U4. Update frontend for Tauri-specific API base URL

**Goal:** The React frontend detects when running inside Tauri, fetches the sidecar port from Rust, and prefixes all API calls with the dynamic base URL.

**Requirements:** R7

**Dependencies:** U3

**Files:**
- Create: `src/client/lib/tauri-api.ts`
- Modify: `src/client/main.tsx`, `src/client/stores/*.ts` (or wherever API calls are made)

**Approach:**
- Create a small Tauri API module that:
  1. Detects Tauri runtime (check for `window.__TAURI__` or use feature detection)
  2. If in Tauri, calls `invoke('get_api_port')` to get the sidecar port
  3. Constructs and exposes the API base URL (e.g., `http://localhost:<port>`)
  4. If not in Tauri (dev mode), returns empty string so relative `/api` paths continue working
- Update the existing API client/stores to use this base URL for all fetch calls
- Ensure the change is minimal and non-breaking for the existing dev workflow

**Patterns to follow:**
- Keep dev workflow intact — the same code must work in `vite dev` and in Tauri
- Use the existing store patterns (Zustand stores in `src/client/stores/`)

**Test scenarios:**
- Happy path: In Tauri, frontend loads workspaces list from the sidecar
- Happy path: In Tauri, chat streaming (SSE via `fetch`) connects to the sidecar
- Happy path: In `vite dev`, frontend continues to use the Vite proxy (no regression)
- Integration: Creating a workspace, sending a message, and receiving a streamed response works end-to-end in Tauri

**Verification:**
- Network tab (or logging) shows API calls going to `http://localhost:<port>/api/*` in Tauri
- Same code in `vite dev` calls `/api/*` via the Vite proxy without changes

---

### U5. Migrate storage to platform-standard per-user directory

**Goal:** Make the server's data directory configurable via environment variable, so the Tauri app can point it to the platform-standard per-user location while the dev workflow continues using `~/.claude-code-gui`.

**Requirements:** R10, R11, R12

**Dependencies:** None (can run in parallel with U1-U3)

**Files:**
- Create: `src/server/storage/data-dir.ts`
- Modify: `src/server/storage/sqlite-store.ts`, `src/server/storage/json-store.ts`

**Approach:**
- Extract the directory resolution logic into a shared module
- Check `process.env.CLAUDE_CODE_GUI_DATA_DIR` first
- Fall back to the current `~/.claude-code-gui` behavior
- The Tauri app (in Rust) resolves the platform-standard directory and passes it via the env var when spawning the sidecar
- No migration logic — desktop starts with a fresh database per the resolved directory

**Patterns to follow:**
- Keep the existing `mkdirSync` + permission logic
- Do not break the dev workflow

**Test scenarios:**
- Happy path: With `CLAUDE_CODE_GUI_DATA_DIR=/tmp/test-data`, server creates `data.db` in `/tmp/test-data`
- Happy path: Without the env var, server continues to use `~/.claude-code-gui`
- Edge case: Directory does not exist — server creates it automatically
- Edge case: Both dev and desktop apps running simultaneously — they use different directories, no conflicts

**Verification:**
- `npm run dev:server` still writes to `~/.claude-code-gui`
- Tauri app writes to `~/Library/Application Support/ClaudeCodeGUI/` (macOS) or `%APPDATA%\ClaudeCodeGUI\` (Windows)

---

### U6. Add Claude CLI detection and friendly error surface

**Goal:** The app checks for a working Claude CLI installation on startup and shows a helpful message if it's missing or unauthenticated, rather than crashing or showing a blank screen.

**Requirements:** R9

**Dependencies:** U4

**Files:**
- Modify: `src/server/index.ts` or `src/server/routes/health.ts` (new)
- Modify: `src/client/App.tsx` or a new error boundary component

**Approach:**
- Add a server-side health check endpoint (e.g., `/api/health/claude`) that verifies:
  1. `claude` binary is in PATH (or accessible to the SDK)
  2. SDK can initialize without auth errors
- On app startup, the frontend calls this endpoint before rendering the main UI
- If the check fails, display a full-screen friendly error with instructions: "Claude CLI must be installed and authenticated. Run `claude login` in your terminal."
- This check also runs in dev mode for consistency

**Patterns to follow:**
- Keep error UI minimal for v1 — a centered card with text and a retry button is sufficient
- Reuse existing Tailwind styling

**Test scenarios:**
- Happy path: Claude CLI is installed and authenticated — app starts normally
- Error path: `claude` binary is not in PATH — friendly error shown with setup instructions
- Error path: `claude` is installed but not authenticated — friendly error shown with `claude login` instruction
- Error path: User clicks retry after fixing CLI — app proceeds to normal UI

**Verification:**
- Temporarily rename `claude` binary, launch app, verify error screen appears
- Restore binary, click retry, verify app proceeds

---

### U7. Set up cross-platform build and distribution pipeline

**Goal:** Produce unsigned `.dmg` (macOS) and `.msi`/`.exe` (Windows) installers ready for manual sharing.

**Requirements:** R5, R6

**Dependencies:** U1-U6

**Files:**
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/tauri.macos.conf.json`, `src-tauri/tauri.windows.conf.json`
- Modify: `package.json` (add distribution scripts)

**Approach:**
- Configure macOS bundle settings: app name, identifier, `.dmg` layout (no signing)
- Configure Windows bundle settings: NSIS installer, webview install mode, no certificate
- Ensure the sidecar binary and `better_sqlite3.node` are included in both platform bundles
- Add npm scripts for building each platform target
- Document the build commands in the project README or a BUILD.md file
- For cross-platform builds: note that macOS builds require macOS, Windows builds require Windows (or a CI runner)

**Patterns to follow:**
- Tauri v2 bundler conventions for unsigned apps

**Test scenarios:**
- Happy path: `npm run tauri build` on macOS produces a `.dmg`
- Happy path: `npm run tauri build` on Windows produces an `.exe` or `.msi`
- Edge case: The `.dmg` can be mounted and the app launched (unsigned — right-click → Open)
- Edge case: The Windows installer runs and the app launches (unsigned — SmartScreen bypass)
- Integration: A clean machine (no Node, no dev tools) can install and run the app

**Verification:**
- Build artifacts exist in `src-tauri/target/release/bundle/`
- Artifacts install and launch on their respective platforms
- App behaves identically to the dev build for all v1 features

---

## System-Wide Impact

- **Interaction graph:** The Tauri Rust runtime introduces a new layer between the OS and the frontend. The sidecar spawn replaces the manual `npm run dev:server` step. No existing callbacks, middleware, or observers are affected.
- **Error propagation:** Sidecar spawn failures (missing binary, port conflicts) surface through Tauri's command system to the frontend. Backend errors (500s, SSE disconnects) continue to propagate through the existing Express → fetch path.
- **State lifecycle risks:** The per-user data directory change means desktop and dev instances use independent databases. No partial-write or cache risks. The only shared state is the Claude SDK's global session store in `~/.claude/`, which both instances read — this is acceptable and by design.
- **API surface parity:** The Express API surface remains unchanged. The frontend makes the same HTTP calls; only the base URL prefix changes in Tauri mode.
- **Unchanged invariants:** The dev workflow (`npm run dev`) is explicitly preserved. The React component tree, Zustand stores, Express routes, and SQLite schema are all untouched except for the API base URL and data directory resolution.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `pkg` fails to bundle ESM or dynamic imports correctly | Pre-bundle with `esbuild` to CJS before `pkg`; test the binary thoroughly on each target platform |
| `better-sqlite3` native binary fails to load at runtime from `process.resourcesPath` | Verify the `nativeBinding` path resolution on macOS and Windows; include debug logging for path diagnostics |
| SSE streaming breaks in Tauri WebView | The existing `fetch`-based SSE approach works in WebKit/WebView2; verify with a real Claude session end-to-end |
| Sidecar process leaks on macOS window close | Implement explicit kill in `WindowEvent::Destroyed` + `app_handle.exit(0)`; test with Activity Monitor |
| Cross-platform build requires macOS + Windows machines | Document that builds must run on their target OS (or use GitHub Actions runners); v1 audience is small so manual builds are acceptable |
| `esbuild` bundling breaks server code (dynamic requires, native modules) | Bundle only JS/TS; exclude `better-sqlite3` from the bundle and load it dynamically via `nativeBinding` |

---

## Documentation / Operational Notes

- Add a `BUILD.md` or section in README documenting: (1) how to build the sidecar, (2) how to build the Tauri app, (3) platform-specific prerequisites (Rust toolchain, Xcode on macOS)
- Document the `CLAUDE_CODE_GUI_DATA_DIR` environment variable for power users
- Note that the app requires Claude CLI to be installed and authenticated before use

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-19-tauri-desktop-wrap-v1-requirements.md](docs/brainstorms/2026-05-19-tauri-desktop-wrap-v1-requirements.md)
- Related code: `src/server/index.ts`, `src/server/storage/sqlite-store.ts`, `src/client/stores/chat-store.ts`, `vite.config.ts`
- Related plans: `docs/plans/2026-05-15-001-feat-claude-code-gui-workspace-manager-plan.md`
- External docs: Tauri v2 sidecar docs, `@yao-pkg/pkg`, `better-sqlite3` nativeBinding API
