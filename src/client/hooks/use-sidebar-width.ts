import { useResizableWidth } from './use-resizable-width'

export function useSidebarWidth() {
  return useResizableWidth({
    storageKey: 'sidebar-width',
    defaultWidth: 288,
    minWidth: 200,
    maxWidth: 600,
  })
}
