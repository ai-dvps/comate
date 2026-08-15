export const SIDECAR_NODE_MAJOR = 22;

export function getNodeMajor(version: string): number {
  const match = /^v?(\d+)\./.exec(version);
  if (!match) {
    throw new Error(`Unable to determine Node major version from ${JSON.stringify(version)}`);
  }
  return Number(match[1]);
}

export function assertSupportedSidecarBuildNode(version = process.version): void {
  const detectedMajor = getNodeMajor(version);
  if (detectedMajor !== SIDECAR_NODE_MAJOR) {
    throw new Error(
      `Sidecar builds require Node ${SIDECAR_NODE_MAJOR}.x, but ${version} is running. ` +
        `Run \`nvm use\` (or activate another Node ${SIDECAR_NODE_MAJOR} environment), ` +
        `reinstall/rebuild native dependencies, and retry.`,
    );
  }
}

export function getSidecarPkgTarget(triple: string): string {
  if (triple.includes('aarch64-apple-darwin')) {
    return `node${SIDECAR_NODE_MAJOR}-darwin-arm64`;
  }
  if (triple.includes('x86_64-apple-darwin')) {
    return `node${SIDECAR_NODE_MAJOR}-darwin-x64`;
  }
  if (triple.includes('x86_64-pc-windows-msvc')) {
    return `node${SIDECAR_NODE_MAJOR}-win-x64`;
  }
  if (triple.includes('x86_64-unknown-linux-gnu')) {
    return `node${SIDECAR_NODE_MAJOR}-linux-x64`;
  }
  if (triple.includes('aarch64-unknown-linux-gnu')) {
    return `node${SIDECAR_NODE_MAJOR}-linux-arm64`;
  }
  throw new Error(`Unsupported target triple: ${triple}`);
}
