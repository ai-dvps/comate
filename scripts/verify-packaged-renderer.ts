import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage } from '@electron/asar';

const INDEX_PATH = '/dist/client/index.html';

export function normalizeArchiveEntryPath(entryPath: string): string {
  return entryPath.replaceAll('\\', '/');
}

function findAppArchives(root: string): string[] {
  const archives: string[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === 'app.asar') {
        archives.push(entryPath);
      } else if (entry.isDirectory()) {
        walk(entryPath);
      }
    }
  }

  walk(root);
  return archives.sort();
}

function verifyRendererArchive(archivePath: string): void {
  const entries = new Set(
    listPackage(archivePath, { isPack: false }).map(normalizeArchiveEntryPath),
  );
  assert.ok(entries.has(INDEX_PATH), `${archivePath} is missing ${INDEX_PATH}`);

  const html = extractFile(archivePath, INDEX_PATH.slice(1)).toString('utf8');
  const assetPaths = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map(
    ([, assetPath]) => `/dist/client${assetPath}`,
  );
  assert.ok(
    assetPaths.some((assetPath) => assetPath.endsWith('.js')),
    `${archivePath} renderer index has no JavaScript entry asset`,
  );

  const missingAssets = assetPaths.filter((assetPath) => !entries.has(assetPath));
  assert.deepEqual(missingAssets, [], `${archivePath} is missing renderer assets`);
}

export function verifyPackagedRenderers(root: string): string[] {
  const archives = findAppArchives(root);
  assert.ok(archives.length > 0, `no app.asar archives found under ${root}`);
  for (const archive of archives) verifyRendererArchive(archive);
  return archives;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (fileURLToPath(import.meta.url) === invokedPath) {
  const root = path.resolve(process.argv[2] ?? 'release');
  const archives = verifyPackagedRenderers(root);
  console.log(`Packaged renderer verified in ${archives.length} archive(s)`);
}
