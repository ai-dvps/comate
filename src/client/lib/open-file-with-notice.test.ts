import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import i18next from 'i18next'

import { openFileWithNotice } from './open-file-with-notice'
import { useToastStore } from '../stores/toast-store'
import enChat from '../i18n/en/chat.json'
import zhChat from '../i18n/zh-CN/chat.json'

const openFileMock = vi.fn()

vi.mock('../stores/context-tab-store', () => ({
  useContextTabStore: {
    getState: () => ({ openFile: openFileMock }),
  },
}))

describe('openFileWithNotice', () => {
  beforeAll(async () => {
    await i18next.init({
      lng: 'en',
      fallbackLng: 'en',
      resources: {
        en: { chat: enChat },
        'zh-CN': { chat: zhChat },
      },
      interpolation: { escapeValue: false },
    })
  })

  beforeEach(() => {
    openFileMock.mockReset()
    useToastStore.setState({ toasts: [] })
  })

  it('defines the openFileFailed toast copy in both chat locales', () => {
    expect(enChat.openFileFailed).toContain('{{name}}')
    expect(zhChat.openFileFailed).toContain('{{name}}')
  })

  it('opens the file, runs onOpened, and raises no toast on success', async () => {
    openFileMock.mockResolvedValue(undefined)
    const onOpened = vi.fn()

    const result = await openFileWithNotice('ws-1', 'src/a.ts', 'a.ts', { onOpened })

    expect(result).toBe(true)
    expect(openFileMock).toHaveBeenCalledWith('ws-1', 'src/a.ts', 'a.ts')
    expect(onOpened).toHaveBeenCalledTimes(1)
    expect(useToastStore.getState().toasts).toEqual([])
  })

  it('raises an error toast naming the file when the open fails', async () => {
    openFileMock.mockRejectedValue(new Error('HTTP 500'))
    const onOpened = vi.fn()
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await openFileWithNotice('ws-1', 'src/missing.ts', 'missing.ts', { onOpened })

    expect(result).toBe(false)
    expect(onOpened).not.toHaveBeenCalled()
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].severity).toBe('error')
    expect(toasts[0].message).toContain('missing.ts')
    expect(toasts[0].message).toBe(enChat.openFileFailed.replace('{{name}}', 'missing.ts'))
    expect(consoleErrorSpy).toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('works without the onOpened option and still toasts on failure', async () => {
    openFileMock.mockRejectedValue(new Error('gone'))
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await openFileWithNotice('ws-1', 'src/b.ts', 'b.ts')

    expect(result).toBe(false)
    const toasts = useToastStore.getState().toasts
    expect(toasts).toHaveLength(1)
    expect(toasts[0].message).toContain('b.ts')
    consoleErrorSpy.mockRestore()
  })
})
