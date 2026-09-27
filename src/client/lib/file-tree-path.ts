/** Returns true when `ancestorPath` is a strict ancestor directory of `targetPath`. */
export function isAncestorPath(ancestorPath: string, targetPath: string): boolean {
  if (!targetPath) return false
  if (!ancestorPath) return targetPath.includes('/')
  return targetPath.startsWith(`${ancestorPath}/`)
}
