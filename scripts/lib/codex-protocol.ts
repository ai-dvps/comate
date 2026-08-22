import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Adapt Codex's bundler-style TS output to this repository's NodeNext imports. */
export function normalizeCodexProtocolImports(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      normalizeCodexProtocolImports(absolute);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const source = readFileSync(absolute, 'utf8');
    const normalized = source.replace(
      /(from\s+["'])(\.{1,2}\/[^"']+?)(["'];)/g,
      (_match, prefix: string, specifier: string, suffix: string) => {
        if (specifier.endsWith('.js')) return `${prefix}${specifier}${suffix}`;
        let normalizedSpecifier = `${specifier}.js`;
        try {
          if (statSync(path.resolve(path.dirname(absolute), specifier)).isDirectory()) {
            normalizedSpecifier = `${specifier}/index.js`;
          }
        } catch {
          // The generated graph is validated by TypeScript after normalization.
        }
        return `${prefix}${normalizedSpecifier}${suffix}`;
      },
    );
    if (normalized !== source) writeFileSync(absolute, normalized);
  }
}
