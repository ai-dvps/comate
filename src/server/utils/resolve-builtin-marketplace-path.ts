import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export function resolveBuiltInMarketplacePath(): string | undefined {
  const candidates: string[] = [];

  if (process.env.TAURI_RESOURCE_DIR) {
    candidates.push(path.join(process.env.TAURI_RESOURCE_DIR, 'claude-code-plugin'));
  }

  // Development / unpackaged fallback: resolve from repo root next to src/server or dist/server.
  // pkg-bundled binaries may not provide a usable import.meta.url, so guard against failures.
  let moduleDir: string | undefined;
  try {
    moduleDir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    moduleDir = undefined;
  }
  if (moduleDir) {
    candidates.push(
      path.join(moduleDir, '..', '..', 'claude-code-plugin'),
      path.join(moduleDir, '..', '..', '..', 'claude-code-plugin'),
    );
  }

  // pkg-bundled sidecar fallback: resolve from the executable directory.
  // In `tauri dev` the sidecar lives in src-tauri/binaries, two levels above the repo root.
  const execDir = path.dirname(process.execPath);
  candidates.push(
    path.join(execDir, '..', '..', 'claude-code-plugin'),
    path.join(execDir, '..', '..', '..', 'claude-code-plugin'),
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
