/**
 * U3 (R3, KTD-9, KTD-13): electron-builder v26 packaging configuration.
 *
 * Functional config (loaded by electron-builder via jiti) so that:
 *  - the enterprise (claude-free) variant is gated by COMATE_BUNDLE_BACKENDS,
 *    exactly like scripts/build-sidecar.ts: the artifact name carries a
 *    variant suffix and the publish channel differs, so update manifests of
 *    the two flavors can never cross-wire (KTD-13);
 *  - signing is conditional on CI-injected credentials: with credentials the
 *    build signs/notarizes; without them it skips signing AND emits no
 *    electron-updater manifests (latest*.yml) — never a half-signed release
 *    (U3 error scenario);
 *  - `npmRebuild: false` pins the better-sqlite3 ABI guard (KTD-1): the shell
 *    has zero native modules, and an Electron-ABI rebuild of better-sqlite3
 *    would corrupt the system-Node sidecar resource. Nothing is rebuilt.
 *
 * IMPORTANT: electron-builder's default config discovery only probes
 * `electron-builder.{yml,yaml,json,json5,toml,js,cjs,ts}` — this file is NOT
 * auto-discovered. Always invoke with `--config electron-builder.config.ts`
 * (see the `dist:electron` npm script); a bare `electron-builder` run silently
 * builds with defaults (wrong layout, and it will attempt an Electron-ABI
 * rebuild of better-sqlite3). U4 CI must use the npm script or the flag.
 *
 * Resource layout (consumed by electron/sidecar.ts):
 *  - build/sidecar/sidecar-node-<arch>[.exe] (staged by build-sidecar.ts)
 *    → <resourcesPath>/sidecar-node[.exe]        (never inside the asar)
 *  - resources/ → <resourcesPath>/resources/  (TAURI_RESOURCE_DIR keeps its
 *    name — the server-side resolvers consume it, KTD-13)
 *  - build/icon.png → <resourcesPath>/icon.png (window/tray icon, electron/main.ts)
 *
 * The updater endpoint (provider github / owner ai-dvps / repo comate) is
 * asserted by src/client/lib/updater-config.test.ts as source text — keep the
 * literal block below intact.
 */
import type { Configuration } from 'electron-builder';

// ---------------------------------------------------------------------------
// Enterprise variant gate (mirrors scripts/build-sidecar.ts)
// ---------------------------------------------------------------------------

const bundleBackends = new Set(
  (process.env.COMATE_BUNDLE_BACKENDS ?? 'claude,opencode')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean),
);
const isEnterpriseVariant = !bundleBackends.has('claude');
const variantSuffix = isEnterpriseVariant ? '-enterprise' : '';
// Independent update channel per flavor (System-Wide Impact: 企业变体走独立更新通道).
// electron-updater reads the channel from the packaged app-update.yml and
// fetches <channel>.yml / <channel>-mac.yml from the release.
const updateChannel = isEnterpriseVariant ? 'latest-enterprise' : 'latest';

// ---------------------------------------------------------------------------
// Conditional signing (KTD-9). Credentials are env-injected by CI (U4);
// absent locally. Unsigned builds must NOT emit update manifests.
// ---------------------------------------------------------------------------

const platform = process.platform;

// macOS: CSC_LINK (base64 p12) or CSC_NAME (keychain identity), injected by CI.
const macSigningEnabled = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);
// Notarize via App Store Connect API key (notarytool): key file + id + issuer.
const macNotarizeEnabled = Boolean(
  process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER,
);

// Windows: Azure Trusted Signing (KTD-9 "云签名"). Auth itself uses the
// standard Microsoft Entra env vars (AZURE_TENANT_ID / AZURE_CLIENT_ID /
// AZURE_CLIENT_SECRET); the four below describe the signing account/profile.
type AzureSignOptions = NonNullable<NonNullable<Configuration['win']>['azureSignOptions']>;

function readWinAzureSignOptions(): AzureSignOptions | null {
  const publisherName = process.env.AZURE_TRUSTED_SIGNING_PUBLISHER;
  const endpoint = process.env.AZURE_TRUSTED_SIGNING_ENDPOINT;
  const certificateProfileName = process.env.AZURE_TRUSTED_SIGNING_CERT_PROFILE;
  const codeSigningAccountName = process.env.AZURE_TRUSTED_SIGNING_ACCOUNT;
  if (!publisherName || !endpoint || !certificateProfileName || !codeSigningAccountName) {
    return null;
  }
  return { publisherName, endpoint, certificateProfileName, codeSigningAccountName };
}

const winAzureSignOptions = readWinAzureSignOptions();
const winSigningEnabled = winAzureSignOptions !== null;

// A platform release is "release-ready" only when the artifacts will be
// usable by end users: macOS requires signature AND notarization (unsigned or
// un-notarized apps cannot auto-update / are Gatekeeper-blocked), Windows
// requires Authenticode. Linux (AppImage/deb) has no signing requirement
// (KTD-9 covers mac + Windows only) and is config-only until U10.
const releaseReady =
  platform === 'darwin'
    ? macSigningEnabled && macNotarizeEnabled
    : platform === 'win32'
      ? winSigningEnabled
      : true;

const githubPublish: Configuration['publish'] = [
  {
    provider: 'github',
    owner: 'ai-dvps',
    repo: 'comate',
    channel: updateChannel,
  },
];

if (!releaseReady) {
  console.log(
    `[electron-builder.config] ${platform} signing credentials absent — ` +
      'building UNSIGNED and suppressing update manifests (publish: null).',
  );
}

const config: Configuration = {
  appId: 'com.comate.app',
  productName: 'Comate',
  // Artifact names carry the variant suffix so enterprise and default
  // manifests can never reference each other's files (KTD-13).
  artifactName: `\${productName}-\${version}${variantSuffix}-\${os}-\${arch}.\${ext}`,
  directories: {
    buildResources: 'build',
    output: 'release',
  },
  // The bundled shell (dist-electron/main.cjs) requires only `electron` and
  // node builtins: electron-vite externalizes package.json `dependencies` but
  // BUNDLES devDependencies — electron-updater (U5) ships inside main.cjs this
  // way (verified: "app-update.yml" strings present, no bare
  // require("electron-updater")). Excluding node_modules keeps ~700 MB of
  // server prod deps (better-sqlite3, playwright, …) out of the asar. A future
  // shell runtime dep listed under `dependencies` must be whitelisted back
  // with a `node_modules/<pkg>/**` pattern (or moved to devDependencies).
  files: ['dist-electron/**', 'dist/client/**', 'package.json', '!node_modules/**'],
  // asar stays on for the shell code; the sidecar binary and all big
  // resources live in extraResources below — NEVER inside the asar.
  asar: true,
  // ABI guard (KTD-1): better-sqlite3 runs in the sidecar under system Node.
  // The shell itself has no native modules, so electron-builder must not
  // rebuild anything against the Electron ABI.
  npmRebuild: false,
  electronFuses: {
    runAsNode: false,
    onlyLoadAppFromAsar: true,
    enableEmbeddedAsarIntegrityValidation: true,
  },
  // No manifests without a release-ready signing chain (no half-signed releases).
  publish: releaseReady ? githubPublish : null,

  extraResources: [
    // Sidecar binary for the target arch, staged by scripts/build-sidecar.ts
    // into build/sidecar/ with electron-builder macro-compatible names.
    platform === 'win32'
      ? { from: 'build/sidecar/sidecar-node-x64.exe', to: 'sidecar-node.exe' }
      : { from: 'build/sidecar/sidecar-node-${arch}', to: 'sidecar-node' },
    {
      from: 'resources',
      to: 'resources',
      // Belt-and-suspenders on top of the build-sidecar assertion gate: the
      // enterprise flavor must not ship a claude binary even if a stale one
      // is sitting in the staging tree.
      filter: isEnterpriseVariant ? ['**/*', '!claude', '!claude.exe'] : ['**/*'],
    },
    // Window/tray icon consumed at runtime by electron/main.ts.
    { from: 'build/icon.png', to: 'icon.png' },
  ],

  mac: {
    category: 'public.app-category.productivity',
    // zip is required for electron-updater auto-update; dmg is the installer.
    target: ['dmg', 'zip'],
    icon: 'build/icon.icns',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // identity: null skips signing explicitly (no keychain scan); undefined
    // lets electron-builder auto-detect the CI-imported certificate.
    identity: macSigningEnabled ? undefined : null,
    notarize: macSigningEnabled && macNotarizeEnabled,
  },

  win: {
    target: ['nsis'],
    icon: 'build/icon.ico',
    azureSignOptions: winAzureSignOptions,
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    // KTD-8 bridge cleanup (U6): detects a legacy per-machine Tauri MSI and
    // uninstalls it via UI msiexec /x (one UAC prompt); on refusal/failure it
    // neutralizes the old all-users entry points and shows a one-time notice.
    include: 'build/nsis-include.nsh',
  },

  // Linux targets configured now (R3) but kept OUT of the CI matrix until U10.
  linux: {
    target: ['AppImage', 'deb'],
    icon: 'build/icon.png',
    category: 'Utility',
  },
};

export default config;
