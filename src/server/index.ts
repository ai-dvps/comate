// Entrypoint dispatcher.
//
// Re-exec-self (KTD-2): launched with COMATE_STEEL=1, this same process/binary
// hosts the vendored Steel API server instead of the Comate sidecar API —
// the packaged sidecar has no `node` to spawn, so Steel rides the same binary
// (mirrors the COMATE_SIDECAR=1 precedent in src-tauri/src/lib.rs).
//
// The branch must run BEFORE any Comate module loads (several open the SQLite
// store at import time, which a Steel child process must not do), so both legs
// sit behind dynamic imports. In the pkg bundle the steel leg's downstream
// `import()` of the vendored entrypoint must survive as a NATIVE dynamic
// import (real filesystem, ESM graph with top-level await) — build-sidecar.ts
// passes esbuild `--supported:dynamic-import=true` for exactly this reason.

async function main(): Promise<void> {
  if (process.env.COMATE_STEEL === '1') {
    const { bootSteelEntrypoint } = await import('./steel-entrypoint.js');
    await bootSteelEntrypoint();
  } else {
    await import('./server-main.js');
  }
}

main().catch((err) => {
  console.error('Fatal error during startup:', err);
  process.exit(1);
});
