import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import enSettings from '../../i18n/en/settings.json'
import { useExpertPackagesStore, type ExpertPackageDetail } from '../../stores/expert-packages-store'
import ExpertPackageInstallModal from './ExpertPackageInstallModal'

const originalFetch = global.fetch

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { settings: enSettings } },
  })
})

const detail: ExpertPackageDetail = {
  slug: 'test-package',
  displayName: 'Test Package',
  summary: 'Test workflow',
  scene: 'tech',
  skillCount: 2,
  source: 'skillhub.cn',
  content: '# Workflow',
  complete: true,
  children: [
    { namespace: 'owner', slug: 'ok', displayName: 'Good Skill', summary: '', available: true, source: 'skillhub-cn:owner/ok' },
    { namespace: 'owner', slug: 'bad', displayName: 'Failed Skill', summary: '', available: true, source: 'skillhub-cn:owner/bad' },
  ],
}

describe('ExpertPackageInstallModal', () => {
  beforeEach(() => useExpertPackagesStore.getState().reset())
  afterEach(() => { global.fetch = originalFetch })

  it('keeps partial results visible and retries only failed item identities', async () => {
    const bodies: Array<Record<string, unknown>> = []
    global.fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      if (bodies.length === 1) {
        return Promise.resolve(Response.json({ results: [
          { id: 'orchestrator:test-package', kind: 'orchestrator', source: 'skillhub-package:test-package', name: 'test-package', status: 'installed' },
          { id: 'skill:owner/ok', kind: 'skill', source: 'skillhub-cn:owner/ok', name: 'ok', status: 'already-installed' },
          { id: 'skill:owner/bad', kind: 'skill', source: 'skillhub-cn:owner/bad', name: 'bad', status: 'error', error: 'download failed' },
        ] }, { status: 201 }))
      }
      return Promise.resolve(Response.json({ results: [
        { id: 'skill:owner/bad', kind: 'skill', source: 'skillhub-cn:owner/bad', name: 'bad', status: 'installed' },
      ] }, { status: 201 }))
    }) as typeof fetch
    const user = userEvent.setup()
    render(<ExpertPackageInstallModal detail={detail} workspaceId="ws-1" onClose={() => undefined} onCompleted={() => undefined} />)

    await user.click(screen.getByRole('button', { name: 'Confirm install' }))
    expect(await screen.findByText('download failed')).toBeInTheDocument()
    expect(screen.getByText('Already installed, skipped')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry failed items' }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toEqual({
      scope: 'project',
      workspaceId: 'ws-1',
      itemIds: ['skill:owner/bad'],
    })
    await waitFor(() => expect(screen.queryByText('download failed')).not.toBeInTheDocument())
    expect(screen.getByText('Already installed, skipped')).toBeInTheDocument()
    expect(screen.getAllByText('Installed')).toHaveLength(2)
  })

  it('ignores Escape while installation is in progress', async () => {
    let resolveInstall: ((response: Response) => void) | undefined
    global.fetch = vi.fn(() => new Promise<Response>((resolve) => { resolveInstall = resolve })) as typeof fetch
    const onClose = vi.fn()
    const user = userEvent.setup()
    render(<ExpertPackageInstallModal detail={detail} workspaceId="ws-1" onClose={onClose} onCompleted={() => undefined} />)

    await user.click(screen.getByRole('button', { name: 'Confirm install' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    resolveInstall?.(Response.json({ results: [
      { id: 'orchestrator:test-package', kind: 'orchestrator', source: 'skillhub-package:test-package', name: 'test-package', status: 'installed' },
    ] }, { status: 201 }))
    await screen.findByText('Installed')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
