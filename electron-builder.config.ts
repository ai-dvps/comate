/**
 * U2 placeholder — minimal electron-builder configuration carrying only the
 * updater publish contract (GitHub releases endpoint) so the client updater
 * config test has a single source of truth to assert against.
 *
 * TODO(U3): flesh this out into the full packaging config (mac dmg+zip with
 * notarization, Windows NSIS, Linux AppImage+deb, extraResources layout,
 * fuses, enterprise variant gating) per the migration plan. U3 also adds the
 * `electron-builder` dependency and the `Configuration` type for this object.
 */
const config = {
  appId: 'com.comate.app',
  publish: [
    {
      provider: 'github',
      owner: 'ai-dvps',
      repo: 'comate',
    },
  ],
} as const;

export default config;
