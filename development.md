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

3. Start the Tauri desktop app in another terminal:
   ```bash
   npm run tauri:dev
   ```
   This automatically launches the Vite dev client via `beforeDevCommand`.

> **Note:** Do not run `npm run dev` (which starts both server and client via `concurrently`) alongside `npm run tauri:dev`, as both would try to start the Vite client and cause a port conflict.

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

This bundles the sidecar server and builds the Tauri application. Output artifacts land in `src-tauri/target/release/bundle/`.

## WeCom Plugin

The WeCom send skill is distributed as a built-in Claude Code plugin in `claude-code-plugin/plugins/wecom/`. After installing the `wecom` plugin from the built-in marketplace, users can invoke it with `/wecom:send-wecom-msg`. The plugin content can be updated independently of the app release by editing `claude-code-plugin/plugins/wecom/SKILL.md`.

## Contributing

- Run `npm run lint` before committing to catch style issues
- Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages
- Open pull requests against the `main` branch
