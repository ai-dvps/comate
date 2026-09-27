/** Resolve the exact Codex native binary shipped with @openai/codex. */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { normalizeWindowsPath } from './normalize-windows-path.js';
import { sidecarLog } from './sidecar-logger.js';

export const CODEX_EXPECTED_VERSION = '0.149.0';

export function codexPlatformPackage(platform: NodeJS.Platform, arch: string): string {
  if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new Error(`Unsupported Codex platform: ${platform}-${arch}`);
  }
  return `@openai/codex-${platform}-${arch}`;
}

export function codexVendorTriple(platform: NodeJS.Platform, arch: string): string {
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (platform === 'darwin') return `${cpu}-apple-darwin`;
  if (platform === 'linux') return `${cpu}-unknown-linux-musl`;
  if (platform === 'win32') return `${cpu}-pc-windows-msvc`;
  throw new Error(`Unsupported Codex platform: ${platform}-${arch}`);
}

export function resolveCodexBinary(): string | undefined {
  const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const packageName = codexPlatformPackage(process.platform, process.arch);
  const triple = codexVendorTriple(process.platform, process.arch);
  try {
    const packageJson = createRequire(import.meta.url).resolve(`${packageName}/package.json`);
    const binary = normalizeWindowsPath(path.join(path.dirname(packageJson), 'vendor', triple, 'bin', binaryName));
    if (existsSync(binary)) return binary;
  } catch (error) {
    sidecarLog(`[resolveCodexBinary] pinned package unavailable: ${String(error)}`);
  }

  const executableDir = path.dirname(process.execPath);
  const resourceRoots = [
    process.env.COMATE_RESOURCE_DIR,
    process.env.TAURI_RESOURCE_DIR,
    executableDir,
    path.join(executableDir, 'resources'),
  ].filter((value): value is string => Boolean(value));
  for (const root of resourceRoots) {
    for (const candidate of [
      path.join(root, 'codex-runtime', 'vendor', triple, 'bin', binaryName),
      path.join(root, 'resources', 'codex-runtime', 'vendor', triple, 'bin', binaryName),
    ]) {
      const normalized = normalizeWindowsPath(candidate);
      if (existsSync(normalized)) return normalized;
    }
  }
  sidecarLog('[resolveCodexBinary] no pinned or staged binary found');
  return undefined;
}
