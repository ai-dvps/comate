import i18next from 'i18next'

import { useContextTabStore } from '../stores/context-tab-store'
import { useToastStore } from '../stores/toast-store'

export interface OpenFileWithNoticeOptions {
  /** Runs after the file opens successfully (e.g. expand the right panel). */
  onOpened?: () => void
}

/**
 * Opens a workspace file in the right-side file tab through the context-tab
 * store. On failure it raises an error toast naming the file (and keeps the
 * diagnostic console log) instead of failing silently.
 *
 * Returns true when the file opened.
 */
export async function openFileWithNotice(
  workspaceId: string,
  path: string,
  name: string,
  options: OpenFileWithNoticeOptions = {},
): Promise<boolean> {
  try {
    await useContextTabStore.getState().openFile(workspaceId, path, name)
    options.onOpened?.()
    return true
  } catch (error) {
    useToastStore.getState().addToast({
      severity: 'error',
      message: i18next.t('chat:openFileFailed', {
        name,
        defaultValue: 'Failed to open {{name}}',
      }),
    })
    console.error('Failed to open file:', error)
    return false
  }
}
