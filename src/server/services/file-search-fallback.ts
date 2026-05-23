import { readFile } from 'fs/promises';
import path from 'path';
import { fdir } from 'fdir';
import ignore from 'ignore';
import type { Ignore } from 'ignore';

export interface FallbackInput {
  workspaceRoot: string;
  query: string;
  signal?: AbortSignal;
}

// Hard excludes match the ripgrep flags in file-search.ts: .git and node_modules
// are always skipped regardless of whether a .gitignore exists.
const HARD_EXCLUDES = new Set(['.git', 'node_modules']);

interface IgnoreLayer {
  // Posix-style directory path relative to workspace root. Empty string for root.
  dir: string;
  ig: Ignore;
}

/**
 * Collect every .gitignore in the workspace and build a layered matcher. Each
 * layer matches paths relative to its own directory, which preserves the
 * gitignore spec's behavior of nested files applying only within their subtree.
 * Negations that cross layers are not perfectly resolved — fallback is the
 * degraded path and this is good enough for AE4.
 */
async function buildIgnoreLayers(workspaceRoot: string): Promise<IgnoreLayer[]> {
  const finder = new fdir()
    .withRelativePaths()
    .glob('**/.gitignore')
    .exclude((name) => HARD_EXCLUDES.has(name))
    .crawl(workspaceRoot);
  const paths = (await finder.withPromise()) as string[];

  const layers: IgnoreLayer[] = [];
  for (const rel of paths) {
    const normalized = rel.split(path.sep).join('/');
    const dirPosix = path.posix.dirname(normalized);
    let content: string;
    try {
      content = await readFile(path.join(workspaceRoot, normalized), 'utf8');
    } catch {
      continue;
    }
    layers.push({
      dir: dirPosix === '.' ? '' : dirPosix,
      ig: ignore().add(content),
    });
  }

  // Shallowest first so root-level rules are evaluated before nested ones.
  layers.sort((a, b) => a.dir.length - b.dir.length);
  return layers;
}

function isIgnored(relPath: string, layers: IgnoreLayer[]): boolean {
  for (const { dir, ig } of layers) {
    if (dir === '') {
      if (ig.ignores(relPath)) return true;
      continue;
    }
    if (relPath === dir || relPath.startsWith(`${dir}/`)) {
      const relativeToLayer = relPath.slice(dir.length + 1);
      if (relativeToLayer && ig.ignores(relativeToLayer)) return true;
    }
  }
  return false;
}

export async function fallbackWalk(
  options: FallbackInput,
  candidateBudget: number,
): Promise<{ paths: string[]; truncated: boolean }> {
  const { workspaceRoot, signal } = options;

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const layers = await buildIgnoreLayers(workspaceRoot);

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const collected: string[] = [];
  let truncated = false;

  const crawler = new fdir()
    .withRelativePaths()
    .exclude((name) => HARD_EXCLUDES.has(name))
    .filter((p) => {
      if (signal?.aborted) return false;
      if (collected.length >= candidateBudget) return false;
      const normalized = p.split(path.sep).join('/');
      if (isIgnored(normalized, layers)) return false;
      collected.push(normalized);
      if (collected.length >= candidateBudget) {
        truncated = true;
      }
      return false; // We collect via side effect; don't double-track in fdir's result array.
    })
    .crawl(workspaceRoot);

  await crawler.withPromise();

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  return { paths: collected, truncated };
}
