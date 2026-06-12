import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export function resolveBuiltInMarketplacePath(): string | undefined {
  const candidates: string[] = [];

  if (process.env.TAURI_RESOURCE_DIR) {
    candidates.push(path.join(process.env.TAURI_RESOURCE_DIR, 'claude-code-plugin'));
  }

  // Development / unpackaged fallback: resolve from repo root next to src/server or dist/server
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(
    path.join(__dirname, '..', '..', 'claude-code-plugin'),
    path.join(__dirname, '..', '..', '..', 'claude-code-plugin'),
  );

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
