import { readdirSync, existsSync } from 'fs';
import { join, relative } from 'path';

/**
 * Build-time supply-chain gates over the staged resource tree.
 *
 * Consumer: scripts/build-sidecar.ts runs the dangling-symlink and
 * non-ASCII-path gates over the ENTIRE resources/ tree at the end of resource
 * staging (KTD-13; electron-builder ships that whole tree via extraResources).
 *
 * Pure functions over a directory, unit-tested in
 * native-artifact-audit.test.ts.
 */

export function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Build gate for symlinks: a dangling symlink anywhere in the staged resource
 * tree must fail the build before packaging — under electron-builder the whole
 * tree ships via extraResources and a broken link would be silently copied
 * into the installed app (the legacy bundler aborted with `resource path ...
 * doesn't exist`; the error message below keeps that string). The classic
 * offender is an npm `.bin` link that fs.cpSync rewrote from relative to
 * absolute-into-the-temp-build-dir (its default resolves link targets against
 * the source tree; verbatimSymlinks: true preserves them). Symlinked
 * directories are not recursed into, matching walkFiles.
 */
export function findDanglingSymlinks(dir: string): string[] {
  const offenders: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        // existsSync follows the link, so a dangling target reads as false.
        if (!existsSync(full)) {
          offenders.push(relative(dir, full));
        }
      } else if (entry.isDirectory()) {
        walk(full);
      }
    }
  };
  walk(dir);
  return offenders;
}

export function assertNoDanglingSymlinks(dir: string): void {
  const offenders = findDanglingSymlinks(dir);
  if (offenders.length > 0) {
    throw new Error(
      `dangling symlinks found in vendored tree (build gate):\n  ` +
        offenders.join('\n  ') +
        '\nPackagers fail on these ("resource path ... doesn\'t exist"). ' +
        'Copy node_modules trees with verbatimSymlinks: true so npm .bin links stay relative.',
    );
  }
}

/**
 * Build gate for non-ASCII paths. Origin: the legacy Windows MSI bundler (WiX
 * light.exe) defaulted to database code page 1252 (Latin-1) and aborted with
 * LGHT0311 on any harvested path outside that code page (e.g. CJK, emoji —
 * @fastify/send ships a `test/fixtures/snow ☃` fixture). The MSI target is
 * retired (KTD-8: NSIS is the Windows primary), but the gate is retained as a
 * conservative cross-platform packaging guard: non-ASCII names in shipped
 * resources are almost always leaked test fixtures, never runtime files, and
 * they keep tripping archiving/signing tooling in hard-to-diagnose ways.
 * Checking the full relative path (not just the basename) also catches
 * non-ASCII directory names, since they appear in every descendant's path.
 */
const NON_ASCII = /[^\x20-\x7E]/;

/** Lists offending relative paths, empty when clean. */
export function findNonAsciiPaths(dir: string): string[] {
  const offenders: string[] = [];
  for (const file of walkFiles(dir)) {
    if (NON_ASCII.test(relative(dir, file))) {
      offenders.push(relative(dir, file));
    }
  }
  return offenders;
}

export function assertNoNonAsciiPaths(dir: string): void {
  const offenders = findNonAsciiPaths(dir);
  if (offenders.length > 0) {
    throw new Error(
      `non-ASCII paths found in vendored tree (build gate):\n  ` +
        offenders.join('\n  ') +
        '\nLegacy packaging tooling (WiX light.exe, code page 1252) aborts on such ' +
        'characters. Strip the offending test/non-runtime directory during staging.',
    );
  }
}
