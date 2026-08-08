# Development

## Architecture

Comate is a hybrid desktop application:

- **Electron** provides the native desktop shell (`electron/`)
- **React 18** + **Vite** powers the frontend UI
- **Express.js** runs an embedded backend API that manages workspaces, sessions, file operations, and AI streaming
- The Express server is bundled as a **sidecar Node.js process** alongside the Electron app

This architecture lets us ship a self-contained desktop app while keeping the UI layer fast and the backend flexible.

## Prerequisites

- [Node.js](https://nodejs.org/) — latest LTS version

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

   On macOS the dev shell's menu bar / dock show "Comate" (not "Electron") via
   `scripts/patch-electron-dev-name.mjs`, which patches the installed Electron
   bundle's `Info.plist` — it runs on `postinstall`, so re-run `npm install`
   (or the script directly) after any Electron upgrade. The patch lives in
   `node_modules` and never affects packaged builds.

> **Note:** Do not run `npm run dev` (which starts both server and client via `concurrently`) alongside `npm run dev:electron`, as both would try to start the Vite client and cause a port conflict.

## Key Directories

| Path | Description |
|------|-------------|
| `src/client/` | React frontend application |
| `src/client/lib/` | Desktop bridge (`window.comate`) and native integration helpers |
| `src/client/i18n/` | Localization files (English, Simplified Chinese) |
| `src/server/` | Express backend and API layer |
| `src/server/routes/` | HTTP route handlers |
| `src/server/services/` | Business logic and AI session management |
| `src/server/storage/` | SQLite database layer |
| `electron/` | Electron desktop shell (main process, preload, sidecar lifecycle) |
| `resources/` | Staged runtime resources (build output of `scripts/build-sidecar.ts`; shipped via electron-builder `extraResources`) |
| `claude-code-plugin/` | Built-in local plugin marketplace (shipped with the app bundle) |
| `packages/wecom-cli/` | WeChat Work (WeCom) CLI tool |
| `scripts/` | Build scripts and code generation |

## Building for Production

Run the release pipeline:

```bash
npm run release
```

This bundles the sidecar server, runs the CDP gates (the native shell-CDP parity suite `test:shell-cdp:required` and the real-Electron shell-path gate `test:electron-cdp:required`), and packages the app with electron-builder. Output artifacts land in `release/`.

### Linux artifacts (AppImage primary, deb secondary)

Linux targets build only on a Linux host (electron-builder cannot cross-build them from macOS without Docker) — in practice the `ubuntu-22.04` CI leg produces them. Two artifacts ship per release:

- **AppImage** — the primary, recommended install. It auto-updates through electron-updater (`latest-linux.yml`) exactly like the macOS/Windows lines.
- **deb** — the secondary artifact for apt-based desktops. **deb updates need privileges:** electron-updater cannot swap files under `/opt` or `/usr` without root, so the in-app updater is supported on the AppImage only. deb users update by downloading the new `.deb` and reinstalling it (`sudo apt install ./Comate-<version>-linux-x86_64.deb`).

Desktops without a status notifier host (minimal WMs) get no tray icon; the app degrades by quitting on window close instead of hiding to a nonexistent tray. The full Linux verification gate lives in `docs/runbooks/linux-smoke.md`.

## Embedded browser: CDP targets

Inside the Electron shell the browser tools drive in-shell Chromium views: the main process opens a loopback-only random debug port and a per-boot-token control channel, and hands both to the sidecar via spawn env (`COMATE_SHELL_DEBUG_PORT` / `COMATE_SHELL_CONTROL_PORT` / `COMATE_SHELL_CONTROL_TOKEN`).

`COMATE_BROWSER_CDP_TARGET` selects the CDP target without a release (R8):

| Value | Behavior |
|-------|----------|
| unset / `auto` | the in-shell Chromium when the shell env is present; otherwise `misconfigured` (dev-web has no browser stack of its own) |
| `shell` | force the in-shell Chromium (fails loud when the shell env is missing) |
| `http://host:port`, `ws://host:port/…`, `host:port`, or a bare port | external debug-port Chromium; each session gets an isolated throwaway browser context |

**R8 rollback path (U9 decision):** the external endpoint IS the fallback landing spot — rollback means pointing `COMATE_BROWSER_CDP_TARGET` at an operator-supplied Chromium, with no client re-release (AE2 semantics preserved; aimed at support/enterprise-ops scenarios). The legacy bundled browser stack (vendored runtime + Chrome for Testing, `COMATE_CHROMIUM_PATH` / `COMATE_USE_SYSTEM_CHROME`) was removed in U9.

For server-side browser debugging, start any Chromium with `--remote-debugging-port=<port> --remote-debugging-address=127.0.0.1` and point the sidecar at it. `/api/health/browser` classifies shell-side failures (`control_channel_unreachable` / `debug_port_unreachable` / `view_creation_failed` / `target_misconfigured`) with remediation guidance.

The CDP contract suite (`npm run test:shell-cdp`) drives Playwright's `chrome-headless-shell` binary — run `npx playwright install chromium` once per checkout (the full Chromium's `--headless=new` never answers `Page.captureScreenshot` over raw CDP, so the suite deliberately uses the headless shell with `--site-per-process`).

## WeCom Plugin

The WeCom send skill is distributed as a built-in Claude Code plugin in `claude-code-plugin/plugins/wecom/`. After installing the `wecom` plugin from the built-in marketplace, users can invoke it with `/wecom:send-wecom-msg`. The plugin content can be updated independently of the app release by editing `claude-code-plugin/plugins/wecom/SKILL.md`.

## Contributing

- Run `npm run lint` before committing to catch style issues
- Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages
- Open pull requests against the `main` branch
