# Development

## Architecture

Comate is a hybrid desktop application:

- **Tauri v2** provides the native desktop shell (Rust)
- **React 18** + **Vite** powers the frontend UI
- **Express.js** runs an embedded backend API that manages workspaces, sessions, file operations, and AI streaming
- The Express server is bundled as a **sidecar Node.js process** alongside the Tauri app

This architecture lets us ship a self-contained desktop app while keeping the UI layer fast and the backend flexible.

## Prerequisites

- [Node.js](https://nodejs.org/) — latest LTS version
- [Rust](https://www.rust-lang.org/tools/install) — 1.77 or later

Tauri CLI is installed automatically as a devDependency via `npm install`. You do not need a global installation.

## Getting Started

1. Clone the repository and install dependencies:
   ```bash
   git clone <repository-url>
   cd comate
   npm install
   ```

2. Start the Express backend in one terminal:
   ```bash
   npm run dev:server
   ```

3. Start the Electron desktop app in another terminal:
   ```bash
   npm run dev:electron
   ```
   This starts the Vite dev client and the Electron shell together.

> **Note:** Do not run `npm run dev` (which starts both server and client via `concurrently`) alongside `npm run dev:electron`, as both would try to start the Vite client and cause a port conflict.

## Key Directories

| Path | Description |
|------|-------------|
| `src/client/` | React frontend application |
| `src/client/lib/` | Tauri API bridge and native integration helpers |
| `src/client/i18n/` | Localization files (English, Simplified Chinese) |
| `src/server/` | Express backend and API layer |
| `src/server/routes/` | HTTP route handlers |
| `src/server/services/` | Business logic and AI session management |
| `src/server/storage/` | SQLite database layer |
| `src-tauri/` | Rust Tauri desktop shell |
| `claude-code-plugin/` | Built-in local plugin marketplace (shipped with the app bundle) |
| `packages/wecom-cli/` | WeChat Work (WeCom) CLI tool |
| `scripts/` | Build scripts and code generation |

## Building for Production

Run the release pipeline:

```bash
npm run release
```

This bundles the sidecar server, runs the CDP gates (the native shell-CDP parity suite `test:shell-cdp:required` and the real-Electron shell-path gate `test:electron-cdp:required`), and packages the app with electron-builder. Output artifacts land in `release/`.

## Embedded browser: CDP targets

Inside the Electron shell the browser tools drive in-shell Chromium views: the main process opens a loopback-only random debug port and a per-boot-token control channel, and hands both to the sidecar via spawn env (`COMATE_SHELL_DEBUG_PORT` / `COMATE_SHELL_CONTROL_PORT` / `COMATE_SHELL_CONTROL_TOKEN`).

`COMATE_BROWSER_CDP_TARGET` selects the CDP target without a release (R8):

| Value | Behavior |
|-------|----------|
| unset / `auto` | shell when the shell env is present, otherwise the legacy Steel stack |
| `steel` | force the legacy vendored-Steel child-process stack |
| `shell` | force the in-shell Chromium (fails loud when the shell env is missing) |
| `http://host:port`, `ws://host:port/…`, `host:port`, or a bare port | external debug-port Chromium; each session gets an isolated throwaway browser context |

For server-side browser debugging, start any Chromium with `--remote-debugging-port=<port> --remote-debugging-address=127.0.0.1` and point the sidecar at it. `/api/health/browser` classifies shell-side failures (`control_channel_unreachable` / `debug_port_unreachable` / `view_creation_failed`) with remediation guidance.

## WeCom Plugin

The WeCom send skill is distributed as a built-in Claude Code plugin in `claude-code-plugin/plugins/wecom/`. After installing the `wecom` plugin from the built-in marketplace, users can invoke it with `/wecom:send-wecom-msg`. The plugin content can be updated independently of the app release by editing `claude-code-plugin/plugins/wecom/SKILL.md`.

## Contributing

- Run `npm run lint` before committing to catch style issues
- Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages
- Open pull requests against the `main` branch
