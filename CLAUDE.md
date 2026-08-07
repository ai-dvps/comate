# Comate — Claude Code Project Guide

Comate is a desktop AI workspace that wraps Claude Code in a native Electron app. It uses a hybrid architecture: a **React 18 + Vite** frontend, an **Express.js** sidecar server, and an **Electron** desktop shell.

## Quick Commands

| Command | Purpose |
|---------|---------|
| `npm run dev:server` | Start the Express backend with hot reload |
| `npm run dev:client` | Start the Vite dev server (port 5173) |
| `npm run dev:electron` | Start the Electron desktop app (Vite dev client + shell) |
| `npm run lint` | Run ESLint on `.ts`/`.tsx` |
| `npm run test:client` | Run jsdom-based component/hook tests |
| `npm run test:server` | Run `node:test` server tests (excludes `src/server/vendor/`) |
| `npm run test:browser` | Run Playwright browser tests |
| `npm run release` | Build sidecar + CDP gate + Electron production bundle (electron-builder) |

> Do **not** run `npm run dev` alongside `npm run dev:electron` — both start Vite and will conflict on port 5173.

## Architecture

```
┌─────────────────┐     WebSocket / HTTP      ┌──────────────────┐
│  Electron shell │  ←──────────────────────→  │  Express server  │
│  (electron/)    │                           │  (src/server/)   │
└────────┬────────┘                           └────────┬─────────┘
         │                                             │
         │  Vite dev client / bundled UI               │  sidecar Node process
         ↓                                             ↓
┌─────────────────┐                          ┌──────────────────┐
│  React UI       │                          │  SQLite, Claude  │
│  (src/client/)  │                          │  SDK, file I/O   │
└─────────────────┘                          └──────────────────┘
```

- **Frontend** (`src/client/`): React 18, Zustand stores, Tailwind CSS, Radix primitives, `lucide-react` icons.
- **Backend** (`src/server/`): Express API routes, service layer, SQLite storage via `better-sqlite3`.
- **Desktop shell** (`electron/`): Electron main process + preload, sidecar Node binary lifecycle, native browser views (WebContentsView), tray, updater.
- **Plugins** (`claude-code-plugin/`): Built-in local plugin marketplace shipped with the app bundle.
- **WeCom CLI** (`packages/wecom-cli/`): Workspace-packaged oclif-style CLI for WeChat Work integration.

## Project Conventions

### TypeScript & Module Rules

- Target: ES2020, module: ESNext, moduleResolution: bundler.
- Strict mode is on, including `noUnusedLocals` and `noUnusedParameters`.
- Import paths use `.js` extensions for compiled server files (e.g., `./routes/workspaces.js`), even though source is TypeScript. Vite handles client imports without extensions.
- Path aliases:
  - `@/` → `src/client/`
  - `@server/` → `src/server/`

### Code Style

- ESLint with `@typescript-eslint/recommended` and `react-hooks/recommended`.
- React Refresh rule enabled; prefer named component exports unless constant-export patterns are needed.
- Use `const` arrow functions for handlers; prefer functional `setState` updates when depending on previous state.
- Tailwind classes are composed with `cn()` from `src/client/components/ui/utils.ts`.

### File Naming

- Components: PascalCase (`ChatPanel.tsx`, `SessionListItem.tsx`).
- Stores/hooks/utils: camelCase (`workspace-store.ts`, `use-theme.ts`).
- Server routes/models/services: kebab-case (`workspace-commands.ts`, `sqlite-store.ts`).
- Tests: co-located as `<name>.test.ts` or `<name>.browser.test.tsx`.

## Client Patterns

### State Management

- Use **Zustand** stores in `src/client/stores/`. Keep store logic close to the feature domain (e.g., `chat-store.ts`, `workspace-store.ts`).
- Select only the slices a component needs to avoid unnecessary re-renders.
- Stores talk to the Express backend via `fetch` to `/api/*` routes.

### Components

- Reusable UI primitives live in `src/client/components/ui/`.
- Feature components live directly under `src/client/components/`.
- Tool-specific renderers live in `src/client/components/tool-renderers/`.
- Use `useTranslation('namespace')` for all user-facing strings; namespaces are in `src/client/i18n/{en,zh-CN}/`.

### Theming

- Dark mode is class-based (`dark` class on root). Tailwind config uses CSS variables (`--color-bg`, `--color-surface`, etc.).
- Theme utilities are in `src/client/hooks/use-theme.ts`.

## Server Patterns

### Routes

- Routes are Express `Router` instances in `src/server/routes/`.
- Return JSON shapes like `{ workspaces }`, `{ workspace }`, `{ error }` for consistency.
- Validate required fields inline; return `400` for bad input, `404` when not found, `500` for unexpected errors.

### Services

- Business logic and long-lived state live in `src/server/services/`.
- Services are generally imported as singletons (e.g., `chatService`, `wecomBotService`).
- Keep services free of Express `req`/`res` concerns — pass plain data in and out.

### Models

- TypeScript interfaces for domain entities live in `src/server/models/`.
- Prefer interfaces over classes; these are compile-time contracts only.

### Storage

- `src/server/storage/sqlite-store.ts` is the main workspace/session/session-message store.
- `src/server/storage/data-dir.ts` resolves app data paths.
- `src/server/storage/json-store.ts` provides simple JSON file persistence.

### Logging

- Use `diagLog()` from `src/server/utils/diag-logger.ts` for server-side diagnostic logs.
- Client logs can be posted to `POST /api/log`.
- The Electron shell writes a `main.log` to the app-data `logs/` folder (same folder as the Node logs) in both debug and release builds (see `electron/logger.ts`).

## Testing

- **jsdom tests**: Component and hook tests under `src/client/{components,hooks}/**/*.test.tsx`.
- **Browser tests**: `*.browser.test.tsx` files run with Playwright + Vitest browser mode.
- **Server/lib tests**: Some server utilities and `src/client/lib` files use `node:test` and are excluded from Vitest. Run them with `npm run test:server`.
- **Server SQLite isolation (mandatory)**: Every server test must import `test-utils/test-env` as its **first** statement — it redirects SQLite away from the production `data.db` (via `COMATE_DATA_DIR`) and is enforced by a lint rule plus a runtime guard. Never construct `SqliteStore()` against the default path in a test; use `createIsolatedStore()` or `new SqliteStore(':memory:')`, and reset with `store.resetData()` rather than reaching into the private `db`. See `docs/solutions/conventions/use-isolated-test-database-for-comate.md`.
- Mock globals in `vitest.setup.ts`: `ResizeObserver`, `matchMedia`, `scrollIntoView`.

## Desktop / Electron Notes

- Electron packaging config is `electron-builder.config.ts` (always pass `--config`; it is not auto-discovered).
- Native resources are staged under `resources/` and sidecar binaries under `build/sidecar/` (both build output of `scripts/build-sidecar.ts`, gitignored).
- The Express server is packaged as a sidecar Node process; `scripts/build-sidecar.ts` handles this.
- Renderer access to shell capabilities goes through the single `window.comate` contextBridge surface (`src/client/lib/desktop-api.ts`); the shell side lives in `electron/preload.ts`.

## WeCom Integration

- WeChat Work bot support is a first-class feature.
- Bot settings, isolation policies, and tool permissions live in workspace settings.
- Server-side WeCom services: `wecom-bot-service.ts`, `wecom-user-resolver.ts`, `wecom-queue-worker.ts`.
- CLI package: `packages/wecom-cli/`.
- Built-in skill: `claude-code-plugin/plugins/wecom/`.

## Claude SDK

- The app embeds `@anthropic-ai/claude-agent-sdk` for AI sessions.
- `src/server/services/chat-service.ts` orchestrates streaming chat sessions.
- The app expects a Claude binary to be available in the bundled resources; `/api/health/claude` reports availability.

## Safety & Security

- Treat server routes as API endpoints: validate input, handle errors, and avoid leaking stack traces to clients.
- Workspace settings can store API keys and secrets; never log them.
- WeCom bot isolation and bash whitelisting exist to constrain untrusted bot users — respect those boundaries when adding features.
- File operations are scoped to the workspace's `folderPath`; do not traverse outside it.

## Dependency Notes

- `better-sqlite3` requires native bindings; the prebuilt `.node` resource ships in the app resources and must match the sidecar's Node ABI.
- `@vscode/ripgrep` powers the fast file picker.
- `shiki` is used for syntax highlighting.
- `streamdown` renders streaming markdown.

## When Modifying Code

1. Run `npm run lint` before committing.
2. Add or update tests for changed behavior.
3. Update `CHANGELOG.md` for user-facing changes (follow Keep a Changelog format).
4. Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.
5. For new features, consider creating a plan doc under `docs/plans/` if the change is non-trivial.
6. Consult `docs/solutions/` — documented solutions to past problems (bugs, best practices, conventions), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`) — when implementing or debugging in documented areas; `CONCEPTS.md` at the repo root defines shared domain vocabulary.

## Common Pitfalls

- **Port conflicts**: `npm run dev` and `npm run dev:electron` both want Vite's port. Use only one.
- **Server `.js` imports**: TypeScript source files import each other with `.js` extensions so compiled ESM works.
- **Resource paths**: Resources move in production; resolve them via `TAURI_RESOURCE_DIR` consumers or `src/server/utils/path-config.ts` rather than hardcoding paths.
- **Zustand subscriptions**: Selecting whole stores causes re-renders; select only needed fields.
- **i18n**: Add keys to both `en` and `zh-CN` namespaces; use `i18next.t('namespace:key', 'Fallback')`.
