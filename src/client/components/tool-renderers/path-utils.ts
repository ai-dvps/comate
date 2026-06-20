export interface PathDisplayInfo {
  displayText: string
  displayAbsolute: string
  relativePath: string | null
  isInsideWorkspace: boolean
}

export function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, '/')
  const isAbs = normalized.startsWith('/')
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.')
  const resolved: string[] = []

  for (const segment of segments) {
    if (segment === '..') {
      if (resolved.length > 0 && resolved[resolved.length - 1] !== '..') {
        resolved.pop()
      } else if (!isAbs) {
        resolved.push('..')
      }
    } else {
      resolved.push(segment)
    }
  }

  const joined = resolved.join('/')
  return isAbs ? `/${joined}` : joined
}

export function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, '') || '/'
}

export function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(idx + 1) : p
}

export function truncateStart(text: string, maxLength: number): string {
  if (maxLength <= 0) return ''
  if (text.length <= maxLength) return text
  return `…${text.slice(-(maxLength - 1))}`
}

export function getRelativePath(absPath: string, workspacePath: string): string | null {
  const normPath = normalizePath(absPath)
  const normWorkspace = normalizePath(workspacePath)
  const workspacePrefix = normWorkspace.endsWith('/')
    ? normWorkspace
    : `${normWorkspace}/`

  if (normPath === normWorkspace) {
    return '.'
  }

  if (normPath.startsWith(workspacePrefix)) {
    return normPath.slice(workspacePrefix.length)
  }

  return null
}

export function getPathDisplayInfo(
  path: string,
  workspacePath?: string,
): PathDisplayInfo {
  const normalizedPath = normalizePath(path)
  const displayAbsolute = stripTrailingSlash(normalizedPath)

  if (!workspacePath) {
    return {
      displayText: displayAbsolute,
      displayAbsolute,
      relativePath: null,
      isInsideWorkspace: false,
    }
  }

  const relativePath = getRelativePath(path, workspacePath)
  if (relativePath === null) {
    return {
      displayText: displayAbsolute,
      displayAbsolute,
      relativePath: null,
      isInsideWorkspace: false,
    }
  }

  return {
    displayText: stripTrailingSlash(relativePath) || relativePath,
    displayAbsolute,
    relativePath,
    isInsideWorkspace: true,
  }
}
