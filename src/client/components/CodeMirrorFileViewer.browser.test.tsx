import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import '../index.css'
import i18n from '../i18n'
import { useContextTabStore } from '../stores/context-tab-store'
import CodeMirrorFileViewer from './CodeMirrorFileViewer'

vi.mock('../lib/websocket-client.js', () => ({
  wsClient: { onEvent: vi.fn(), onReconnect: vi.fn(), onDisconnect: vi.fn() },
}))

afterEach(() => {
  cleanup()
  useContextTabStore.getState().reset()
  vi.unstubAllGlobals()
})

function Preview() {
  const tab = useContextTabStore((state) => state.openTabs[0])
  return tab?.type === 'file' ? <CodeMirrorFileViewer tab={tab} /> : null
}

describe('file preview auto reload in Chromium', () => {
  it.each([390, 1280])('loads updates and fits the notice in a %ipx panel', async (width) => {
    let version = 'v1'
    let content = 'Original file contents'
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(input, location.origin)
      return url.searchParams.get('ifVersion') === version
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ content, version, isBinary: false }))
    }))
    const store = useContextTabStore.getState()
    store.setContext('reload-browser', null)
    await store.openFile('reload-browser', 'notes.md', 'notes.md')
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <div style={{ width, height: 500 }}><Preview /></div>
      </I18nextProvider>,
    )
    expect(screen.getByText(content)).toBeVisible()
    version = 'v2'
    content = 'Updated file contents'
    await waitFor(() => expect(screen.getByText(content)).toBeVisible(), { timeout: 4000 })
    const notice = screen.getByRole('status')
    expect(notice).toHaveTextContent(i18n.t('common:fileReloaded'))
    const bounds = container.firstElementChild!.getBoundingClientRect()
    expect(notice.getBoundingClientRect().right).toBeLessThanOrEqual(bounds.right)
    expect(notice.scrollWidth).toBeLessThanOrEqual(width)
  })
})
