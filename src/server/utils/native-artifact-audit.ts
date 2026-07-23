import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';

/**
 * Build-time supply-chain gate for the vendored Steel tree (KTD-2): the tree
 * must be pure JS. Any `.node` / Mach-O / PE / ELF artifact fails the build —
 * macOS universal shares one resources directory across architectures, so a
 * stray native binary would silently break one architecture.
 *
 * Pure functions over a directory, unit-tested in
 * native-artifact-audit.test.ts; consumed by scripts/build-steel-bundle.ts.
 */

const MAGIC_SIGNATURES: Array<{ name: string; bytes: number[] }> = [
  { name: 'Mach-O', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { name: 'Mach-O', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: 'Mach-O', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O fat/universal', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: 'Mach-O fat/universal', bytes: [0xca, 0xfe, 0xba, 0xbf] },
  { name: 'PE', bytes: [0x4d, 0x5a] },
  { name: 'ELF', bytes: [0x7f, 0x45, 0x4c, 0x46] },
];

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

/** Returns the native artifact kind ('.node', 'Mach-O', 'PE', 'ELF') or undefined. */
export function detectNativeKind(filePath: string): string | undefined {
  if (filePath.endsWith('.node')) {
    return '.node';
  }
  const content = readFileSync(filePath);
  if (content.length < 4) {
    return undefined;
  }
  for (const sig of MAGIC_SIGNATURES) {
    if (sig.bytes.every((b, i) => content[i] === b)) {
      return sig.name;
    }
  }
  return undefined;
}

/** Lists offending files as `<kind>: <relative path>`, empty when clean. */
export function findNativeArtifacts(dir: string): string[] {
  const offenders: string[] = [];
  for (const file of walkFiles(dir)) {
    const kind = detectNativeKind(file);
    if (kind) {
      offenders.push(`${kind}: ${relative(dir, file)}`);
    }
  }
  return offenders;
}

export function assertNoNativeArtifacts(dir: string): void {
  const offenders = findNativeArtifacts(dir);
  if (offenders.length > 0) {
    throw new Error(
      `native artifacts found in vendored tree (build gate):\n  ` +
        offenders.join('\n  ') +
        '\nSteel must ship pure JS only — stub or remove the responsible dependency.',
    );
  }
}

/**
 * Build gate for symlinks: the Tauri bundler walks the vendored tree and
 * aborts with `resource path ... doesn't exist` on any symlink whose target
 * is missing. The classic offender is an npm `.bin` link that fs.cpSync
 * rewrote from relative to absolute-into-the-temp-build-dir (its default
 * resolves link targets against the source tree; verbatimSymlinks: true
 * preserves them). Symlinked directories are not recursed into, matching
 * walkFiles.
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
        '\nThe Tauri bundler fails on these ("resource path ... doesn\'t exist"). ' +
        'Copy node_modules trees with verbatimSymlinks: true so npm .bin links stay relative.',
    );
  }
}

/**
 * Build gate for non-ASCII paths. The Windows MSI bundler (WiX light.exe)
 * defaults to database code page 1252 (Latin-1) and aborts with LGHT0311 on any
 * harvested path whose name contains a character outside that code page (e.g.
 * CJK, emoji — @fastify/send ships a `test/fixtures/snow ☃` fixture). Tauri
 * swallows light.exe's stderr, so without this gate the failure surfaces only
 * as a cryptic remote "failed to run light.exe". Checking the full relative
 * path (not just the basename) also catches non-ASCII directory names, since
 * they appear in every descendant's path.
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
        '\nThe Windows MSI bundler (WiX light.exe) uses code page 1252 and aborts with ' +
        'LGHT0311 on such characters; Tauri swallows the error. ' +
        'Strip the offending test/non-runtime directory during vendoring (pruneNonRuntimeDirs).',
    );
  }
}

export function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const file of walkFiles(dir)) {
    total += statSync(file).size;
  }
  return total;
}

export function assertSizeBudget(dir: string, maxBytes: number): number {
  const bytes = dirSizeBytes(dir);
  if (bytes > maxBytes) {
    const mib = (bytes / (1024 * 1024)).toFixed(1);
    const budgetMib = (maxBytes / (1024 * 1024)).toFixed(0);
    throw new Error(`vendored tree is ${mib} MiB, over the ${budgetMib} MiB budget`);
  }
  return bytes;
}
