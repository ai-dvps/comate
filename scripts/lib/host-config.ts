/**
 * Shared host/build configuration, side-effect-free.
 *
 * Single source of truth for the Rust-style target triple map and the
 * COMATE_BUNDLE_BACKENDS CSV parse, previously mirrored across
 * scripts/build-sidecar.ts, electron-builder.config.ts, and
 * electron/sidecar.ts (`resolveSidecarTriple` — same map, same
 * throw-on-unsupported contract).
 *
 * Lives under scripts/lib/ because it is consumed by tsx-run scripts and by
 * electron-builder.config.ts (jiti); electron/sidecar.ts imports it via a
 * relative path and electron-vite bundles it into the main process.
 */

/** Rust-style target triple for a platform/arch pair (host or cross). */
export function resolveHostTriple(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (platform === 'win32') {
    return 'x86_64-pc-windows-msvc';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }
  throw new Error(`Unsupported platform: ${platform}-${arch}`);
}

/**
 * Parse COMATE_BUNDLE_BACKENDS ('claude,opencode,codex' when unset) into the set of
 * agent backends to ship. Unknown entries are kept — the consumers only test
 * membership.
 */
export function parseBundleBackends(envValue: string | undefined): Set<string> {
  return new Set(
    (envValue ?? 'claude,opencode,codex')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}
