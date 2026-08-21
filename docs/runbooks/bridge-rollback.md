# Retired Tauri updater bridge

The temporary Tauri-to-Electron updater bridge was retired on 2026-08-21.
Current releases use `electron-updater` and publish only `latest.yml`,
`latest-mac.yml`, and `latest-linux.yml` (plus their package metadata and
blockmaps).

The following bridge-only components no longer exist:

- the `bridge-manifest` GitHub Actions job;
- Tauri minisign credentials and signing steps;
- `scripts/build-bridge-manifest.ts` and its tests;
- newly generated `latest.json`, `.app.tar.gz`, and Tauri `.sig` assets.

Previously published releases and migration plans remain the historical record
of the original bridge. Do not rewrite their assets. Windows installers still
retain the independent legacy-MSI cleanup in `build/nsis-include.nsh` so users
with an old per-machine installation do not end up with duplicate entries.

For current release validation, use the Electron release workflow and the
platform smoke checklists in this directory.
