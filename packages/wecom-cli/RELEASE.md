# CLI Release Process

This document describes how to release a new version of `@webank/wecom`.

## Prerequisites
- `wnpm` CLI configured on your machine

## Release Steps

1. **Bump version** in `package.json`
   - Follow semantic versioning (major.minor.patch)
   - For new features: bump minor version (e.g., 1.0.0 → 1.1.0)
   - For bug fixes: bump patch version (e.g., 1.1.0 → 1.1.1)
   - For breaking changes: bump major version (e.g., 1.1.0 → 2.0.0)

2. **Build the package**
   ```bash
   npm run build
   ```

3. **Update dependent skill version requirements**
   The WeCom skills in `claude-code-plugin/plugins/wecom/skills/` verify the installed CLI version before invoking commands. After bumping the CLI version, update every `Expected: X.Y.Z or higher` reference in those `SKILL.md` files to match the new release.

4. **Publish to registry**
   ```bash
   wnpm publish 
   ```

## Notes

- The `prepublishOnly` hook in `package.json` automatically runs `npm run build` before publishing, so you can skip step 2 if you want
- Verify the publish succeeded by checking the registry output for `+ @webank/wecom@<version>`

## Release History

### 1.0.1
- Fixed `wecom --version` to read from `package.json` instead of a hardcoded value.
- Updated dependent WeCom skills (`send-wecom-file`, `send-wecom-msg`, `wecom-doc`) to require CLI `1.0.1` or higher.
- Synced workspace lockfile versions.
