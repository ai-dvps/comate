import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'

/**
 * RememberedSitesCard (U8): the settings-page management list for "记住此站点".
 * The component only ever sees keys + metadata (the server strips contexts) —
 * these tests pin the fetch/render/revoke flow and the value-free payload.
 */

// The card is a named export of SettingsPanel; that module pulls the Tauri
// updater API at import time — mock it (same pattern as the SettingsPanel
// tests).
vi.mock('../../lib/updater-api', () => ({
  checkForUpdates: vi.fn(),
  getAppVersion: vi.fn(() => Promise.resolve('0.0.0-test')),
  downloadAndInstallUpdate: vi.fn(),
  restartToUpdate: vi.fn(),
  dismissUpdate: vi.fn(),
}))

import { RememberedSitesCard } from '../SettingsPanel'

const WORKSPACE_ID = 'ws-1'

function workspacePayload(browserSiteAuth: Record<string, unknown>) {
  return {
    workspace: {
      id: WORKSPACE_ID,
      name: 'Test',
      description: '',
      folderPath: '/tmp/ws',
      settings: { browserSiteAuth },
      skills: [],
      mcpServers: [],
      hooks: [],
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    },
  }
}

function mockFetchOnce(payload: unknown, ok = true) {
  const fetchMock = global.fetch as ReturnType<typeof vi.fn>
  fetchMock.mockResolvedValueOnce({
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(payload),
  } as unknown as Response)
}

function renderCard() {
  return render(
    <I18nextProvider i18n={i18n}>
      <RememberedSitesCard workspaceId={WORKSPACE_ID} />
    </I18nextProvider>,
  )
}

describe('RememberedSitesCard', () => {
  beforeEach(() => {
    cleanup()
    global.fetch = vi.fn()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the remembered sites (keys + metadata only)', async () => {
    mockFetchOnce(
      workspacePayload({
        'example.com': { createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' },
        'user.github.io': { createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-19T01:00:00.000Z' },
      }),
    )
    renderCard()

    await waitFor(() => {
      expect(screen.getByTestId('remembered-sites-list')).toBeInTheDocument()
    })
    expect(screen.getByText('example.com')).toBeInTheDocument()
    expect(screen.getByText('user.github.io')).toBeInTheDocument()
    // The payload the component consumed contains no sessionContext at all.
    const fetchArg = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(fetchArg).toBe(`/api/workspaces/${WORKSPACE_ID}`)
  })

  it('shows the empty state when nothing is remembered', async () => {
    mockFetchOnce(workspacePayload({}))
    renderCard()
    await waitFor(() => {
      expect(screen.getByTestId('remembered-sites-empty')).toBeInTheDocument()
    })
  })

  it('revoke calls the DELETE endpoint and refreshes the list', async () => {
    mockFetchOnce(
      workspacePayload({
        'example.com': { createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-19T00:00:00.000Z' },
      }),
    )
    renderCard()
    await waitFor(() => {
      expect(screen.getByTestId('remembered-sites-list')).toBeInTheDocument()
    })

    mockFetchOnce({}, true) // DELETE 204
    mockFetchOnce(workspacePayload({})) // refresh → empty
    fireEvent.click(screen.getByTestId('remembered-site-revoke-example.com'))

    await waitFor(() => {
      expect(screen.getByTestId('remembered-sites-empty')).toBeInTheDocument()
    })
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    const deleteCall = calls.find((call) => (call[1] as { method?: string } | undefined)?.method === 'DELETE')
    expect(deleteCall?.[0]).toBe(`/api/workspaces/${WORKSPACE_ID}/browser-site-auth/example.com`)
  })
})
