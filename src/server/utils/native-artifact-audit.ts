import { readdirSync, readFileSync, statSync } from 'fs';
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
