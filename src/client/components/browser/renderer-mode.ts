export function isDetachedBrowserWindow(search: string): boolean {
  return new URLSearchParams(search).get('window') === 'detached-browser'
}
