export function basename(filePath: string): string {
  if (!filePath) return ''
  const normalized = filePath.replace(/\\+/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1)
}

export function dirname(filePath: string): string {
  if (!filePath) return ''
  const normalized = filePath.replace(/\\+/g, '/')
  const lastSlash = normalized.lastIndexOf('/')
  return lastSlash === -1 ? '' : normalized.slice(0, lastSlash)
}

export interface PathDisplayInfo {
  displayAbsolute: string
  displayRelative: string
}

export function getPathDisplayInfo(
  relativePath: string,
  workspacePath?: string,
): PathDisplayInfo {
  const displayAbsolute = workspacePath
    ? `${workspacePath.replace(/\\+/g, '/')}/${relativePath.replace(/\\+/g, '/')}`
    : relativePath.replace(/\\+/g, '/')
  return {
    displayAbsolute,
    displayRelative: relativePath.replace(/\\+/g, '/'),
  }
}
