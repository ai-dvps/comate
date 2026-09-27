/** Strip Windows extended-length path prefix (\\\\?\\) so paths work with spawn/exec. */
export function normalizeWindowsPath(p: string): string {
  if (process.platform === 'win32' && p.startsWith('\\\\?\\')) {
    return p.slice(4);
  }
  return p;
}
